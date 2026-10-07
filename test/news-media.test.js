import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { sniffMedia } from '../server/news.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

const db = openDatabase(':memory:');
const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koolkat-test-media-'));
let now = Date.now();
let app, server, base;
before(async () => {
  app = createApp({ db, admins: ['boss'], clock: () => now, mediaDir });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(mediaDir, { recursive: true, force: true });
});

async function call(method, p, { token, body, raw, type } = {}) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  if (raw) headers['content-type'] = type || 'application/octet-stream';
  else if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api${p}`, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, body: await res.json().catch(() => null), res };
}
async function register(username) {
  const { authSecret, vaultKey } = await deriveKeysFromPassword(username, 'password123', 1000);
  const id = await createIdentity(vaultKey);
  const res = await call('POST', '/auth/register', {
    body: { username, displayName: username, authSecret, publicKey: id.publicKey, encryptedPrivateKey: id.encryptedPrivateKey, privateKeyIv: id.privateKeyIv },
  });
  return { ...res.body.user, token: res.body.token };
}

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(50_000, 3)]);

let boss, ann;
before(async () => {
  [boss, ann] = [await register('boss'), await register('ann')];
});

describe('News photos and videos', () => {
  test('recognises files by their contents, not their name', () => {
    assert.deepEqual(sniffMedia(jpeg), { kind: 'image', mime: 'image/jpeg' });
    assert.deepEqual(sniffMedia(mp4), { kind: 'video', mime: 'video/mp4' });
    assert.equal(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypqt  '), Buffer.alloc(10)])).mime, 'video/quicktime');
    assert.equal(sniffMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'no SVG (it can contain scripts)');
    assert.equal(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(10)])), null);
  });

  test('only admins upload; uploads are checked', async () => {
    assert.equal((await call('POST', '/news/media', { token: ann.token, raw: jpeg, type: 'image/jpeg' })).status, 403);
    assert.equal((await call('POST', '/news/media', { token: boss.token, raw: Buffer.from('not really a picture at all'), type: 'image/jpeg' })).status, 415);
    assert.equal((await call('POST', '/news/media', { token: boss.token, raw: Buffer.alloc(0) })).status, 415);
  });

  test('a post with a video: everyone can watch it, and skip around in it', async () => {
    const up = await call('POST', '/news/media', { token: boss.token, raw: mp4, type: 'video/mp4' });
    assert.equal(up.status, 201);
    assert.equal(up.body.kind, 'video');
    assert.equal((await call('POST', '/news', { token: boss.token, body: { title: 'x', mediaId: 'nope' } })).status, 400);
    const post = await call('POST', '/news', { token: boss.token, body: { title: 'Watch this', mediaId: up.body.mediaId } });
    assert.equal(post.status, 201);
    assert.deepEqual(post.body.post.media, { kind: 'video', type: 'video/mp4', url: `news/media/${up.body.mediaId}` });
    assert.equal((await call('POST', '/news', { token: boss.token, body: { title: 'again', mediaId: up.body.mediaId } })).status, 400, 'used once');

    const seen = (await call('GET', '/news', { token: ann.token })).body.posts[0];
    assert.equal(seen.media.kind, 'video');
    const full = await fetch(`${base}/api/${seen.media.url}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal((await full.arrayBuffer()).byteLength, mp4.length);
    const part = await fetch(`${base}/api/${seen.media.url}`, { headers: { range: 'bytes=100-199' } });
    assert.equal(part.status, 206, 'range requests work');
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(`${base}/api/news/media/AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);

    // Deleting the post deletes the file.
    await call('DELETE', `/news/${post.body.post.id}`, { token: boss.token });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(path.join(mediaDir, up.body.mediaId)), false);
    assert.equal((await fetch(`${base}/api/${seen.media.url}`)).status, 404);
  });

  test('a post with a photo, and abandoned uploads are cleaned up', async () => {
    const up = await call('POST', '/news/media', { token: boss.token, raw: jpeg, type: 'image/jpeg' });
    const post = await call('POST', '/news', { token: boss.token, body: { title: 'Look', body: 'A photo', mediaId: up.body.mediaId } });
    assert.equal(post.body.post.media.kind, 'image');
    const img = await fetch(`${base}/api/${post.body.post.media.url}`);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');

    const abandoned = await call('POST', '/news/media', { token: boss.token, raw: jpeg, type: 'image/jpeg' });
    now += 25 * 60 * 60 * 1000;
    app.locals.cleanupNewsUploads();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(path.join(mediaDir, abandoned.body.mediaId)), false);
    assert.equal(fs.existsSync(path.join(mediaDir, up.body.mediaId)), true, 'posted media is kept');
    assert.equal((await call('POST', '/news', { token: boss.token, body: { title: 'late', mediaId: abandoned.body.mediaId } })).status, 400);
  });

  test('posts without media still work', async () => {
    const post = await call('POST', '/news', { token: boss.token, body: { title: 'Plain' } });
    assert.equal(post.body.post.media, null);
  });

  test('admins edit posts: text, and keep, swap or remove the photo/video', async () => {
    const up = await call('POST', '/news/media', { token: boss.token, raw: jpeg, type: 'image/jpeg' });
    const post = (await call('POST', '/news', { token: boss.token, body: { title: 'Typo', body: 'helo', mediaId: up.body.mediaId } })).body.post;
    assert.equal(post.editedAt, null);
    assert.equal((await call('POST', `/news/${post.id}`, { token: ann.token, body: { title: 'Hacked' } })).status, 403);
    assert.equal((await call('POST', `/news/${post.id}`, { token: boss.token, body: { title: '' } })).status, 400);
    assert.equal((await call('POST', '/news/999999', { token: boss.token, body: { title: 'x' } })).status, 404);

    let edited = (await call('POST', `/news/${post.id}`, { token: boss.token, body: { title: 'Fixed', body: 'hello' } })).body.post;
    assert.equal(edited.title, 'Fixed');
    assert.equal(edited.body, 'hello');
    assert.ok(edited.editedAt);
    assert.equal(edited.media.url, post.media.url, 'photo kept');

    const video = await call('POST', '/news/media', { token: boss.token, raw: mp4, type: 'video/mp4' });
    edited = (await call('POST', `/news/${post.id}`, { token: boss.token, body: { title: 'Fixed', mediaId: video.body.mediaId } })).body.post;
    assert.equal(edited.media.kind, 'video');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(path.join(mediaDir, up.body.mediaId)), false, 'old photo deleted');

    edited = (await call('POST', `/news/${post.id}`, { token: boss.token, body: { title: 'Fixed', removeMedia: true } })).body.post;
    assert.equal(edited.media, null);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(path.join(mediaDir, video.body.mediaId)), false);
  });

  test('hearts and saves (Favorite Articles)', async () => {
    const post = (await call('POST', '/news', { token: boss.token, body: { title: 'Like me' } })).body.post;
    assert.equal(post.likes, 0);
    let r = await call('POST', `/news/${post.id}/like`, { token: ann.token });
    assert.deepEqual(r.body, { liked: true, likes: 1 });
    await call('POST', `/news/${post.id}/like`, { token: ann.token });
    r = await call('POST', `/news/${post.id}/like`, { token: boss.token });
    assert.equal(r.body.likes, 2, 'one heart per person');
    await call('POST', `/news/${post.id}/save`, { token: ann.token });

    const forAnn = (await call('GET', '/news', { token: ann.token })).body.posts.find((p) => p.id === post.id);
    assert.equal(forAnn.likes, 2);
    assert.equal(forAnn.liked, true);
    assert.equal(forAnn.saved, true);
    const forBoss = (await call('GET', '/news', { token: boss.token })).body.posts.find((p) => p.id === post.id);
    assert.equal(forBoss.saved, false, 'saves are personal');

    const saved = (await call('GET', '/news/saved', { token: ann.token })).body.posts;
    assert.deepEqual(saved.map((p) => p.id), [post.id]);
    assert.deepEqual((await call('GET', '/news/saved', { token: boss.token })).body.posts, []);

    assert.deepEqual((await call('DELETE', `/news/${post.id}/like`, { token: ann.token })).body, { liked: false, likes: 1 });
    await call('DELETE', `/news/${post.id}/save`, { token: ann.token });
    assert.deepEqual((await call('GET', '/news/saved', { token: ann.token })).body.posts, []);
    assert.equal((await call('POST', '/news/999999/like', { token: ann.token })).status, 404);

    // Deleting the post removes it from everyone's Favorite Articles.
    await call('POST', `/news/${post.id}/save`, { token: ann.token });
    await call('DELETE', `/news/${post.id}`, { token: boss.token });
    assert.deepEqual((await call('GET', '/news/saved', { token: ann.token })).body.posts, []);
  });
});

describe('profiles and profile pictures', () => {
  const pic = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 9)]).toString('base64');

  test('anyone can set a profile picture; it shows with their name', async () => {
    assert.equal((await call('POST', '/me/avatar', { token: ann.token, body: { image: Buffer.from('x'.repeat(200)).toString('base64') } })).status, 400);
    const set = await call('POST', '/me/avatar', { token: ann.token, body: { image: pic } });
    assert.match(set.body.avatarUrl, /^avatars\/[A-Za-z0-9_-]{16}\.jpg$/);
    const img = await fetch(`${base}/api/${set.body.avatarUrl}`);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await call('GET', '/me', { token: ann.token })).body.user.avatarUrl, set.body.avatarUrl);
    // e.g. as a News author
    await call('POST', '/me/avatar', { token: boss.token, body: { image: pic } });
    const post = (await call('POST', '/news', { token: boss.token, body: { title: 'By me' } })).body.post;
    assert.ok(post.author.avatarUrl);

    await call('DELETE', '/me/avatar', { token: ann.token });
    assert.equal((await call('GET', '/me', { token: ann.token })).body.user.avatarUrl, null);
    assert.equal((await fetch(`${base}/api/${set.body.avatarUrl}`)).status, 404);
  });

  test('admins can reset a profile picture', async () => {
    await call('POST', '/me/avatar', { token: ann.token, body: { image: pic } });
    const res = await call('POST', '/admin/reset-customization', { token: boss.token, body: { username: 'ann', avatar: true } });
    assert.deepEqual(res.body.reset, ['avatar']);
    assert.equal((await call('GET', '/me', { token: ann.token })).body.user.avatarUrl, null);
  });

  test("tapping a name opens that person's profile", async () => {
    const p = (await call('GET', `/users/${boss.id}`, { token: ann.token })).body.user;
    assert.equal(p.username, 'boss');
    assert.equal(p.relationship, 'none');
    assert.equal(p.isAdmin, true);
    assert.ok(p.joinedAt);
    assert.equal(p.activity, null, 'activity is for friends only');
    assert.equal((await call('GET', `/users/${ann.id}`, { token: ann.token })).body.user.relationship, 'you');
    assert.equal((await call('GET', '/users/99999', { token: ann.token })).status, 404);
  });
});

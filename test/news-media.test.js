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
});

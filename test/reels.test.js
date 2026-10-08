import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

const db = openDatabase(':memory:');
let server, base;
before(async () => {
  server = createApp({ db, admins: ['boss'] }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api${p}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function register(username) {
  const { authSecret, vaultKey } = await deriveKeysFromPassword(username, 'password123', 1000);
  const id = await createIdentity(vaultKey);
  const res = await call('POST', '/auth/register', {
    body: { username, displayName: username, authSecret, publicKey: id.publicKey, encryptedPrivateKey: id.encryptedPrivateKey, privateKeyIv: id.privateKeyIv },
  });
  return { ...res.body.user, token: res.body.token };
}

async function upload(token, bytes) {
  const res = await fetch(`${base}/api/reels/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    body: bytes,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

let boss, amy;
before(async () => {
  [boss, amy] = [await register('boss'), await register('amy')]; // boss: admin, so Unlimited
});

describe('KoolKat Reels', () => {
  let reel;
  test('Unlimited members post Reels; everyone can watch', async () => {
    assert.equal((await upload(amy.token, MP4)).status, 403, 'Free accounts cannot post');
    assert.equal((await upload(boss.token, Buffer.from('not a video at all'))).status, 415);
    const video = await upload(boss.token, MP4);
    const poster = await upload(boss.token, JPEG);
    assert.equal(video.body.kind, 'video');
    assert.equal(poster.body.kind, 'image');
    assert.equal((await call('POST', '/reels', { token: boss.token, body: { videoId: poster.body.uploadId } })).status, 400);
    const res = await call('POST', '/reels', {
      token: boss.token,
      body: { videoId: video.body.uploadId, posterId: poster.body.uploadId, caption: '  my first reel  ' },
    });
    assert.equal(res.status, 201);
    reel = res.body.reel;
    assert.equal(reel.caption, 'my first reel');
    assert.equal(reel.author.username, 'boss');
    assert.ok(reel.poster);
    // Same upload can't be posted twice.
    assert.equal((await call('POST', '/reels', { token: boss.token, body: { videoId: video.body.uploadId } })).status, 400);

    const feed = await call('GET', '/reels', { token: amy.token });
    assert.equal(feed.body.canPost, false);
    assert.deepEqual(feed.body.reels.map((r) => r.id), [reel.id]);
    const file = await fetch(`${base}/api/${reel.video.url}`, { headers: { range: 'bytes=0-11' } });
    assert.equal(file.status, 206);
    assert.equal(file.headers.get('content-type'), 'video/mp4');
    assert.equal((await fetch(`${base}/api/${reel.poster}`)).headers.get('content-type'), 'image/jpeg');
    assert.equal((await call('GET', `/reels?user=${amy.id}`, { token: amy.token })).body.reels.length, 0);
  });

  test('hearts, views and comments', async () => {
    // Free accounts can heart and comment too.
    assert.equal((await call('POST', `/reels/${reel.id}/like`, { token: amy.token })).body.likes, 1);
    assert.equal((await call('POST', `/reels/${reel.id}/like`, { token: boss.token })).body.likes, 2);
    assert.equal((await call('DELETE', `/reels/${reel.id}/like`, { token: amy.token })).body.likes, 1);
    assert.equal((await call('POST', `/reels/${reel.id}/comments`, { token: amy.token, body: { body: 'hi' } })).status, 201);
    await call('POST', `/reels/${reel.id}/view`, { token: amy.token });
    assert.equal((await call('POST', `/reels/${reel.id}/view`, { token: amy.token })).body.views, 1, 'once per person');
    const c = await call('POST', `/reels/${reel.id}/comments`, { token: boss.token, body: { body: 'Nice' } });
    assert.equal(c.status, 201);
    const list = await call('GET', `/reels/${reel.id}/comments`, { token: amy.token });
    assert.deepEqual(list.body.comments.map((x) => x.body), ['hi', 'Nice']);
    assert.equal(list.body.comments[0].canDelete, true, 'your own comment');
    assert.equal(list.body.comments[1].canDelete, false);
    const one = (await call('GET', `/reels/${reel.id}`, { token: boss.token })).body.reel;
    assert.equal(one.liked, true);
    assert.equal(one.comments, 2);
    const profile = (await call('GET', `/users/${boss.id}`, { token: amy.token })).body.user;
    assert.deepEqual(profile.stats, { friends: 0, reels: 1, likes: 1, songs: 0 });
  });

  test('only the author or an admin deletes a Reel', async () => {
    assert.equal((await call('DELETE', `/reels/${reel.id}`, { token: amy.token })).status, 403);
    assert.equal((await call('DELETE', `/reels/${reel.id}`, { token: boss.token })).status, 200);
    assert.equal((await call('GET', `/reels/${reel.id}`, { token: boss.token })).status, 404);
    assert.equal((await fetch(`${base}/api/${reel.video.url}`)).status, 404);
  });
});

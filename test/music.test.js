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

async function upload(token, kind, bytes) {
  const res = await fetch(`${base}/api/music/upload?kind=${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    body: bytes,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300, 3)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

let boss, amy;
before(async () => {
  [boss, amy] = [await register('boss'), await register('amy')]; // boss: admin, so Unlimited
});

describe('KoolKat Music', () => {
  let song;
  test('Unlimited artists post songs with a cover and music video', async () => {
    assert.equal((await upload(amy.token, 'audio', MP3)).status, 403, 'Free accounts cannot post');
    assert.equal((await upload(boss.token, 'audio', JPEG)).status, 415);
    assert.equal((await upload(boss.token, 'cover', MP3)).status, 415);
    const audio = await upload(boss.token, 'audio', MP3);
    const video = await upload(boss.token, 'video', MP4);
    const cover = await upload(boss.token, 'cover', JPEG);
    assert.equal(audio.status, 201);
    assert.equal((await call('POST', '/music', { token: boss.token, body: { audioId: audio.body.uploadId } })).status, 400, 'needs a title');
    assert.equal((await call('POST', '/music', { token: boss.token, body: { title: 'x', audioId: cover.body.uploadId } })).status, 400);
    const res = await call('POST', '/music', {
      token: boss.token,
      body: { title: 'Nine Lives', album: 'Kool Kuts', audioId: audio.body.uploadId, videoId: video.body.uploadId, coverId: cover.body.uploadId, duration: 187.4 },
    });
    assert.equal(res.status, 201);
    song = res.body.song;
    assert.equal(song.title, 'Nine Lives');
    assert.equal(song.album, 'Kool Kuts');
    assert.equal(song.artist.username, 'boss');
    assert.ok(song.video && song.cover);
    assert.equal(song.duration, 187.4);
    const list = await call('GET', '/music', { token: amy.token });
    assert.equal(list.body.canPost, false);
    assert.deepEqual(list.body.songs.map((s) => s.id), [song.id]);
    assert.deepEqual((await call('GET', '/music?q=kool', { token: amy.token })).body.songs.map((s) => s.id), [song.id], 'search finds the album');
    assert.deepEqual((await call('GET', '/music?q=nothing', { token: amy.token })).body.songs, []);
    const file = await fetch(`${base}/api/${song.audio.url}`, { headers: { range: 'bytes=0-2' } });
    assert.equal(file.status, 206);
    assert.equal(file.headers.get('content-type'), 'audio/mpeg');
  });

  test('anyone can heart, play and comment', async () => {
    assert.equal((await call('POST', `/music/${song.id}/like`, { token: amy.token })).body.likes, 1);
    await call('POST', `/music/${song.id}/play`, { token: amy.token });
    assert.equal((await call('POST', `/music/${song.id}/play`, { token: amy.token })).body.plays, 1, 'not twice in a row');
    assert.equal((await call('POST', `/music/${song.id}/comments`, { token: amy.token, body: { body: 'Banger 🔥' } })).status, 201);
    const home = (await call('GET', '/music/home', { token: amy.token })).body;
    assert.deepEqual(home.liked.map((s) => s.id), [song.id], 'Liked Songs');
    assert.equal(home.top[0].plays, 1);
    const comments = (await call('GET', `/music/${song.id}/comments`, { token: boss.token })).body.comments;
    assert.equal(comments[0].canDelete, true, 'the artist can remove comments on their song');
    assert.equal((await call('GET', `/users/${boss.id}`, { token: amy.token })).body.user.stats.songs, 1);
  });

  test('only the artist or an admin deletes a song', async () => {
    assert.equal((await call('DELETE', `/music/${song.id}`, { token: amy.token })).status, 403);
    assert.equal((await call('DELETE', `/music/${song.id}`, { token: boss.token })).status, 200);
    assert.equal((await fetch(`${base}/api/${song.audio.url}`)).status, 404);
  });
});

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
  const res = await fetch(`${base}/api/books/upload?kind=${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    body: bytes,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300, 3)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]);

let boss, amy;
before(async () => {
  [boss, amy] = [await register('boss'), await register('amy')]; // boss: admin, so Unlimited
});

describe('KoolKat Books', () => {
  let book;
  test('Unlimited writers make books of text, pictures or both', async () => {
    assert.equal((await upload(amy.token, 'image', JPEG)).status, 403, 'free accounts cannot make books');
    assert.equal((await call('POST', '/books', { token: amy.token, body: { title: 'Nope', pages: [{ text: 'hi' }] } })).status, 403);
    assert.equal((await upload(boss.token, 'image', MP3)).status, 415);
    assert.equal((await upload(boss.token, 'audio', JPEG)).status, 415);
    const cover = await upload(boss.token, 'cover', JPEG);
    const pic = await upload(boss.token, 'image', PNG);
    assert.equal(pic.status, 201);
    assert.equal((await call('POST', '/books', { token: boss.token, body: { title: 'The Kat', pages: [] } })).status, 400, 'needs a page');
    assert.equal((await call('POST', '/books', { token: boss.token, body: { title: 'The Kat', pages: [{ text: '  ' }] } })).status, 400, 'no empty pages');
    assert.equal((await call('POST', '/books', { token: boss.token, body: { pages: [{ text: 'x' }] } })).status, 400, 'needs a title');
    const made = await call('POST', '/books', {
      token: boss.token,
      body: {
        title: 'The Kool Kat',
        description: 'A story',
        coverId: cover.body.uploadId,
        pages: [{ text: 'Once upon a time…' }, { image: { upload: pic.body.uploadId } }, { text: 'The end', image: { upload: pic.body.uploadId } }],
      },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    book = made.body.book;
    assert.equal(book.pageCount, 3);
    assert.deepEqual(book.pages.map((p) => [p.text, Boolean(p.image)]), [['Once upon a time…', false], [null, true], ['The end', true]]);
    assert.equal(book.audiobook, null, 'the audiobook is optional');
    const img = await fetch(`${base}/api/${book.pages[1].image}`);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/api/${book.cover}`)).status, 200);
  });

  test('anyone can read, heart and comment (no Unlimited needed)', async () => {
    const list = (await call('GET', '/books', { token: amy.token })).body;
    assert.equal(list.canCreate, false);
    assert.equal(list.books[0].title, 'The Kool Kat');
    assert.equal((await call('GET', '/books?q=kool', { token: amy.token })).body.books.length, 1);
    const read = (await call('GET', `/books/${book.id}`, { token: amy.token })).body.book;
    assert.equal(read.pages.length, 3);
    assert.equal(read.mine, false);
    assert.deepEqual((await call('POST', `/books/${book.id}/like`, { token: amy.token })).body, { liked: true, likes: 1 });
    const c = await call('POST', `/books/${book.id}/comments`, { token: amy.token, body: { body: 'Loved it!' } });
    assert.equal(c.status, 201);
    assert.equal((await call('GET', `/books/${book.id}/comments`, { token: boss.token })).body.comments[0].body, 'Loved it!');
    assert.equal((await call('PUT', `/books/${book.id}`, { token: amy.token, body: { title: 'Mine now', pages: [{ text: 'x' }] } })).status, 403);
    assert.equal((await call('DELETE', `/books/${book.id}`, { token: amy.token })).status, 403);
  });

  test('add an audiobook later (or take it off), and change the pages', async () => {
    const audio = await upload(boss.token, 'audio', MP3);
    let res = await call('PUT', `/books/${book.id}/audiobook`, { token: boss.token, body: { audioId: audio.body.uploadId, audioDuration: 312 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.book.audiobook.duration, 312);
    assert.equal((await fetch(`${base}/api/${res.body.book.audiobook.url}`)).headers.get('content-type'), 'audio/mpeg');
    const keep = book.pages[1].imageId;
    res = await call('PUT', `/books/${book.id}`, { token: boss.token, body: { title: 'The Kool Kat (2nd edition)', keepCover: true, pages: [{ image: { keep } }, { text: 'New ending' }] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.book.pages.map((p) => p.text), [null, 'New ending']);
    assert.ok(res.body.book.cover, 'kept the cover');
    assert.ok(res.body.book.audiobook, 'kept the audiobook');
    assert.equal((await call('PUT', `/books/${book.id}`, { token: boss.token, body: { title: 'x', pages: [{ image: { keep: 'AAAAAAAAAAAAAAAAAAAAAA' } }] } })).status, 400);
    res = await call('DELETE', `/books/${book.id}/audiobook`, { token: boss.token });
    assert.equal(res.body.book.audiobook, null);
    assert.equal((await call('DELETE', `/books/${book.id}`, { token: boss.token })).status, 200);
    assert.equal((await call('GET', `/books/${book.id}`, { token: amy.token })).status, 404);
  });
});

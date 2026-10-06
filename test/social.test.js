import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

const db = openDatabase(':memory:');
let now = Date.now();
let server;
let base;
before(async () => {
  server = createApp({ db, admins: ['boss'], clock: () => now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
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

let boss, ann, ben, cat;
const me = async (u) => (await call('GET', '/me', { token: u.token })).body;
before(async () => {
  [boss, ann, ben, cat] = [await register('boss'), await register('ann'), await register('ben'), await register('cat')];
  for (const [a, b] of [[ann, ben], [ann, boss]]) {
    await call('POST', '/friends/request', { token: a.token, body: { username: b.username } });
    await call('POST', `/friends/${a.id}/accept`, { token: b.token });
  }
  await call('POST', '/admin/grant', { token: boss.token, body: { username: 'ann' } });
});


describe('QR friending', () => {
  test('scanning a code makes you friends straight away', async () => {
    const first = await call('GET', '/friend-code', { token: cat.token });
    assert.match(first.body.code, /^[A-Za-z0-9_-]{22}$/);
    assert.equal((await call('GET', '/friend-code', { token: cat.token })).body.code, first.body.code, 'same code while fresh');

    assert.equal((await call('POST', '/friends/qr', { token: cat.token, body: { code: first.body.code } })).status, 400, 'own code');
    assert.equal((await call('POST', '/friends/qr', { token: ann.token, body: { code: 'nope' } })).status, 400);
    const scan = await call('POST', '/friends/qr', { token: ann.token, body: { code: first.body.code } });
    assert.equal(scan.status, 200);
    assert.equal(scan.body.status, 'accepted');
    assert.equal(scan.body.user.username, 'cat');
    const friends = (await call('GET', '/friends', { token: cat.token })).body.friends;
    assert.ok(friends.some((f) => f.username === 'ann'));
    assert.equal((await call('POST', '/friends/qr', { token: ann.token, body: { code: first.body.code } })).body.status, 'already');
  });

  test('codes expire and are replaced', async () => {
    const old = (await call('GET', '/friend-code', { token: ben.token })).body.code;
    now += 7 * 60 * 1000;
    const renewed = (await call('GET', '/friend-code', { token: ben.token })).body.code;
    assert.notEqual(renewed, old, 'a new code when the old one is nearly used up');
    now += 4 * 60 * 1000;
    const expired = await call('POST', '/friends/qr', { token: cat.token, body: { code: old } });
    assert.equal(expired.status, 404);
    const ok = await call('POST', '/friends/qr', { token: cat.token, body: { code: renewed } });
    assert.equal(ok.body.status, 'accepted');
  });
});

describe('Nearby', () => {
  test('only people close by who have Nearby open show up, without their location', async () => {
    const here = { lat: 51.5007, lng: -0.1246, accuracy: 20 };
    assert.equal((await call('POST', '/nearby', { token: ann.token, body: {} })).status, 400);
    assert.equal((await call('POST', '/nearby', { token: ann.token, body: { ...here, accuracy: 5000 } })).status, 422);
    assert.deepEqual((await call('POST', '/nearby', { token: ann.token, body: here })).body.people, []);
    // ~50 m away
    const ben1 = await call('POST', '/nearby', { token: ben.token, body: { lat: 51.50115, lng: -0.1246, accuracy: 10 } });
    assert.deepEqual(ben1.body.people.map((p) => p.username), ['ann']);
    assert.equal(ben1.body.people[0].relationship, 'friends');
    assert.equal(ben1.body.people[0].lat, undefined);
    // ~5 km away
    const far = await call('POST', '/nearby', { token: boss.token, body: { lat: 51.546, lng: -0.1246, accuracy: 10 } });
    assert.deepEqual(far.body.people, []);

    await call('DELETE', '/nearby', { token: ben.token });
    assert.deepEqual((await call('POST', '/nearby', { token: ann.token, body: here })).body.people, []);
    await call('POST', '/nearby', { token: ben.token, body: here });
    now += 3 * 60 * 1000;
    assert.deepEqual((await call('POST', '/nearby', { token: ann.token, body: here })).body.people, [], 'stale spots expire');
  });
});

describe('Activity Bubbles', () => {
  test('Unlimited users set one and friends see it', async () => {
    assert.equal((await call('POST', '/me/activity', { token: ben.token, body: { emoji: '🎮', text: 'gaming' } })).status, 403);
    assert.equal((await call('POST', '/me/activity', { token: ann.token, body: { emoji: 'abc', text: 'x' } })).status, 400);
    assert.equal((await call('POST', '/me/activity', { token: ann.token, body: { text: 'x', hours: 3 } })).status, 400);
    const set = await call('POST', '/me/activity', { token: ann.token, body: { emoji: '🎮', text: '  playing   games ', hours: 1 } });
    assert.equal(set.status, 200);
    assert.equal(set.body.activity.text, 'playing games');
    assert.equal((await me(ann)).plan.activity.emoji, '🎮');
    const seen = (await call('GET', '/friends', { token: ben.token })).body.friends.find((f) => f.username === 'ann');
    assert.equal(seen.activity.text, 'playing games');
    // Not visible to strangers searching.
    const search = (await call('GET', '/users/search?q=ann', { token: boss.token })).body.users[0];
    assert.equal(search.activity, undefined);

    now += 61 * 60 * 1000;
    const later = (await call('GET', '/friends', { token: ben.token })).body.friends.find((f) => f.username === 'ann');
    assert.equal(later.activity, null, 'expired');

    await call('POST', '/me/activity', { token: ann.token, body: { emoji: '📚', text: 'studying' } });
    await call('DELETE', '/me/activity', { token: ann.token });
    assert.equal((await me(ann)).plan.activity, null);
  });
});

describe('chat themes', () => {
  test('Unlimited users pick a background and bubble colour', async () => {
    assert.equal((await call('POST', '/me/chat-theme', { token: ben.token, body: { background: 'ocean' } })).status, 403);
    assert.equal((await call('POST', '/me/chat-theme', { token: ann.token, body: { background: 'lava' } })).status, 400);
    assert.equal((await call('POST', '/me/chat-theme', { token: ann.token, body: { background: 'color' } })).status, 400);
    assert.equal((await call('POST', '/me/chat-theme', { token: ann.token, body: { background: 'ocean', bubble: 'red' } })).status, 400);
    const ok = await call('POST', '/me/chat-theme', { token: ann.token, body: { background: 'color', color: '#112233', bubble: '#FF00AA' } });
    assert.deepEqual(ok.body.chatTheme, { background: 'color', bubble: '#ff00aa', color: '#112233' });
    assert.deepEqual((await me(ann)).plan.chatTheme, ok.body.chatTheme);

    assert.equal((await call('POST', '/me/chat-theme', { token: ann.token, body: { background: 'image' } })).status, 400, 'needs a picture');
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]).toString('base64');
    const img = await call('POST', '/me/chat-theme', { token: ann.token, body: { background: 'image', image: jpeg } });
    assert.equal(img.status, 200);
    const pic = await fetch(`${base}/api/me/chat-background`, { headers: { authorization: `Bearer ${ann.token}` } });
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(`${base}/api/me/chat-background`)).status, 401);
    assert.equal((await fetch(`${base}/api/me/chat-background`, { headers: { authorization: `Bearer ${ben.token}` } })).status, 404);
    // Keeping the same picture while changing the bubble colour.
    const again = await call('POST', '/me/chat-theme', { token: ann.token, body: { background: 'image', bubble: '#00ff00' } });
    assert.equal(again.body.chatTheme.imageVersion, img.body.chatTheme.imageVersion);

    await call('POST', '/me/chat-theme', { token: ann.token, body: { background: 'default' } });
    assert.equal((await me(ann)).plan.chatTheme, null);
    assert.equal((await fetch(`${base}/api/me/chat-background`, { headers: { authorization: `Bearer ${ann.token}` } })).status, 404);
  });
});

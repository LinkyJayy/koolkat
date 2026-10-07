import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

const db = openDatabase(':memory:');
let now = Date.now();
let server;
let app;
let base;
before(async () => {
  app = createApp({ db, admins: ['boss'], clock: () => now });
  server = app.listen(0);
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
  await call('POST', '/admin/grant', { token: boss.token, body: { username: 'ben' } });
});



describe('admin reset', () => {
  test('admins can clear an Activity Bubble', async () => {
    await call('POST', '/me/activity', { token: ann.token, body: { emoji: '🎮', text: 'rude words' } });
    const res = await call('POST', '/admin/reset-customization', { token: boss.token, body: { username: 'ann', activity: true } });
    assert.deepEqual(res.body.reset, ['activity']);
    assert.equal((await me(ann)).plan.activity, null);
    const again = await call('POST', '/admin/reset-customization', { token: boss.token, body: { username: 'ann', badge: true, icon: true, activity: true } });
    assert.deepEqual(again.body.reset, []);
    assert.equal((await call('POST', '/admin/reset-customization', { token: ann.token, body: { username: 'ann', activity: true } })).status, 403);
  });
});

describe('Kat Map', () => {
  const here = { lat: 40.7128, lng: -74.006, accuracy: 12 };
  test('Unlimited only, and nobody is shared until they turn it on', async () => {
    assert.equal((await call('GET', '/map', { token: cat.token })).status, 403);
    assert.equal((await call('POST', '/map/settings', { token: cat.token, body: { mode: 'friends' } })).status, 403);
    assert.equal((await call('POST', '/map/settings', { token: ann.token, body: { mode: 'everyone' } })).status, 400);
    assert.equal((await call('POST', '/map/location', { token: ann.token, body: here })).status, 409, 'sharing is off');
    const map = await call('GET', '/map', { token: ben.token });
    assert.deepEqual(map.body, { mode: 'off', location: null, friends: [] });
  });

  test('friends see where you are; BFF-only and off hide you', async () => {
    await call('POST', '/map/settings', { token: ann.token, body: { mode: 'friends' } });
    assert.equal((await call('POST', '/map/location', { token: ann.token, body: { lat: 200, lng: 0 } })).status, 400);
    assert.equal((await call('POST', '/map/location', { token: ann.token, body: here })).status, 200);
    const mine = (await call('GET', '/map', { token: ann.token })).body;
    assert.equal(mine.mode, 'friends');
    assert.equal(mine.location.lat, here.lat);

    let seen = (await call('GET', '/map', { token: ben.token })).body.friends;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].username, 'ann');
    assert.equal(seen[0].location.lng, here.lng);
    // boss is ann's friend too (admins have Unlimited); cat isn't her friend.
    assert.equal((await call('GET', '/map', { token: boss.token })).body.friends.length, 1);
    await call('POST', '/admin/grant', { token: boss.token, body: { username: 'cat' } });
    assert.equal((await call('GET', '/map', { token: cat.token })).body.friends.length, 0, 'not friends');

    // Only BFFs: ann makes ben a BFF, so ben still sees her but boss doesn't.
    await call('POST', '/map/settings', { token: ann.token, body: { mode: 'bffs' } });
    await call('POST', `/bffs/${ben.id}`, { token: ann.token });
    assert.equal((await call('GET', '/map', { token: ben.token })).body.friends.length, 1);
    assert.equal((await call('GET', '/map', { token: boss.token })).body.friends.length, 0);

    // Old locations disappear.
    now += 25 * 60 * 60 * 1000;
    assert.equal((await call('GET', '/map', { token: ben.token })).body.friends.length, 0);
    await call('POST', '/map/location', { token: ann.token, body: here });
    assert.equal((await call('GET', '/map', { token: ben.token })).body.friends.length, 1);

    // Turning it off deletes the location.
    await call('POST', '/map/settings', { token: ann.token, body: { mode: 'off' } });
    assert.equal((await call('GET', '/map', { token: ben.token })).body.friends.length, 0);
    const row = db.prepare('SELECT map_lat, map_at FROM users WHERE id = ?').get(ann.id);
    assert.equal(row.map_lat, null);
  });
});

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

let now = 1_000_000;
const db = openDatabase(':memory:');
let server, base;
before(async () => {
  server = createApp({ db, clock: () => now, admins: ['boss'] }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
async function call(method, p, token, body) {
  const res = await fetch(`${base}/api${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function register(username) {
  const { authSecret, vaultKey } = await deriveKeysFromPassword(username, 'password123', 1000);
  const id = await createIdentity(vaultKey);
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, displayName: username, authSecret, publicKey: id.publicKey, encryptedPrivateKey: id.encryptedPrivateKey, privateKeyIv: id.privateKeyIv }),
  });
  const body = await res.json();
  return { id: body.user.id, token: body.token };
}
/** Bolts for testing, straight into the ledger. */
const give = (userId, amount) => db.prepare("INSERT INTO bolt_rewards (user_id, game, reason, amount, ref, created_at) VALUES (?, 'test', 'test', ?, ?, ?)").run(userId, amount, `test:${Math.random()}`, now);
const item = (shop, id) => shop.items.find((i) => i.id === id);

describe('Bolt Shop', () => {
  test('team colours: 500 each, sell them back for what you paid', async () => {
    const u = await register('shopper');
    let shop = (await call('GET', '/shop', u.token)).body.shop;
    assert.deepEqual(shop.teams, ['red', 'yellow', 'green', 'blue', 'purple'], 'the five free colours');
    assert.equal(item(shop, 'team-orange').price, 500);
    assert.deepEqual(shop.items.filter((i) => i.kind === 'team').map((i) => i.team), ['orange', 'pink', 'teal', 'white', 'gray', 'black', 'brown']);
    const broke = await call('POST', '/shop/buy', u.token, { item: 'team-orange' });
    assert.equal(broke.status, 402);
    assert.match(broke.body.error, /500 more bolts/);
    give(u.id, 1200);
    shop = (await call('POST', '/shop/buy', u.token, { item: 'team-orange' })).body.shop;
    assert.equal(shop.bolts, 700);
    assert.ok(shop.teams.includes('orange'));
    assert.deepEqual([item(shop, 'team-orange').owned, item(shop, 'team-orange').paid], [true, 500]);
    assert.equal((await call('POST', '/shop/buy', u.token, { item: 'team-orange' })).status, 409, 'already yours');
    assert.equal((await call('POST', '/shop/buy', u.token, { item: 'team-rainbow' })).status, 404);
    // Use it in a game.
    const code = (await call('POST', '/circles/rooms', u.token)).body.room.code;
    assert.equal((await call('POST', `/circles/rooms/${code}/team`, u.token, { team: 'orange' })).body.room.players[0].team, 'orange');
    assert.equal((await call('POST', `/circles/rooms/${code}/team`, u.token, { team: 'pink' })).status, 403, "haven't bought pink");
    // Sell: every bolt back, and the colour's gone.
    shop = (await call('POST', '/shop/sell', u.token, { item: 'team-orange' })).body.shop;
    assert.equal(shop.bolts, 1200);
    assert.ok(!shop.teams.includes('orange'));
    assert.equal((await call('POST', '/shop/sell', u.token, { item: 'team-orange' })).status, 409, 'nothing to sell');
    const ki = (await call('POST', '/invaders/rooms', u.token)).body.room.code;
    assert.equal((await call('POST', `/invaders/rooms/${ki}/team`, u.token, { team: 'orange' })).status, 403);
  });

  test('KoolKat Unlimited for 10,000 bolts: all the colours, until you sell it', async () => {
    const u = await register('richkat');
    give(u.id, 15000);
    let shop = (await call('POST', '/shop/buy', u.token, { item: 'unlimited' })).body.shop;
    assert.equal(shop.bolts, 5000);
    assert.equal(shop.unlimited, true);
    assert.equal(shop.teams.length, 12, 'every team colour comes with Unlimited');
    assert.equal(item(shop, 'team-teal').included, true);
    assert.equal((await call('POST', '/shop/buy', u.token, { item: 'team-teal' })).status, 409, 'no need to buy what Unlimited gives you');
    let me = (await call('GET', '/me', u.token)).body;
    assert.equal(me.plan.plan, 'unlimited');
    assert.equal(me.user.badge, true, 'the Kool badge too');
    shop = (await call('POST', '/shop/sell', u.token, { item: 'unlimited' })).body.shop;
    assert.equal(shop.bolts, 15000);
    me = (await call('GET', '/me', u.token)).body;
    assert.equal(me.plan.plan, 'free');
    assert.equal(shop.teams.length, 5);
  });

  test('the Bolt Badge for 5,000 bolts, shown next to your name', async () => {
    const u = await register('shiny');
    give(u.id, 5000);
    await call('POST', '/shop/buy', u.token, { item: 'bolt-badge' });
    assert.equal((await call('GET', '/me', u.token)).body.user.boltBadge, true);
    assert.equal((await call('GET', '/shop', u.token)).body.shop.bolts, 0);
    await call('POST', '/shop/sell', u.token, { item: 'bolt-badge' });
    assert.equal((await call('GET', '/me', u.token)).body.user.boltBadge, false);
  });

  test('Unlimited users have the team colours already', async () => {
    const boss = await register('boss'); // admins have Unlimited
    const shop = (await call('GET', '/shop', boss.token)).body.shop;
    assert.equal(shop.teams.length, 12);
    assert.ok(shop.items.filter((i) => i.kind !== 'badge').every((i) => i.included), 'colours and Unlimited are already theirs');
    assert.equal((await call('POST', '/shop/buy', boss.token, { item: 'unlimited' })).status, 409);
  });
});

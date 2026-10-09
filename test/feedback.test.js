import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

let now = 1_000_000;
const db = openDatabase(':memory:');
const notes = [];
let server, base;
before(async () => {
  // 'boss' is the owner; notifications are caught here.
  const pusher = { publicKey: 'test', subscribe() {}, unsubscribe() {}, runStreakReminders: async () => 0, notify: async (userId, note) => notes.push({ userId, ...note }) };
  server = createApp({ db, clock: () => now, admins: ['boss'], pusher }).listen(0);
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
const unlimited = (userId) => db.prepare('UPDATE users SET plan_until = ? WHERE id = ?').run(now + 1e10, userId);
const give = (table, userId, amount) => db.prepare(`INSERT INTO ${table} (user_id, game, reason, amount, ref, created_at) VALUES (?, 'test', 'test', ?, ?, ?)`).run(userId, amount, `t:${Math.random()}`, now);

let boss, helper, kat, freebie;
before(async () => {
  [boss, helper, kat, freebie] = [await register('boss'), await register('helper'), await register('kat'), await register('freebie')];
  // helper becomes an admin (not the owner).
  await call('POST', '/admin/admins', boss.token, { username: 'helper' });
  unlimited(kat.id);
});

describe('Suggestions', () => {
  test('Unlimited users send them (with a category); only the owner sees and approves them', async () => {
    assert.equal((await call('POST', '/suggestions', freebie.token, { category: 'playables', idea: 'x', does: 'y' })).status, 403, 'KoolKat Unlimited only');
    assert.equal((await call('POST', '/suggestions', kat.token, { idea: 'Kat Golf', does: 'Mini golf with cats' })).status, 400, 'a category is required');
    assert.equal((await call('POST', '/suggestions', kat.token, { category: 'new-playable', idea: 'Kat Golf' })).status, 400, 'and what it could do');
    const made = await call('POST', '/suggestions', kat.token, { category: 'new-playable', idea: 'Kat Golf', does: 'Mini golf with cats\nand a windmill' });
    assert.equal(made.status, 201);
    await call('POST', '/suggestions', kat.token, { category: 'music', idea: 'Playlists', does: 'Save songs into lists' });
    assert.equal((await call('GET', '/suggestions/mine', kat.token)).body.suggestions.length, 2);
    // Other admins see them (to reply), but only the owner searches, sorts and approves.
    const forHelper = (await call('GET', '/admin/suggestions?category=music', helper.token)).body;
    assert.deepEqual([forHelper.canSearch, forHelper.canApprove, forHelper.suggestions.length], [false, false, 2], "admins can't filter");
    assert.equal((await call('GET', '/admin/suggestions', kat.token)).status, 403);
    let list = (await call('GET', '/admin/suggestions', boss.token)).body;
    assert.deepEqual(list.suggestions.map((s) => s.idea), ['Playlists', 'Kat Golf'], 'newest first');
    assert.equal(list.suggestions[0].author.username, 'kat');
    assert.deepEqual(list.counts['new-playable'], { total: 1, done: 0 });
    // Search, category, sort.
    assert.deepEqual((await call('GET', '/admin/suggestions?q=windmill', boss.token)).body.suggestions.map((s) => s.idea), ['Kat Golf']);
    assert.deepEqual((await call('GET', '/admin/suggestions?category=music', boss.token)).body.suggestions.map((s) => s.idea), ['Playlists']);
    assert.deepEqual((await call('GET', '/admin/suggestions?sort=old', boss.token)).body.suggestions.map((s) => s.idea), ['Kat Golf', 'Playlists']);
    assert.deepEqual((await call('GET', '/admin/suggestions?q=kat', boss.token)).body.suggestions.length, 2, 'searches who sent it too');
    // Approve.
    const id = made.body.suggestion.id;
    assert.equal((await call('POST', `/admin/suggestions/${id}/approve`, helper.token)).status, 403);
    assert.equal((await call('POST', `/admin/suggestions/${id}/approve`, boss.token)).body.suggestion.approved, true);
    assert.deepEqual((await call('GET', '/admin/suggestions?status=done', boss.token)).body.suggestions.map((s) => s.idea), ['Kat Golf']);
    assert.equal((await call('GET', '/suggestions/mine', kat.token)).body.suggestions.find((s) => s.id === id).approved, true);
  });
});

describe('Bug reports', () => {
  test('Unlimited users report them; every admin verifies; only the owner searches and sorts', async () => {
    assert.equal((await call('POST', '/bugs', freebie.token, { category: 'circles', description: 'x' })).status, 403);
    assert.equal((await call('POST', '/bugs', kat.token, { description: 'The leaderboard never changes' })).status, 400, 'category required');
    const bug = (await call('POST', '/bugs', kat.token, { category: 'circles', description: 'The leaderboard never changes' })).body.bug;
    await call('POST', '/bugs', kat.token, { category: 'kart', description: 'Karts go through walls' });
    // Any admin can see and verify...
    assert.equal((await call('GET', '/admin/bugs', kat.token)).status, 403);
    const forHelper = (await call('GET', '/admin/bugs?category=kart', helper.token)).body;
    assert.equal(forHelper.canSearch, false);
    assert.equal(forHelper.bugs.length, 2, "admins (not the owner) can't filter");
    const verified = (await call('POST', `/admin/bugs/${bug.id}/verify`, helper.token)).body.bug;
    assert.equal(verified.verified, true);
    assert.equal(verified.author.verified, false, "the bug's check, not the person's");
    // ...the owner can also search and sort.
    const forBoss = (await call('GET', '/admin/bugs?category=kart', boss.token)).body;
    assert.equal(forBoss.canSearch, true);
    assert.deepEqual(forBoss.bugs.map((b) => b.description), ['Karts go through walls']);
    assert.deepEqual((await call('GET', '/admin/bugs?q=leaderboard&status=done', boss.token)).body.bugs.map((b) => b.id), [bug.id]);
    assert.equal((await call('POST', `/admin/bugs/${bug.id}/verify`, boss.token, { verified: false })).body.bug.verified, false, 'and un-verify');
    assert.equal((await call('GET', '/bugs/mine', kat.token)).body.bugs.length, 2);
  });
});

describe('Replies', () => {
  test('admins reply to suggestions and bug reports; the sender sees it and is told', async () => {
    const bug = (await call('POST', '/bugs', kat.token, { category: 'escape', description: 'The cop walks through trains' })).body.bug;
    const idea = (await call('POST', '/suggestions', kat.token, { category: 'reels', idea: 'Duets', does: 'Film next to a friend' })).body.suggestion;
    assert.deepEqual(bug.replies, []);
    assert.equal((await call('POST', `/admin/bugs/${bug.id}/replies`, kat.token, { body: 'Hi' })).status, 403, 'admins only');
    assert.equal((await call('POST', `/admin/bugs/${bug.id}/replies`, helper.token, { body: '   ' })).status, 400);
    notes.length = 0;
    let r = await call('POST', `/admin/bugs/${bug.id}/replies`, helper.token, { body: 'Thanks! Which level?' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.bug.replies.map((x) => [x.from.username, x.body]), [['helper', 'Thanks! Which level?']]);
    r = await call('POST', `/admin/suggestions/${idea.id}/replies`, boss.token, { body: 'Love it, coming soon' });
    assert.equal(r.body.suggestion.replies[0].from.username, 'boss');
    // The sender sees the replies, and was told.
    assert.equal((await call('GET', '/bugs/mine', kat.token)).body.bugs.find((b) => b.id === bug.id).replies[0].body, 'Thanks! Which level?');
    assert.equal((await call('GET', '/suggestions/mine', kat.token)).body.suggestions.find((x) => x.id === idea.id).replies[0].body, 'Love it, coming soon');
    assert.deepEqual(notes.map((n) => n.userId), [kat.id, kat.id]);
    assert.match(notes[0].body, /💬 helper replied to your bug report: Thanks! Which level\?/);
    // And other admins see them in the list.
    assert.equal((await call('GET', '/admin/bugs', boss.token)).body.bugs.find((b) => b.id === bug.id).replies.length, 1);
    assert.equal((await call('POST', '/admin/bugs/9999/replies', helper.token, { body: 'x' })).status, 404);
  });
});

describe('Gem Shop', () => {
  test('the same things for gems (1 gem = 100 bolts), with a Gem Badge; sell back in gems', async () => {
    const u = await register('gemshopper');
    give('gem_rewards', u.id, 200);
    let shop = (await call('GET', '/shop', u.token)).body.shop;
    const item = (id) => shop.items.find((i) => i.id === id);
    assert.deepEqual([item('team-pink').gemPrice, item('unlimited-trial').gemPrice, item('unlimited').gemPrice, item('gem-badge').gemPrice], [5, 25, 100, 50]);
    assert.equal(item('bolt-badge').gemPrice, null, 'the Bolt Badge is bolts only');
    assert.equal(item('gem-badge').price, null, 'the Gem Badge is gems only');
    assert.equal((await call('POST', '/shop/buy', u.token, { item: 'bolt-badge', currency: 'gems' })).status, 404);
    assert.equal((await call('POST', '/shop/buy', u.token, { item: 'gem-badge', currency: 'bolts' })).status, 404);
    shop = (await call('POST', '/shop/buy', u.token, { item: 'gem-badge', currency: 'gems' })).body.shop;
    assert.deepEqual([shop.gems, shop.bolts], [150, 0]);
    assert.equal((await call('GET', '/me', u.token)).body.user.gemBadge, true);
    shop = (await call('POST', '/shop/buy', u.token, { item: 'team-pink', currency: 'gems' })).body.shop;
    assert.ok(shop.teams.includes('pink'));
    assert.deepEqual([item('team-pink').paid, item('team-pink').paidIn], [5, 'gems']);
    assert.equal((await call('POST', '/shop/buy', u.token, { item: 'team-pink', currency: 'bolts' })).status, 409, 'already yours');
    shop = (await call('POST', '/shop/buy', u.token, { item: 'unlimited', currency: 'gems' })).body.shop;
    assert.equal(shop.unlimited, true);
    assert.equal(shop.gems, 45);
    // Sell back: in gems.
    shop = (await call('POST', '/shop/sell', u.token, { item: 'unlimited' })).body.shop;
    assert.deepEqual([shop.gems, shop.bolts, shop.unlimited], [145, 0, false]);
    assert.equal((await call('POST', '/shop/buy', u.token, { item: 'unlimited-trial', currency: 'gems' })).body.shop.gems, 120);
  });
});

describe('Owner notifications', () => {
  test('only the owner gets told about new suggestions and bug reports', async () => {
    notes.length = 0;
    await call('POST', '/bugs', kat.token, { category: 'invaders', description: 'Mice are cats' });
    await call('POST', '/suggestions', kat.token, { category: 'shop', idea: 'Hats', does: 'Hats for cats' });
    assert.deepEqual(notes.map((n) => n.userId), [boss.id, boss.id], 'the owner, not other admins');
    assert.match(notes[0].body, /🐞 kat reported a bug \(🐭 Kat Invaders\)/);
    assert.match(notes[1].body, /💡 kat suggested \(🛒 Bolt & Gem Shop\): Hats/);
    assert.equal(notes[0].view, 'feedback');
  });
});

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

const db = openDatabase(':memory:');
let server;
let base;
before(async () => {
  server = createApp({ db, admins: ['boss'] }).listen(0);
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

// A PNG header with the given size (enough for the server's checks).
function png(width, height, extra = 64) {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
}

let boss, ann, ben, cat;
const me = async (u) => (await call('GET', '/me', { token: u.token })).body;
before(async () => {
  [boss, ann, ben, cat] = [await register('boss'), await register('ann'), await register('ben'), await register('cat')];
  for (const [a, b] of [[ann, ben], [ann, cat], [ann, boss]]) {
    await call('POST', '/friends/request', { token: a.token, body: { username: b.username } });
    await call('POST', `/friends/${a.id}/accept`, { token: b.token });
  }
  await call('POST', '/admin/grant', { token: boss.token, body: { username: 'ann' } });
});

describe('app icons', () => {
  test('Unlimited users pick a built-in icon or upload one; Free users cannot', async () => {
    assert.equal((await call('POST', '/me/app-icon', { token: ben.token, body: { icon: 'crown' } })).status, 403);
    assert.equal((await call('POST', '/me/app-icon', { token: ann.token, body: { icon: 'nope' } })).status, 400);
    const crown = await call('POST', '/me/app-icon', { token: ann.token, body: { icon: 'crown' } });
    assert.equal(crown.body.appIcon.icon, 'crown');
    assert.equal((await me(ann)).plan.appIcon.icon, 'crown');

    assert.equal((await call('POST', '/me/app-icon', { token: ann.token, body: { icon: 'custom' } })).status, 400, 'needs a picture');
    const wrongSize = await call('POST', '/me/app-icon', { token: ann.token, body: { icon: 'custom', icon512: png(100, 100), icon192: png(192, 192) } });
    assert.equal(wrongSize.status, 400);
    const notPng = await call('POST', '/me/app-icon', { token: ann.token, body: { icon: 'custom', icon512: Buffer.from('x'.repeat(80)).toString('base64'), icon192: png(192, 192) } });
    assert.equal(notPng.status, 400);
    const custom = await call('POST', '/me/app-icon', { token: ann.token, body: { icon: 'custom', icon512: png(512, 512), icon192: png(192, 192) } });
    assert.equal(custom.status, 200);
    const id = custom.body.appIcon.customId;
    assert.match(id, /^[A-Za-z0-9_-]{16}$/);
    const img = await fetch(`${base}/api/app-icons/${id}/512.png`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/api/app-icons/${id}/999.png`)).status, 404);
  });

  test('the manifest serves the chosen icon', async () => {
    const plain = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.equal(plain.icons[0].src, 'icons/icon-192.png');
    const glow = await (await fetch(`${base}/manifest.webmanifest?icon=glow`)).json();
    assert.ok(glow.icons.every((i) => i.src.startsWith('icons/alt-glow-')));
    assert.ok(glow.icons.some((i) => i.purpose === 'maskable'));
    const { customId } = (await me(ann)).plan.appIcon;
    const custom = await (await fetch(`${base}/manifest.webmanifest?icon=custom-${customId}`)).json();
    assert.equal(custom.icons[1].src, `api/app-icons/${customId}/512.png`);
    assert.equal(custom.id, plain.id, 'still the same app');
    const unknown = await (await fetch(`${base}/manifest.webmanifest?icon=custom-AAAAAAAAAAAAAAAA`)).json();
    assert.equal(unknown.icons[0].src, 'icons/icon-192.png');
  });
});

describe('custom badge', () => {
  test('upload a badge everyone sees, then reset it to the default', async () => {
    assert.equal((await call('POST', '/me/badge', { token: ben.token, body: { image: png(64, 64) } })).status, 403);
    assert.equal((await call('POST', '/me/badge', { token: ann.token, body: { image: png(1000, 1000) } })).status, 400);
    const up = await call('POST', '/me/badge', { token: ann.token, body: { image: png(96, 64) } });
    assert.match(up.body.badgeUrl, /^badges\/[A-Za-z0-9_-]{16}\.png$/);
    const img = await fetch(`${base}/api/${up.body.badgeUrl}`);
    assert.equal(img.status, 200);
    assert.match(img.headers.get('cache-control'), /immutable/);

    const seenByBen = (await call('GET', '/friends', { token: ben.token })).body.friends.find((f) => f.id === ann.id);
    assert.equal(seenByBen.badge, true);
    assert.equal(seenByBen.badgeUrl, up.body.badgeUrl);

    await call('DELETE', '/me/badge', { token: ann.token });
    const after = (await call('GET', '/friends', { token: ben.token })).body.friends.find((f) => f.id === ann.id);
    assert.equal(after.badge, true, 'still has the default crown');
    assert.equal(after.badgeUrl, null);
    assert.equal((await fetch(`${base}/api/${up.body.badgeUrl}`)).status, 404);
  });
});

describe('BFFs', () => {
  test('heart a friend to pin them to the top of friends and chats', async () => {
    assert.equal((await call('POST', `/bffs/${ann.id}`, { token: ben.token })).status, 403, 'Free users cannot');
    const stranger = await register('dee');
    assert.equal((await call('POST', `/bffs/${stranger.id}`, { token: ann.token })).status, 403, 'friends only');

    // Chats with ben and cat; cat's is newer.
    const benChat = (await call('POST', '/chats/direct', { token: ann.token, body: { userId: ben.id } })).body.chat;
    const catChat = (await call('POST', '/chats/direct', { token: ann.token, body: { userId: cat.id } })).body.chat;
    db.prepare('UPDATE chats SET last_message_at = ? WHERE id = ?').run(1000, benChat.id);
    db.prepare('UPDATE chats SET last_message_at = ? WHERE id = ?').run(2000, catChat.id);
    let chats = (await call('GET', '/chats', { token: ann.token })).body.chats;
    assert.equal(chats[0].id, catChat.id);

    assert.equal((await call('POST', `/bffs/${ben.id}`, { token: ann.token })).status, 200);
    const friends = (await call('GET', '/friends', { token: ann.token })).body.friends;
    assert.equal(friends[0].username, 'ben');
    assert.equal(friends[0].bff, true);
    chats = (await call('GET', '/chats', { token: ann.token })).body.chats;
    assert.equal(chats[0].id, benChat.id);
    assert.equal(chats[0].bff, true);

    // BFFs are private: ben doesn't see ann marked as his BFF.
    assert.ok(!(await call('GET', '/friends', { token: ben.token })).body.friends.some((f) => f.bff));

    await call('DELETE', `/bffs/${ben.id}`, { token: ann.token });
    assert.equal((await call('GET', '/friends', { token: ann.token })).body.friends.find((f) => f.id === ben.id).bff, false);

    // Unfriending removes the heart.
    await call('POST', `/bffs/${cat.id}`, { token: ann.token });
    await call('DELETE', `/friends/${cat.id}`, { token: ann.token });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bffs WHERE friend_id = ?').get(cat.id).n, 0);
  });
});

describe('admin reset of badges and icons', () => {
  const setUp = async () => {
    await call('POST', '/me/badge', { token: ann.token, body: { image: png(64, 64) } });
    await call('POST', '/me/app-icon', { token: ann.token, body: { icon: 'custom', icon512: png(512, 512), icon192: png(192, 192) } });
    return (await me(ann)).plan;
  };
  const reset = (body, token = boss.token) => call('POST', '/admin/reset-customization', { token, body });

  test('only admins can reset', async () => {
    assert.equal((await reset({ username: 'ann', badge: true }, ben.token)).status, 403);
    assert.equal((await reset({ username: 'nobody', badge: true })).status, 404);
    assert.equal((await reset({ username: 'ann' })).status, 400, 'must choose something');
  });

  test('reset just the badge, just the icon, or both', async () => {
    let plan = await setUp();
    const badgeUrl = (await me(ann)).user.badgeUrl;
    const iconId = plan.appIcon.customId;

    let res = await reset({ username: 'ANN', badge: true });
    assert.deepEqual(res.body.reset, ['badge']);
    plan = (await me(ann)).plan;
    assert.equal(plan.customBadge, false);
    assert.equal(plan.appIcon.icon, 'custom', 'icon untouched');
    assert.equal((await fetch(`${base}/api/${badgeUrl}`)).status, 404, 'picture deleted');

    res = await reset({ username: 'ann', icon: true });
    assert.deepEqual(res.body.reset, ['icon']);
    plan = (await me(ann)).plan;
    assert.equal(plan.appIcon.icon, 'default');
    assert.equal(plan.appIcon.customId, null);
    assert.equal((await fetch(`${base}/api/app-icons/${iconId}/512.png`)).status, 404);

    await setUp();
    res = await reset({ username: 'ann', badge: true, icon: true });
    assert.deepEqual(res.body.reset, ['badge', 'icon']);
    plan = (await me(ann)).plan;
    assert.equal(plan.customBadge, false);
    assert.equal(plan.appIcon.icon, 'default');

    res = await reset({ username: 'ann', badge: true, icon: true });
    assert.deepEqual(res.body.reset, [], 'nothing left to reset');
  });
});

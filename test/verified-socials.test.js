import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { socialLink } from '../server/socials.js';
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

let boss, ann, ben;
before(async () => {
  [boss, ann, ben] = [await register('boss'), await register('ann'), await register('ben')];
  await call('POST', '/admin/admins', { token: boss.token, body: { username: 'ben' } }); // ben: admin, not owner
});

describe('verified badges (owner only)', () => {
  test('only the owner verifies accounts; everyone sees ✔', async () => {
    assert.equal((await call('POST', '/admin/verified', { token: ann.token, body: { username: 'ann' } })).status, 403);
    assert.equal((await call('POST', '/admin/verified', { token: ben.token, body: { username: 'ann' } })).status, 403, 'other admins cannot');
    assert.equal((await call('POST', '/admin/verified', { token: boss.token, body: { username: 'nobody' } })).status, 404);
    const res = await call('POST', '/admin/verified', { token: boss.token, body: { username: 'Ann' } });
    assert.equal(res.body.user.verified, true);
    assert.equal((await call('POST', '/admin/verified', { token: boss.token, body: { username: 'ann' } })).status, 409);
    assert.equal((await call('GET', `/users/${ann.id}`, { token: ben.token })).body.user.verified, true);
    assert.equal((await call('GET', `/users/${ben.id}`, { token: ann.token })).body.user.verified, false);
    assert.deepEqual((await call('GET', '/admin/verified', { token: boss.token })).body.users.map((u) => u.username), ['ann']);
    assert.equal((await call('GET', '/admin/verified', { token: ben.token })).status, 403);
    assert.equal((await call('DELETE', '/admin/verified/ann', { token: ben.token })).status, 403);
    assert.equal((await call('DELETE', '/admin/verified/ann', { token: boss.token })).status, 200);
    assert.equal((await call('GET', `/users/${ann.id}`, { token: ben.token })).body.user.verified, false);
  });
});

describe('social media links', () => {
  test('handles and links become clean links to that site only', () => {
    assert.equal(socialLink('youtube', '@KoolKat'), 'https://www.youtube.com/@KoolKat');
    assert.equal(socialLink('linktree', 'linktr.ee/koolkat'), 'https://linktr.ee/koolkat');
    assert.equal(socialLink('linktree', '@koolkat'), 'https://linktr.ee/koolkat');
    assert.equal(socialLink('youtube', 'https://m.youtube.com/channel/UC123abc/'), 'https://www.youtube.com/channel/UC123abc');
    assert.equal(socialLink('instagram', 'kool.kat_'), 'https://www.instagram.com/kool.kat_');
    assert.equal(socialLink('instagram', 'instagram.com/koolkat?igsh=abc'), 'https://www.instagram.com/koolkat');
    assert.equal(socialLink('tiktok', 'koolkat'), 'https://www.tiktok.com/@koolkat');
    assert.equal(socialLink('facebook', 'https://www.facebook.com/profile.php?id=10001234'), 'https://www.facebook.com/profile.php?id=10001234');
    assert.equal(socialLink('x', 'https://twitter.com/koolkat'), 'https://x.com/koolkat');
    assert.equal(socialLink('x', ''), null);
    assert.throws(() => socialLink('instagram', 'https://evil.example/koolkat'));
    assert.throws(() => socialLink('instagram', 'javascript:alert(1)'));
    assert.throws(() => socialLink('tiktok', 'two words'));
    assert.throws(() => socialLink('youtube', 'https://www.youtube.com.evil.example/@x'));
  });

  test('anyone saves theirs; they show on their profile', async () => {
    assert.equal((await call('POST', '/me/socials', { token: ann.token, body: { instagram: 'https://evil.example/x' } })).status, 400);
    let res = await call('POST', '/me/socials', { token: ann.token, body: { youtube: '@annvids', instagram: 'ann.pics', x: 'twitter.com/ann' } });
    assert.deepEqual(res.body.socials, { youtube: 'https://www.youtube.com/@annvids', instagram: 'https://www.instagram.com/ann.pics', x: 'https://x.com/ann' });
    res = await call('POST', '/me/socials', { token: ann.token, body: { x: '', tiktok: 'anntok' } });
    assert.deepEqual(Object.keys(res.body.socials).sort(), ['instagram', 'tiktok', 'youtube'], 'only the sent ones change');
    assert.equal((await call('GET', `/users/${ann.id}`, { token: ben.token })).body.user.socials.tiktok, 'https://www.tiktok.com/@anntok');
    assert.deepEqual((await call('GET', '/me', { token: ann.token })).body.plan.socials, res.body.socials);
  });
});

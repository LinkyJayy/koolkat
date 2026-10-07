import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { isBirthday } from '../server/plans.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

const db = openDatabase(':memory:');
let now = Date.UTC(2026, 9, 7, 12, 0); // 7 October 2026, noon UTC
let server, base;
const start = async () => {
  server = createApp({ db, admins: ['boss'], clock: () => now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
};
before(start);
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
const me = async (u) => (await call('GET', '/me', { token: u.token })).body;

let boss, ann, ben;
before(async () => {
  [boss, ann, ben] = [await register('boss'), await register('ann'), await register('ben')];
});

describe('making admins (owner only)', () => {
  test('only the owner sees and manages admins', async () => {
    assert.equal((await me(boss)).plan.isOwner, true);
    assert.equal((await me(ann)).plan.isOwner, false);
    assert.equal((await call('GET', '/admin/admins', { token: ann.token })).status, 403);
    const list = (await call('GET', '/admin/admins', { token: boss.token })).body.admins;
    assert.deepEqual(list.map((a) => [a.username, a.owner]), [['boss', true]]);
  });

  test('a new admin gets admin tools and Unlimited, but cannot make admins', async () => {
    assert.equal((await call('POST', '/admin/admins', { token: boss.token, body: { username: 'nobody' } })).status, 404);
    const res = await call('POST', '/admin/admins', { token: boss.token, body: { username: 'ANN' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.admin.username, 'ann');
    assert.equal((await call('POST', '/admin/admins', { token: boss.token, body: { username: 'ann' } })).status, 409);
    const plan = (await me(ann)).plan;
    assert.equal(plan.isAdmin, true);
    assert.equal(plan.isOwner, false);
    assert.equal(plan.plan, 'unlimited');
    assert.equal((await call('POST', '/news', { token: ann.token, body: { title: 'From ann' } })).status, 201, 'can post News');
    assert.equal((await call('POST', '/admin/admins', { token: ann.token, body: { username: 'ben' } })).status, 403, 'only the owner');
    assert.equal((await call('DELETE', '/admin/admins/boss', { token: ann.token })).status, 403);
    assert.equal((await call('DELETE', '/admin/admins/boss', { token: boss.token })).status, 403, "the owner can't be removed");
  });

  test('admins added stay admins after a restart, until removed', async () => {
    server.close();
    await start();
    assert.equal((await me(ann)).plan.isAdmin, true);
    assert.equal((await call('DELETE', '/admin/admins/ann', { token: boss.token })).status, 200);
    assert.equal((await me(ann)).plan.isAdmin, false);
    assert.equal((await call('POST', '/news', { token: ann.token, body: { title: 'nope' } })).status, 403);
    assert.equal((await call('DELETE', '/admin/admins/ann', { token: boss.token })).status, 404);
  });
});

describe('birthdays', () => {
  test('asked once (month and day only), and 🎉 shows on the day', async () => {
    assert.equal((await me(ben)).plan.birthdayAsked, false);
    assert.equal((await call('POST', '/me/birthday', { token: ben.token, body: { month: 2, day: 30 } })).status, 400);
    assert.equal((await call('POST', '/me/birthday', { token: ben.token, body: { month: 13, day: 1 } })).status, 400);
    const set = await call('POST', '/me/birthday', { token: ben.token, body: { month: 10, day: 7, timeZone: 'America/New_York', year: 1990 } });
    assert.deepEqual(set.body.birthday, { month: 10, day: 7 });
    const plan = (await me(ben)).plan;
    assert.equal(plan.birthdayAsked, true);
    assert.deepEqual(plan.birthday, { month: 10, day: 7 });
    assert.equal(db.prepare("SELECT * FROM users WHERE username = 'ben'").get().birth_year, undefined, 'no year is stored');
    // Others only see the 🎉, not the date.
    const seen = (await call('GET', `/users/${ben.id}`, { token: ann.token })).body.user;
    assert.equal(seen.birthday, true);
    assert.equal(seen.birthMonth, undefined);
    now += 24 * 60 * 60 * 1000;
    assert.equal((await call('GET', `/users/${ben.id}`, { token: ann.token })).body.user.birthday, false);
    now -= 24 * 60 * 60 * 1000;
  });

  test('skipping counts as asked; it can be removed later', async () => {
    await call('POST', '/me/birthday', { token: ann.token, body: { skip: true } });
    assert.equal((await me(ann)).plan.birthdayAsked, true);
    assert.equal((await me(ann)).plan.birthday, null);
    await call('DELETE', '/me/birthday', { token: ben.token });
    assert.equal((await me(ben)).plan.birthday, null);
  });

  test('time zones and 29 February', () => {
    const at = (iso) => Date.parse(iso);
    const ny = { birth_month: 10, birth_day: 7, birth_tz: 'America/New_York' };
    assert.equal(isBirthday(ny, at('2026-10-07T03:00:00Z')), false, 'still the 6th in New York');
    assert.equal(isBirthday(ny, at('2026-10-07T05:00:00Z')), true);
    const leap = { birth_month: 2, birth_day: 29, birth_tz: 'UTC' };
    assert.equal(isBirthday(leap, at('2027-02-28T12:00:00Z')), true, 'celebrated on the 28th in other years');
    assert.equal(isBirthday(leap, at('2028-02-28T12:00:00Z')), false);
    assert.equal(isBirthday(leap, at('2028-02-29T12:00:00Z')), true);
    assert.equal(isBirthday({}, Date.now()), false);
  });
});

describe('News polls and comments', () => {
  test('admins add polls; anyone votes once and can change their vote', async () => {
    assert.equal((await call('POST', '/news', { token: boss.token, body: { title: 'Poll', poll: { options: ['Only one'] } } })).status, 400);
    assert.equal((await call('POST', '/news', { token: boss.token, body: { title: 'Poll', poll: { options: ['a', 'A'] } } })).status, 400);
    const post = (await call('POST', '/news', { token: boss.token, body: { title: 'Best feature?', poll: { question: 'Pick one', options: ['Calls', 'KatCam', 'Kat Map'] } } })).body.post;
    assert.deepEqual(post.poll.options.map((o) => o.text), ['Calls', 'KatCam', 'Kat Map']);
    assert.equal(post.poll.question, 'Pick one');
    assert.equal((await call('POST', `/news/${post.id}/vote`, { token: ann.token, body: { choice: 5 } })).status, 400);
    let poll = (await call('POST', `/news/${post.id}/vote`, { token: ann.token, body: { choice: 0 } })).body.poll;
    assert.equal(poll.myVote, 0);
    poll = (await call('POST', `/news/${post.id}/vote`, { token: ben.token, body: { choice: 0 } })).body.poll;
    poll = (await call('POST', `/news/${post.id}/vote`, { token: ann.token, body: { choice: 2 } })).body.poll;
    assert.deepEqual(poll.options.map((o) => o.votes), [1, 0, 1], 'changed vote');
    assert.equal(poll.total, 2);
    const seen = (await call('GET', '/news', { token: ben.token })).body.posts.find((p) => p.id === post.id);
    assert.equal(seen.poll.myVote, 0);
    poll = (await call('DELETE', `/news/${post.id}/vote`, { token: ben.token })).body.poll;
    assert.equal(poll.total, 1);
    assert.equal(poll.myVote, null);

    // Editing the text keeps votes; changing options restarts the vote; null removes it.
    let edited = (await call('POST', `/news/${post.id}`, { token: boss.token, body: { title: 'Best feature??' } })).body.post;
    assert.equal(edited.poll.total, 1);
    edited = (await call('POST', `/news/${post.id}`, { token: boss.token, body: { title: 'x', poll: { options: ['Calls', 'FaceTime'] } } })).body.post;
    assert.equal(edited.poll.total, 0);
    edited = (await call('POST', `/news/${post.id}`, { token: boss.token, body: { title: 'x', poll: null } })).body.post;
    assert.equal(edited.poll, null);
    assert.equal((await call('POST', `/news/${post.id}/vote`, { token: ann.token, body: { choice: 0 } })).status, 404);
  });

  test('anyone comments; you or an admin can delete it', async () => {
    const post = (await call('POST', '/news', { token: boss.token, body: { title: 'Say hi' } })).body.post;
    assert.equal((await call('POST', `/news/${post.id}/comments`, { token: ann.token, body: { body: '   ' } })).status, 400);
    const c1 = (await call('POST', `/news/${post.id}/comments`, { token: ann.token, body: { body: 'Hi everyone 👋' } })).body.comment;
    assert.equal(c1.author.username, 'ann');
    assert.equal(c1.mine, true);
    const c2 = (await call('POST', `/news/${post.id}/comments`, { token: ben.token, body: { body: 'hey' } })).body.comment;
    const list = (await call('GET', `/news/${post.id}/comments`, { token: ann.token })).body.comments;
    assert.deepEqual(list.map((c) => [c.body, c.canDelete]), [['Hi everyone 👋', true], ['hey', false]]);
    assert.equal((await call('GET', '/news', { token: ann.token })).body.posts.find((p) => p.id === post.id).comments, 2);
    assert.equal((await call('DELETE', `/news/comments/${c2.id}`, { token: ann.token })).status, 403);
    assert.equal((await call('DELETE', `/news/comments/${c2.id}`, { token: boss.token })).status, 200, 'admins moderate');
    assert.equal((await call('DELETE', `/news/comments/${c1.id}`, { token: ann.token })).status, 200);
    assert.deepEqual((await call('GET', `/news/${post.id}/comments`, { token: ann.token })).body.comments, []);
  });

  test('comment spam is slowed down', async () => {
    const post = (await call('POST', '/news', { token: boss.token, body: { title: 'Spam test' } })).body.post;
    const results = [];
    for (let i = 0; i < 12; i++) results.push((await call('POST', `/news/${post.id}/comments`, { token: ben.token, body: { body: `c${i}` } })).status);
    assert.ok(results.includes(429));
  });
});

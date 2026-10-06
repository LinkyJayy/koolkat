import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDatabasePath, openDatabase } from '../server/db.js';
import { INBOX_PAGE_SIZE, cleanup, createApp } from '../server/app.js';
import { DAY_MS, dayNumber } from '../server/streaks.js';
import { createPusher } from '../server/push.js';
import { DEFAULT_FLAIR, FREE_STORAGE, UNLIMITED_STORAGE } from '../server/plans.js';
import {
  createIdentity,
  decryptSnap,
  deriveKeysFromPassword,
  decryptMessage,
  encryptMessage,
  encryptSnap,
  unlockIdentity,
} from '../public/js/crypto.js';

// A controllable clock so streak behaviour can be tested across days.
let now = Date.UTC(2026, 0, 10, 12);
const clock = () => now;

const db = openDatabase(':memory:');
let server;
let base;
let origin;

// Push notifications are captured here instead of going to a real push service.
const pushes = [];
let pushFailure = null;
const pusher = createPusher({
  db,
  clock,
  send: async (sub, payload) => {
    if (pushFailure) throw pushFailure;
    pushes.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
  },
});
const flush = () => new Promise((r) => setTimeout(r, 20));
const PAGES_ORIGIN = 'https://linkyjayy.github.io';

before(async () => {
  server = createApp({ db, clock, serveStatic: false, pusher, allowedOrigins: [PAGES_ORIGIN] }).listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  base = `${origin}/api`;
});
after(() => server.close());

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const ITER = 1000; // fast for tests; the app uses the default 600k
async function register(username, password = 'correct horse battery') {
  const { authSecret, vaultKey } = await deriveKeysFromPassword(username, password, ITER);
  const id = await createIdentity(vaultKey);
  const res = await call('POST', '/auth/register', {
    body: {
      username,
      displayName: username.toUpperCase(),
      authSecret,
      publicKey: id.publicKey,
      encryptedPrivateKey: id.encryptedPrivateKey,
      privateKeyIv: id.privateKeyIv,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { ...res.body.user, token: res.body.token, privateKey: id.privateKey, publicKey: id.publicKey, password };
}

async function befriend(a, b) {
  assert.equal((await call('POST', '/friends/request', { token: a.token, body: { username: b.username } })).status, 201);
  assert.equal((await call('POST', `/friends/${a.id}/accept`, { token: b.token })).status, 200);
}

async function sendSnap(from, to, caption = 'hi') {
  const friends = (await call('GET', '/friends', { token: from.token })).body.friends;
  const recipients = to.map((t) => {
    const f = friends.find((x) => x.id === t.id);
    return { userId: t.id, publicKey: f ? f.publicKey : t.publicKey };
  });
  const image = new Uint8Array(2048).map((_, i) => i % 251);
  const payload = await encryptSnap(image, { caption, captionY: 0.3 }, recipients, {
    userId: from.id,
    publicKey: from.publicKey,
  });
  return call('POST', '/snaps', { token: from.token, body: payload });
}

test('health check', async () => {
  const { body } = await call('GET', '/health');
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
});

test('database path prefers KOOLKAT_DB, then a Railway volume', () => {
  assert.equal(defaultDatabasePath({ KOOLKAT_DB: '/x/a.db', RAILWAY_VOLUME_MOUNT_PATH: '/data' }), '/x/a.db');
  assert.equal(defaultDatabasePath({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }), '/data/koolkat.db');
  assert.equal(defaultDatabasePath({}), 'data/koolkat.db');
});

describe('accounts', () => {
  let alice;
  before(async () => {
    alice = await register('alice');
  });

  test('rejects duplicate usernames case-insensitively', async () => {
    const { authSecret, vaultKey } = await deriveKeysFromPassword('ALICE', 'x', ITER);
    const id = await createIdentity(vaultKey);
    const res = await call('POST', '/auth/register', {
      body: { username: 'ALICE', displayName: 'A', authSecret, ...id, privateKey: undefined },
    });
    assert.equal(res.status, 409);
  });

  test('rejects malformed public keys', async () => {
    const res = await call('POST', '/auth/register', {
      body: {
        username: 'mallory',
        displayName: 'M',
        authSecret: 'a'.repeat(64),
        publicKey: btoa('not a key'),
        encryptedPrivateKey: btoa('x'.repeat(100)),
        privateKeyIv: btoa('x'.repeat(12)),
      },
    });
    assert.equal(res.status, 400);
  });

  test('login returns the encrypted private key, which only the password unlocks', async () => {
    const good = await deriveKeysFromPassword('alice', alice.password, ITER);
    const res = await call('POST', '/auth/login', { body: { username: 'alice', authSecret: good.authSecret } });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    await unlockIdentity(good.vaultKey, res.body.encryptedPrivateKey, res.body.privateKeyIv);

    const bad = await deriveKeysFromPassword('alice', 'wrong password', ITER);
    const wrong = await call('POST', '/auth/login', { body: { username: 'alice', authSecret: bad.authSecret } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, 'Wrong password');
    const missing = await call('POST', '/auth/login', { body: { username: 'nobody', authSecret: bad.authSecret } });
    assert.equal(missing.status, 401);
    assert.match(missing.body.error, /no account/);
    await assert.rejects(unlockIdentity(bad.vaultKey, res.body.encryptedPrivateKey, res.body.privateKeyIv));
  });

  test('protected routes need a valid token and logout revokes it', async () => {
    assert.equal((await call('GET', '/me')).status, 401);
    const login = await call('POST', '/auth/login', {
      body: { username: 'alice', authSecret: (await deriveKeysFromPassword('alice', alice.password, ITER)).authSecret },
    });
    const token = login.body.token;
    assert.equal((await call('GET', '/me', { token })).status, 200);
    await call('POST', '/auth/logout', { token });
    assert.equal((await call('GET', '/me', { token })).status, 401);
  });
});

describe('friends and snaps', () => {
  let bob, carol, dave;
  before(async () => {
    [bob, carol, dave] = [await register('bob'), await register('carol'), await register('dave')];
  });

  test('friend requests can be sent, seen and accepted', async () => {
    await call('POST', '/friends/request', { token: bob.token, body: { username: 'carol' } });
    let carolView = (await call('GET', '/friends', { token: carol.token })).body;
    assert.deepEqual(carolView.incoming.map((u) => u.username), ['bob']);
    const search = (await call('GET', '/users/search?q=bo', { token: carol.token })).body.users;
    assert.equal(search.find((u) => u.username === 'bob').relationship, 'incoming');

    // Adding someone who already added you accepts the request.
    const res = await call('POST', '/friends/request', { token: carol.token, body: { username: 'bob' } });
    assert.equal(res.body.status, 'accepted');
    carolView = (await call('GET', '/friends', { token: carol.token })).body;
    assert.deepEqual(carolView.friends.map((u) => u.username), ['bob']);
    assert.ok(carolView.friends[0].publicKey);
  });

  test('snaps can only be sent to friends', async () => {
    const res = await sendSnap(bob, [dave]);
    assert.equal(res.status, 403);
  });

  test('a snap is end-to-end encrypted, kept after viewing, and only for its recipient', async () => {
    const sent = await sendSnap(bob, [carol], 'look at this cat 🐱');
    assert.equal(sent.status, 201);

    // The server stores ciphertext only: the caption is nowhere in the database.
    const row = db.prepare('SELECT ciphertext FROM snaps WHERE id = ?').get(sent.body.id);
    assert.ok(!Buffer.from(row.ciphertext).toString('utf8').includes('look at this cat'));

    // Non-recipients can't fetch it.
    assert.equal((await call('GET', `/snaps/${sent.body.id}`, { token: dave.token })).status, 404);

    const inbox = (await call('GET', '/snaps/inbox', { token: carol.token })).body.snaps;
    assert.equal(inbox[0].from.username, 'bob');
    assert.equal(inbox[0].opened, false);

    const snap = (await call('GET', `/snaps/${sent.body.id}`, { token: carol.token })).body;
    const opened = await decryptSnap(snap, carol.privateKey, carol.id);
    assert.equal(opened.caption, 'look at this cat 🐱');
    assert.equal(opened.captionY, 0.3);
    assert.equal(opened.imageBytes.length, 2048);
    assert.equal(opened.imageBytes[300], 300 % 251);

    // Another user's private key can't decrypt it.
    await assert.rejects(decryptSnap(snap, dave.privateKey, carol.id));

    await call('POST', `/snaps/${sent.body.id}/viewed`, { token: carol.token });
    // Still there after viewing, and still decryptable by carol only.
    const again = await call('GET', `/snaps/${sent.body.id}`, { token: carol.token });
    assert.equal(again.status, 200);
    assert.equal((await decryptSnap(again.body, carol.privateKey, carol.id)).caption, 'look at this cat 🐱');
    assert.equal((await call('GET', `/snaps/${sent.body.id}`, { token: dave.token })).status, 404);
    const after = (await call('GET', '/snaps/inbox', { token: carol.token })).body.snaps[0];
    assert.equal(after.opened, true);
    assert.equal(after.available, true);

    const sentList = (await call('GET', '/snaps/sent', { token: bob.token })).body.snaps;
    assert.equal(sentList.find((s) => s.id === sent.body.id).recipients[0].opened, true);
  });

  test('unfriending hides saved snaps; becoming friends again shows them', async () => {
    await befriend(bob, dave);
    const sent = await sendSnap(bob, [dave]);
    await call('DELETE', `/friends/${bob.id}`, { token: dave.token });
    assert.equal((await call('GET', `/snaps/${sent.body.id}`, { token: dave.token })).status, 403);
    assert.equal((await call('GET', '/snaps/inbox', { token: dave.token })).body.snaps.length, 0);
    await befriend(bob, dave);
    assert.equal((await call('GET', `/snaps/${sent.body.id}`, { token: dave.token })).status, 200);
  });

  test('a recipient can delete their copy; the data goes once nobody has it', async () => {
    const sent = await sendSnap(bob, [carol, dave]);
    const id = sent.body.id;
    assert.equal((await call('DELETE', `/snaps/${id}`, { token: carol.token })).status, 200);
    assert.equal((await call('GET', `/snaps/${id}`, { token: carol.token })).status, 404);
    assert.equal((await call('GET', `/snaps/${id}`, { token: dave.token })).status, 200, "dave's copy stays");
    await call('DELETE', `/snaps/${id}`, { token: dave.token });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM snaps WHERE id = ?').get(id).n, 0);
  });

  test('the inbox is paged, newest first', async () => {
    for (let i = 0; i < INBOX_PAGE_SIZE + 3; i++) {
      now += 1000;
      await sendSnap(bob, [carol], `n${i}`);
    }
    const first = (await call('GET', '/snaps/inbox', { token: carol.token })).body;
    assert.equal(first.snaps.length, INBOX_PAGE_SIZE);
    assert.equal(first.hasMore, true);
    const next = (await call('GET', `/snaps/inbox?before=${first.snaps.at(-1).createdAt}`, { token: carol.token })).body;
    assert.ok(next.snaps.length >= 3);
    assert.ok(next.snaps.every((s) => s.createdAt < first.snaps.at(-1).createdAt));
    assert.equal(new Set([...first.snaps, ...next.snaps].map((s) => s.id)).size, first.snaps.length + next.snaps.length);
  });
});

describe('streaks', () => {
  let erin, frank;
  const streakFor = async (user, otherId) =>
    (await call('GET', '/friends', { token: user.token })).body.friends.find((f) => f.id === otherId).streak;

  before(async () => {
    [erin, frank] = [await register('erin'), await register('frank')];
    await befriend(erin, frank);
  });

  test('a streak needs both friends to snap each other each day', async () => {
    await sendSnap(erin, [frank]);
    let s = await streakFor(erin, frank.id);
    assert.equal(s.count, 0);
    assert.equal(s.youNeedToSnap, false);
    assert.equal(s.theyNeedToSnap, true);

    await sendSnap(frank, [erin]);
    assert.equal((await streakFor(erin, frank.id)).count, 1);
    // Extra snaps the same day don't add to it.
    await sendSnap(frank, [erin]);
    assert.equal((await streakFor(frank, erin.id)).count, 1);

    now += DAY_MS;
    s = await streakFor(erin, frank.id);
    assert.equal(s.count, 1);
    assert.equal(s.expiring, true);
    await sendSnap(erin, [frank]);
    await sendSnap(frank, [erin]);
    s = await streakFor(erin, frank.id);
    assert.equal(s.count, 2);
    assert.equal(s.expiring, false);
  });

  test('missing a whole day resets the streak', async () => {
    now += 2 * DAY_MS;
    assert.equal((await streakFor(erin, frank.id)).count, 0);
    await sendSnap(erin, [frank]);
    await sendSnap(frank, [erin]);
    assert.equal((await streakFor(erin, frank.id)).count, 1);
  });
});

const subscription = (name) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') },
});

describe('push notifications', () => {
  let gina, hank;
  before(async () => {
    [gina, hank] = [await register('gina'), await register('hank')];
  });

  test('exposes the VAPID public key', async () => {
    const { body } = await call('GET', '/push/key');
    assert.equal(body.publicKey, pusher.publicKey);
  });

  test('only accepts subscriptions from real push services', async () => {
    const bad = { ...subscription('x'), endpoint: 'https://evil.example.com/hook' };
    assert.equal((await call('POST', '/push/subscribe', { token: gina.token, body: bad })).status, 400);
    const http = { ...subscription('x'), endpoint: 'http://fcm.googleapis.com/x' };
    assert.equal((await call('POST', '/push/subscribe', { token: gina.token, body: http })).status, 400);
    assert.equal((await call('POST', '/push/subscribe', { body: subscription('x') })).status, 401);
  });

  test('notifies about friend requests, acceptances and snaps without revealing contents', async () => {
    for (const [u, name] of [[gina, 'gina'], [hank, 'hank']]) {
      assert.equal((await call('POST', '/push/subscribe', { token: u.token, body: subscription(name) })).status, 200);
    }
    pushes.length = 0;
    await call('POST', '/friends/request', { token: gina.token, body: { username: 'hank' } });
    await flush();
    assert.deepEqual(pushes.map((p) => [p.endpoint.split('/').pop(), p.view]), [['hank', 'friends']]);
    assert.match(pushes[0].body, /GINA/);

    pushes.length = 0;
    await call('POST', `/friends/${gina.id}/accept`, { token: hank.token });
    await flush();
    assert.deepEqual(pushes.map((p) => p.endpoint.split('/').pop()), ['gina']);
    assert.match(pushes[0].body, /accepted/);

    pushes.length = 0;
    await sendSnap(gina, [hank], 'top secret caption');
    await flush();
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].view, 'inbox');
    assert.match(pushes[0].body, /GINA sent you a Klick/);
    assert.ok(!JSON.stringify(pushes).includes('top secret'));
  });

  test('expired subscriptions are removed', async () => {
    pushFailure = Object.assign(new Error('gone'), { statusCode: 410 });
    await pusher.notify(hank.id, { body: 'x' });
    pushFailure = null;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(hank.id).n, 0);
    await call('POST', '/push/subscribe', { token: hank.token, body: subscription('hank') });
  });

  test('unsubscribing stops notifications', async () => {
    await call('POST', '/push/unsubscribe', { token: gina.token, body: { endpoint: subscription('gina').endpoint } });
    pushes.length = 0;
    await pusher.notify(gina.id, { body: 'x' });
    assert.equal(pushes.length, 0);
    await call('POST', '/push/subscribe', { token: gina.token, body: subscription('gina') });
  });

  test('streak reminders go out near the end of the day, once', async () => {
    // Keep a streak today (gina already snapped hank above)...
    await sendSnap(hank, [gina]);
    // ...then come back late tomorrow without having snapped.
    const tomorrow = dayNumber(now) + 1;
    now = tomorrow * DAY_MS + 12 * 60 * 60 * 1000;
    pushes.length = 0;
    assert.equal(await pusher.runStreakReminders(), 0, 'too early in the day');

    now = tomorrow * DAY_MS + 21 * 60 * 60 * 1000;
    await sendSnap(gina, [hank]); // gina keeps her side, so only hank is reminded
    await flush();
    pushes.length = 0;
    await pusher.runStreakReminders();
    // (Streaks from earlier tests are expiring too; only look at gina & hank.)
    const ours = pushes.filter((p) => /\/(gina|hank)$/.test(p.endpoint));
    assert.equal(ours.length, 1);
    assert.equal(ours[0].endpoint.split('/').pop(), 'hank');
    assert.match(ours[0].title, /streak/);
    assert.match(ours[0].body, /GINA.*3 hours/);
    assert.equal(await pusher.runStreakReminders(), 0, 'only once per day');
  });
});

describe('cross-origin access (GitHub Pages)', () => {
  test('allows the configured origin', async () => {
    const res = await fetch(`${base}/friends`, {
      method: 'OPTIONS',
      headers: { origin: PAGES_ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), PAGES_ORIGIN);
    assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
  });

  test('ignores other origins', async () => {
    const res = await fetch(`${base}/push/key`, { headers: { origin: 'https://evil.example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

describe('senders can view their own snaps', () => {
  let ivy, jack;
  before(async () => {
    [ivy, jack] = [await register('ivy'), await register('jack')];
    await befriend(ivy, jack);
  });

  test('the sender can open and decrypt what they sent', async () => {
    const sent = await sendSnap(ivy, [jack], 'my own snap');
    const own = await call('GET', `/snaps/${sent.body.id}`, { token: ivy.token });
    assert.equal(own.status, 200);
    assert.equal(own.body.own, true);
    assert.deepEqual(own.body.to.map((u) => u.username), ['jack']);
    assert.equal((await decryptSnap(own.body, ivy.privateKey, ivy.id)).caption, 'my own snap');
    const sentList = (await call('GET', '/snaps/sent', { token: ivy.token })).body.snaps;
    assert.equal(sentList.find((s) => s.id === sent.body.id).viewable, true);
  });

  test('deleting as the sender removes it for everyone', async () => {
    const sent = await sendSnap(ivy, [jack]);
    const res = await call('DELETE', `/snaps/${sent.body.id}`, { token: ivy.token });
    assert.equal(res.body.deletedForEveryone, true);
    assert.equal((await call('GET', `/snaps/${sent.body.id}`, { token: jack.token })).status, 404);
  });
});

describe('favorites', () => {
  let nia, omar, pia;
  before(async () => {
    [nia, omar, pia] = [await register('nia'), await register('omar'), await register('pia')];
    await befriend(nia, omar);
  });

  test('star received and sent Klicks, list them, unstar', async () => {
    const got = (await sendSnap(omar, [nia], 'fav me')).body.id;
    const mine = (await sendSnap(nia, [omar], 'my fav')).body.id;
    assert.equal((await call('POST', `/snaps/${got}/favorite`, { token: nia.token })).status, 200);
    assert.equal((await call('POST', `/snaps/${mine}/favorite`, { token: nia.token })).status, 200);
    assert.equal((await call('POST', `/snaps/${got}/favorite`, { token: pia.token })).status, 404, 'not theirs');

    const favs = (await call('GET', '/favorites', { token: nia.token })).body.favorites;
    assert.deepEqual(favs.map((f) => [f.id, f.own]).sort(), [[got, false], [mine, true]].sort());
    const inbox = (await call('GET', '/snaps/inbox', { token: nia.token })).body.snaps;
    assert.equal(inbox.find((x) => x.id === got).favorite, true);
    assert.equal((await call('GET', `/snaps/${got}`, { token: nia.token })).body.favorite, true);

    await call('DELETE', `/snaps/${got}/favorite`, { token: nia.token });
    assert.deepEqual((await call('GET', '/favorites', { token: nia.token })).body.favorites.map((f) => f.id), [mine]);
  });

  test('favorites from ex-friends are hidden, and go when the Klick is deleted', async () => {
    const got = (await sendSnap(omar, [nia])).body.id;
    await call('POST', `/snaps/${got}/favorite`, { token: nia.token });
    await call('DELETE', `/friends/${omar.id}`, { token: nia.token });
    assert.ok(!(await call('GET', '/favorites', { token: nia.token })).body.favorites.some((f) => f.id === got));
    await befriend(nia, omar);
    assert.ok((await call('GET', '/favorites', { token: nia.token })).body.favorites.some((f) => f.id === got));
    await call('DELETE', `/snaps/${got}`, { token: omar.token });
    assert.ok(!(await call('GET', '/favorites', { token: nia.token })).body.favorites.some((f) => f.id === got));
  });
});

describe('chats', () => {
  let quinn, ruby, sam, tess;
  const membersOf = (chat) => chat.members.map((m) => ({ userId: m.id, publicKey: m.publicKey }));
  const say = async (user, chat, text) => {
    now += 1000;
    return call('POST', `/chats/${chat.id}/messages`, { token: user.token, body: await encryptMessage(text, membersOf(chat)) });
  };
  const read = async (user, chat) => {
    const { body } = await call('GET', `/chats/${chat.id}/messages`, { token: user.token });
    return Promise.all(body.messages.map(async (m) => [m.sender?.username, await decryptMessage(m, user.privateKey, user.id)]));
  };

  before(async () => {
    [quinn, ruby, sam, tess] = [await register('quinn'), await register('ruby'), await register('sam'), await register('tess')];
    await befriend(quinn, ruby);
    await befriend(quinn, sam);
  });

  test('friends can message each other, end-to-end encrypted', async () => {
    const { chat } = (await call('POST', '/chats/direct', { token: quinn.token, body: { userId: ruby.id } })).body;
    assert.equal(chat.kind, 'direct');
    assert.equal(chat.name, 'RUBY');
    // Opening it again returns the same chat, from either side.
    const same = (await call('POST', '/chats/direct', { token: ruby.token, body: { userId: quinn.id } })).body.chat;
    assert.equal(same.id, chat.id);

    assert.equal((await say(quinn, chat, 'hey ruby 👋')).status, 201);
    assert.equal((await say(ruby, chat, 'hi quinn')).status, 201);
    assert.deepEqual(await read(ruby, chat), [['quinn', 'hey ruby 👋'], ['ruby', 'hi quinn']]);

    // The server only has ciphertext.
    const stored = db.prepare('SELECT ciphertext FROM messages WHERE chat_id = ?').all(chat.id);
    assert.ok(stored.every((r) => !Buffer.from(r.ciphertext).toString('utf8').includes('hey ruby')));

    // Quinn hasn't read Ruby's reply yet; Ruby has read everything (she replied).
    const list = (await call('GET', '/chats', { token: quinn.token })).body;
    assert.equal(list.chats[0].id, chat.id);
    assert.equal(list.unread, 1);
    assert.equal((await call('GET', '/chats', { token: ruby.token })).body.unread, 0);
    await call('POST', `/chats/${chat.id}/read`, { token: quinn.token });
    assert.equal((await call('GET', '/chats', { token: quinn.token })).body.unread, 0);
  });

  test('only friends can message; outsiders see nothing', async () => {
    assert.equal((await call('POST', '/chats/direct', { token: quinn.token, body: { userId: tess.id } })).status, 403);
    const { chat } = (await call('POST', '/chats/direct', { token: quinn.token, body: { userId: ruby.id } })).body;
    assert.equal((await call('GET', `/chats/${chat.id}/messages`, { token: tess.token })).status, 404);
    // Unfriending closes the chat until you're friends again.
    await call('DELETE', `/friends/${ruby.id}`, { token: quinn.token });
    assert.equal((await say(quinn, chat, 'still there?')).status, 403);
    assert.ok(!(await call('GET', '/chats', { token: quinn.token })).body.chats.some((c) => c.id === chat.id));
    await befriend(quinn, ruby);
    assert.equal((await say(quinn, chat, 'friends again')).status, 201);
  });

  test('group chats need at least 2 friends', async () => {
    assert.equal(
      (await call('POST', '/chats/group', { token: quinn.token, body: { memberIds: [ruby.id] } })).status,
      400
    );
    assert.equal(
      (await call('POST', '/chats/group', { token: quinn.token, body: { memberIds: [ruby.id, tess.id] } })).status,
      403,
      'tess is not their friend'
    );
    const res = await call('POST', '/chats/group', { token: quinn.token, body: { name: 'Kool Kats', memberIds: [ruby.id, sam.id] } });
    assert.equal(res.status, 201);
    const chat = res.body.chat;
    assert.equal(chat.name, 'Kool Kats');
    assert.equal(chat.members.length, 3);

    assert.equal((await say(quinn, chat, 'welcome!')).status, 201);
    // Ruby and Sam aren't friends with each other, but both are in the group.
    assert.equal((await say(sam, chat, 'hi all')).status, 201);
    assert.deepEqual(await read(ruby, chat), [['quinn', 'welcome!'], ['sam', 'hi all']]);

    // A message that isn't encrypted for every member is refused.
    const partial = await encryptMessage('secret', membersOf(chat).slice(0, 2));
    assert.equal((await call('POST', `/chats/${chat.id}/messages`, { token: quinn.token, body: partial })).status, 409);
  });

  test('add people to a group and leave it', async () => {
    await befriend(quinn, tess);
    let chat = (await call('POST', '/chats/group', { token: quinn.token, body: { memberIds: [ruby.id, sam.id] } })).body.chat;
    await say(quinn, chat, 'before tess');
    chat = (await call('POST', `/chats/${chat.id}/members`, { token: quinn.token, body: { userIds: [tess.id] } })).body.chat;
    assert.equal(chat.members.length, 4);
    await say(quinn, chat, 'hi tess');
    // New members only see messages sent after they joined.
    assert.deepEqual(await read(tess, chat), [['quinn', 'hi tess']]);

    await call('POST', `/chats/${chat.id}/leave`, { token: sam.token });
    assert.equal((await call('GET', `/chats/${chat.id}/messages`, { token: sam.token })).status, 404);
    chat = (await call('GET', `/chats/${chat.id}/messages`, { token: quinn.token })).body.chat;
    assert.equal(chat.members.length, 3);
  });
});

describe('KoolKat Unlimited', () => {
  let admin, kim, leo;
  const me = async (u) => (await call('GET', '/me', { token: u.token })).body;
  before(async () => {
    // Admin is matched case-insensitively.
    [admin, kim, leo] = [await register('ZaLiTh9'), await register('kim'), await register('leo')];
    await befriend(kim, leo);
  });

  test('zalith9 (any capitalisation) is the admin; nobody else is', async () => {
    assert.equal((await me(admin)).plan.isAdmin, true);
    assert.equal((await me(kim)).plan.isAdmin, false);
    assert.equal((await call('GET', '/admin/codes', { token: kim.token })).status, 403);
    assert.equal((await call('POST', '/admin/grant', { token: kim.token, body: { username: 'kim' } })).status, 403);
  });

  test('zalith9 always has KoolKat Unlimited, forever, even after a revoke', async () => {
    let plan = (await me(admin)).plan;
    assert.equal(plan.plan, 'unlimited');
    assert.equal(plan.forever, true);
    assert.equal(plan.storageLimit, UNLIMITED_STORAGE);
    assert.equal(plan.flair, DEFAULT_FLAIR);
    await call('POST', '/admin/revoke', { token: admin.token, body: { username: 'zalith9' } });
    plan = (await me(admin)).plan;
    assert.equal(plan.plan, 'unlimited');
    const adminSeenByOthers = (await call('GET', '/users/search?q=zal', { token: kim.token })).body.users[0];
    assert.equal(adminSeenByOthers.badge, true);
  });

  test('everyone starts on KoolKat Free: 512 MB, no badge, no flair', async () => {
    const { plan, user } = await me(kim);
    assert.equal(plan.plan, 'free');
    assert.equal(plan.storageLimit, FREE_STORAGE);
    assert.equal(user.badge, false);
    assert.equal(plan.flair, null);
    assert.equal((await call('POST', '/me/flair', { token: kim.token, body: { flair: 'hi' } })).status, 403);
  });

  test('admin codes: custom text, usage limit, expiry, one use per person', async () => {
    const expiresAt = now + 2 * DAY_MS;
    const created = await call('POST', '/admin/codes', {
      token: admin.token,
      body: { code: 'nine lives', maxUses: 2, expiresAt, grantDays: 30 },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code.code, 'NINELIVES');
    assert.equal(created.body.code.maxUses, 2);

    const redeem = (u, code = 'ninelives') => call('POST', '/codes/redeem', { token: u.token, body: { code } });
    assert.equal((await redeem(kim)).status, 200);
    assert.equal((await redeem(kim)).status, 409, 'same person twice');
    assert.equal((await redeem(leo)).status, 200);
    assert.equal((await redeem(admin)).status, 410, 'used up');
    assert.equal((await redeem(kim, 'NOPE-NOPE')).status, 404);

    const k = await me(kim);
    assert.equal(k.plan.plan, 'unlimited');
    assert.equal(k.plan.storageLimit, UNLIMITED_STORAGE);
    assert.ok(Math.abs(k.plan.unlimitedUntil - (now + 30 * DAY_MS)) < 5000);

    const list = (await call('GET', '/admin/codes', { token: admin.token })).body.codes;
    assert.equal(list.find((c) => c.code === 'NINELIVES').uses, 2);

    const auto = (await call('POST', '/admin/codes', { token: admin.token, body: { expiresAt: now + DAY_MS } })).body.code;
    assert.match(auto.code, /^KOOL-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    now += 2 * DAY_MS;
    assert.equal((await redeem(admin, auto.code)).status, 410, 'expired');
    assert.equal((await call('DELETE', `/admin/codes/${auto.code}`, { token: admin.token })).status, 200);
  });

  test('badge and flair: default, customisable, and shown to friends', async () => {
    let leoSeenByKim = (await call('GET', '/friends', { token: kim.token })).body.friends.find((f) => f.id === leo.id);
    assert.equal(leoSeenByKim.badge, true);
    assert.equal(leoSeenByKim.flair, DEFAULT_FLAIR);
    assert.equal(DEFAULT_FLAIR, 'i have nine lives');

    const long = 'x'.repeat(60);
    const set = await call('POST', '/me/flair', { token: leo.token, body: { flair: `  cool\n cat ${long}` } });
    assert.equal(set.body.flair.length, 40);
    await call('POST', '/me/flair', { token: leo.token, body: { flair: 'certified kool' } });
    leoSeenByKim = (await call('GET', '/friends', { token: kim.token })).body.friends.find((f) => f.id === leo.id);
    assert.equal(leoSeenByKim.flair, 'certified kool');
    await call('POST', '/me/flair', { token: leo.token, body: { flair: '' } });
    assert.equal((await me(leo)).plan.flair, DEFAULT_FLAIR);
  });

  test('admin can gift Unlimited (forever or for some days) and take gifts back', async () => {
    const gift = await call('POST', '/admin/grant', { token: admin.token, body: { username: 'ZALITH9' } });
    assert.equal(gift.status, 200);
    assert.equal(gift.body.forever, true);
    assert.equal((await me(admin)).plan.forever, true);
    assert.equal((await call('POST', '/admin/grant', { token: admin.token, body: { username: 'ghost' } })).status, 404);

    await call('POST', '/admin/revoke', { token: admin.token, body: { username: 'kim' } });
    assert.equal((await me(kim)).plan.plan, 'free');
    const days = await call('POST', '/admin/grant', { token: admin.token, body: { username: 'kim', days: 7 } });
    assert.ok(Math.abs(days.body.unlimitedUntil - (now + 7 * DAY_MS)) < 5000);
  });

  test('storage limits apply to what you have sent', async () => {
    await call('POST', '/admin/revoke', { token: admin.token, body: { username: 'kim' } });
    // Pretend kim has already used almost all of her 512 MB.
    db.prepare(
      `INSERT INTO snaps (id, sender_id, iv, ephemeral_key, ciphertext, size, created_at, expires_at)
       VALUES ('filler', ?, 'x', 'x', x'00', ?, ?, 0)`
    ).run(kim.id, FREE_STORAGE - 100, now);
    const full = await sendSnap(kim, [leo]);
    assert.equal(full.status, 413);
    assert.match(full.body.error, /Unlimited/);
    assert.equal((await me(kim)).plan.storageUsed, FREE_STORAGE - 100);

    await call('POST', '/admin/grant', { token: admin.token, body: { username: 'kim', days: 1 } });
    assert.equal((await sendSnap(kim, [leo])).status, 201);
    db.prepare("DELETE FROM snaps WHERE id = 'filler'").run();
  });

});

describe('free Unlimited: requests, and News', () => {
  let admin, uma, vic;
  const me = async (u) => (await call('GET', '/me', { token: u.token })).body;
  before(async () => {
    // zalith9 was registered earlier; sign in again.
    const keys = await deriveKeysFromPassword('zalith9', 'correct horse battery', ITER);
    admin = (await call('POST', '/auth/login', { body: { username: 'Zalith9', authSecret: keys.authSecret } })).body;
    [uma, vic] = [await register('uma'), await register('vic')];
  });

  test('there is no paid checkout any more', async () => {
    assert.equal((await call('POST', '/billing/checkout', { token: uma.token })).status, 404);
    assert.equal((await call('POST', '/stripe/webhook', { body: {} })).status, 404);
  });

  test('ask for Unlimited; an admin approves it', async () => {
    const asked = await call('POST', '/unlimited/request', { token: uma.token, body: { message: 'pretty please 🙏' } });
    assert.equal(asked.status, 201);
    assert.equal((await me(uma)).plan.request.status, 'pending');
    assert.equal((await call('POST', '/unlimited/request', { token: uma.token, body: {} })).status, 409, 'one at a time');

    assert.equal((await call('GET', '/admin/requests', { token: uma.token })).status, 403);
    const pending = (await call('GET', '/admin/requests', { token: admin.token })).body.requests;
    const mine = pending.find((r) => r.user.username === 'uma');
    assert.equal(mine.message, 'pretty please 🙏');

    const ok = await call('POST', `/admin/requests/${mine.id}/approve`, { token: admin.token, body: { days: 14 } });
    assert.equal(ok.status, 200);
    const plan = (await me(uma)).plan;
    assert.equal(plan.plan, 'unlimited');
    assert.equal(plan.request.status, 'approved');
    assert.ok(Math.abs(plan.unlimitedUntil - (now + 14 * DAY_MS)) < 5000);
    assert.equal((await call('POST', `/admin/requests/${mine.id}/approve`, { token: admin.token })).status, 409);
    assert.equal((await call('POST', '/unlimited/request', { token: uma.token, body: {} })).status, 409, 'already has it');
  });

  test('a declined request can be asked again the next day', async () => {
    await call('POST', '/unlimited/request', { token: vic.token, body: {} });
    const r = (await call('GET', '/admin/requests', { token: admin.token })).body.requests.find((x) => x.user.username === 'vic');
    await call('POST', `/admin/requests/${r.id}/decline`, { token: admin.token });
    assert.equal((await me(vic)).plan.plan, 'free');
    assert.equal((await call('POST', '/unlimited/request', { token: vic.token, body: {} })).status, 429);
    now += DAY_MS + 1000;
    assert.equal((await call('POST', '/unlimited/request', { token: vic.token, body: {} })).status, 201);
  });

  test('only admins can post News; everyone can read it', async () => {
    assert.equal((await call('POST', '/news', { token: uma.token, body: { title: 'hi' } })).status, 403);
    assert.equal((await call('POST', '/news', { token: admin.token, body: { title: 'Code!', code: 'NOPE-NOPE' } })).status, 400);
    await call('POST', '/admin/codes', { token: admin.token, body: { code: 'NEWS-2026', maxUses: 100 } });
    const posted = await call('POST', '/news', {
      token: admin.token,
      body: { title: 'Free Unlimited 🎉', body: 'Line one\nLine two', code: 'news-2026' },
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.post.code, 'NEWS-2026');

    const feed = (await call('GET', '/news', { token: vic.token })).body;
    assert.equal(feed.canPost, false);
    assert.equal(feed.posts[0].title, 'Free Unlimited 🎉');
    assert.equal(feed.posts[0].body, 'Line one\nLine two');
    assert.equal(feed.posts[0].author.username, 'ZaLiTh9');
    assert.equal(feed.unread, 1);
    await call('POST', '/news/seen', { token: vic.token });
    assert.equal((await call('GET', '/news/unread', { token: vic.token })).body.unread, 0);
    assert.equal((await call('GET', '/news', { token: admin.token })).body.canPost, true);

    // The code in the post works.
    assert.equal((await call('POST', '/codes/redeem', { token: vic.token, body: { code: 'NEWS-2026' } })).status, 200);

    assert.equal((await call('DELETE', `/news/${posted.body.post.id}`, { token: uma.token })).status, 403);
    assert.equal((await call('DELETE', `/news/${posted.body.post.id}`, { token: admin.token })).status, 200);
    assert.equal((await call('GET', '/news', { token: vic.token })).body.posts.length, 0);
  });
});

test('cleanup removes expired sessions but keeps snaps', () => {
  const snapsBefore = db.prepare('SELECT COUNT(*) AS n FROM snaps').get().n;
  cleanup(db, now + 365 * DAY_MS);
  assert.ok(snapsBefore > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM snaps').get().n, snapsBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

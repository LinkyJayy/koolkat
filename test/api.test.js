import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDatabasePath, openDatabase } from '../server/db.js';
import { cleanup, createApp } from '../server/app.js';
import { DAY_MS, dayNumber } from '../server/streaks.js';
import { createPusher } from '../server/push.js';
import {
  createIdentity,
  decryptSnap,
  deriveKeysFromPassword,
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
  const payload = await encryptSnap(image, { caption, captionY: 0.3 }, recipients);
  return call('POST', '/snaps', { token: from.token, body: payload });
}

test('health check', async () => {
  assert.deepEqual((await call('GET', '/health')).body, { ok: true });
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
    assert.equal((await call('POST', '/auth/login', { body: { username: 'alice', authSecret: bad.authSecret } })).status, 401);
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

  test('a snap is end-to-end encrypted, viewable once, and only by its recipient', async () => {
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
    assert.equal((await call('GET', `/snaps/${sent.body.id}`, { token: carol.token })).status, 410);
    assert.equal(db.prepare('SELECT ciphertext FROM snaps WHERE id = ?').get(sent.body.id).ciphertext, null);

    const sentList = (await call('GET', '/snaps/sent', { token: bob.token })).body.snaps;
    assert.equal(sentList.find((s) => s.id === sent.body.id).recipients[0].opened, true);
  });

  test('unfriending hides unopened snaps', async () => {
    await befriend(bob, dave);
    const sent = await sendSnap(bob, [dave]);
    await call('DELETE', `/friends/${bob.id}`, { token: dave.token });
    assert.equal((await call('GET', `/snaps/${sent.body.id}`, { token: dave.token })).status, 403);
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
    assert.match(pushes[0].body, /GINA sent you a snap/);
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

test('cleanup removes expired snaps', () => {
  cleanup(db, now + 365 * DAY_MS);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM snaps').get().n, 0);
});

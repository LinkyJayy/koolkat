import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { runBolts } from '../server/bolts.js';
import { GAME_SECONDS, mousePos, mouseSchedule } from '../public/js/invaders.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

let now = 1_000_000;
const db = openDatabase(':memory:');
let server, base;
before(async () => {
  server = createApp({ db, clock: () => now }).listen(0);
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

describe('Bolts', () => {
  test('KatEscape: you keep the bolts you collected', () => {
    assert.deepEqual([runBolts(0), runBolts(37), runBolts(2600.7), runBolts(-5), runBolts('x'), runBolts(1e9)], [0, 37, 2600, 0, 0, 10000]);
  });

  test('earning: wins are 100, runs pay the bolts collected, with limits', async () => {
    const u = await register('bolty');
    assert.equal((await call('GET', '/bolts', u.token)).body.bolts, 0);
    let r = await call('POST', '/bolts/earn', u.token, { game: 'kart', reason: 'win' });
    assert.deepEqual(r.body, { earned: 100, bolts: 100 });
    r = await call('POST', '/bolts/earn', u.token, { game: 'kart', reason: 'win' });
    assert.equal(r.body.earned, 0, 'not two wins in 20 seconds');
    r = await call('POST', '/bolts/earn', u.token, { game: 'escape', reason: 'run', bolts: 412 });
    assert.deepEqual(r.body, { earned: 412, bolts: 512 });
    assert.equal((await call('POST', '/bolts/earn', u.token, { game: 'wordle', reason: 'run', bolts: 9000 })).status, 400, 'only KatEscape pays for collecting');
    assert.equal((await call('POST', '/bolts/earn', u.token, { game: 'chess', reason: 'win' })).status, 400);
    // A daily cap.
    for (let i = 0; i < 3; i++) {
      now += 21_000;
      await call('POST', '/bolts/earn', u.token, { game: 'escape', reason: 'run', bolts: 10000 });
    }
    assert.equal((await call('GET', '/bolts', u.token)).body.bolts, 25000);
    now += 25 * 60 * 60 * 1000;
    assert.equal((await call('POST', '/bolts/earn', u.token, { game: 'wordle', reason: 'win' })).body.earned, 100, 'a new day');
  });
});

describe('Kat Invaders', () => {
  test('the same seed gives everyone the same mice, worth 10 to 50', () => {
    const a = mouseSchedule(42);
    assert.deepEqual(a, mouseSchedule(42));
    assert.notDeepEqual(a, mouseSchedule(43));
    assert.ok(a.length > 100, 'plenty of mice in 2 minutes');
    assert.ok(a.every((m) => m.t < GAME_SECONDS && [10, 20, 30, 40, 50].includes(m.points)));
    assert.equal(mousePos(a[0], a[0].t - 1), null, 'not here yet');
    assert.ok(mousePos(a[0], a[0].t + 2).y > mousePos(a[0], a[0].t + 1).y, 'they come down');
  });

  test('online: teams, difficulty, scores, results and bolts for the winner', async () => {
    const [ann, ben] = [await register('kia'), await register('kib')];
    const code = (await call('POST', '/invaders/rooms', ann.token)).body.room.code;
    let room = (await call('POST', `/invaders/rooms/${code}/join`, ben.token)).body.room;
    assert.deepEqual(room.players.map((p) => p.team), ['red', 'yellow']);
    assert.equal(room.difficulty, 'medium');
    assert.equal((await call('POST', `/invaders/rooms/${code}/difficulty`, ben.token, { difficulty: 'hard' })).status, 403, 'only the host');
    room = (await call('POST', `/invaders/rooms/${code}/difficulty`, ann.token, { difficulty: 'easy' })).body.room;
    assert.equal(room.difficulty, 'easy');
    assert.equal((await call('POST', `/invaders/rooms/${code}/team`, ben.token, { team: 'red' })).status, 409);
    await call('POST', `/invaders/rooms/${code}/team`, ben.token, { team: 'blue' });
    room = (await call('POST', `/invaders/rooms/${code}/start`, ann.token)).body.room;
    assert.equal(room.state, 'running');
    assert.ok(Number.isInteger(room.seed));
    now += 5000;
    await call('POST', `/invaders/rooms/${code}/state`, ann.token, { x: 0.5, score: 120, lives: 5 });
    room = (await call('POST', `/invaders/rooms/${code}/state`, ben.token, { x: 0.2, score: 90, lives: 9 })).body.room;
    assert.equal(room.players.find((p) => p.name === 'kib').st.lives, 5, 'no more lives than Easy gives');
    // Scores only go up.
    room = (await call('POST', `/invaders/rooms/${code}/state`, ann.token, { x: 0.5, score: 10, lives: 5 })).body.room;
    assert.equal(room.players.find((p) => p.name === 'kia').st.score, 120);
    await call('POST', `/invaders/rooms/${code}/state`, ben.token, { x: 0.2, score: 300, lives: 0, status: 'out' });
    room = (await call('POST', `/invaders/rooms/${code}/state`, ann.token, { x: 0.5, score: 250, lives: 2, status: 'out' })).body.room;
    assert.equal(room.state, 'done');
    assert.deepEqual(room.results.map((r) => [r.name, r.place, r.score]), [['kib', 1, 300], ['kia', 2, 250]]);
    assert.equal((await call('GET', '/bolts', ben.token)).body.bolts, 100, 'the winner got 100 bolts');
    assert.equal((await call('GET', '/bolts', ann.token)).body.bolts, 0);
  });
});

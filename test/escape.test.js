import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
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
  const res = await fetch(`${base}/api${p}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
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

let ann, ben, cat;
before(async () => {
  [ann, ben, cat] = [await register('ann'), await register('ben'), await register('cat')];
});

const st = (dist, extra = {}) => ({ dist, x: 0, y: 0, speed: 11, roll: false, score: Math.floor(dist), bolts: 0, status: 'running', ...extra });

describe('KatEscape online', () => {
  test('All Chasers: one revive each, then out; the highest score wins', async () => {
    const code = (await call('POST', '/escape/rooms', ann.token)).body.room.code;
    await call('POST', `/escape/rooms/${code}/join`, ben.token);
    const joined = (await call('POST', `/escape/rooms/${code}/join`, cat.token)).body.room;
    assert.equal(joined.mode, 'all');
    assert.equal(joined.players.length, 3);
    // Chaser vs Cop is only for two.
    assert.equal((await call('POST', `/escape/rooms/${code}/mode`, ann.token, { mode: 'chase' })).status, 409);
    assert.equal((await call('POST', `/escape/rooms/${code}/start`, ben.token)).status, 403, 'only the host starts');
    const started = (await call('POST', `/escape/rooms/${code}/start`, ann.token)).body.room;
    assert.equal(started.state, 'running');
    assert.ok(Number.isInteger(started.seed), 'everyone gets the same course');
    assert.ok(['natho-town', 'crystal-cavern', 'kingdom-dominance'].includes(started.song));
    now += 5000;
    await call('POST', `/escape/rooms/${code}/state`, ann.token, st(100));
    await call('POST', `/escape/rooms/${code}/state`, ben.token, st(90));
    const seen = (await call('POST', `/escape/rooms/${code}/state`, cat.token, st(80))).body.room;
    assert.equal(seen.players.find((p) => p.name === 'ann').st.dist, 100);
    // Ben gets caught, revives (once), gets caught again and can't revive.
    await call('POST', `/escape/rooms/${code}/state`, ben.token, st(120, { status: 'down', reason: 'caught' }));
    await call('POST', `/escape/rooms/${code}/state`, ben.token, st(120));
    await call('POST', `/escape/rooms/${code}/state`, ben.token, st(300, { status: 'down', reason: 'train' }));
    const again = (await call('POST', `/escape/rooms/${code}/state`, ben.token, st(300))).body.room;
    assert.equal(again.players.find((p) => p.name === 'ben').status, 'down', 'only one revive');
    await call('POST', `/escape/rooms/${code}/state`, ben.token, st(300, { status: 'out', reason: 'train' }));
    await call('POST', `/escape/rooms/${code}/state`, cat.token, st(200, { status: 'out' }));
    const still = (await call('POST', `/escape/rooms/${code}/state`, ann.token, st(250))).body.room;
    assert.equal(still.state, 'running', 'ann is still going');
    const done = (await call('POST', `/escape/rooms/${code}/state`, ann.token, st(900, { status: 'out' }))).body.room;
    assert.equal(done.state, 'done');
    assert.deepEqual(done.results.players.map((p) => [p.name, p.place]), [['ann', 1], ['ben', 2], ['cat', 3]]);
  });

  test('Chaser vs Cop: the host picks the cop, Mice reach the chaser, getting away wins', async () => {
    const made = (await call('POST', '/escape/rooms', ann.token, { mode: 'chase' })).body.room;
    const code = made.code;
    assert.equal(made.mode, 'chase');
    let room = (await call('POST', `/escape/rooms/${code}/join`, ben.token)).body.room;
    assert.equal(room.copId, ben.id, 'the friend who joins is the cop to start with');
    assert.equal((await call('POST', `/escape/rooms/${code}/join`, cat.token)).status, 409, 'two only');
    assert.equal((await call('POST', `/escape/rooms/${code}/cop`, ben.token, { copId: ben.id })).status, 403);
    const picked = await call('POST', `/escape/rooms/${code}/cop`, ann.token, { copId: ann.id });
    assert.equal(picked.status, 200, JSON.stringify(picked.body));
    room = picked.body.room;
    assert.equal(room.copId, ann.id, 'the host can be the cop instead');
    await call('POST', `/escape/rooms/${code}/start`, ann.token);
    now += 5000;
    // The cop (ann) starts behind, so a negative distance is fine.
    await call('POST', `/escape/rooms/${code}/state`, ann.token, st(-8, { uses: [{ kind: 'mouse', id: 'm-1' }, { kind: 'thunder', id: 't-1' }] }));
    const seen = (await call('POST', `/escape/rooms/${code}/state`, ben.token, st(0))).body.room;
    assert.equal(seen.players.find((p) => p.name === 'ann').st.dist, -8);
    assert.deepEqual(seen.events.map((e) => [e.id, e.kind]), [['m-1', 'mouse']], 'only Mice in Chaser vs Cop');
    // The chaser can't throw Mice.
    await call('POST', `/escape/rooms/${code}/state`, ben.token, st(10, { uses: [{ kind: 'mouse', id: 'm-2' }] }));
    // "Escaped" too early doesn't count...
    now += 10_000;
    const early = (await call('POST', `/escape/rooms/${code}/state`, ben.token, st(200, { status: 'out', reason: 'escaped' }))).body.room;
    assert.equal(early.events.length, 1);
    assert.equal(early.results.winner, 'cop');
  });

  test('Chaser vs Cop: lasting the whole time wins it for the chaser', async () => {
    const code = (await call('POST', '/escape/rooms', ann.token, { mode: 'chase' })).body.room.code;
    await call('POST', `/escape/rooms/${code}/join`, ben.token);
    await call('POST', `/escape/rooms/${code}/start`, ann.token);
    now += 4000;
    for (let i = 0; i < 9; i++) {
      now += 10_000;
      await call('POST', `/escape/rooms/${code}/state`, ann.token, st(100 * i));
      await call('POST', `/escape/rooms/${code}/state`, ben.token, st(100 * i - 6));
    }
    const done = (await call('POST', `/escape/rooms/${code}/state`, ann.token, st(1500, { status: 'out', reason: 'escaped' }))).body.room;
    assert.equal(done.state, 'done');
    assert.equal(done.results.winner, 'chaser');
    assert.equal(done.results.chaserId, ann.id);
  });

  test('Chaser vs Cop: the cop gets one revive too; crashing again hands it to the chaser', async () => {
    const code = (await call('POST', '/escape/rooms', ann.token, { mode: 'chase' })).body.room.code;
    await call('POST', `/escape/rooms/${code}/join`, ben.token); // ben: the cop
    await call('POST', `/escape/rooms/${code}/start`, ann.token);
    now += 5000;
    await call('POST', `/escape/rooms/${code}/state`, ben.token, st(-8, { status: 'down', reason: 'train' }));
    let room = (await call('POST', `/escape/rooms/${code}/state`, ben.token, st(-8))).body.room;
    assert.equal(room.players.find((p) => p.name === 'ben').status, 'running', 'revived');
    await call('POST', `/escape/rooms/${code}/state`, ben.token, st(50, { status: 'down', reason: 'train' }));
    room = (await call('POST', `/escape/rooms/${code}/state`, ben.token, st(50))).body.room;
    assert.equal(room.players.find((p) => p.name === 'ben').status, 'down', 'only once');
    room = (await call('POST', `/escape/rooms/${code}/state`, ben.token, st(50, { status: 'out', reason: 'train' }))).body.room;
    assert.equal(room.state, 'done');
    assert.deepEqual([room.results.winner, room.results.reason], ['chaser', 'cop-train']);
  });
});

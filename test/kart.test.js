import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

const db = openDatabase(':memory:');
let server, base;
before(async () => {
  server = createApp({ db, admins: ['boss'] }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

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

let ann, ben, cat;
before(async () => {
  [ann, ben, cat] = [await register('ann'), await register('ben'), await register('cat')];
});

describe('Kat Kart online races', () => {
  test('make a race, join with the code, start, race and finish', async () => {
    const made = await call('POST', '/kart/rooms', { token: ann.token });
    assert.equal(made.status, 201);
    const code = made.body.room.code;
    assert.match(code, /^[A-Z]{4}$/);
    assert.equal((await call('POST', `/kart/rooms/${code}/start`, { token: ann.token })).status, 409, 'needs 2 racers');
    const joined = await call('POST', `/kart/rooms/${code.toLowerCase()}/join`, { token: ben.token });
    assert.deepEqual(joined.body.room.players.map((p) => [p.name, p.slot]), [['ann', 0], ['ben', 1]]);
    assert.equal((await call('POST', `/kart/rooms/${code}/start`, { token: ben.token })).status, 403, 'only the host starts');
    assert.equal((await call('GET', `/kart/rooms/${code}`, { token: cat.token })).status, 403);
    const started = await call('POST', `/kart/rooms/${code}/start`, { token: ann.token });
    assert.equal(started.body.room.state, 'racing');
    assert.ok(started.body.room.startAt > started.body.room.serverNow);
    assert.equal((await call('POST', `/kart/rooms/${code}/join`, { token: cat.token })).status, 409, 'too late to join');
  });

  test('positions are shared once the race is on, and results come at the end', async () => {
    let now = 1_000_000;
    const db2 = openDatabase(':memory:');
    const app = createApp({ db: db2, clock: () => now }).listen(0);
    await new Promise((r) => app.once('listening', r));
    after(() => {
      app.closeAllConnections();
      app.close();
    });
    const b2 = `http://127.0.0.1:${app.address().port}`;
    const c2 = async (method, p, token, body) => {
      const res = await fetch(`${b2}/api${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
    const reg = async (u) => {
      const { authSecret, vaultKey } = await deriveKeysFromPassword(u, 'password123', 1000);
      const id = await createIdentity(vaultKey);
      const r = await fetch(`${b2}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, displayName: u, authSecret, publicKey: id.publicKey, encryptedPrivateKey: id.encryptedPrivateKey, privateKeyIv: id.privateKeyIv }) });
      return (await r.json()).token;
    };
    const [a, b] = [await reg('ann'), await reg('ben')];
    const code = (await c2('POST', '/kart/rooms', a)).body.room.code;
    await c2('POST', `/kart/rooms/${code}/join`, b);
    await c2('POST', `/kart/rooms/${code}/start`, a);
    now += 5000;
    await c2('POST', `/kart/rooms/${code}/state`, a, { x: 100, y: 200, h: 1, v: 2, progress: 50, lap: 0, finished: null });
    const seen = (await c2('POST', `/kart/rooms/${code}/state`, b, { x: 120, y: 210, h: 1, v: 2, progress: 40, lap: 0 })).body.room;
    assert.deepEqual(seen.players.find((p) => p.name === 'ann').st, { x: 100, y: 200, h: 1, v: 2, progress: 50, lap: 0 });
    assert.equal(seen.players.find((p) => p.name === 'ann').finished, null, 'not finished just by racing');
    // Both keep sending (much more often in real life).
    for (let i = 0; i < 6; i++) {
      now += 10000;
      await c2('POST', `/kart/rooms/${code}/state`, a, { x: 100, y: 200, h: 1, v: 2, progress: 100 + i * 400, lap: 0 });
      await c2('POST', `/kart/rooms/${code}/state`, b, { x: 100, y: 200, h: 1, v: 2, progress: 120 + i * 400, lap: 0 });
    }
    await c2('POST', `/kart/rooms/${code}/state`, b, { x: 1, y: 1, h: 0, v: 2, progress: 3000, lap: 3, finished: 61000 });
    const done = (await c2('POST', `/kart/rooms/${code}/state`, a, { x: 1, y: 1, h: 0, v: 2, progress: 3001, lap: 3, finished: 62500 })).body.room;
    assert.equal(done.state, 'done');
    assert.deepEqual(done.results.map((r) => [r.name, r.place, r.time]), [['ben', 1, 61000], ['ann', 2, 62500]]);
  });
});

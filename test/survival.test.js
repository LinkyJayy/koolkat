import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';
import { ANIMALS, FIRE, NIGHT_MS, PREP_MS, START_ITEMS, SWORD, TOTAL_MS, act, createGame, isWarm, movePlayer, seeded, snapshot, step, survivalGems, worldNodes } from '../public/js/survival-rules.js';

const solo = (seed = 7) => createGame(seed, [{ id: 1, name: 'ann', team: 'blue' }]);
const run = (g, ms, rand = seeded(1)) => {
  for (let t = 0; t < ms && !g.over; t += 100) step(g, 100, rand);
};

describe('Kat Survival rules', () => {
  test('5 minutes to get ready, then 3 minutes of night', () => {
    assert.deepEqual([PREP_MS, NIGHT_MS, TOTAL_MS], [300_000, 180_000, 480_000]);
  });

  test('everyone starts with food, a sword (10 damage), 15 wood and a campfire', () => {
    const g = solo();
    assert.deepEqual(g.players[0].inv, { food: 3, wood: 15, stone: 0, campfire: 1 });
    assert.deepEqual(START_ITEMS, { food: 3, wood: 15, stone: 0, campfire: 1 });
    assert.equal(SWORD.damage, 10);
    assert.deepEqual(ANIMALS.bear.damage, [3, 5]);
    assert.ok(g.animals.some((a) => a.kind === 'cow') && g.animals.some((a) => a.kind === 'pig') && g.animals.some((a) => a.kind === 'bear'));
    assert.deepEqual(worldNodes(7), g.nodes, 'the same trees and rocks for everyone with the seed');
  });

  test('hit trees for wood and rocks for stone; craft and place campfires, and feed them wood', () => {
    const g = solo();
    const p = g.players[0];
    const tree = g.nodes.find((n) => n.kind === 'tree');
    g.animals = [];
    Object.assign(p, { x: tree.x + 30, y: tree.y, angle: Math.PI });
    let wood = 0;
    for (let i = 0; i < 5; i++) {
      const e = act(g, 1, { type: 'swing' });
      assert.equal(e.type, 'gather');
      wood += e.amount;
      step(g, 400);
    }
    assert.equal(p.inv.wood, 15 + wood);
    assert.equal(tree.hp, 0, 'chopped down');
    assert.equal(act(g, 1, { type: 'swing' }).type, 'miss');
    step(g, 400);
    const rock = g.nodes.find((n) => n.kind === 'rock');
    Object.assign(p, { x: rock.x + 26, y: rock.y });
    for (let i = 0; i < 3; i++) {
      act(g, 1, { type: 'swing' });
      step(g, 400);
    }
    assert.equal(p.inv.stone, 6);
    assert.equal(act(g, 1, { type: 'craft' }).type, 'craft');
    assert.deepEqual([p.inv.wood, p.inv.stone, p.inv.campfire], [15, 1, 2]);
    assert.match(act(g, 1, { type: 'craft' }).error, /10 wood and 5 stone/);
    Object.assign(p, { x: 1200, y: 1200 });
    assert.equal(act(g, 1, { type: 'place' }).type, 'place');
    assert.match(act(g, 1, { type: 'place' }).error, /already/, 'not two on the same spot');
    assert.equal(act(g, 1, { type: 'fuel', amount: 5 }).amount, 5);
    assert.equal(g.fires[0].fuel, FIRE.startFuel + 5 * FIRE.woodFuel);
    assert.equal(p.inv.wood, 10);
  });

  test('cows and pigs are food; bears hit back for 3 to 5', () => {
    const g = solo();
    const p = g.players[0];
    g.animals = g.animals.filter((a) => a.kind === 'cow').slice(0, 1);
    const cow = g.animals[0];
    Object.assign(cow, { x: p.x + 20, y: p.y });
    for (let i = 0; i < 3; i++) {
      act(g, 1, { type: 'swing' });
      g.t += 400;
    }
    assert.equal(g.animals.length, 0);
    assert.equal(p.inv.food, START_ITEMS.food + ANIMALS.cow.food);
    assert.equal(p.kills, 1);
    const hp = p.hp;
    g.animals = [{ id: 99, kind: 'bear', x: p.x + 20, y: p.y, hp: 60, heading: 0, turnAt: 0, fleeUntil: 0, target: null, hitAt: -1e9, face: 1 }];
    const bites = [];
    for (let i = 0; i < 30; i++) {
      step(g, 100);
      bites.push(...g.events.filter((e) => e.type === 'bite' && !bites.includes(e)));
    }
    assert.ok(bites.length >= 2);
    assert.ok(bites.every((e) => e.damage >= 3 && e.damage <= 5));
    assert.ok(p.hp < hp);
    p.hunger = 50;
    assert.equal(act(g, 1, { type: 'eat' }).type, 'eat');
    assert.equal(p.hunger, 85);
  });

  test('at night it is cold away from a burning campfire, and more bears come', () => {
    const g = solo();
    const p = g.players[0];
    g.animals = [];
    act(g, 1, { type: 'place' });
    act(g, 1, { type: 'fuel', amount: 15 });
    g.t = PREP_MS - 100;
    const before = p.hp;
    step(g, 100);
    assert.equal(g.phase, 'night');
    assert.ok(g.animals.filter((a) => a.kind === 'bear').length >= 4, 'the bears come out');
    g.animals = [];
    assert.ok(isWarm(g, p));
    run(g, 10_000);
    assert.equal(Math.round(p.hp), Math.round(before), 'warm by the fire');
    p.x += 400;
    assert.ok(!isWarm(g, p));
    const warmHp = p.hp;
    for (let i = 0; i < 100; i++) step(g, 100), (g.animals = []);
    assert.ok(warmHp - p.hp > 9, 'cold away from it');
  });

  test('ready early? Skip the rest of the day (everyone still standing has to be ready)', () => {
    const g = createGame(3, [{ id: 1, name: 'ann', team: 'blue' }, { id: 2, name: 'ben', team: 'red' }]);
    g.animals = [];
    run(g, 60_000);
    assert.equal(act(g, 1, { type: 'ready' }).ready, true);
    step(g, 100);
    assert.equal(g.phase, 'day', 'ben is not ready yet');
    act(g, 2, { type: 'ready', ready: true });
    step(g, 100);
    assert.equal(g.phase, 'night', 'both ready: here comes the night');
    assert.ok(g.skipped > 200_000, 'the rest of the day was skipped');
    assert.match(act(g, 1, { type: 'ready' }).error, /already night/);
    // Someone who isn't ready drops out: the rest don't wait for them.
    const h = createGame(3, [{ id: 1, name: 'ann', team: 'blue' }, { id: 2, name: 'ben', team: 'red' }]);
    act(h, 1, { type: 'ready' });
    h.players[1].gone = true;
    step(h, 100);
    assert.equal(h.phase, 'night');
  });

  test('survive until morning to win; running too fast is not allowed', () => {
    const g = solo();
    const p = g.players[0];
    g.t = 1000;
    p.movedAt = 1000;
    movePlayer(g, 1, p.x + 5000, p.y, 0);
    assert.ok(p.x < 1200 + 120, 'no teleporting');
    g.t = TOTAL_MS - 100;
    g.animals = [];
    g.fires.push({ id: 5, x: p.x, y: p.y, fuel: 300 });
    step(g, 100);
    assert.equal(g.over, true);
    assert.equal(g.results[0].survived, true);
    assert.equal(survivalGems(g.results[0]), 6);
    assert.equal(survivalGems({ survived: false, time: TOTAL_MS / 2, kills: 0 }), 3);
    assert.ok(snapshot(g).players[0].inv.food >= 0);
  });
});

let now = 5_000_000;
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

describe('Kat Survival online', () => {
  test('online: the night starts once everyone is ready', async () => {
    const [cat, dan] = [await register('cat'), await register('dan')];
    const code = (await call('POST', '/survival/rooms', cat.token)).body.room.code;
    await call('POST', `/survival/rooms/${code}/join`, dan.token);
    await call('POST', `/survival/rooms/${code}/start`, cat.token);
    now += 4500;
    for (let i = 0; i < 3; i++) {
      now += 10_000;
      for (const u of [cat, dan]) await call('POST', `/survival/rooms/${code}/state`, u.token, { x: 1200, y: 1200, angle: 0 });
    }
    let res = await call('POST', `/survival/rooms/${code}/state`, cat.token, { x: 1200, y: 1200, angle: 0, actions: [{ type: 'ready', ready: true }] });
    assert.equal(res.body.game.phase, 'day');
    assert.equal(res.body.game.players.find((p) => p.id === cat.id).ready, true);
    now += 1000;
    res = await call('POST', `/survival/rooms/${code}/state`, dan.token, { x: 1200, y: 1260, angle: 0, actions: [{ type: 'ready', ready: true }] });
    now += 500;
    res = await call('POST', `/survival/rooms/${code}/state`, dan.token, { x: 1200, y: 1260, angle: 0 });
    assert.equal(res.body.game.phase, 'night');
    const t = res.body.game.t;
    assert.ok(t >= 300_000 && t < 302_000, `night has just started (t=${t})`);
    // The night goes on in real time from here: 3 minutes and it's morning.
    now += 60_000;
    res = await call('POST', `/survival/rooms/${code}/state`, dan.token, { x: 1200, y: 1260, angle: 0 });
    assert.ok(Math.abs(res.body.game.t - (t + 60_000)) <= 200 || res.body.room.state === 'done');
    await call('POST', `/survival/rooms/${code}/leave`, cat.token);
    await call('POST', `/survival/rooms/${code}/leave`, dan.token);
  });

  test('lobby, start, play together, and the survivors get bolts', async () => {
    const [ann, ben] = [await register('ann'), await register('ben')];
    const code = (await call('POST', '/survival/rooms', ann.token)).body.room.code;
    assert.equal((await call('POST', `/survival/rooms/${code}/start`, ann.token)).status, 409, 'needs 2');
    let room = (await call('POST', `/survival/rooms/${code}/join`, ben.token)).body.room;
    assert.deepEqual(room.players.map((p) => p.team), ['red', 'yellow']);
    room = (await call('POST', `/survival/rooms/${code}/team`, ben.token, { team: 'blue' })).body.room;
    assert.equal((await call('POST', `/survival/rooms/${code}/song`, ben.token, { song: 'gold-mine' })).status, 403);
    assert.equal((await call('POST', `/survival/rooms/${code}/song`, ann.token, { song: 'none' })).body.room.song, 'none');
    await call('POST', `/survival/rooms/${code}/song`, ann.token, { song: 'gold-mine' });
    room = (await call('POST', `/survival/rooms/${code}/start`, ann.token)).body.room;
    assert.equal(room.state, 'running');
    assert.equal(room.song, 'gold-mine');
    now += 4500;
    let res = await call('POST', `/survival/rooms/${code}/state`, ann.token, { x: 1200, y: 1200, angle: 0, actions: [{ type: 'place' }, { type: 'fuel', amount: 15 }, { type: 'dance' }] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.outcomes.map((o) => [o.type, o.error]), [['place', null], ['fuel', null]]);
    let game = res.body.game;
    assert.equal(game.fires.length, 1);
    assert.equal(game.players.find((p) => p.id === ann.id).inv.wood, 0);
    assert.equal(game.players.length, 2);
    assert.ok(game.animals.length > 10);
    // Both stand by the fire all night (and keep checking in).
    const fire = game.fires[0];
    for (let t = 0; t < 490; t += 10) {
      now += 10_000;
      for (const u of [ann, ben]) {
        res = await call('POST', `/survival/rooms/${code}/state`, u.token, { x: fire.x, y: fire.y + 20, angle: 0, actions: [{ type: 'eat' }] });
      }
      if (res.body.room.state === 'done') break;
    }
    assert.equal(res.body.room.state, 'done');
    const results = res.body.room.results;
    assert.equal(results.length, 2);
    for (const r of results.filter((x) => x.survived)) {
      const earned = db.prepare("SELECT SUM(amount) AS n FROM bolt_rewards WHERE user_id = ? AND game = 'survival'").get(r.id).n;
      assert.equal(earned, 100, 'bolts for surviving the night');
    }
    for (const r of results) assert.ok(db.prepare("SELECT SUM(amount) AS n FROM gem_rewards WHERE user_id = ? AND game = 'survival'").get(r.id).n >= 1);
  });
});

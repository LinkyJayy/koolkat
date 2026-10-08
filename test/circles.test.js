import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { LUCKY, TURNS, choose, draw, newDeck, playLucky } from '../server/circlerooms.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

const game = (n = 3) => ({
  dir: 1,
  prevId: null,
  pending: null,
  players: ['red', 'yellow', 'green', 'blue', 'purple'].slice(0, n).map((team, i) => ({ id: i + 1, team, name: team, circles: 5, turns: 0, gone: false })),
  turnId: 1,
  deck: [],
});
/** Always pick a given Lucky outcome. */
const luckyIs = (g, outcome) => (n) => {
  const choices = LUCKY.filter((o) => (o.startsWith('prev') ? g.prevId && g.prevId !== g.turnId : true));
  return n === choices.length ? choices.indexOf(outcome) : 0;
};
const circles = (g) => g.players.map((p) => p.circles);

describe('Circle Chaos rules', () => {
  test('the bag: 14 of each team colour plus the rainbow circles', () => {
    const deck = newDeck(['red', 'blue']);
    assert.equal(deck.filter((c) => c === 'red').length, 14);
    assert.equal(deck.filter((c) => c === 'green').length, 0, 'only the teams that are playing');
    assert.equal(deck.filter((c) => c === 'lose2').length, 4);
    assert.equal(deck.filter((c) => c === 'lose4').length, 2);
    assert.equal(deck.filter((c) => c === 'lucky').length, 4);
  });

  test('a coloured circle goes to the team of that colour', () => {
    const g = game();
    g.deck = ['green'];
    const ev = draw(g);
    assert.equal(ev.to, 3);
    assert.deepEqual(circles(g), [5, 5, 6]);
    assert.equal(g.turnId, 2, "next person's turn");
  });

  test('Lose 2 / Lose 4: you pick the opponent', () => {
    const g = game();
    g.deck = ['lose4'];
    assert.equal(draw(g).choose, true);
    assert.equal(g.turnId, 1, 'still your turn until you pick');
    assert.equal(choose(g, 1), null, "can't pick yourself");
    const ev = choose(g, 3);
    assert.deepEqual([ev.target, ev.lost], [3, 4]);
    assert.deepEqual(circles(g), [5, 5, 1]);
    g.deck = ['lose2'];
    draw(g);
    choose(g, 3);
    assert.equal(g.players[2].circles, 0, "can't go below 0");
  });

  test('Lucky outcomes', () => {
    const check = (outcome, setup, expect) => {
      const g = game(4);
      setup?.(g);
      const r = playLucky(g, g.turnId, luckyIs(g, outcome));
      assert.equal(r.outcome, outcome);
      expect(g, r);
    };
    check('everyone-none', null, (g) => assert.deepEqual(circles(g), [0, 0, 0, 0]));
    check('everyone-none-but-player', null, (g) => assert.deepEqual(circles(g), [5, 0, 0, 0]));
    check('everyone-4', null, (g) => assert.deepEqual(circles(g), [9, 9, 9, 9]));
    check('flip', null, (g) => assert.equal(g.dir, -1));
    check('next-all', null, (g, r) => assert.deepEqual([r.target, circles(g)], [2, [5, 0, 5, 5]]));
    check('next-4', null, (g) => assert.deepEqual(circles(g), [5, 1, 5, 5]));
    // Previous person: whoever went just before.
    check('prev-all', (g) => Object.assign(g, { prevId: 4, turnId: 1 }), (g, r) => assert.deepEqual([r.target, circles(g)], [4, [5, 5, 5, 0]]));
    check('prev-4', (g) => Object.assign(g, { prevId: 4, turnId: 1 }), (g) => assert.deepEqual(circles(g), [5, 5, 5, 1]));
    check('random-next', null, (g, r) => assert.ok([2, 3, 4].includes(r.nextId)));
    // No "previous person" on the first turn.
    const g = game();
    for (let i = 0; i < 50; i++) assert.ok(!playLucky(g, 1).outcome.startsWith('prev'));
  });

  test('flipped: the turn goes the other way', () => {
    const g = game(4);
    g.deck = ['red', 'lucky'];
    const flipOnly = (n) => (n === LUCKY.length - 2 ? LUCKY.filter((o) => !o.startsWith('prev')).indexOf('flip') : 0);
    draw(g, flipOnly);
    assert.equal(g.turnId, 4, 'Red flipped it, so Blue (before Red) goes next');
    draw(g);
    assert.equal(g.turnId, 3);
  });

  test(`everyone gets ${TURNS} turns, then it's over`, () => {
    const g = game(2);
    g.deck = newDeck(['red', 'yellow']);
    let draws = 0;
    while (g.turnId) {
      draw(g);
      if (g.pending) choose(g, g.players.find((p) => p.id !== g.pending.by).id);
      draws += 1;
    }
    assert.equal(draws, TURNS * 2);
    assert.deepEqual(g.players.map((p) => p.turns), [TURNS, TURNS]);
  });
});

// ---------- online ----------
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

describe('Circle Chaos online', () => {
  test('lobby, teams, the deal, playing all the turns, results', async () => {
    const [ann, ben, cat] = [await register('ann'), await register('ben'), await register('cat')];
    const code = (await call('POST', '/circles/rooms', ann.token)).body.room.code;
    assert.equal((await call('POST', `/circles/rooms/${code}/start`, ann.token)).status, 409, 'needs 2 people');
    let room = (await call('POST', `/circles/rooms/${code}/join`, ben.token)).body.room;
    assert.deepEqual(room.players.map((p) => p.team), ['red', 'yellow']);
    // Teams: pick a free one.
    assert.equal((await call('POST', `/circles/rooms/${code}/team`, ben.token, { team: 'red' })).status, 409, 'taken');
    room = (await call('POST', `/circles/rooms/${code}/team`, ben.token, { team: 'purple' })).body.room;
    room = (await call('POST', `/circles/rooms/${code}/join`, cat.token)).body.room;
    assert.deepEqual(room.players.map((p) => p.team), ['red', 'purple', 'yellow']);
    assert.equal((await call('POST', `/circles/rooms/${code}/start`, ben.token)).status, 403);
    room = (await call('POST', `/circles/rooms/${code}/start`, ann.token)).body.room;
    assert.equal(room.state, 'dealing');
    assert.deepEqual(room.players.map((p) => p.team), ['red', 'yellow', 'purple'], 'seats in team order');
    assert.equal(room.deck, 3 * 14 + 3 * 5);
    assert.equal((await call('POST', `/circles/rooms/${code}/play`, ann.token)).status, 409, 'still dealing');
    now += 3500;
    const tokens = { [ann.id]: ann.token, [ben.id]: ben.token, [cat.id]: cat.token };
    assert.equal((await call('POST', `/circles/rooms/${code}/play`, ben.token)).status, 409, 'not your turn');
    let turns = 0;
    room = (await call('GET', `/circles/rooms/${code}`, ann.token)).body.room;
    while (room.state === 'playing') {
      const token = tokens[room.turnId];
      const other = room.players.find((p) => p.id !== room.turnId).id;
      const res = await call('POST', `/circles/rooms/${code}/play`, token, room.pending ? { target: other } : {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      room = res.body.room;
      if (!room.pending) turns += 1;
      now += 100;
    }
    assert.equal(turns, 3 * TURNS);
    assert.equal(room.state, 'done');
    assert.equal(room.results.length, 3);
    assert.ok(room.results[0].circles >= room.results[2].circles);
    assert.ok(room.events.some((e) => e.type === 'draw'));
  });

  test("too slow? The bot takes your turn; leaving hands it on", async () => {
    const [dan, eve] = [await register('dan'), await register('eve')];
    const code = (await call('POST', '/circles/rooms', dan.token)).body.room.code;
    await call('POST', `/circles/rooms/${code}/join`, eve.token);
    await call('POST', `/circles/rooms/${code}/start`, dan.token);
    now += 3500;
    let room = (await call('GET', `/circles/rooms/${code}`, eve.token)).body.room;
    assert.equal(room.turnId, dan.id);
    // Dan's phone is still there (checking in), just not playing.
    for (let i = 0; i < 4; i++) {
      now += 8_000;
      await call('GET', `/circles/rooms/${code}`, dan.token);
      room = (await call('GET', `/circles/rooms/${code}`, eve.token)).body.room;
    }
    assert.ok(room.events.some((e) => e.auto), 'the bot played for dan');
    await call('POST', `/circles/rooms/${code}/leave`, dan.token);
    room = (await call('GET', `/circles/rooms/${code}`, eve.token)).body.room;
    assert.equal(room.state, 'done', 'only one person left');
  });
});

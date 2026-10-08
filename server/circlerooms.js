import crypto from 'node:crypto';
import { fail } from './http.js';

// Circle Chaos: 2 to 5 people, one team colour each (Red, Yellow, Green,
// Blue, Purple). The bot spills the bag of circles into a random pile, the
// Deck. On your turn you take the top circle:
//  - a coloured circle goes to the team of that colour;
//  - Lose 2 / Lose 4: pick an opponent, they lose that many circles;
//  - Lucky: something random happens (see LUCKY).
// Everyone gets 15 turns. Most circles at the end wins.
// The server keeps the deck and does the dealing, so nobody can peek or
// cheat. Games live in memory (a restart ends them).

export const TEAMS = ['red', 'yellow', 'green', 'blue', 'purple'];
export const TURNS = 15;
export const MIN_PLAYERS = 2;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DEAL_MS = 3200; // the bot spilling the bag
const TURN_MS = 30 * 1000; // take too long and the bot takes your turn for you
const GONE_AFTER = 15 * 1000;
const ROOM_MAX_AGE = 2 * 60 * 60 * 1000;
const EVENTS_KEPT = 30;

/**
 * The Lucky Card outcomes. "player" played it, "next" goes next, "prev"
 * went just before, "random" is a random other team.
 */
export const LUCKY = [
  'everyone-none', // Everyone has no circles!
  'everyone-none-but-player', // Everyone has no circles, except for Player!
  'flip', // The turn order is Flipped!
  'random-next', // Random Team can go next
  'everyone-4', // Everyone gets 4 Circles!
  'next-all', // Next person loses all circles!
  'next-4', // Next person loses 4 Circles!
  'prev-all', // Previous person loses all circles!
  'prev-4', // Previous person loses 4 circles!
];

const randomInt = (n) => crypto.randomInt(n);

/** The bag of circles, spilled into a random pile. */
export function newDeck(teams, rand = randomInt) {
  const deck = [];
  for (const team of teams) for (let i = 0; i < 14; i++) deck.push(team);
  for (let i = 0; i < teams.length * 2; i++) deck.push('lose2', 'lucky');
  for (let i = 0; i < teams.length; i++) deck.push('lose4');
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---------- the rules (the game state is plain data, so it's easy to test) ----------

/** Who's still playing: here, with turns left. */
const canPlay = (game, id) => {
  const p = game.players.find((x) => x.id === id);
  return p && !p.gone && p.turns < TURNS;
};
const seat = (game, id) => game.players.findIndex((p) => p.id === id);
const teamOf = (game, id) => game.players.find((p) => p.id === id);

/** The next person after `id` going `dir`, who can play (or null). */
export function nextAfter(game, id, dir = game.dir, { anyone = false } = {}) {
  const n = game.players.length;
  const at = seat(game, id);
  for (let k = 1; k <= n; k++) {
    const p = game.players[(at + dir * k + n * k) % n];
    if (p.id === id) continue;
    if (anyone ? !p.gone : canPlay(game, p.id)) return p.id;
  }
  return null;
}

const lose = (p, n) => {
  const before = p.circles;
  p.circles = n === 'all' ? 0 : Math.max(0, p.circles - n);
  return before - p.circles;
};

/** Play a Lucky Card: returns what happened, and maybe who goes next. */
export function playLucky(game, playerId, rand = randomInt) {
  const player = teamOf(game, playerId);
  const others = game.players.filter((p) => p.id !== playerId && !p.gone);
  const next = teamOf(game, nextAfter(game, playerId) ?? nextAfter(game, playerId, game.dir, { anyone: true }));
  const prev = game.prevId && game.prevId !== playerId ? teamOf(game, game.prevId) : null;
  // Only outcomes that make sense right now (no "previous" on the very first turn).
  const choices = LUCKY.filter((o) => {
    if (o.startsWith('prev')) return Boolean(prev);
    if (o.startsWith('next')) return Boolean(next);
    if (o === 'random-next') return others.some((p) => canPlay(game, p.id));
    return true;
  });
  const outcome = choices[rand(choices.length)];
  const result = { outcome, by: player.id };
  switch (outcome) {
    case 'everyone-none':
      for (const p of game.players) p.circles = 0;
      break;
    case 'everyone-none-but-player':
      for (const p of game.players) if (p.id !== playerId) p.circles = 0;
      break;
    case 'flip':
      game.dir = -game.dir;
      break;
    case 'random-next': {
      const can = others.filter((p) => canPlay(game, p.id));
      result.target = can[rand(can.length)].id;
      result.nextId = result.target;
      break;
    }
    case 'everyone-4':
      for (const p of game.players) if (!p.gone) p.circles += 4;
      break;
    case 'next-all':
    case 'next-4':
      result.target = next.id;
      result.lost = lose(next, outcome === 'next-all' ? 'all' : 4);
      break;
    case 'prev-all':
    case 'prev-4':
      result.target = prev.id;
      result.lost = lose(prev, outcome === 'prev-all' ? 'all' : 4);
      break;
  }
  return result;
}

/** End the current turn and move on (or end the game). */
export function endTurn(game, nextId = null) {
  const current = teamOf(game, game.turnId);
  current.turns += 1;
  game.prevId = current.id;
  game.pending = null;
  let next = nextId && canPlay(game, nextId) ? nextId : nextAfter(game, current.id);
  if (!next && canPlay(game, current.id)) next = current.id; // everyone else is done
  game.turnId = next;
  return next;
}

/** Take the top circle. Returns the event. */
export function draw(game, rand = randomInt) {
  const player = teamOf(game, game.turnId);
  const event = { type: 'draw', by: player.id };
  if (!game.deck.length) {
    // The bot spills the bag again.
    game.deck = newDeck(game.players.map((p) => p.team), rand);
    event.refill = true;
  }
  const circle = game.deck.pop();
  event.circle = circle;
  if (TEAMS.includes(circle)) {
    const to = game.players.find((p) => p.team === circle);
    if (to) {
      to.circles += 1;
      event.to = to.id;
    }
    endTurn(game);
  } else if (circle === 'lucky') {
    Object.assign(event, playLucky(game, player.id, rand), { type: 'draw' });
    endTurn(game, event.nextId);
  } else {
    // Lose 2 / Lose 4: you pick who loses them (or the only choice is made for you).
    const targets = game.players.filter((p) => p.id !== player.id && !p.gone);
    if (targets.length === 1) {
      Object.assign(event, penalty(game, circle, targets[0].id));
      endTurn(game);
    } else {
      game.pending = { circle, by: player.id };
      event.choose = true;
    }
  }
  return event;
}

function penalty(game, circle, targetId) {
  const target = teamOf(game, targetId);
  return { target: target.id, lost: lose(target, circle === 'lose4' ? 4 : 2) };
}

/** Lose 2 / Lose 4: the opponent you picked loses them. */
export function choose(game, targetId) {
  const { circle, by } = game.pending;
  if (targetId === by || !teamOf(game, targetId) || teamOf(game, targetId).gone) return null;
  const event = { type: 'penalty', by, circle, ...penalty(game, circle, targetId) };
  endTurn(game);
  return event;
}

/** Same circles, same place. */
export const ranked = (players) =>
  [...players]
    .sort((a, b) => b.circles - a.circles)
    .map((p, i, list) => ({ place: list.findIndex((q) => q.circles === p.circles) + 1, id: p.id, team: p.team, name: p.name, circles: p.circles, gone: p.gone }));

// ---------- online ----------

export function registerCircleRoutes({ api, auth, wrap, clock, publicUser, db }) {
  const rooms = new Map();
  const roomOf = new Map();
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');

  const newCode = () => {
    for (;;) {
      const code = Array.from(crypto.randomBytes(4), (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
      if (!rooms.has(code)) return code;
    }
  };
  const present = (room) => room.players.filter((p) => !p.gone);
  const pushEvent = (room, event, now) => {
    room.seq += 1;
    room.events = [...room.events, { ...event, id: room.seq, at: now }].slice(-EVENTS_KEPT);
  };

  function leave(userId) {
    const code = roomOf.get(userId);
    roomOf.delete(userId);
    const room = code && rooms.get(code);
    if (!room) return;
    const p = room.players.find((x) => x.id === userId);
    if (room.state === 'lobby') room.players = room.players.filter((x) => x.id !== userId);
    else if (p) {
      p.gone = true;
      pushEvent(room, { type: 'left', by: p.id }, clock());
    }
    if (room.hostId === userId && present(room).length) room.hostId = present(room)[0].id;
    if (!present(room).length) rooms.delete(code);
    else if (room.state === 'playing') moveOn(room, clock());
  }

  /** Someone left mid-turn, or the game should end: sort it out. */
  function moveOn(room, now) {
    const g = room;
    if (g.state !== 'playing') return;
    if (present(g).length < 2 || !g.players.some((p) => canPlay(g, p.id))) return finish(room, now);
    if (!canPlay(g, g.turnId)) {
      g.pending = null;
      g.turnId = nextAfter(g, g.turnId) ?? g.players.find((p) => canPlay(g, p.id)).id;
      g.turnAt = now;
    }
  }

  function finish(room, now) {
    room.state = 'done';
    room.pending = null;
    room.turnId = null;
    room.results = ranked(room.players);
    pushEvent(room, { type: 'done' }, now);
  }

  function tidy(room, now) {
    for (const p of room.players) {
      if (!p.gone && now - p.seen > GONE_AFTER) {
        if (roomOf.get(p.id) === room.code) roomOf.delete(p.id);
        if (room.state === 'lobby') room.players = room.players.filter((x) => x !== p);
        else {
          p.gone = true;
          pushEvent(room, { type: 'left', by: p.id }, now);
        }
      }
    }
    if (!present(room).some((p) => p.id === room.hostId) && present(room).length) room.hostId = present(room)[0].id;
    if (room.state === 'dealing' && now >= room.startAt) {
      room.state = 'playing';
      room.turnAt = now;
    }
    if (room.state === 'playing') {
      moveOn(room, now);
      // Too slow: the bot takes your turn for you.
      if (room.state === 'playing' && now - room.turnAt > TURN_MS) act(room, room.turnId, room.pending ? { target: randomTarget(room) } : {}, now, true);
    }
  }
  const randomTarget = (room) => {
    const t = room.players.filter((p) => p.id !== room.pending.by && !p.gone);
    return t[randomInt(t.length)].id;
  };

  function act(room, userId, { target } = {}, now, auto = false) {
    if (room.state !== 'playing') fail(409, room.state === 'dealing' ? 'The bot is still spilling the bag' : 'The game is over');
    if (room.turnId !== userId) fail(409, "It's not your turn");
    let event;
    if (room.pending) {
      if (target == null) fail(409, 'Pick who loses the circles first');
      event = choose(room, room.players.find((p) => String(p.id) === String(target))?.id);
      if (!event) fail(400, 'Pick an opponent');
    } else event = draw(room);
    if (auto) event.auto = true;
    pushEvent(room, event, now);
    room.turnAt = now;
    if (!room.turnId) finish(room, now);
    else moveOn(room, now);
  }

  const describe = (room, now) => ({
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    serverNow: now,
    startAt: room.startAt ?? null,
    turnId: room.turnId ?? null,
    turnEndsAt: room.state === 'playing' ? room.turnAt + TURN_MS : null,
    dir: room.dir ?? 1,
    deck: room.deck?.length ?? 0,
    pending: room.pending ? { circle: room.pending.circle, by: room.pending.by } : null,
    players: room.players.map((p) => ({ id: p.id, name: p.name, user: p.user, team: p.team, circles: p.circles, turns: p.turns, gone: p.gone })),
    events: room.events,
    results: room.results ?? null,
  });

  const roomOr404 = (req) => {
    const code = String(req.params.code ?? '').toUpperCase();
    const room = rooms.get(code);
    if (!room) fail(404, "That game doesn't exist any more");
    const me = room.players.find((p) => p.id === req.user.id);
    if (me && !me.gone) me.seen = clock();
    tidy(room, clock());
    return room;
  };
  const mine = (room, req) => {
    const me = room.players.find((p) => p.id === req.user.id);
    if (!me) fail(403, "You're not in this game");
    return me;
  };

  function join(room, user, now) {
    const used = new Set(room.players.map((p) => p.team));
    const team = TEAMS.find((t) => !used.has(t));
    room.players.push({ id: user.id, name: user.display_name, user: publicUser(user), team, circles: 0, turns: 0, seen: now, gone: false });
    roomOf.set(user.id, room.code);
  }

  api.post(
    '/circles/rooms',
    auth,
    wrap((req, res) => {
      const now = clock();
      for (const [code, r] of rooms) if (now - r.createdAt > ROOM_MAX_AGE) rooms.delete(code);
      leave(req.user.id);
      const room = { code: newCode(), hostId: req.user.id, state: 'lobby', players: [], events: [], seq: 0, createdAt: now, dir: 1 };
      rooms.set(room.code, room);
      join(room, userById.get(req.user.id), now);
      res.status(201);
      return { room: describe(room, now) };
    })
  );

  api.post(
    '/circles/rooms/:code/join',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      if (!room.players.some((p) => p.id === req.user.id)) {
        if (room.state !== 'lobby') fail(409, 'That game has already started');
        if (room.players.length >= TEAMS.length) fail(409, 'That game is full (5 teams)');
        leave(req.user.id);
        join(room, userById.get(req.user.id), now);
      }
      return { room: describe(room, now) };
    })
  );

  api.get(
    '/circles/rooms/:code',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      mine(room, req);
      return { room: describe(room, clock()) };
    })
  );

  // Pick a team colour that nobody else has.
  api.post(
    '/circles/rooms/:code/team',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const me = mine(room, req);
      if (room.state !== 'lobby') fail(409, 'The game has already started');
      const team = String(req.body?.team ?? '');
      if (!TEAMS.includes(team)) fail(400, 'Pick Red, Yellow, Green, Blue or Purple');
      if (room.players.some((p) => p.team === team && p.id !== me.id)) fail(409, 'Someone already has that team');
      me.team = team;
      return { room: describe(room, clock()) };
    })
  );

  api.post(
    '/circles/rooms/:code/start',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      if (room.hostId !== req.user.id) fail(403, 'Only the host starts the game');
      if (room.state !== 'lobby') fail(409, 'The game has already started');
      if (present(room).length < MIN_PLAYERS) fail(409, 'Wait for at least one friend to join');
      // Seats go in team order: Red, Yellow, Green, Blue, Purple.
      room.players.sort((a, b) => TEAMS.indexOf(a.team) - TEAMS.indexOf(b.team));
      room.deck = newDeck(room.players.map((p) => p.team));
      room.state = 'dealing';
      room.startAt = now + DEAL_MS;
      room.dir = 1;
      room.turnId = room.players[0].id;
      room.prevId = null;
      pushEvent(room, { type: 'deal', count: room.deck.length }, now);
      return { room: describe(room, now) };
    })
  );

  // Your turn: take the top circle, or pick who loses the circles.
  api.post(
    '/circles/rooms/:code/play',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      mine(room, req);
      act(room, req.user.id, { target: req.body?.target }, now);
      return { room: describe(room, now) };
    })
  );

  api.post(
    '/circles/rooms/:code/leave',
    auth,
    wrap((req) => {
      leave(req.user.id);
      return { ok: true };
    })
  );

  return { rooms };
}

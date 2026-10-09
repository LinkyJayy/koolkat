import crypto from 'node:crypto';
import { fail } from './http.js';
import { KART_SONGS } from './kartrooms.js';
import { TEAMS, canPlay, choose, draw, newDeck, nextAfter, ranked } from '../public/js/circle-rules.js';

export * from '../public/js/circle-rules.js';

// Circle Chaos online: 2 to 5 people, one team colour each (Red, Yellow,
// Green, Blue, Purple). The rules are in public/js/circle-rules.js (Practice
// runs them in the browser against bots). Online, the server keeps the deck and does the dealing, so nobody can peek or
// cheat. Games live in memory (a restart ends them).

export const MIN_PLAYERS = 2;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DEAL_MS = 3200; // the bot spilling the bag
const TURN_MS = 30 * 1000; // take too long and the bot takes your turn for you
const GONE_AFTER = 15 * 1000;
const ROOM_MAX_AGE = 2 * 60 * 60 * 1000;
const EVENTS_KEPT = 30;

const randomInt = (n) => crypto.randomInt(n);

// ---------- online ----------

export function registerCircleRoutes({ api, auth, wrap, clock, publicUser, db, bolts }) {
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
    for (const r of room.results) if (r.place === 1 && !r.gone) bolts?.award(r.id, 'circles', 'win', 5, `circles:${room.code}:${room.startAt}`);
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
    } else event = draw(room, randomInt);
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
    song: room.song ?? 'random',
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
      const room = { code: newCode(), hostId: req.user.id, state: 'lobby', players: [], events: [], seq: 0, createdAt: now, dir: 1, song: 'random' };
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

  // The host picks the music (a Kat Kart song, or Random).
  api.post(
    '/circles/rooms/:code/song',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      if (room.hostId !== req.user.id) fail(403, 'Only the host picks the music');
      if (room.state !== 'lobby') fail(409, 'The game has already started');
      const song = String(req.body?.song ?? '');
      if (song !== 'random' && !KART_SONGS.includes(song)) fail(400, "That song isn't on the Kat Kart OST");
      room.song = song;
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
      room.deck = newDeck(room.players.map((p) => p.team), randomInt);
      // Random music: pick now, so everyone hears the same song.
      if (!KART_SONGS.includes(room.song)) room.song = KART_SONGS[randomInt(KART_SONGS.length)];
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

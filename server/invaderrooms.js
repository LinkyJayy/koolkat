import crypto from 'node:crypto';
import { fail } from './http.js';
import { WIN_BOLTS } from './bolts.js';
import { placeGems } from '../public/js/rewards.js';
import { KART_SONGS } from './kartrooms.js';
import { ALL_TEAMS, BASE_TEAMS, TEAM_NAMES } from '../public/js/teams.js';

// Kat Invaders online: 2 to 5 people, one team colour each. Everyone gets the
// same mice (from the same seed) and has 2 minutes to shoot as many as they
// can. The host picks the difficulty (Easy 5 lives, Medium 3, Hard 1) and the
// music. Each phone sends its score ~6 times a second. Most points wins.
// Games live in memory (a restart ends them).

export const INVADER_LIVES = { easy: 5, medium: 3, hard: 1 };
export const INVADER_SECONDS = 120;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const COUNTDOWN = 4000;
const GONE_AFTER = 12 * 1000;
const ROOM_MAX_AGE = 2 * 60 * 60 * 1000;

const num = (v, min, max) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
};

export function registerInvaderRoutes({ api, auth, wrap, clock, publicUser, db, bolts, gems, shop }) {
  const rooms = new Map();
  const roomOf = new Map();
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const present = (room) => [...room.players.values()].filter((p) => !p.gone);

  const newCode = () => {
    for (;;) {
      const code = Array.from(crypto.randomBytes(4), (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
      if (!rooms.has(code)) return code;
    }
  };

  function leave(userId) {
    const code = roomOf.get(userId);
    roomOf.delete(userId);
    const room = code && rooms.get(code);
    if (!room) return;
    if (room.state === 'lobby') room.players.delete(userId);
    else if (room.players.get(userId)) room.players.get(userId).gone = true;
    if (room.hostId === userId && present(room).length) room.hostId = present(room)[0].id;
    if (!present(room).length) rooms.delete(code);
    else finishIfDone(room, clock());
  }

  function tidy(room, now) {
    for (const p of room.players.values()) {
      if (!p.gone && now - p.seen > GONE_AFTER) {
        p.gone = true;
        if (roomOf.get(p.id) === room.code) roomOf.delete(p.id);
        if (room.state === 'lobby') room.players.delete(p.id);
      }
    }
    if (room.players.get(room.hostId)?.gone !== false && present(room).length) room.hostId = present(room)[0].id;
    finishIfDone(room, now);
  }

  // Over when everyone's out of lives (or gone), or the time's up (and a moment for the last scores).
  function finishIfDone(room, now) {
    if (room.state !== 'running') return;
    if (!present(room).every((p) => p.status === 'out') && now < room.startAt + (INVADER_SECONDS + 4) * 1000) return;
    room.state = 'done';
    room.results = [...room.players.values()]
      .sort((a, b) => (b.st?.score ?? 0) - (a.st?.score ?? 0))
      .map((p, i, all) => ({ place: all.findIndex((q) => (q.st?.score ?? 0) === (p.st?.score ?? 0)) + 1, id: p.id, name: p.name, team: p.team, score: p.st?.score ?? 0, gone: p.gone }));
    for (const r of room.results) if (r.place === 1 && !r.gone && r.score > 0) bolts?.award(r.id, 'invaders', 'win', WIN_BOLTS, `invaders:${room.code}:${room.startAt}`);
    for (const r of room.results) if (!r.gone) gems?.award(r.id, 'invaders', 'finish', placeGems(r.place, room.results.length), `invaders:${room.code}:${room.startAt}`);
  }

  const describe = (room, now, withStates = false) => ({
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    difficulty: room.difficulty,
    song: room.song,
    seed: room.seed ?? null,
    startAt: room.startAt ?? null,
    serverNow: now,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, user: p.user, team: p.team, gone: p.gone, status: p.status ?? 'playing', ...(withStates ? { st: p.st ?? null } : {}) })),
    results: room.results ?? null,
  });

  const roomOr404 = (req) => {
    const room = rooms.get(String(req.params.code ?? '').toUpperCase());
    if (!room) fail(404, "That game doesn't exist any more");
    const me = room.players.get(req.user.id);
    if (me && !me.gone) me.seen = clock();
    tidy(room, clock());
    return room;
  };
  const mine = (room, req) => {
    const me = room.players.get(req.user.id);
    if (!me) fail(403, "You're not in this game");
    return me;
  };
  const hostOnly = (room, req, what) => {
    if (room.hostId !== req.user.id) fail(403, `Only the host ${what}`);
    if (room.state !== 'lobby') fail(409, 'The game has already started');
  };

  function join(room, user, now) {
    const used = new Set([...room.players.values()].map((p) => p.team));
    room.players.set(user.id, { id: user.id, name: user.display_name, user: publicUser(user), team: BASE_TEAMS.find((t) => !used.has(t)), seen: now, gone: false });
    roomOf.set(user.id, room.code);
  }

  api.post(
    '/invaders/rooms',
    auth,
    wrap((req, res) => {
      const now = clock();
      for (const [code, r] of rooms) if (now - r.createdAt > ROOM_MAX_AGE) rooms.delete(code);
      leave(req.user.id);
      const room = { code: newCode(), hostId: req.user.id, state: 'lobby', difficulty: 'medium', song: 'random', players: new Map(), createdAt: now };
      rooms.set(room.code, room);
      join(room, userById.get(req.user.id), now);
      res.status(201);
      return { room: describe(room, now) };
    })
  );

  api.post(
    '/invaders/rooms/:code/join',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      if (!room.players.has(req.user.id)) {
        if (room.state !== 'lobby') fail(409, 'That game has already started');
        if (room.players.size >= BASE_TEAMS.length) fail(409, 'That game is full (5 teams)');
        leave(req.user.id);
        join(room, userById.get(req.user.id), now);
      }
      return { room: describe(room, now) };
    })
  );

  api.get(
    '/invaders/rooms/:code',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      mine(room, req);
      return { room: describe(room, clock()) };
    })
  );

  api.post(
    '/invaders/rooms/:code/team',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const me = mine(room, req);
      if (room.state !== 'lobby') fail(409, 'The game has already started');
      const team = String(req.body?.team ?? '');
      if (!ALL_TEAMS.includes(team)) fail(400, "That's not a team colour");
      if (shop && !shop.canUseTeam(me.id, team)) fail(403, `Get the ${TEAM_NAMES[team]} team in the Bolt Shop first`);
      if ([...room.players.values()].some((p) => p.team === team && p.id !== me.id)) fail(409, 'Someone already has that team');
      me.team = team;
      return { room: describe(room, clock()) };
    })
  );

  // The host picks the difficulty (how many lives everyone gets)...
  api.post(
    '/invaders/rooms/:code/difficulty',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      hostOnly(room, req, 'picks the difficulty');
      const difficulty = String(req.body?.difficulty ?? '');
      if (!(difficulty in INVADER_LIVES)) fail(400, 'Pick Easy, Medium or Hard');
      room.difficulty = difficulty;
      return { room: describe(room, clock()) };
    })
  );

  // ...and the music.
  api.post(
    '/invaders/rooms/:code/song',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      hostOnly(room, req, 'picks the music');
      const song = String(req.body?.song ?? '');
      if (song !== 'random' && song !== 'none' && !KART_SONGS.includes(song)) fail(400, "That song isn't on the Kat Kart OST");
      room.song = song;
      return { room: describe(room, clock()) };
    })
  );

  api.post(
    '/invaders/rooms/:code/start',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      hostOnly(room, req, 'starts the game');
      if (present(room).length < 2) fail(409, 'Wait for at least one friend to join');
      const now = clock();
      room.state = 'running';
      room.startAt = now + COUNTDOWN;
      room.seed = crypto.randomInt(1, 2 ** 31 - 1);
      if (room.song !== 'none' && !KART_SONGS.includes(room.song)) room.song = KART_SONGS[crypto.randomInt(KART_SONGS.length)];
      for (const p of present(room)) p.status = 'playing';
      return { room: describe(room, now) };
    })
  );

  // Your score; answers with everyone's.
  api.post(
    '/invaders/rooms/:code/state',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      const me = mine(room, req);
      if (me.gone) fail(403, "You're not in this game");
      const b = req.body ?? {};
      if (room.state === 'running' && now >= room.startAt) {
        const lives = INVADER_LIVES[room.difficulty];
        const st = { x: num(b.x, 0, 1), score: num(b.score, 0, 1e6), lives: num(b.lives, 0, lives) };
        if (Object.values(st).every((v) => v != null)) {
          // Scores only go up.
          st.score = Math.max(st.score, me.st?.score ?? 0);
          me.st = st;
        }
        if (b.status === 'out' || st.lives === 0) me.status = 'out';
        finishIfDone(room, now);
      }
      return { room: describe(room, now, true) };
    })
  );

  api.post(
    '/invaders/rooms/:code/leave',
    auth,
    wrap((req) => {
      leave(req.user.id);
      return { ok: true };
    })
  );

  return { rooms };
}

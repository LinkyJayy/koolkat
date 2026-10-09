import crypto from 'node:crypto';
import { fail } from './http.js';
import { WIN_BOLTS } from './bolts.js';
import { KART_SONGS } from './kartrooms.js';

// KatEscape online. One person makes a game and shares its 4-letter code.
// Two modes:
//  - "all": All Chasers. Up to 8 people run from a bot cop on the same
//    course. Caught? Revive once, or spectate. Highest score wins.
//  - "chase": Chaser vs Cop. Two people: one runs, one is the cop. The host
//    picks who's who. The cop throws Mice to slow the chaser down. Both
//    get one revive.
// Like Kat Kart, each phone sends where it is ~10 times a second and gets
// everyone else's back. Games live in memory (a restart ends them).

export const MAX_RUNNERS = 8;
export const ESCAPE_MODES = ['all', 'chase'];
/** Chaser vs Cop: get away for this long and the chaser wins. */
export const CHASE_SECONDS = 90;
const STATUSES = ['running', 'down', 'out'];
const OUT_REASONS = ['caught', 'train', 'escaped'];
const EVENT_ID_RE = /^[A-Za-z0-9-]{3,40}$/;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const COUNTDOWN = 4000;
const GONE_AFTER = 12 * 1000;
const DOWN_FOR = 20 * 1000; // deciding whether to revive for longer than this: out
const ROOM_MAX_AGE = 2 * 60 * 60 * 1000;

const num = (v, min, max) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
};

export function registerEscapeRoutes({ api, auth, wrap, clock, publicUser, db, bolts }) {
  const rooms = new Map();
  const roomOf = new Map();
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');

  const newCode = () => {
    for (;;) {
      const code = Array.from(crypto.randomBytes(4), (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
      if (!rooms.has(code)) return code;
    }
  };
  const present = (room) => [...room.players.values()].filter((p) => !p.gone);

  /** Chaser vs Cop: the cop is whoever the host picked, or the first person who isn't the host. */
  function fixCop(room) {
    if (room.mode !== 'chase') return;
    const here = present(room);
    if (!here.some((p) => p.id === room.copId)) room.copId = here.find((p) => p.id !== room.hostId)?.id ?? null;
  }

  function leave(userId) {
    const code = roomOf.get(userId);
    roomOf.delete(userId);
    const room = code && rooms.get(code);
    if (!room) return;
    const p = room.players.get(userId);
    if (room.state === 'lobby') room.players.delete(userId);
    else if (p) p.gone = true;
    if (room.hostId === userId) {
      const next = present(room)[0];
      if (next) room.hostId = next.id;
    }
    if (room.state === 'lobby') fixCop(room);
    if (!present(room).length) rooms.delete(code);
    else if (room.state === 'running') finishIfDone(room, clock());
  }

  function tidy(room, now) {
    for (const p of room.players.values()) {
      if (!p.gone && now - p.seen > GONE_AFTER) {
        p.gone = true;
        if (roomOf.get(p.id) === room.code) roomOf.delete(p.id);
        if (room.state === 'lobby') room.players.delete(p.id);
      }
      if (room.state === 'running' && p.status === 'down' && now - p.downAt > DOWN_FOR) p.status = 'out';
    }
    if (room.players.get(room.hostId)?.gone !== false) {
      const next = present(room)[0];
      if (next) room.hostId = next.id;
    }
    if (room.state === 'lobby') fixCop(room);
    if (room.state === 'running') finishIfDone(room, now);
  }

  function finishIfDone(room, now) {
    if (room.mode === 'chase') {
      const chaser = room.players.get(room.chaserId);
      const cop = room.players.get(room.copId);
      let winner = null;
      let reason = null;
      if (chaser?.status === 'out') [winner, reason] = [chaser.reason === 'escaped' ? 'chaser' : 'cop', chaser.reason];
      else if (cop?.status === 'out') [winner, reason] = ['chaser', 'cop-train']; // out of revives
      else if (!chaser || chaser.gone) [winner, reason] = ['cop', 'left'];
      else if (!cop || cop.gone) [winner, reason] = ['chaser', 'left'];
      // (Time spent deciding on a revive doesn't count, so allow for it.)
      else if (now - room.startAt > (CHASE_SECONDS + 45) * 1000) [winner, reason] = ['chaser', 'escaped'];
      if (!winner) return;
      room.state = 'done';
      room.results = { winner, reason, chaserId: room.chaserId, copId: room.copId, players: ranked(room) };
      bolts?.award(winner === 'chaser' ? room.chaserId : room.copId, 'escape', 'win', WIN_BOLTS, `escape:${room.code}:${room.startAt}`);
      return;
    }
    if (present(room).every((p) => p.status === 'out')) {
      room.state = 'done';
      room.results = { players: ranked(room) };
      for (const p of room.results.players) if (p.place === 1 && !p.gone) bolts?.award(p.id, 'escape', 'win', WIN_BOLTS, `escape:${room.code}:${room.startAt}`);
    }
  }

  // Same score, same place.
  const ranked = (room) =>
    [...room.players.values()]
      .sort((a, b) => (b.st?.score ?? 0) - (a.st?.score ?? 0))
      .map((p, i, list) => ({ place: list.findIndex((q) => (q.st?.score ?? 0) === (p.st?.score ?? 0)) + 1, id: p.id, slot: p.slot, name: p.name, score: p.st?.score ?? 0, dist: Math.floor(p.st?.dist ?? 0), gone: p.gone, reason: p.reason ?? null }));

  const describe = (room, now, withStates = false) => ({
    code: room.code,
    state: room.state,
    mode: room.mode,
    hostId: room.hostId,
    copId: room.mode === 'chase' ? room.copId : null,
    startAt: room.startAt ?? null,
    seed: room.seed ?? null,
    song: room.song,
    serverNow: now,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      slot: p.slot,
      name: p.name,
      user: p.user,
      gone: p.gone,
      status: p.status ?? 'running',
      // age: how long ago that was (ms), so the others can tell where they are now.
      ...(withStates ? { st: p.st ? { ...p.st, age: now - p.stAt } : null } : {}),
    })),
    results: room.results ?? null,
    ...(withStates ? { events: room.events ?? [] } : {}),
  });

  const roomOr404 = (req) => {
    const code = String(req.params.code ?? '').toUpperCase();
    const room = rooms.get(code);
    if (!room) fail(404, "That game doesn't exist any more");
    const me = room.players.get(req.user.id);
    if (me && !me.gone) me.seen = clock();
    tidy(room, clock());
    return room;
  };
  const hostOnly = (room, req, what) => {
    if (room.hostId !== req.user.id) fail(403, `Only the host ${what}`);
    if (room.state !== 'lobby') fail(409, 'The game has already started');
  };

  function join(room, user, now) {
    const used = new Set([...room.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot += 1;
    room.players.set(user.id, { id: user.id, slot, name: user.display_name, user: publicUser(user), seen: now, gone: false });
    roomOf.set(user.id, room.code);
    fixCop(room);
  }

  api.post(
    '/escape/rooms',
    auth,
    wrap((req, res) => {
      const now = clock();
      for (const [code, r] of rooms) if (now - r.createdAt > ROOM_MAX_AGE) rooms.delete(code);
      leave(req.user.id);
      const mode = ESCAPE_MODES.includes(req.body?.mode) ? req.body.mode : 'all';
      const room = { code: newCode(), hostId: req.user.id, state: 'lobby', mode, copId: null, players: new Map(), createdAt: now, song: 'random' };
      rooms.set(room.code, room);
      join(room, userById.get(req.user.id), now);
      res.status(201);
      return { room: describe(room, now) };
    })
  );

  api.post(
    '/escape/rooms/:code/join',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      if (!room.players.has(req.user.id)) {
        if (room.state !== 'lobby') fail(409, 'That game has already started');
        const max = room.mode === 'chase' ? 2 : MAX_RUNNERS;
        if (room.players.size >= max) fail(409, room.mode === 'chase' ? 'That game is full (Chaser vs Cop is for 2)' : 'That game is full (8 runners)');
        leave(req.user.id);
        join(room, userById.get(req.user.id), now);
      }
      room.players.get(req.user.id).seen = now;
      return { room: describe(room, now) };
    })
  );

  api.get(
    '/escape/rooms/:code',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      if (!room.players.has(req.user.id)) fail(403, "You're not in this game");
      return { room: describe(room, clock()) };
    })
  );

  // The host picks the mode...
  api.post(
    '/escape/rooms/:code/mode',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      hostOnly(room, req, 'picks the mode');
      const mode = String(req.body?.mode ?? '');
      if (!ESCAPE_MODES.includes(mode)) fail(400, 'Pick All Chasers or Chaser vs Cop');
      if (mode === 'chase' && present(room).length > 2) fail(409, 'Chaser vs Cop is for 2 people');
      room.mode = mode;
      room.copId = null;
      fixCop(room);
      return { room: describe(room, clock()) };
    })
  );

  // ...who's the cop in Chaser vs Cop (everyone else is the chaser)...
  api.post(
    '/escape/rooms/:code/cop',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      hostOnly(room, req, 'picks the cop');
      if (room.mode !== 'chase') fail(409, 'There are no cops to pick in All Chasers');
      const cop = present(room).find((p) => String(p.id) === String(req.body?.copId ?? ''));
      if (!cop) fail(400, "They're not in this game");
      room.copId = cop.id;
      return { room: describe(room, clock()) };
    })
  );

  // ...and the music.
  api.post(
    '/escape/rooms/:code/song',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      hostOnly(room, req, 'picks the music');
      const song = String(req.body?.song ?? '');
      if (song !== 'random' && !KART_SONGS.includes(song)) fail(400, "That song isn't on the Kat Kart OST");
      room.song = song;
      return { room: describe(room, clock()) };
    })
  );

  api.post(
    '/escape/rooms/:code/start',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      hostOnly(room, req, 'starts the game');
      const here = present(room);
      if (here.length < 2) fail(409, 'Wait for at least one friend to join');
      if (room.mode === 'chase') {
        if (here.length !== 2) fail(409, 'Chaser vs Cop is for 2 people');
        fixCop(room);
        room.chaserId = here.find((p) => p.id !== room.copId).id;
      }
      const now = clock();
      room.state = 'running';
      room.startAt = now + COUNTDOWN;
      room.seed = crypto.randomInt(1, 2 ** 31 - 1);
      if (!KART_SONGS.includes(room.song)) room.song = KART_SONGS[crypto.randomInt(KART_SONGS.length)];
      for (const p of here) p.status = 'running';
      return { room: describe(room, now) };
    })
  );

  // Where you are; answers with everyone's.
  api.post(
    '/escape/rooms/:code/state',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      const me = room.players.get(req.user.id);
      if (!me || me.gone) fail(403, "You're not in this game");
      const b = req.body ?? {};
      if (room.state === 'running' && now >= room.startAt) {
        const st = { dist: num(b.dist, -100, 1e7), x: num(b.x, -3, 3), y: num(b.y, 0, 5), speed: num(b.speed, 0, 100), roll: Boolean(b.roll), score: num(b.score, 0, 1e9), bolts: num(b.bolts, 0, 1e7) };
        if (Object.values(st).every((v) => v != null)) {
          me.st = st;
          me.stAt = now;
        }
        const status = STATUSES.includes(b.status) ? b.status : null;
        if (me.status !== 'out' && status) {
          if (status === 'down' && me.status !== 'down') {
            me.downAt = now;
            me.reason = OUT_REASONS.includes(b.reason) ? b.reason : 'caught';
          }
          // Back up from "down" is the revive: once a game.
          if (status === 'running' && me.status === 'down') {
            if (!me.revived) {
              me.revived = true;
              me.status = 'running';
            }
          } else me.status = status;
          if (status === 'out') {
            me.reason = OUT_REASONS.includes(b.reason) ? b.reason : me.reason ?? 'caught';
            // Only the chaser gets away, and only once the time's up.
            if (me.reason === 'escaped' && !(room.mode === 'chase' && me.id === room.chaserId && now - room.startAt >= (CHASE_SECONDS - 3) * 1000)) me.reason = 'caught';
          }
        }
        // The cop's Mice (Chaser vs Cop).
        for (const use of Array.isArray(b.uses) ? b.uses.slice(0, 3) : []) {
          if (use?.kind !== 'mouse' || !EVENT_ID_RE.test(String(use?.id ?? ''))) continue;
          if (room.mode !== 'chase' || me.id !== room.copId || now - (me.lastUse ?? 0) < 1500) continue;
          me.lastUse = now;
          room.events = [...(room.events ?? []), { id: String(use.id), slot: me.slot, kind: 'mouse', at: now }].slice(-20);
        }
        finishIfDone(room, now);
      }
      return { room: describe(room, now, true) };
    })
  );

  api.post(
    '/escape/rooms/:code/leave',
    auth,
    wrap((req) => {
      leave(req.user.id);
      return { ok: true };
    })
  );

  return { rooms };
}

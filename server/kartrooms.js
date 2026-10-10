import crypto from 'node:crypto';
import { fail } from './http.js';
import { WIN_BOLTS } from './bolts.js';
import { placeGems } from '../public/js/rewards.js';
import { KART_MAP_IDS, KART_MAP_SIZE, kartMap } from '../public/js/kart-maps.js';

// Kat Kart online: race your friends. One person makes a race and shares its
// 4-letter code; up to 8 people join, and the host starts it. While racing,
// each phone sends where its kart is about 10 times a second and gets
// everyone else's back. Races live in memory (a restart ends them).

export const MAX_RACERS = 8;
/** The Kat Kart OST: the host picks one (or Random, picked when the race starts, or the map's own song: the default). */
export const KART_SONGS = ['natho-town', 'crystal-cavern', 'kingdom-dominance', 'gold-mine', 'rainbow-wonderland'];
/** Power-ups a racer can use on everyone else (speed boosts only affect yourself). */
export const ATTACKS = ['mouse', 'food', 'thunder'];
const EVENT_ID_RE = /^[A-Za-z0-9-]{3,40}$/;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const COUNTDOWN = 4000; // ms from "start" to GO (3, 2, 1 and a moment)
const GONE_AFTER = 12 * 1000; // no update for this long: left the race
const FINISH_WAIT = 25 * 1000; // after the first finisher, others get this long
const ROOM_MAX_AGE = 2 * 60 * 60 * 1000;

const num = (v, min, max) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
};

export function registerKartRoutes({ api, auth, wrap, clock, publicUser, db, bolts, gems }) {
  const rooms = new Map(); // code -> room
  const roomOf = new Map(); // userId -> code
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');

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
    const p = room.players.get(userId);
    if (room.state === 'lobby') room.players.delete(userId);
    else if (p) p.gone = true;
    if (room.hostId === userId) {
      const next = [...room.players.values()].find((x) => !x.gone);
      if (next) room.hostId = next.id;
    }
    if (![...room.players.values()].some((x) => !x.gone)) rooms.delete(code);
  }

  function tidy(room, now) {
    for (const p of room.players.values()) {
      if (!p.gone && now - p.seen > GONE_AFTER) {
        p.gone = true;
        if (roomOf.get(p.id) === room.code) roomOf.delete(p.id);
        if (room.state === 'lobby') room.players.delete(p.id);
      }
    }
    if (room.hostId && room.players.get(room.hostId)?.gone !== false) {
      const next = [...room.players.values()].find((x) => !x.gone);
      if (next) room.hostId = next.id;
    }
    if (room.state === 'racing') {
      const racing = [...room.players.values()].filter((p) => !p.gone);
      const firstFinish = Math.min(...[...room.players.values()].map((p) => p.finishedAt ?? Infinity));
      if (!racing.length || racing.every((p) => p.finished != null) || now - firstFinish > FINISH_WAIT) {
        room.state = 'done';
        room.results = results(room);
        // The winner gets bolts.
        for (const r of room.results) if (r.place === 1 && r.time != null) bolts?.award(r.id, 'kart', 'win', WIN_BOLTS, `kart:${room.code}:${room.createdAt}`);
        // Gems for everyone who finished, by place.
        for (const r of room.results) if (r.time != null) gems?.award(r.id, 'kart', 'finish', placeGems(r.place, room.results.length), `kart:${room.code}:${room.createdAt}`);
      }
    }
  }

  function results(room) {
    return [...room.players.values()]
      .sort((a, b) => {
        if (a.finished != null || b.finished != null) {
          if (a.finished == null) return 1;
          if (b.finished == null) return -1;
          return a.finished - b.finished;
        }
        return (b.st?.progress ?? -1e9) - (a.st?.progress ?? -1e9);
      })
      .map((p, i) => ({ place: i + 1, id: p.id, slot: p.slot, name: p.name, time: p.finished ?? null, gone: p.gone }));
  }

  const describe = (room, now, withStates = false) => ({
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    startAt: room.startAt ?? null,
    song: room.song ?? 'map',
    map: room.map ?? 'random',
    serverNow: now,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      slot: p.slot,
      name: p.name,
      user: p.user,
      gone: p.gone,
      finished: p.finished ?? null,
      ...(withStates ? { st: p.st ?? null } : {}),
    })),
    results: room.results ?? null,
    ...(withStates ? { events: room.events ?? [] } : {}),
  });

  const roomOr404 = (req) => {
    const code = String(req.params.code ?? '').toUpperCase();
    const room = rooms.get(code);
    if (!room) fail(404, "That race doesn't exist any more");
    // You're here now: check the others, not you.
    const me = room.players.get(req.user.id);
    if (me && !me.gone) me.seen = clock();
    tidy(room, clock());
    return room;
  };

  function join(room, user, now) {
    const used = new Set([...room.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot += 1;
    room.players.set(user.id, { id: user.id, slot, name: user.display_name, user: publicUser(user), seen: now, gone: false });
    roomOf.set(user.id, room.code);
  }

  api.post(
    '/kart/rooms',
    auth,
    wrap((req, res) => {
      const now = clock();
      for (const [code, r] of rooms) if (now - r.createdAt > ROOM_MAX_AGE) rooms.delete(code);
      leave(req.user.id);
      const room = { code: newCode(), hostId: req.user.id, state: 'lobby', players: new Map(), createdAt: now, song: 'map', map: 'random' };
      rooms.set(room.code, room);
      join(room, userById.get(req.user.id), now);
      res.status(201);
      return { room: describe(room, now) };
    })
  );

  api.post(
    '/kart/rooms/:code/join',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      if (!room.players.has(req.user.id)) {
        if (room.state !== 'lobby') fail(409, 'That race has already started');
        if (room.players.size >= MAX_RACERS) fail(409, 'That race is full (8 racers)');
        leave(req.user.id);
        join(room, userById.get(req.user.id), now);
      }
      room.players.get(req.user.id).seen = now;
      return { room: describe(room, now) };
    })
  );

  // The lobby checks in every second or so.
  api.get(
    '/kart/rooms/:code',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      const me = room.players.get(req.user.id);
      if (!me) fail(403, "You're not in this race");
      me.seen = now;
      return { room: describe(room, now) };
    })
  );

  api.post(
    '/kart/rooms/:code/start',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      if (room.hostId !== req.user.id) fail(403, 'Only the person who made the race can start it');
      if (room.state !== 'lobby') fail(409, 'The race has already started');
      const ready = [...room.players.values()].filter((p) => !p.gone);
      if (ready.length < 2) fail(409, 'Wait for at least one friend to join');
      room.state = 'racing';
      room.startAt = now + COUNTDOWN;
      // Random: pick now, so everyone races the same track and hears the same song.
      if (!KART_MAP_IDS.includes(room.map)) room.map = KART_MAP_IDS[crypto.randomInt(KART_MAP_IDS.length)];
      if (room.song === 'map') room.song = kartMap(room.map).song;
      if (room.song !== 'none' && !KART_SONGS.includes(room.song)) room.song = KART_SONGS[crypto.randomInt(KART_SONGS.length)];
      return { room: describe(room, now) };
    })
  );

  // The host picks the race music.
  api.post(
    '/kart/rooms/:code/song',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      if (room.hostId !== req.user.id) fail(403, 'Only the host picks the music');
      if (room.state !== 'lobby') fail(409, 'The race has already started');
      const song = String(req.body?.song ?? '');
      if (song !== 'random' && song !== 'map' && song !== 'none' && !KART_SONGS.includes(song)) fail(400, "That song isn't on the Kat Kart OST");
      room.song = song;
      return { room: describe(room, clock()) };
    })
  );

  // The host picks the map.
  api.post(
    '/kart/rooms/:code/map',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      if (room.hostId !== req.user.id) fail(403, 'Only the host picks the map');
      if (room.state !== 'lobby') fail(409, 'The race has already started');
      const map = String(req.body?.map ?? '');
      if (map !== 'random' && !KART_MAP_IDS.includes(map)) fail(400, "That's not a Kat Kart map");
      room.map = map;
      return { room: describe(room, clock()) };
    })
  );

  // Where your kart is; answers with everyone's.
  api.post(
    '/kart/rooms/:code/state',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      const me = room.players.get(req.user.id);
      if (!me || me.gone) fail(403, "You're not in this race");
      me.seen = now;
      const b = req.body ?? {};
      if (room.state === 'racing' && now >= room.startAt) {
        const st = { x: num(b.x, 0, KART_MAP_SIZE), y: num(b.y, 0, KART_MAP_SIZE), h: num(b.h, -100, 100), v: num(b.v, 0, 10), progress: num(b.progress, -1e5, 1e5), lap: num(b.lap, -1, 10) };
        if (Object.values(st).every((v) => v != null)) me.st = st;
        // Power-ups used on everyone else (Mouse, Food Bowl, Thunder).
        for (const use of Array.isArray(b.uses) ? b.uses.slice(0, 3) : []) {
          if (!ATTACKS.includes(use?.kind) || !EVENT_ID_RE.test(String(use?.id ?? ''))) continue;
          if (now - (me.lastUse ?? 0) < 1500) continue;
          me.lastUse = now;
          room.events = [...(room.events ?? []), { id: String(use.id), slot: me.slot, kind: use.kind, at: now }].slice(-30);
        }
        const finished = num(b.finished, 10 * 1000, 60 * 60 * 1000);
        if (finished != null && me.finished == null) {
          me.finished = finished;
          me.finishedAt = now;
        }
        tidy(room, now);
      }
      return { room: describe(room, now, true) };
    })
  );

  api.post(
    '/kart/rooms/:code/leave',
    auth,
    wrap((req) => {
      leave(req.user.id);
      return { ok: true };
    })
  );

  return { rooms };
}

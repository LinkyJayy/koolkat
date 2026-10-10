import crypto from 'node:crypto';
import { fail } from './http.js';
import { WIN_BOLTS } from './bolts.js';
import { KART_SONGS } from './kartrooms.js';
import { ALL_TEAMS, BASE_TEAMS, TEAM_NAMES } from '../public/js/teams.js';
import { MAX_PLAYERS, act, createGame, finish, movePlayer, snapshot, step, survivalGems } from '../public/js/survival-rules.js';

// Kat Survival online: 2 to 5 people, one team colour each, survive the night
// together. The server runs the world (animals, campfires, trees, the clock)
// in steps of 100 ms, catching up whenever someone checks in (once
// everyone's ready for the night, the rest of the day is skipped); each phone sends
// where its Kat is and what it did about 10 times a second and gets the world
// back. Games live in memory (a restart ends them).

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const COUNTDOWN = 4000;
const STEP_MS = 100;
const GONE_AFTER = 15 * 1000;
const ROOM_MAX_AGE = 2 * 60 * 60 * 1000;
const ACTIONS = ['swing', 'eat', 'place', 'fuel', 'craft', 'ready'];

export function registerSurvivalRoutes({ api, auth, wrap, clock, publicUser, db, bolts, gems, shop }) {
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
  const rand = () => crypto.randomInt(2 ** 30) / 2 ** 30;

  function markGone(room, p) {
    p.gone = true;
    const gp = room.game?.players.find((q) => q.id === p.id);
    if (gp) gp.gone = true;
  }

  function leave(userId) {
    const code = roomOf.get(userId);
    roomOf.delete(userId);
    const room = code && rooms.get(code);
    if (!room) return;
    if (room.state === 'lobby') room.players.delete(userId);
    else if (room.players.get(userId)) markGone(room, room.players.get(userId));
    if (room.hostId === userId && present(room).length) room.hostId = present(room)[0].id;
    if (!present(room).length) rooms.delete(code);
    else advance(room, clock());
  }

  /** Run the world up to now. */
  function advance(room, now) {
    if (room.state !== 'running' || now < room.startAt) return;
    const game = room.game;
    const target = now - room.startAt + game.skipped; // (minus the daytime everyone skipped)
    for (let n = 0; game.t + STEP_MS <= target && !game.over && n < 1200; n++) step(game, STEP_MS, rand);
    if (!game.over && !game.players.some((p) => p.alive && !p.gone)) finish(game);
    if (game.over && room.state === 'running') {
      room.state = 'done';
      room.results = game.results;
      const ref = `survival:${room.code}:${room.startAt}`;
      for (const r of room.results) {
        if (r.gone) continue;
        if (r.survived) bolts?.award(r.id, 'survival', 'win', WIN_BOLTS, ref);
        gems?.award(r.id, 'survival', 'finish', survivalGems(r), ref);
      }
    }
  }

  function tidy(room, now) {
    for (const p of room.players.values()) {
      if (!p.gone && now - p.seen > GONE_AFTER) {
        if (roomOf.get(p.id) === room.code) roomOf.delete(p.id);
        if (room.state === 'lobby') room.players.delete(p.id);
        else markGone(room, p);
      }
    }
    if (room.players.get(room.hostId)?.gone !== false && present(room).length) room.hostId = present(room)[0].id;
    advance(room, now);
  }

  const describe = (room, now) => ({
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    song: room.song,
    seed: room.seed ?? null,
    startAt: room.startAt ?? null,
    serverNow: now,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, user: p.user, team: p.team, gone: p.gone })),
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
    '/survival/rooms',
    auth,
    wrap((req, res) => {
      const now = clock();
      for (const [code, r] of rooms) if (now - r.createdAt > ROOM_MAX_AGE) rooms.delete(code);
      leave(req.user.id);
      const room = { code: newCode(), hostId: req.user.id, state: 'lobby', song: 'random', players: new Map(), createdAt: now };
      rooms.set(room.code, room);
      join(room, userById.get(req.user.id), now);
      res.status(201);
      return { room: describe(room, now) };
    })
  );

  api.post(
    '/survival/rooms/:code/join',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      if (!room.players.has(req.user.id)) {
        if (room.state !== 'lobby') fail(409, 'That game has already started');
        if (room.players.size >= MAX_PLAYERS) fail(409, `That game is full (${MAX_PLAYERS} Kats)`);
        leave(req.user.id);
        join(room, userById.get(req.user.id), now);
      }
      return { room: describe(room, now) };
    })
  );

  api.get(
    '/survival/rooms/:code',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      mine(room, req);
      return { room: describe(room, clock()) };
    })
  );

  api.post(
    '/survival/rooms/:code/team',
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

  api.post(
    '/survival/rooms/:code/song',
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
    '/survival/rooms/:code/start',
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
      room.game = createGame(
        room.seed,
        present(room).map((p) => ({ id: p.id, name: p.name, team: p.team }))
      );
      return { room: describe(room, now) };
    })
  );

  // Where your Kat is and what it did; answers with the world.
  api.post(
    '/survival/rooms/:code/state',
    auth,
    wrap((req) => {
      const room = roomOr404(req);
      const now = clock();
      const me = mine(room, req);
      if (me.gone) fail(403, "You're not in this game");
      if (room.state === 'lobby') fail(409, "The game hasn't started");
      const b = req.body ?? {};
      const outcomes = [];
      if (room.state === 'running' && now >= room.startAt) {
        movePlayer(room.game, me.id, Number(b.x), Number(b.y), Number(b.angle));
        for (const a of Array.isArray(b.actions) ? b.actions.slice(0, 6) : []) {
          if (!ACTIONS.includes(a?.type)) continue;
          const out = act(room.game, me.id, { type: a.type, amount: a.amount, ready: a.ready }, rand);
          outcomes.push({ type: a.type, error: out.error ?? null });
        }
        advance(room, now);
      }
      return { room: describe(room, now), game: room.game ? snapshot(room.game) : null, outcomes };
    })
  );

  api.post(
    '/survival/rooms/:code/leave',
    auth,
    wrap((req) => {
      leave(req.user.id);
      return { ok: true };
    })
  );

  return { rooms };
}

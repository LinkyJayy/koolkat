// Kat Survival rules, shared by the server (online games) and the browser
// (Solo). Top-down: get wood and stone, keep a campfire going, and survive
// the night. 5 minutes of daylight to get ready, then 3 minutes of night.
// At night it's cold away from a burning campfire, and the bears come out
// hunting. Cows and pigs don't hurt anyone; they're food when you get them.
//
// Ready early? Everyone still standing can say so, and the night starts
// straight away (Solo: just you).
//
// The game is plain data, so it's easy to test and to send over the network.
// The trees and rocks come from the seed, so only how much is left of each
// needs sending.

export const WORLD = 2400; // the world is WORLD × WORLD units
export const PREP_MS = 5 * 60 * 1000; // daylight: get ready
export const NIGHT_MS = 3 * 60 * 1000; // night: survive
export const TOTAL_MS = PREP_MS + NIGHT_MS;
export const MAX_PLAYERS = 5;

export const PLAYER = { hp: 100, speed: 150, radius: 14 }; // speed: units a second
export const SWORD = { damage: 10, reach: 40, cooldown: 380 };
export const START_ITEMS = { food: 3, wood: 15, stone: 0, campfire: 1 };
export const CAMPFIRE_RECIPE = { wood: 10, stone: 5 };
export const FOOD = { hunger: 35, hp: 10 }; // eating one
export const HUNGER = { max: 100, perSecond: 100 / 300, starveHp: 0.5 };
export const FIRE = { startFuel: 30, woodFuel: 12, maxFuel: 300, warmth: 150, near: 70, spacing: 60 };
export const COLD_HP = 1; // lost each second at night, away from a burning campfire

export const ANIMALS = {
  cow: { hp: 30, food: 3, speed: 38, flee: 120, radius: 16 },
  pig: { hp: 20, food: 2, speed: 42, flee: 130, radius: 13 },
  bear: { hp: 60, food: 4, speed: 35, chase: 128, radius: 18, damage: [3, 5], hitEvery: 1000, sight: 220, nightSight: 1000, reach: 32 },
};
export const NODES = {
  tree: { hp: 50, gives: 'wood', each: 2, radius: 18 },
  rock: { hp: 50, gives: 'stone', each: 2, radius: 15 },
};
const COUNTS = { tree: 110, rock: 50, cow: 16, pig: 14, bear: 4 };
const BEAR_CAP = 40;

/** A repeatable random number generator (0 ≤ n < 1). */
export function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clampWorld = (v, r = 0) => Math.max(r, Math.min(WORLD - r, v));
const CENTER = { x: WORLD / 2, y: WORLD / 2 };

/** Where everyone starts: in a ring round the middle. */
export function spawnPoint(i, n) {
  const a = (i / Math.max(1, n)) * Math.PI * 2;
  return { x: CENTER.x + Math.cos(a) * 60, y: CENTER.y + Math.sin(a) * 60 };
}

/** The trees and rocks: the same for everyone with the same seed. */
export function worldNodes(seed) {
  const rand = seeded(seed);
  const nodes = [];
  for (const kind of ['tree', 'rock']) {
    for (let i = 0; i < COUNTS[kind]; i++) {
      for (let tries = 0; tries < 20; tries++) {
        const p = { x: 60 + rand() * (WORLD - 120), y: 60 + rand() * (WORLD - 120) };
        if (dist(p, CENTER) < 220) continue; // a clearing in the middle, where you start
        if (nodes.some((n) => dist(n, p) < 60)) continue;
        nodes.push({ id: nodes.length + 1, kind, ...p, hp: NODES[kind].hp });
        break;
      }
    }
  }
  return nodes;
}

function addAnimal(game, kind, rand, { awayFrom = [], far = 0 } = {}) {
  for (let tries = 0; tries < 30; tries++) {
    const p = { x: 80 + rand() * (WORLD - 160), y: 80 + rand() * (WORLD - 160) };
    if (dist(p, CENTER) < 300 && game.t < PREP_MS && kind === 'bear') continue;
    if (awayFrom.some((q) => dist(p, q) < far)) continue;
    const a = { id: game.nextId++, kind, ...p, hp: ANIMALS[kind].hp, heading: rand() * Math.PI * 2, turnAt: 0, fleeUntil: 0, target: null, hitAt: 0, face: 1 };
    game.animals.push(a);
    return a;
  }
  return null;
}

/**
 * A new game. `players` is [{ id, name, team }]. Everyone starts in the
 * middle with food, a sword, 15 wood and a campfire.
 */
export function createGame(seed, players) {
  const rand = seeded(seed ^ 0x5eed);
  const game = {
    seed,
    t: 0,
    phase: 'day',
    nextId: 1000,
    skipped: 0, // daytime skipped by being ready early (ms)
    seq: 0,
    events: [],
    nodes: worldNodes(seed),
    fires: [],
    animals: [],
    players: players.map((p, i) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      ...spawnPoint(i, players.length),
      angle: Math.PI / 2,
      hp: PLAYER.hp,
      hunger: HUNGER.max,
      alive: true,
      gone: false,
      inv: { ...START_ITEMS },
      kills: 0,
      swingAt: -1e9,
      diedAt: null,
      movedAt: 0,
      ready: false, // ready for the night (skip the rest of the day)
    })),
    over: false,
    results: null,
  };
  for (const kind of ['cow', 'pig', 'bear']) for (let i = 0; i < COUNTS[kind]; i++) addAnimal(game, kind, rand);
  return game;
}

export function pushEvent(game, event) {
  game.seq += 1;
  game.events.push({ ...event, id: game.seq, t: game.t });
  if (game.events.length > 40) game.events.splice(0, game.events.length - 40);
}

const living = (game) => game.players.filter((p) => p.alive && !p.gone);
export const isNight = (game) => game.t >= PREP_MS;
const burning = (game) => game.fires.filter((f) => f.fuel > 0);
/** Warm: close to a campfire that's burning (in the day, everywhere's warm). */
export const isWarm = (game, p) => !isNight(game) || burning(game).some((f) => dist(f, p) <= FIRE.warmth);

/** Keep out of trees and rocks (and in the world). */
export function resolveMove(game, x, y) {
  let px = clampWorld(x, PLAYER.radius);
  let py = clampWorld(y, PLAYER.radius);
  for (const n of game.nodes) {
    if (n.hp <= 0) continue;
    const min = NODES[n.kind].radius + PLAYER.radius - 4;
    const dx = px - n.x;
    const dy = py - n.y;
    const d = Math.hypot(dx, dy);
    if (d < min && d > 0.001) {
      px = n.x + (dx / d) * min;
      py = n.y + (dy / d) * min;
    }
  }
  return { x: px, y: py };
}

/**
 * Someone moved (their phone works out where they are). We only check it's
 * not faster than a Kat can run.
 */
export function movePlayer(game, id, x, y, angle) {
  const p = game.players.find((q) => q.id === id);
  if (!p || !p.alive || game.over) return;
  if (![x, y].every(Number.isFinite)) return;
  const elapsed = Math.max(0, game.t - p.movedAt);
  const max = (PLAYER.speed * Math.min(elapsed, 1500)) / 1000 * 1.4 + 24;
  let dx = x - p.x;
  let dy = y - p.y;
  const d = Math.hypot(dx, dy);
  if (d > max) {
    dx *= max / d;
    dy *= max / d;
  }
  Object.assign(p, resolveMove(game, p.x + dx, p.y + dy));
  if (Number.isFinite(angle)) p.angle = angle;
  p.movedAt = game.t;
}

function hurt(game, p, amount, by) {
  if (!p.alive) return;
  p.hp = Math.max(0, p.hp - amount);
  if (p.hp <= 0) {
    p.alive = false;
    p.diedAt = game.t;
    pushEvent(game, { type: 'died', who: p.id, by, x: p.x, y: p.y });
  }
}

/**
 * Do something: { type: 'swing' } (hit whatever's in reach: an animal, a tree
 * or a rock), 'eat', 'place' (your campfire), 'fuel' (add wood to the fire
 * you're next to; `amount`), 'craft' (a campfire from wood and stone).
 * Returns the event, or { error }.
 */
export function act(game, id, action, rand = Math.random) {
  const p = game.players.find((q) => q.id === id);
  if (!p || !p.alive || game.over) return { error: "You can't do that now" };
  const inv = p.inv;
  switch (action?.type) {
    case 'swing': {
      if (game.t - p.swingAt < SWORD.cooldown) return { error: 'Too fast' };
      p.swingAt = game.t;
      // In front of you first, then whatever's closest.
      const inReach = (thing, r) => dist(thing, p) <= SWORD.reach + r;
      const ahead = (thing) => {
        const a = Math.atan2(thing.y - p.y, thing.x - p.x) - p.angle;
        return Math.cos(a);
      };
      const animals = game.animals.filter((a) => inReach(a, ANIMALS[a.kind].radius)).sort((a, b) => ahead(b) - ahead(a) || dist(a, p) - dist(b, p));
      const target = animals[0];
      if (target) {
        target.hp -= SWORD.damage;
        const event = { type: 'hit', by: p.id, kind: target.kind, target: target.id, x: target.x, y: target.y };
        if (target.kind === 'bear') target.target = p.id;
        else target.fleeUntil = game.t + 3000;
        target.fleeFrom = { x: p.x, y: p.y };
        if (target.hp <= 0) {
          game.animals = game.animals.filter((a) => a !== target);
          inv.food += ANIMALS[target.kind].food;
          p.kills += 1;
          Object.assign(event, { killed: true, food: ANIMALS[target.kind].food });
        }
        pushEvent(game, event);
        return event;
      }
      const node = game.nodes.filter((n) => n.hp > 0 && inReach(n, NODES[n.kind].radius)).sort((a, b) => ahead(b) - ahead(a) || dist(a, p) - dist(b, p))[0];
      if (node) {
        const info = NODES[node.kind];
        node.hp = Math.max(0, node.hp - SWORD.damage);
        inv[info.gives] += info.each;
        const event = { type: 'gather', by: p.id, node: node.id, kind: node.kind, gives: info.gives, amount: info.each, x: node.x, y: node.y, gone: node.hp <= 0 };
        pushEvent(game, event);
        return event;
      }
      return { type: 'miss', by: p.id };
    }
    case 'eat': {
      if (inv.food <= 0) return { error: 'No food left. Get some from cows and pigs!' };
      if (p.hunger >= HUNGER.max && p.hp >= PLAYER.hp) return { error: "You're full" };
      inv.food -= 1;
      p.hunger = Math.min(HUNGER.max, p.hunger + FOOD.hunger);
      p.hp = Math.min(PLAYER.hp, p.hp + FOOD.hp);
      const event = { type: 'eat', by: p.id, x: p.x, y: p.y };
      pushEvent(game, event);
      return event;
    }
    case 'place': {
      if (inv.campfire <= 0) return { error: 'No campfire to put down. Make one from 10 wood and 5 stone.' };
      if (game.fires.some((f) => dist(f, p) < FIRE.spacing)) return { error: "There's a campfire right here already" };
      inv.campfire -= 1;
      const fire = { id: game.nextId++, x: p.x, y: p.y + 4, fuel: FIRE.startFuel, by: p.id };
      game.fires.push(fire);
      const event = { type: 'place', by: p.id, fire: fire.id, x: fire.x, y: fire.y };
      pushEvent(game, event);
      return event;
    }
    case 'fuel': {
      const fire = game.fires.filter((f) => dist(f, p) <= FIRE.near).sort((a, b) => dist(a, p) - dist(b, p))[0];
      if (!fire) return { error: 'Stand next to a campfire to add wood' };
      if (inv.wood <= 0) return { error: 'No wood left. Hit some trees!' };
      const room = Math.floor((FIRE.maxFuel - fire.fuel) / FIRE.woodFuel);
      const n = Math.min(inv.wood, Math.max(1, Math.min(15, Math.floor(Number(action.amount) || 1))), room);
      if (n <= 0) return { error: 'That fire is full of wood' };
      inv.wood -= n;
      fire.fuel += n * FIRE.woodFuel;
      const event = { type: 'fuel', by: p.id, fire: fire.id, amount: n, x: fire.x, y: fire.y };
      pushEvent(game, event);
      return event;
    }
    case 'craft': {
      if (inv.wood < CAMPFIRE_RECIPE.wood || inv.stone < CAMPFIRE_RECIPE.stone) {
        return { error: `A campfire needs ${CAMPFIRE_RECIPE.wood} wood and ${CAMPFIRE_RECIPE.stone} stone` };
      }
      inv.wood -= CAMPFIRE_RECIPE.wood;
      inv.stone -= CAMPFIRE_RECIPE.stone;
      inv.campfire += 1;
      const event = { type: 'craft', by: p.id, x: p.x, y: p.y };
      pushEvent(game, event);
      return event;
    }
    case 'ready': {
      if (isNight(game)) return { error: "It's already night" };
      p.ready = action.ready == null ? !p.ready : Boolean(action.ready);
      const event = { type: 'ready', by: p.id, ready: p.ready };
      pushEvent(game, event);
      skipIfReady(game);
      return event;
    }
    default:
      return { error: "That's not something you can do" };
  }
}

function moveAnimal(a, dx, dy, dtS, speed) {
  const d = Math.hypot(dx, dy);
  if (d < 0.001) return;
  const r = ANIMALS[a.kind].radius;
  a.x = clampWorld(a.x + (dx / d) * speed * dtS, r);
  a.y = clampWorld(a.y + (dy / d) * speed * dtS, r);
  if (Math.abs(dx) > 0.01) a.face = dx > 0 ? 1 : -1;
}

function stepAnimals(game, dt, rand) {
  const dtS = dt / 1000;
  const night = isNight(game);
  const alive = living(game);
  for (const a of game.animals) {
    const info = ANIMALS[a.kind];
    if (a.kind === 'bear') {
      // Bears hunt: anyone close by day, anyone at all at night.
      let target = alive.find((p) => p.id === a.target);
      const sight = night ? info.nightSight : info.sight;
      if (!target || dist(target, a) > sight * 1.8) {
        target = alive.filter((p) => dist(p, a) <= sight).sort((p, q) => dist(p, a) - dist(q, a))[0] ?? null;
      }
      a.target = target?.id ?? null;
      if (target) {
        const d = dist(target, a);
        if (d > info.reach) moveAnimal(a, target.x - a.x, target.y - a.y, dtS, night ? info.chase : info.chase * 0.85);
        else if (game.t - a.hitAt >= info.hitEvery) {
          a.hitAt = game.t;
          const [lo, hi] = info.damage;
          const damage = lo + Math.floor(rand() * (hi - lo + 1));
          hurt(game, target, damage, 'bear');
          pushEvent(game, { type: 'bite', who: target.id, bear: a.id, damage, x: target.x, y: target.y });
        }
        continue;
      }
    } else if (game.t < a.fleeUntil && a.fleeFrom) {
      moveAnimal(a, a.x - a.fleeFrom.x, a.y - a.fleeFrom.y, dtS, info.flee);
      continue;
    }
    // Wander about.
    if (game.t >= a.turnAt) {
      a.heading = rand() * Math.PI * 2;
      a.turnAt = game.t + 1500 + rand() * 3500;
      a.resting = rand() < 0.35;
    }
    if (!a.resting) moveAnimal(a, Math.cos(a.heading), Math.sin(a.heading), dtS, info.speed);
  }
}

/** Everyone still standing is ready: no need to wait, the night starts now. */
function skipIfReady(game) {
  const alive = living(game);
  if (isNight(game) || !alive.length || !alive.every((p) => p.ready)) return false;
  const to = PREP_MS - 1; // the next step crosses into the night
  if (game.t < to) {
    game.skipped += to - game.t;
    game.t = to;
  }
  pushEvent(game, { type: 'skip' });
  return true;
}

/** The world moves on by `dt` ms. */
export function step(game, dt, rand = Math.random) {
  if (game.over) return;
  if (!isNight(game)) skipIfReady(game); // (someone who wasn't ready left, or got knocked out)
  const wasNight = isNight(game);
  game.t += dt;
  const dtS = dt / 1000;
  const night = isNight(game);
  if (night && !wasNight) {
    game.phase = 'night';
    pushEvent(game, { type: 'night' });
    // The bears come out: a few more for everyone, away from the players.
    const around = living(game);
    for (let i = 0; i < 2 + around.length * 2; i++) addAnimal(game, 'bear', rand, { awayFrom: around, far: 700 });
    game.nextBearAt = game.t + 30000;
  }
  if (night && game.t >= (game.nextBearAt ?? Infinity)) {
    const around = living(game);
    const bears = game.animals.filter((a) => a.kind === 'bear').length;
    for (let i = 0; i < around.length && bears + i < BEAR_CAP; i++) addAnimal(game, 'bear', rand, { awayFrom: around, far: 600 });
    game.nextBearAt = game.t + 30000;
  }
  // Campfires burn at night.
  if (night) for (const f of game.fires) f.fuel = Math.max(0, f.fuel - dtS);
  for (const p of living(game)) {
    p.hunger = Math.max(0, p.hunger - HUNGER.perSecond * dtS);
    if (p.hunger <= 0) hurt(game, p, HUNGER.starveHp * dtS, 'hunger');
    if (p.alive && !isWarm(game, p)) hurt(game, p, COLD_HP * dtS, 'cold');
  }
  stepAnimals(game, dt, rand);
  // By day, more cows and pigs wander in if they're running out.
  if (!night && Math.floor((game.t - dt) / 20000) !== Math.floor(game.t / 20000)) {
    for (const kind of ['cow', 'pig']) {
      if (game.animals.filter((a) => a.kind === kind).length < COUNTS[kind] / 2) addAnimal(game, kind, rand, { awayFrom: living(game), far: 500 });
    }
  }
  if (game.t >= TOTAL_MS || !living(game).length) finish(game);
}

/** The end: everyone still standing when the sun comes up survived. */
export function finish(game) {
  if (game.over) return;
  game.over = true;
  game.phase = 'over';
  game.t = Math.min(game.t, TOTAL_MS);
  game.results = game.players
    .map((p) => ({ id: p.id, name: p.name, team: p.team, survived: p.alive && !p.gone && game.t >= TOTAL_MS, time: p.diedAt ?? game.t, kills: p.kills, gone: p.gone }))
    .sort((a, b) => Number(b.survived) - Number(a.survived) || b.time - a.time || b.kills - a.kills);
  pushEvent(game, { type: 'over' });
}

/** Gems: 1 to 10. Survive for 6, plus 1 for each animal you got (up to 4 more); otherwise by how long you lasted. */
export const survivalGems = (r) => (r.survived ? Math.min(10, 6 + Math.min(4, r.kills)) : Math.max(1, Math.min(5, 1 + Math.floor((r.time / TOTAL_MS) * 5))));

/** What gets sent to phones: everything moving, and how much is left of the trees and rocks. */
export function snapshot(game) {
  const round = (v) => Math.round(v * 10) / 10;
  return {
    t: Math.round(game.t),
    skipped: game.skipped,
    phase: game.phase,
    over: game.over,
    players: game.players.map((p) => ({ id: p.id, name: p.name, team: p.team, x: round(p.x), y: round(p.y), angle: round(p.angle), hp: Math.ceil(p.hp), hunger: Math.ceil(p.hunger), alive: p.alive, gone: p.gone, inv: p.inv, kills: p.kills, swingAt: p.swingAt, ready: p.ready })),
    animals: game.animals.map((a) => ({ id: a.id, kind: a.kind, x: round(a.x), y: round(a.y), hp: a.hp, face: a.face })),
    fires: game.fires.map((f) => ({ id: f.id, x: round(f.x), y: round(f.y), fuel: round(f.fuel) })),
    nodes: game.nodes.filter((n) => n.hp < NODES[n.kind].hp).map((n) => [n.id, n.hp]),
    events: game.events,
    results: game.results,
  };
}

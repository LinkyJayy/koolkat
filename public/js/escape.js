// KatEscape: an endless runner, like Subway Surfers. KoolKat runs down three
// train tracks with a cop on its tail; switch lanes, jump and roll to dodge
// trains and barriers, and collect bolts. Stumble (clip a barrier or the side
// of a train) and the cop catches up; stumble again before you've got away,
// or hit a train head-on, and you're caught. The bolts make a trail along the safe way through.
// Every 750 bolts gives you Double Speed, every 2500 Triple Speed; speed
// boosts also smash you through anything in your way. Thunder (found on the
// track) clears the obstacles ahead. Drawn in chunky pixels like Kat Kart.
//
// Caught? You get one revive a game.
//
// Modes:
//  - solo: you and the bot cop.
//  - all: All Chasers, online. Everyone runs the same course from a bot cop
//    each. Out of revives? Spectate the others. Highest score wins. Mouse
//    boxes on the track slow your cop down for a second.
//  - practice: All Chasers against bot runners, no friends needed.
//  - chase: Chaser vs Cop, online. One person runs, the other is the cop
//    running the same course behind them. Both get one revive (back in at
//    the normal gap). Stumbles slow you down; the cop
//    catches the chaser by closing the gap, the chaser wins by lasting
//    CHASE_SECONDS. No speed power-ups, only Mice: the cop throws one and the
//    chaser slows down until the cop is closer than normal.

import { gamepadSteer } from './input.js';
import { createRaceMusic, showNowPlaying } from './kart.js';

const LANE = 1.25; // world units between lanes
const CAM_Z = -3.6;
const CAM_H = 2.6;
const DRAW_TO = 70; // how far ahead is drawn
const JUMP_TIME = 0.62; // seconds
const JUMP_HEIGHT = 1.45;
const ROLL_TIME = 0.6;
const BASE_SPEED = 11; // units per second at the start
const MAX_SPEED = 24;
const BOOSTS = {
  double: { name: 'Double Speed', icon: 'icons/powerups/double.png', mul: 1.5, secs: 5 },
  triple: { name: 'Triple Speed', icon: 'icons/powerups/triple.png', mul: 2, secs: 5 },
};
const BOLT_ICON = 'icons/powerups/thunder.png';
const MOUSE_ICON = 'icons/powerups/mouse.png';
const BEST_KEY = 'koolkat.katEscape.best';
export const CHASE_SECONDS = 90;
const START_GAP = 8; // Chaser vs Cop: how far behind the cop starts (normal)
const CATCH_GAP = 0.7;
const MOUSE_SLOW = 0.6;
const MOUSE_MAX_SECS = 5;
const REVIVE_SHIELD = 2.5;
const PRACTICE_BOTS = ['Whiskers', 'Mittens', 'Nala'];

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

/** The same numbers from the same seed, so everyone online runs the same course. */
function seeded(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const speedAt = (time) => Math.min(MAX_SPEED, BASE_SPEED + time * 0.18);

export function createKatEscape(els) {
  const { canvas } = els;
  const ctx = canvas.getContext('2d');
  let game = null;
  let frame = 0;
  let assets = null;
  // The same music as Kat Kart (a song from the Kat Kart OST).
  const music = createRaceMusic();

  async function loadAssets() {
    if (assets) return assets;
    const [bolt, double, triple, mouse, cat, cop] = await Promise.all(
      [BOLT_ICON, BOOSTS.double.icon, BOOSTS.triple.icon, MOUSE_ICON, 'icons/escape-cat.png', 'icons/escape-cop.png'].map(loadImage)
    );
    assets = { bolt, icons: { double, triple, thunder: bolt, mouse }, cat, cop };
    return assets;
  }

  function size() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = rect.width > rect.height ? 240 : 160;
    const h = Math.max(120, Math.min(420, Math.round((w * rect.height) / Math.max(rect.width, 1))));
    canvas.width = w;
    canvas.height = h;
    if (game) Object.assign(game, view(w, h));
  }
  const view = (w, h) => ({ w, h, horizon: Math.round(h * 0.34), focal: Math.min(w, h * 0.75) * 1.25 });

  /**
   * opts: { mode: 'solo' | 'practice' | 'all' | 'chase', role: 'chaser' | 'cop',
   *   seed, startAt (performance.now() time of GO), song, mySlot,
   *   players: [{ slot, name }], sync(state) -> Promise<room> }
   */
  async function start(opts = {}) {
    await loadAssets();
    stop();
    size();
    const mode = opts.mode ?? 'solo';
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    game = {
      ...view(canvas.width, canvas.height),
      mode,
      role: mode === 'chase' ? opts.role ?? 'chaser' : 'chaser',
      online: Boolean(opts.sync),
      sync: opts.sync ?? null,
      mySlot: opts.mySlot ?? 0,
      song: opts.song ?? null,
      startAt: opts.startAt ?? null,
      seed,
      state: opts.sync ? 'countdown' : 'ready',
      dist: 0,
      speed: BASE_SPEED,
      curSpeed: 0,
      time: 0,
      lane: 0,
      x: 0,
      jumpT: -1,
      rollT: -1,
      y: 0,
      objects: [], // obstacles, bolts and power-ups (wz = where on the course; z = how far ahead of the camera)
      rows: [], // { z, end, safe } for the bots
      bolts: 0,
      boost: null, // { kind, until }
      flash: 0,
      last: performance.now(),
      runFrame: 0,
      copZ: -0.9, // the bot cop starts right behind you
      copUntil: 3, // ...and stays close for the first 3 seconds
      stumbleUntil: 0,
      copSlowUntil: 0, // a Mouse slowed the bot cop down
      slowUntil: 0, // Chaser vs Cop: stumbled
      slowMul: 1,
      mouseUntil: 0, // Chaser vs Cop: the cop's Mouse is slowing you down
      shieldUntil: 0, // just revived
      item: null, // a Mouse, ready to use
      reviveUsed: false,
      reason: null,
      others: new Map(), // slot -> { name, dist, x, y, roll, speed, status, at, bot? }
      spectate: null, // slot you're watching
      uses: [],
      seenEvents: new Set(),
      finished: false,
      halted: false,
    };
    for (const p of opts.players ?? []) {
      if (p.slot !== game.mySlot) game.others.set(p.slot, { name: p.name, dist: mode === 'chase' && game.role === 'chaser' ? -START_GAP : 0, x: 0, y: 0, roll: false, speed: 0, status: 'running', at: performance.now() });
    }
    if (mode === 'practice') {
      PRACTICE_BOTS.forEach((name, i) => {
        // Each bot gets caught somewhere different: some early, some late.
        game.others.set(i + 1, { name, bot: true, dist: 2 + i * 2.2, x: (i - 1) * LANE, y: 0, lane: i - 1, roll: false, jumpT: -1, rollT: -1, bolts: 0, pace: 0.97 + Math.random() * 0.06, outAt: 350 + Math.random() * (1200 + i * 900), speed: 0, status: 'running', at: 0 });
      });
    }
    // Chaser vs Cop: the cop starts behind.
    if (mode === 'chase' && game.role === 'cop') game.dist = -START_GAP;
    resetTrack();
    els.over.hidden = true;
    els.spectate.hidden = true;
    els.hint.hidden = game.online;
    els.chase.hidden = mode !== 'chase';
    els.countdown.hidden = true;
    hud();
    frame = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(frame);
    music.pause();
    if (game) game.halted = true;
    game = null;
    els.countdown.hidden = true;
  }

  // ---------- the course ----------
  function resetTrack() {
    const g = game;
    g.rand = seeded(g.seed);
    g.nextRow = 22;
    g.safe = 0;
    g.objects = [];
    g.rows = [];
  }
  const usesMouse = () => game.mode === 'all' || game.mode === 'practice' || (game.mode === 'chase' && game.role === 'cop');

  /** One row of obstacles, with at least one way through and a bolt trail along it. */
  function spawnRow() {
    const g = game;
    const r = g.rand;
    const pick = (list) => list[Math.floor(r() * list.length)];
    const z = g.nextRow;
    const difficulty = Math.min(1, Math.max(0, z) / 3000);
    // The safe lane moves at most one lane at a time, so the trail can be followed.
    const prevSafe = g.safe;
    const safe = Math.max(-1, Math.min(1, prevSafe + pick([-1, 0, 0, 1])));
    g.safe = safe;
    let trainLen = 0;
    const add = (o) => g.objects.push({ ...o, wz: o.z });
    for (const lane of [-1, 0, 1]) {
      if (lane === safe) continue;
      const roll = r();
      if (roll < 0.15 + 0.15 * (1 - difficulty)) continue; // nothing
      if (roll < 0.62) {
        const len = 8 + Math.floor(r() * 10);
        trainLen = Math.max(trainLen, len);
        add({ type: 'train', lane, z, len, moving: r() < 0.25 + 0.25 * difficulty, color: pick(['#d7263d', '#2e86de', '#f4a300', '#8e44ad']) });
      } else if (roll < 0.82) add({ type: 'low', lane, z, len: 0.5 });
      else add({ type: 'high', lane, z, len: 0.5 });
    }
    // Sometimes the safe lane needs a jump or a roll too.
    if (r() < 0.35 + 0.3 * difficulty) add({ type: r() < 0.5 ? 'low' : 'high', lane: safe, z: z + 3, len: 0.5 });
    // Bolts: a trail from the last row to this one, then along the safe lane.
    const from = z - 12;
    for (let bz = from; bz < z + Math.max(4, trainLen); bz += 1.6) {
      const lane = bz < z - 5 ? prevSafe + (safe - prevSafe) * Math.min(1, Math.max(0, (bz - from) / 6)) : safe;
      add({ type: 'bolt', lane, z: bz, len: 0.4, y: 0.6 });
    }
    // (Always roll for these, so the course stays the same for everyone.)
    const thunder = r() < 0.06;
    const mouse = r() < 0.2;
    // Now and then Thunder on the track. (Double and Triple Speed only come from bolts.)
    if (thunder && g.mode !== 'chase') add({ type: 'power', kind: 'thunder', lane: safe, z: z - 6, len: 0.5, y: 0.8 });
    // Mouse boxes, like Kat Kart's.
    if (mouse && usesMouse()) add({ type: 'mouse', lane: safe, z: z - 9.5, len: 0.5, y: 0.7 });
    g.rows.push({ z, end: z + Math.max(4, trainLen), safe });
    g.nextRow = z + Math.max(trainLen, 4) + 14 - 4 * difficulty;
  }

  /** Make sure the course is there from `from` to `to` (+ what's drawn), and forget what's behind. */
  function trackFor(from, to) {
    const g = game;
    if (g.rows.length && from < g.rows[0].z - 20 && g.rows[0].z > 22) {
      // Watching someone further back than the course we kept: make it again.
      resetTrack();
    }
    while (g.nextRow - to < DRAW_TO + 30) spawnRow();
    const behind = from + CAM_Z - 1;
    g.objects = g.objects.filter((o) => !o.gone && o.wz + o.len > behind);
    while (g.rows.length > 1 && g.rows[1].end < from - 5) g.rows.shift();
  }

  // ---------- controls ----------
  function move(dir) {
    const g = game;
    if (!g) return;
    if (g.state === 'ready') begin();
    if (g.state !== 'running') return;
    if (dir === 'left' || dir === 'right') {
      const lane = Math.max(-1, Math.min(1, g.lane + (dir === 'left' ? -1 : 1)));
      // Running into the side of a train: bounce back and stumble.
      const blocked = !boosted() && !shielded() &&
        g.objects.some((o) => o.type === 'train' && !o.gone && o.lane === lane && o.z < 0.6 && o.z + o.len > -0.3);
      if (blocked) stumble();
      else g.lane = lane;
    } else if (dir === 'up' && g.jumpT < 0) {
      g.jumpT = 0;
      g.rollT = -1;
    } else if (dir === 'down') {
      g.rollT = 0;
      g.jumpT = -1; // dive down out of a jump
    }
  }
  function begin() {
    const g = game;
    g.state = 'running';
    g.last = performance.now();
    els.hint.hidden = true;
    els.countdown.hidden = true;
    // Online the host picked the song; otherwise you did (or Random).
    const song = music.pick(g.song ?? els.song?.value);
    g.songPlaying = song;
    music.play(song);
    showNowPlaying(els.nowPlaying, song);
    if (g.mode === 'chase') {
      announce(g.role === 'cop' ? 'You\'re the cop! Catch them. Grab Mice to slow them down' : `You're the chaser! Get away for ${CHASE_SECONDS} seconds`, g.role === 'cop' ? 'mouse' : null, 2600);
    }
  }

  // Swipes
  let touch = null;
  canvas.parentElement.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, select, label')) return;
    touch = { x: e.clientX, y: e.clientY, done: false };
  });
  canvas.parentElement.addEventListener('pointermove', (e) => {
    if (!touch || touch.done) return;
    const dx = e.clientX - touch.x;
    const dy = e.clientY - touch.y;
    if (Math.hypot(dx, dy) < 28) return;
    touch.done = true;
    move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
  });
  canvas.parentElement.addEventListener('pointerup', () => {
    // A tap starts the run.
    if (touch && !touch.done && game?.state === 'ready') begin();
    touch = null;
  });
  els.item.addEventListener('click', () => useItem());

  function keyDown(e) {
    const key = e.key.toLowerCase();
    if ((key === 'e' || key === 'enter' || key === 'shift') && !e.repeat) {
      if (game?.item) {
        e.preventDefault();
        useItem();
      }
      return;
    }
    const dir = { arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', arrowup: 'up', w: 'up', ' ': 'up', arrowdown: 'down', s: 'down' }[key];
    if (!dir || e.repeat) return;
    e.preventDefault();
    move(dir);
  }

  // Controllers: D-pad or stick to move (one lane per push), A to jump, B to roll, X / Y for a Mouse.
  const padHeld = new Set();
  function pollPad() {
    const now = new Set();
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue;
      const ay = pad.axes[1] ?? 0;
      const steer = gamepadSteer();
      if (steer < -0.6) now.add('left');
      if (steer > 0.6) now.add('right');
      if (pad.buttons[12]?.pressed || ay < -0.6 || pad.buttons[0]?.pressed) now.add('up');
      if (pad.buttons[13]?.pressed || ay > 0.6 || pad.buttons[1]?.pressed) now.add('down');
      if (pad.buttons[2]?.pressed || pad.buttons[3]?.pressed) now.add('item');
    }
    if (game?.state === 'running') {
      for (const d of now) {
        if (padHeld.has(d)) continue;
        if (d === 'item') useItem();
        else move(d);
      }
    }
    padHeld.clear();
    for (const d of now) padHeld.add(d);
  }

  // ---------- the game ----------
  const boosted = () => Boolean(game.boost && game.time < game.boost.until);
  const shielded = () => game.time < game.shieldUntil;

  /** Where someone else is now (a little ahead of their last update). */
  function estimate(o) {
    if (!o) return null;
    if (o.bot || o.status !== 'running') return o.dist;
    return o.dist + o.speed * Math.min(1, (performance.now() - o.at) / 1000);
  }
  const opponent = () => [...game.others.values()][0];
  /** Chaser vs Cop: how far the cop is behind the chaser. */
  function gap() {
    const other = estimate(opponent());
    if (other == null) return START_GAP;
    return game.role === 'chaser' ? game.dist - other : other - game.dist;
  }

  function update(dt) {
    const g = game;
    g.time += dt;
    if (g.boost && !boosted()) g.boost = null;
    g.speed = speedAt(g.time);
    let speed = g.speed * (boosted() ? BOOSTS[g.boost.kind].mul : 1);
    if (g.time < g.slowUntil) speed *= g.slowMul;
    // The cop's Mouse: slowed down until the cop is closer than normal.
    if (g.time < g.mouseUntil) {
      if (gap() > START_GAP / 2) speed *= MOUSE_SLOW;
      else g.mouseUntil = 0;
    }
    g.curSpeed = speed;
    const step = speed * dt;
    g.dist += step;
    g.runFrame += step * 0.9;
    // Slide between lanes, jump, roll.
    g.x += (g.lane * LANE - g.x) * Math.min(1, dt * 14);
    if (g.jumpT >= 0) {
      g.jumpT += dt;
      const t = g.jumpT / JUMP_TIME;
      g.y = t >= 1 ? 0 : 4 * JUMP_HEIGHT * t * (1 - t);
      if (t >= 1) g.jumpT = -1;
    } else g.y = 0;
    if (g.rollT >= 0) {
      g.rollT += dt;
      if (g.rollT >= ROLL_TIME) g.rollT = -1;
    }
    for (const o of g.objects) if (o.moving) o.wz -= g.speed * 0.45 * dt;
    place(g.dist);
    // Hits
    for (const o of g.objects) {
      if (o.gone || o.z > 1 || o.z + o.len < -0.4) continue;
      const ox = o.lane * LANE;
      if (Math.abs(g.x - ox) > LANE * 0.55) continue;
      if (o.type === 'bolt') {
        if (Math.abs(g.y + 0.5 - o.y) < 1.2) collectBolt(o);
      } else if (o.type === 'power') {
        o.gone = true;
        power(o.kind);
      } else if (o.type === 'mouse') {
        if (!g.item) {
          o.gone = true;
          g.item = 'mouse';
          announce('You got a Mouse! Tap it to use it', 'mouse');
        }
      } else if (boosted() || shielded()) {
        o.gone = true; // smash through
        g.flash = 0.08;
      } else if (o.type === 'train') {
        return crash('train');
      } else if ((o.type === 'low' && g.y < 0.75) || (o.type === 'high' && g.rollT < 0)) {
        o.gone = true;
        if (stumble()) return;
      }
    }
    if (g.flash > 0) g.flash -= dt;
    // The bot cop: close behind while he's chasing, falling back once you get away (or a Mouse got him).
    const copTarget = g.time < g.copUntil && g.time >= g.copSlowUntil ? -0.9 : -9;
    g.copZ += (copTarget - g.copZ) * Math.min(1, dt * (copTarget > g.copZ ? 4 : 0.8));
    if (g.mode === 'chase' && g.role === 'chaser') {
      if (gap() <= CATCH_GAP) return crash('caught');
      if (g.time >= CHASE_SECONDS) return goOut('escaped');
    }
  }

  /** Where everything is from the camera (o.z: how far ahead). */
  function place(camDist) {
    for (const o of game.objects) o.z = o.wz - camDist;
  }

  function slow(mul, secs) {
    game.slowMul = Math.min(game.time < game.slowUntil ? game.slowMul : 1, mul);
    game.slowUntil = game.time + secs;
    game.flash = 0.12;
  }

  /** Clipped something: the cop catches up. A second time while he's close and he gets you. */
  function stumble() {
    const g = game;
    if (g.mode === 'chase') {
      slow(0.55, 0.8);
      announce(g.role === 'cop' ? 'Stumbled! They\'re getting away' : 'Stumbled! The cop is catching up');
      return false;
    }
    // A Mouse holds the cop back: he can't grab you this second.
    if (g.time < g.stumbleUntil && g.time >= g.copSlowUntil) {
      crash('caught');
      return true;
    }
    g.stumbleUntil = g.time + 8;
    g.copUntil = g.time + 8;
    g.flash = 0.12;
    announce('Watch out, the cop is right behind you!');
    return false;
  }

  function collectBolt(o) {
    o.gone = true;
    const g = game;
    g.bolts += 1;
    // Chaser vs Cop: only Mice, no speed power-ups.
    if (g.mode === 'chase') return;
    // Every 2500 bolts: Triple Speed. Every other 750: Double Speed.
    if (g.bolts % 2500 === 0) power('triple', `${g.bolts} bolts!`);
    else if (g.bolts % 750 === 0) power('double', `${g.bolts} bolts!`);
  }

  function power(kind, why) {
    const g = game;
    if (kind === 'thunder') {
      // Zap everything in the way ahead.
      for (const o of g.objects) if (o.z > 0 && o.z < 45 && ['train', 'low', 'high'].includes(o.type)) o.gone = true;
      g.flash = 0.3;
      announce('Thunder! The way is clear', 'thunder');
      return;
    }
    g.boost = { kind, until: g.time + BOOSTS[kind].secs };
    announce(`${why ? `${why} ` : ''}${BOOSTS[kind].name}! ×${BOOSTS[kind].mul}`, kind);
  }

  function useItem() {
    const g = game;
    if (!g || g.state !== 'running' || g.item !== 'mouse') return;
    g.item = null;
    if (g.mode === 'chase') {
      // Thrown at the chaser: they slow down until you're closer than normal.
      g.uses.push({ kind: 'mouse', id: `m-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}` });
      announce('Mouse! They\'re slowed down', 'mouse');
    } else {
      // The bot cop trips over it: slowed down for 1 second.
      g.copSlowUntil = g.time + 1;
      g.copUntil = Math.max(g.time, g.copUntil - 1);
      g.stumbleUntil = Math.max(g.time, g.stumbleUntil - 1);
      announce('Mouse! The cop is slowed down for 1 second', 'mouse');
    }
    hud();
  }

  let announceTimer = null;
  function announce(text, kind, ms = 1800) {
    const a = els.alert;
    a.replaceChildren();
    if (kind) {
      const img = document.createElement('img');
      img.src = kind === 'thunder' ? BOLT_ICON : kind === 'mouse' ? MOUSE_ICON : BOOSTS[kind].icon;
      img.alt = '';
      a.append(img);
    }
    a.append(text);
    a.hidden = false;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => (a.hidden = true), ms);
  }

  const score = () => Math.max(0, Math.floor(game.dist)) + game.bolts * 5;
  const botScore = (b) => Math.floor(b.dist) + Math.floor(b.bolts) * 5;
  const alive = () => [...game.others.entries()].filter(([, o]) => o.status !== 'out');

  /** Caught or crashed: one revive a game (not in Chaser vs Cop), then you're out. */
  function crash(reason = 'train') {
    const g = game;
    if (reason === 'caught') g.copZ = -0.4; // he's got you
    g.flash = 0;
    if (!g.reviveUsed) {
      g.state = 'down';
      g.reason = reason;
      music.pause();
      render();
      els.onDown({ reason, score: score(), bolts: g.bolts, distance: Math.floor(g.dist), online: g.online, mode: g.mode });
      return;
    }
    goOut(reason);
  }

  function revive() {
    const g = game;
    if (!g || g.state !== 'down' || g.reviveUsed) return;
    g.reviveUsed = true;
    g.state = 'running';
    g.last = performance.now();
    // Chaser vs Cop: back in the chase at the normal gap (the other one kept running).
    if (g.mode === 'chase') {
      const other = estimate(opponent());
      if (other != null) g.dist = g.role === 'chaser' ? Math.max(g.dist, other + START_GAP) : Math.max(g.dist, other - START_GAP);
      place(g.dist);
    }
    // Clear the way, and a moment where nothing can hurt you.
    for (const o of g.objects) if (['train', 'low', 'high'].includes(o.type) && o.wz + o.len > g.dist - 1 && o.wz < g.dist + 25) o.gone = true;
    g.shieldUntil = g.time + REVIVE_SHIELD;
    g.stumbleUntil = 0;
    g.copUntil = g.time + 1.5;
    g.copZ = -2.5;
    g.jumpT = -1;
    g.rollT = -1;
    els.over.hidden = true;
    if (g.songPlaying) music.play(g.songPlaying);
    announce('Revived! That was your one revive', null, 2200);
  }

  /** No more revives (or gave up). */
  function goOut(reason) {
    const g = game;
    if (!g || g.state === 'out' || g.state === 'spectate') return;
    g.reason = reason;
    g.state = 'out';
    g.item = null;
    music.pause();
    render();
    const final = score();
    if (g.mode === 'solo') {
      let best = 0;
      try {
        best = Number(localStorage.getItem(BEST_KEY)) || 0;
        if (final > best) localStorage.setItem(BEST_KEY, String(final));
      } catch {
        // Just for fun.
      }
      g.halted = true;
      els.onOver({ score: final, bolts: g.bolts, distance: Math.floor(g.dist), best: Math.max(best, final), newBest: final > best, reason });
      return;
    }
    if (g.mode === 'chase') {
      // The game's over for both; the server says so on the next update.
      if (g.role === 'chaser') chaseOver(reason === 'escaped' ? 'chaser' : 'cop', reason);
      else chaseOver('chaser', 'cop-train'); // the cop crashed for good
      return;
    }
    // All Chasers / Practice: watch the others, if anyone's still going.
    if (alive().length) {
      g.state = 'spectate';
      g.spectate = alive()[0][0];
      spectating();
    } else if (g.mode === 'practice') practiceResults();
    else els.onWaiting();
  }

  function spectating() {
    const o = game.others.get(game.spectate);
    els.onSpectate({ name: o?.name ?? '', count: alive().length });
  }
  /** Watch the next (or previous) person still running. */
  function spectateNext(step = 1) {
    const g = game;
    if (!g || g.state !== 'spectate') return;
    const list = alive().map(([slot]) => slot);
    if (!list.length) return;
    const i = list.indexOf(g.spectate);
    g.spectate = list[(i + step + list.length) % list.length];
    spectating();
  }

  function practiceResults() {
    const g = game;
    g.finished = true;
    const players = [{ slot: g.mySlot, name: 'You', me: true, score: score(), dist: Math.floor(g.dist) }, ...[...g.others.entries()].map(([slot, b]) => ({ slot, name: b.name, score: botScore(b), dist: Math.floor(b.dist) }))]
      .sort((a, b) => b.score - a.score)
      .map((p, i, list) => ({ ...p, place: list.findIndex((q) => q.score === p.score) + 1 }));
    els.onResults({ mode: 'practice', players, distance: Math.floor(g.dist) });
  }

  function chaseOver(winner, reason) {
    const g = game;
    if (g.finished) return;
    g.finished = true;
    g.state = 'out';
    music.pause();
    els.onResults({ mode: 'chase', winner, reason, role: g.role, time: Math.min(g.time, CHASE_SECONDS), score: score(), distance: Math.max(0, Math.floor(g.dist)) });
  }

  // ---------- practice bots ----------
  function updateBots(dt) {
    const g = game;
    for (const b of g.others.values()) {
      if (!b.bot || b.status === 'out') continue;
      b.time = (b.time ?? 0) + dt;
      b.speed = speedAt(b.time) * b.pace;
      b.dist += b.speed * dt;
      b.bolts += (b.speed * dt) / 2.2;
      // Follow the bolt trail.
      const row = g.rows.find((r) => r.end > b.dist);
      if (row && b.dist > row.z - 9) b.lane = row.safe;
      b.x += (b.lane * LANE - b.x) * Math.min(1, dt * 10);
      // Jump the low barriers, roll under the high ones.
      if (b.jumpT < 0 && b.rollT < 0) {
        const next = g.objects.find((o) => (o.type === 'low' || o.type === 'high') && o.lane === b.lane && o.wz - b.dist > 0 && o.wz - b.dist < 1.6);
        if (next?.type === 'low') b.jumpT = 0;
        else if (next) b.rollT = 0;
      }
      if (b.jumpT >= 0) {
        b.jumpT += dt;
        const t = b.jumpT / JUMP_TIME;
        b.y = t >= 1 ? 0 : 4 * JUMP_HEIGHT * t * (1 - t);
        if (t >= 1) b.jumpT = -1;
      }
      if (b.rollT >= 0) {
        b.rollT += dt;
        if (b.rollT >= ROLL_TIME) b.rollT = -1;
      }
      b.roll = b.rollT >= 0;
      if (b.dist >= b.outAt) {
        b.status = 'out';
        if (g.state === 'running') announce(`🚓 The cop caught ${b.name}!`);
      }
    }
    afterOthersChange();
  }

  /** Someone got caught: maybe watch someone else, or that's the game. */
  function afterOthersChange() {
    const g = game;
    if (g.state !== 'spectate') return;
    if (!alive().length) {
      if (g.mode === 'practice') practiceResults();
      else els.onWaiting();
      g.state = 'out';
      return;
    }
    if (g.others.get(g.spectate)?.status === 'out') spectateNext(1);
  }

  // ---------- online ----------
  let syncing = false;
  let lastSync = 0;
  function maybeSync(t) {
    const g = game;
    if (!g.sync || syncing || t - lastSync < 100 || g.serverDone || g.state === 'countdown') return;
    syncing = true;
    lastSync = t;
    const uses = g.uses.splice(0);
    const sentAt = t;
    const status = g.state === 'down' ? 'down' : g.state === 'out' || g.state === 'spectate' ? 'out' : 'running';
    g.sync({ dist: g.dist, x: g.x, y: g.y, speed: g.state === 'running' ? g.curSpeed : 0, roll: g.rollT >= 0, score: score(), bolts: g.bolts, status, reason: g.reason, uses })
      .then((room) => {
        if (game === g && room) applyRoom(room, performance.now() - sentAt);
      })
      .catch(() => {
        g.uses.unshift(...uses);
      })
      .finally(() => {
        syncing = false;
      });
  }

  function applyRoom(room, rtt = 0) {
    const g = game;
    const now = performance.now();
    for (const p of room.players) {
      if (p.slot === g.mySlot) continue;
      const o = g.others.get(p.slot) ?? { name: p.name };
      const was = o.status;
      o.status = p.gone ? 'out' : p.status;
      if (p.st) Object.assign(o, { dist: p.st.dist, x: p.st.x, y: p.st.y, roll: p.st.roll, speed: p.st.speed, score: p.st.score });
      // Their update reached the server `age` ms ago, and took about a round trip to get here.
      if (p.st) o.at = now - (p.st.age ?? 0) - rtt;
      g.others.set(p.slot, o);
      if (g.mode === 'all' && was !== 'out' && o.status === 'out' && g.state === 'running') announce(`🚓 ${p.name} is out!`);
      if (g.mode === 'chase' && g.state === 'running') {
        if (was === 'running' && o.status === 'down') announce(`💥 ${p.name} crashed! Will they use their revive?`, null, 2400);
        else if (was === 'down' && o.status === 'running') announce(`💖 ${p.name} revived!`);
      }
    }
    // The cop's Mice.
    for (const ev of room.events ?? []) {
      if (g.seenEvents.has(ev.id)) continue;
      g.seenEvents.add(ev.id);
      if (ev.slot !== g.mySlot && ev.kind === 'mouse' && g.state === 'running' && g.role === 'chaser') {
        g.mouseUntil = g.time + MOUSE_MAX_SECS;
        announce('The cop threw a Mouse! You\'re slowed down', 'mouse');
      }
    }
    if (room.state === 'done' && room.results) {
      g.serverDone = true;
      if (g.mode === 'chase') return chaseOver(room.results.winner, room.results.reason);
      g.finished = true;
      g.state = 'out';
      music.pause();
      els.onResults({ mode: 'all', players: room.results.players.map((p) => ({ ...p, me: p.slot === g.mySlot })), distance: Math.floor(g.dist) });
      return;
    }
    afterOthersChange();
  }

  // ---------- drawing ----------
  function project(x, y, z) {
    const dz = z - CAM_Z;
    if (dz <= 0.1) return null;
    return { x: game.w / 2 + ((x - game.camX * 0.35) * game.focal) / dz, y: game.horizon + ((CAM_H - y) * game.focal) / dz, s: game.focal / dz };
  }

  function quad(a, b, c, d, color) {
    if (!a || !b || !c || !d) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fill();
  }

  /** Who the camera follows: you, or who you're spectating. */
  function camera() {
    const g = game;
    if (g.state === 'spectate' || (g.state === 'out' && g.spectate != null)) {
      const o = g.others.get(g.spectate);
      if (o) {
        o.viewX = (o.viewX ?? o.x) + (o.x - (o.viewX ?? o.x)) * 0.3;
        return { dist: estimate(o), x: o.viewX, y: o.y, roll: o.roll, slot: g.spectate };
      }
    }
    return { dist: g.dist, x: g.x, y: g.y, roll: g.rollT >= 0, slot: g.mySlot };
  }

  function render() {
    const g = game;
    const { w, h, horizon } = g;
    const cam = camera();
    g.camX = cam.x;
    if (cam.slot !== g.mySlot) {
      trackFor(Math.min(cam.dist, ...botDists()), Math.max(cam.dist, ...botDists()));
      place(cam.dist);
    }
    ctx.imageSmoothingEnabled = false;
    // Sky and city
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#ff9e6d');
    sky.addColorStop(1, '#ffd29a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon + 1);
    for (let i = 0; i < 14; i++) {
      const bw = 10 + ((i * 37) % 13);
      const bh = 8 + ((i * 53) % 22);
      const bx = (((i * 41 - cam.dist * 0.4) % (w + 40)) + w + 40) % (w + 40) - 20;
      ctx.fillStyle = i % 2 ? '#7a4c6e' : '#5e3a5a';
      ctx.fillRect(Math.round(bx), horizon - bh, bw, bh);
    }
    // Ground
    ctx.fillStyle = '#6b6b6b';
    ctx.fillRect(0, horizon, w, h - horizon);
    const edge = LANE * 1.9;
    for (let z = DRAW_TO; z > CAM_Z + 0.4; z -= 2) {
      const z2 = Math.max(CAM_Z + 0.4, z - 2);
      const band = Math.floor((z + cam.dist) / 2) % 2;
      quad(project(-40, 0, z), project(-edge, 0, z), project(-edge, 0, z2), project(-40, 0, z2), band ? '#4f8a3a' : '#5a9a43');
      quad(project(edge, 0, z), project(40, 0, z), project(40, 0, z2), project(edge, 0, z2), band ? '#4f8a3a' : '#5a9a43');
    }
    // Tracks: gravel, sleepers and rails for each lane.
    quad(project(-edge, 0, DRAW_TO), project(edge, 0, DRAW_TO), project(edge, 0, CAM_Z + 0.4), project(-edge, 0, CAM_Z + 0.4), '#8a7f74');
    const sleeperGap = 1.1;
    const first = sleeperGap - ((cam.dist % sleeperGap) + sleeperGap) % sleeperGap;
    for (let z = first + CAM_Z + 0.5; z < DRAW_TO; z += sleeperGap) {
      for (const lane of [-1, 0, 1]) {
        const cx = lane * LANE;
        quad(project(cx - 0.5, 0, z), project(cx + 0.5, 0, z), project(cx + 0.5, 0, z + 0.25), project(cx - 0.5, 0, z + 0.25), '#5b3b25');
      }
    }
    for (const lane of [-1, 0, 1]) {
      for (const off of [-0.32, 0.32]) {
        const x = lane * LANE + off;
        quad(project(x - 0.05, 0.02, DRAW_TO), project(x + 0.05, 0.02, DRAW_TO), project(x + 0.05, 0.02, CAM_Z + 0.5), project(x - 0.05, 0.02, CAM_Z + 0.5), '#c9ced6');
      }
    }
    // Things on the track, far first.
    const items = g.objects.filter((o) => !o.gone && o.z < DRAW_TO && o.z + o.len > CAM_Z + 0.5);
    items.push(...runners(cam));
    items.sort((p, q) => q.z - p.z);
    for (const o of items) drawObject(o);
    if (g.flash > 0) {
      ctx.fillStyle = `rgba(255, 240, 120, ${Math.min(0.6, g.flash * 3)})`;
      ctx.fillRect(0, 0, w, h);
    }
    hud();
  }
  const botDists = () => [...game.others.values()].filter((b) => b.bot && b.status !== 'out').map((b) => b.dist);

  /** The cat (and cop) sprites to draw: you, whoever you're watching, the others, the cops. */
  function runners(cam) {
    const g = game;
    const list = [];
    const me = cam.slot === g.mySlot;
    const add = (r) => {
      if (r.z > CAM_Z + 0.7 && r.z < DRAW_TO) list.push({ type: 'runner', ...r });
    };
    if (me) {
      const flicker = shielded() && Math.floor(g.time * 12) % 2;
      add({ sprite: g.role === 'cop' ? 'cop' : 'cat', z: 0, x: g.x, y: g.y, roll: g.rollT >= 0, scale: 1.2, alpha: flicker ? 0.4 : 1, boost: g.boost?.kind, main: true });
    } else {
      add({ sprite: 'cat', z: 0, x: cam.x, y: cam.y, roll: cam.roll, scale: 1.2, main: true, name: g.others.get(cam.slot)?.name });
    }
    if (g.mode === 'chase') {
      const o = opponent();
      if (o) {
        const z = estimate(o) - g.dist;
        if (g.role === 'chaser') add({ sprite: 'cop', z: Math.min(-CATCH_GAP, z), x: o.x, y: o.y, roll: o.roll, scale: 1.1, name: o.name });
        else add({ sprite: 'cat', z: Math.max(CATCH_GAP, z), x: o.x, y: o.y, roll: o.roll, scale: 1.2, name: o.name });
      }
      return list;
    }
    // The bot cop chasing you.
    if (me && g.copZ > CAM_Z + 0.7) add({ sprite: 'cop', z: g.copZ, x: g.x + 0.75, y: 0, scale: 0.85, cop: true });
    // Everyone else still running (see-through, with their names).
    for (const [slot, o] of g.others) {
      if (slot === cam.slot || o.status === 'out' || o.dist == null) continue;
      add({ sprite: 'cat', z: estimate(o) - cam.dist, x: o.x, y: o.y, roll: o.roll, scale: 1.2, alpha: 0.65, name: o.name });
    }
    return list;
  }

  function box(x0, x1, y0, y1, z0, z1, front, side, top) {
    // Top
    quad(project(x0, y1, z1), project(x1, y1, z1), project(x1, y1, z0), project(x0, y1, z0), top);
    // Sides (only the one facing the camera shows)
    const camX = game.camX * 0.35;
    if (x1 < camX) quad(project(x1, y1, z0), project(x1, y1, z1), project(x1, y0, z1), project(x1, y0, z0), side);
    if (x0 > camX) quad(project(x0, y1, z0), project(x0, y1, z1), project(x0, y0, z1), project(x0, y0, z0), side);
    // Front
    quad(project(x0, y1, z0), project(x1, y1, z0), project(x1, y0, z0), project(x0, y0, z0), front);
  }

  function drawRunner(o) {
    const g = game;
    const p = project(o.x, o.y, o.z);
    if (!p) return;
    const img = o.sprite === 'cop' ? assets.cop : assets.cat;
    const size = p.s * o.scale;
    // Running: a bounce; rolling: squashed into a ball.
    const rolling = o.roll;
    const moving = g.state === 'running' || g.state === 'spectate' || !o.main;
    const bounce = moving && o.y < 0.05 && !rolling ? Math.abs(Math.sin((g.runFrame + o.z * 0.7 + (o.cop ? 0.5 : 0)) * Math.PI)) * size * 0.07 : 0;
    const hgt = rolling ? size * 0.55 : size;
    const wid = size * (img.width / img.height) * (rolling ? 1.1 : 1);
    const sh = project(o.x, 0, o.z);
    ctx.globalAlpha = o.alpha ?? 1;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(Math.round(sh.x - wid * 0.4), Math.round(sh.y - size * 0.05), Math.round(wid * 0.8), Math.max(1, Math.round(size * 0.08)));
    ctx.drawImage(img, Math.round(p.x - wid / 2), Math.round(p.y - hgt - bounce), Math.round(wid), Math.round(hgt));
    ctx.globalAlpha = 1;
    if (o.boost) {
      ctx.fillStyle = o.boost === 'triple' ? '#00c8d4' : '#00d26a';
      ctx.fillRect(Math.round(p.x - size * 0.3), Math.round(p.y - 2), Math.round(size * 0.6), 2);
    }
    if (o.name && !o.main) {
      ctx.font = 'bold 7px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#fff';
      const ty = Math.round(p.y - hgt - bounce - 2);
      ctx.strokeText(o.name, Math.round(p.x), ty);
      ctx.fillText(o.name, Math.round(p.x), ty);
    }
  }

  function drawObject(o) {
    const g = game;
    if (o.type === 'runner') return drawRunner(o);
    const cx = o.lane * LANE;
    const z0 = Math.max(o.z, CAM_Z + 0.5);
    if (o.type === 'train') {
      const z1 = o.z + o.len;
      box(cx - 0.55, cx + 0.55, 0, 2.2, z0, z1, o.color, shade(o.color), '#9aa3ad');
      // Windscreen and stripe on the front.
      const a = project(cx - 0.4, 1.9, z0);
      const b = project(cx + 0.4, 1.3, z0);
      if (a && b) {
        ctx.fillStyle = '#1b2733';
        ctx.fillRect(Math.round(a.x), Math.round(a.y), Math.max(1, Math.round(b.x - a.x)), Math.max(1, Math.round(b.y - a.y)));
      }
      const s1 = project(cx - 0.55, 0.7, z0);
      const s2 = project(cx + 0.55, 0.55, z0);
      if (s1 && s2) {
        ctx.fillStyle = '#ffd400';
        ctx.fillRect(Math.round(s1.x), Math.round(s1.y), Math.max(1, Math.round(s2.x - s1.x)), Math.max(1, Math.round(s2.y - s1.y)));
      }
      if (o.moving) {
        const l = project(cx, 1.05, z0);
        if (l) {
          ctx.fillStyle = '#fff6a8';
          ctx.fillRect(Math.round(l.x - l.s * 0.12), Math.round(l.y), Math.max(1, Math.round(l.s * 0.24)), Math.max(1, Math.round(l.s * 0.12)));
        }
      }
    } else if (o.type === 'low') {
      // A low barrier: jump over it.
      box(cx - 0.55, cx + 0.55, 0.25, 0.7, z0, z0 + 0.15, '#f2f2f2', '#c9c9c9', '#e0e0e0');
      stripes(cx, 0.25, 0.7, z0);
      for (const lx of [cx - 0.45, cx + 0.45]) box(lx - 0.05, lx + 0.05, 0, 0.25, z0, z0 + 0.1, '#555', '#444', '#666');
    } else if (o.type === 'high') {
      // An overhead barrier: roll under it.
      box(cx - 0.6, cx + 0.6, 1.0, 1.55, z0, z0 + 0.15, '#f2f2f2', '#c9c9c9', '#e0e0e0');
      stripes(cx, 1.0, 1.55, z0);
      for (const lx of [cx - 0.55, cx + 0.55]) box(lx - 0.06, lx + 0.06, 0, 1.0, z0, z0 + 0.1, '#555', '#444', '#666');
    } else if (o.type === 'mouse') {
      // A Kat Kart item box with a Mouse in it.
      const p = project(cx, (o.y ?? 0.7) + Math.sin((g.time + o.wz) * 4) * 0.08, z0);
      if (!p) return;
      const s = Math.max(2, Math.round(p.s * 0.7));
      ctx.fillStyle = 'rgba(255, 210, 26, 0.85)';
      ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(p.x - s / 2) + 0.5, Math.round(p.y - s / 2) + 0.5, s - 1, s - 1);
      const m = Math.round(s * 0.8);
      ctx.drawImage(assets.icons.mouse, Math.round(p.x - m / 2), Math.round(p.y - m / 2), m, m);
    } else if (o.type === 'bolt' || o.type === 'power') {
      const x = typeof o.lane === 'number' ? o.lane * LANE : 0;
      const bob = Math.sin((g.time + o.wz) * 6) * 0.08;
      const p = project(x, (o.y ?? 0.6) + bob, z0);
      if (!p) return;
      const size = p.s * (o.type === 'power' ? 0.85 : 0.55);
      const img = o.type === 'power' ? assets.icons[o.kind] : assets.bolt;
      // Spin: squash sideways.
      const squash = o.type === 'bolt' ? Math.abs(Math.cos((g.time * 4 + o.wz) % Math.PI)) * 0.7 + 0.3 : 1;
      ctx.drawImage(img, Math.round(p.x - (size * squash) / 2), Math.round(p.y - size / 2), Math.max(1, Math.round(size * squash)), Math.round(size));
    }
  }

  function stripes(cx, y0, y1, z) {
    for (let i = 0; i < 4; i++) {
      const a = project(cx - 0.55 + i * 0.3, y1, z);
      const b = project(cx - 0.4 + i * 0.3, y0, z);
      if (!a || !b) continue;
      ctx.fillStyle = '#e5172f';
      ctx.fillRect(Math.round(a.x), Math.round(a.y), Math.max(1, Math.round(b.x - a.x)), Math.max(1, Math.round(b.y - a.y)));
    }
  }

  const shade = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.round(v * 0.7);
    return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
  };

  function hud() {
    const g = game;
    if (!g) return;
    els.score.textContent = score().toLocaleString();
    els.bolts.textContent = g.bolts.toLocaleString();
    const b = g.boost;
    els.boost.hidden = !b;
    if (b) {
      const img = els.boost.querySelector('img');
      if (img.dataset.kind !== b.kind) {
        img.src = BOOSTS[b.kind].icon;
        img.dataset.kind = b.kind;
      }
      els.boost.querySelector('span').style.width = `${Math.max(0, ((b.until - g.time) / BOOSTS[b.kind].secs) * 100)}%`;
    }
    els.item.hidden = !(g.item && g.state === 'running');
    if (g.mode === 'chase') {
      const left = Math.max(0, Math.ceil(CHASE_SECONDS - g.time));
      const metres = Math.max(0, gap()).toFixed(1);
      els.chase.querySelector('.escape-chase-gap').textContent = g.role === 'cop' ? `🐱 ${metres} m ahead` : `🚓 ${metres} m behind`;
      els.chase.querySelector('.escape-chase-time').textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      els.chase.classList.toggle('close', gap() < START_GAP / 2);
    }
  }

  function loop(t) {
    const g = game;
    if (!g || g.halted) return;
    pollPad();
    const dt = Math.min(0.05, (t - g.last) / 1000);
    g.last = t;
    if (g.state === 'countdown') {
      const left = (g.startAt ?? 0) - t;
      if (left <= 0) begin();
      else {
        els.countdown.hidden = false;
        const n = Math.ceil(left / 1000);
        els.countdown.textContent = n > 3 ? 'Get ready…' : String(n);
      }
    }
    if (g.state === 'running') update(dt);
    if (!game || game !== g || g.halted) return;
    // Bots and spectating keep going while you're down or out.
    if (g.mode === 'practice' && g.state !== 'ready' && !g.finished) updateBots(dt);
    if (g.state === 'spectate') g.runFrame += dt * 9;
    if (game !== g || g.halted) return;
    if (g.state === 'running' || g.state === 'ready' || g.state === 'countdown') trackFor(Math.min(g.dist, ...botDists()), Math.max(g.dist, ...botDists()));
    if (g.state !== 'down') {
      if (camera().slot === g.mySlot) place(g.dist);
      render();
    }
    maybeSync(t);
    frame = requestAnimationFrame(loop);
  }

  window.addEventListener('resize', () => game && size());

  return {
    start,
    stop,
    keyDown,
    revive,
    /** Gave up instead of reviving. */
    giveUp: () => game?.state === 'down' && goOut(game.reason),
    spectateNext,
    // Call from a tap (phones only allow sound after one).
    unlockAudio: () => music.unlock(),
    get running() {
      return Boolean(game) && ['ready', 'countdown', 'running'].includes(game.state);
    },
    get mode() {
      return game?.mode ?? null;
    },
    best: () => {
      try {
        return Number(localStorage.getItem(BEST_KEY)) || 0;
      } catch {
        return 0;
      }
    },
  };
}

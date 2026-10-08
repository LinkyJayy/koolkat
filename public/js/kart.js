import { gamepadSteer } from './input.js';

// Kat Kart: a kart race, like Mario Kart, with KoolKat cats, over three laps
// of the Kool Kircuit. Solo: you (always blue) race seven computer Kats, each
// in its own colour, and they get better when you win and easier when you
// don't. Online: up to 8 friends race each other, each in their slot's colour. The road is drawn in pseudo-3D ("Mode 7", like the old
// SNES games): every row of the screen below the horizon is a slice of the
// track map seen from just behind your kart.

const MAP = 1024; // the track map is MAP × MAP world units (1 unit = 1 pixel of the map)
const ROAD_HALF = 30;
const LAPS = 3;
const STEP = 1000 / 60;
const KART_SIZE = 11; // world units across
const CAM_BACK = 34;
const CAM_HEIGHT = 15;

/** Every racer's colour is fixed for the race, and they're all easy to tell apart. */
export const RACERS = [
  { name: 'You', color: '#1f4fff', player: true },
  { name: 'Red Kat', color: '#e5172f' },
  { name: 'Green Kat', color: '#1aa33a' },
  { name: 'Yellow Kat', color: '#ffcc00' },
  { name: 'Purple Kat', color: '#8a2be2' },
  { name: 'Orange Kat', color: '#ff7a00' },
  { name: 'Pink Kat', color: '#ff4fb3' },
  { name: 'Brown Kat', color: '#8b5a2b' },
];

// The Kool Kircuit: a closed loop through these points (smoothed into a curve).
const TRACK = [
  [512, 900], [700, 905], [860, 860], [930, 740], [900, 610], [790, 560], [690, 520], [650, 430],
  [700, 330], [820, 280], [890, 190], [830, 100], [680, 85], [520, 120], [400, 210], [300, 190],
  [190, 130], [105, 200], [110, 340], [200, 430], [320, 480], [380, 580], [330, 690], [210, 730],
  [150, 820], [230, 895], [370, 905],
];
const BOOST_AT = [0.18, 0.43, 0.7, 0.9]; // boost pads, as a fraction of the way round
const ITEM_ROWS_AT = [0.08, 0.3, 0.52, 0.78]; // rows of item boxes
const ITEM_LANES = [-18, -6, 6, 18];
const ITEM_RESPAWN = 3000;
const ROULETTE = 1100; // the item spins this long before you get it

/**
 * Power-ups, from item boxes on the track. The weights set how often each
 * comes up: Triple Speed is half as common as Double Speed, and Food Bowl is
 * rarer than Mouse but more common than Thunder.
 */
export const POWERUPS = {
  double: { name: 'Double Speed', icon: 'icons/powerups/double.png', weight: 40, self: true, mul: 1.5, ms: 3500 },
  triple: { name: 'Triple Speed', icon: 'icons/powerups/triple.png', weight: 20, self: true, mul: 2, ms: 3000 },
  mouse: { name: 'Mouse', icon: 'icons/powerups/mouse.png', weight: 24, mul: 0.5, ms: 4000 },
  food: { name: 'Food Bowl', icon: 'icons/powerups/food.png', weight: 11, mul: 0.25, ms: 3500 },
  thunder: { name: 'Thunder', icon: 'icons/powerups/thunder.png', weight: 5, mul: 0, ms: 2000 },
};
const POWERUP_KINDS = Object.keys(POWERUPS);
export function randomPowerup(rand = Math.random) {
  const total = POWERUP_KINDS.reduce((sum, k) => sum + POWERUPS[k].weight, 0);
  let roll = rand() * total;
  for (const k of POWERUP_KINDS) {
    roll -= POWERUPS[k].weight;
    if (roll < 0) return k;
  }
  return 'double';
}

// For testing: ?katkart-autopilot drives your kart for you.
const AUTOPILOT = typeof location !== 'undefined' && /[?&]katkart-autopilot\b/.test(location.search);

const ordinal = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
export const formatRaceTime = (ms) => {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
};

/** The centre line: the control points smoothed (Catmull-Rom) and spaced ~3 units apart. */
function buildCenterline() {
  const fine = [];
  const n = TRACK.length;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [TRACK[(i - 1 + n) % n], TRACK[i], TRACK[(i + 1) % n], TRACK[(i + 2) % n]];
    for (let t = 0; t < 1; t += 0.02) {
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      fine.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const pts = [fine[0]];
  let acc = 0;
  for (let i = 1; i < fine.length; i++) {
    const [ax, ay] = fine[i - 1];
    const [bx, by] = fine[i];
    acc += Math.hypot(bx - ax, by - ay);
    if (acc >= 3) {
      pts.push(fine[i]);
      acc = 0;
    }
  }
  return pts;
}

function trackPath(ctx, line) {
  ctx.beginPath();
  ctx.moveTo(line[0][0], line[0][1]);
  for (const [x, y] of line) ctx.lineTo(x, y);
  ctx.closePath();
}

/** Draws the track map (grass, curbs, road, start line, boost pads) and the "is this road?" mask. */
function buildTrack(line, boosts) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MAP;
  const ctx = canvas.getContext('2d');
  // Grass, in a checker so you can feel the speed.
  for (let y = 0; y < MAP; y += 32) for (let x = 0; x < MAP; x += 32) {
    ctx.fillStyle = (x + y) % 64 ? '#3da447' : '#46b351';
    ctx.fillRect(x, y, 32, 32);
  }
  ctx.lineJoin = ctx.lineCap = 'round';
  trackPath(ctx, line);
  ctx.strokeStyle = '#e7d7a4';
  ctx.lineWidth = ROAD_HALF * 2 + 26;
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = ROAD_HALF * 2 + 10;
  ctx.stroke();
  ctx.setLineDash([12, 12]);
  ctx.strokeStyle = '#e5172f';
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = '#5d5f66';
  ctx.lineWidth = ROAD_HALF * 2;
  ctx.stroke();
  ctx.setLineDash([10, 18]);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);

  const across = (i) => {
    const [x0, y0] = line[i];
    const [x1, y1] = line[(i + 1) % line.length];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    return { x: x0, y: y0, dx: (x1 - x0) / len, dy: (y1 - y0) / len };
  };
  // Start/finish line: a black and white checker across the road.
  {
    const { x, y, dx, dy } = across(0);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(dy, dx));
    for (let r = 0; r < 2; r++) for (let c = -ROAD_HALF; c < ROAD_HALF; c += 6) {
      ctx.fillStyle = ((c / 6 + r) & 1) ? '#111' : '#fff';
      ctx.fillRect(-6 + r * 6, c, 6, 6);
    }
    ctx.restore();
  }
  // Boost pads: orange arrows.
  for (const b of boosts) {
    const { x, y, dx, dy } = across(b.index);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.fillStyle = '#ffb000';
    ctx.fillRect(-14, -12, 28, 24);
    ctx.fillStyle = '#ff5a00';
    for (const off of [-10, 0]) {
      ctx.beginPath();
      ctx.moveTo(off, -9);
      ctx.lineTo(off + 9, 0);
      ctx.lineTo(off, 9);
      ctx.lineTo(off + 4, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  const texture = new Uint32Array(ctx.getImageData(0, 0, MAP, MAP).data.buffer);

  // Road mask: road and curbs count as road (grass slows you down).
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskCanvas.height = MAP;
  const m = maskCanvas.getContext('2d');
  m.lineJoin = m.lineCap = 'round';
  trackPath(m, line);
  m.strokeStyle = '#fff';
  m.lineWidth = ROAD_HALF * 2 + 10;
  m.stroke();
  const md = m.getImageData(0, 0, MAP, MAP).data;
  const road = new Uint8Array(MAP * MAP);
  for (let i = 0; i < road.length; i++) road[i] = md[i * 4] > 128 ? 1 : 0;
  return { texture, road, preview: canvas };
}

/** The mascot kart from the picture, with its blue body repainted in a racer's colour. */
function kartSprite(image, color) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size);
  const px = data.data;
  const n = parseInt(color.slice(1), 16);
  const [cr, cg, cb] = [n >> 16, (n >> 8) & 255, n & 255];
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    if (b > 100 && b > r + 60 && b > g + 50) {
      const k = b / 255; // the two blues in the picture: 0.75 (body) and 1.0 (seat)
      px[i] = Math.round(cr * k);
      px[i + 1] = Math.round(cg * k);
      px[i + 2] = Math.round(cb * k);
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

let assets = null;
async function loadAssets() {
  if (assets) return assets;
  const line = buildCenterline();
  const boosts = BOOST_AT.map((f) => ({ index: Math.floor(f * line.length) }));
  const track = buildTrack(line, boosts);
  const image = await loadImage('icons/kat-kart.png');
  const sprites = RACERS.map((r) => kartSprite(image, r.color));
  const icons = Object.fromEntries(await Promise.all(POWERUP_KINDS.map(async (k) => [k, await loadImage(POWERUPS[k].icon)])));
  const itemSpots = ITEM_ROWS_AT.flatMap((f) => {
    const i = Math.floor(f * line.length);
    const [x, y] = line[i];
    const [x2, y2] = line[(i + 1) % line.length];
    const h = Math.atan2(y2 - y, x2 - x);
    return ITEM_LANES.map((off) => ({ index: i, x: x - Math.sin(h) * off, y: y + Math.cos(h) * off }));
  });
  assets = { line, boosts, ...track, sprites, icons, itemSpots, itemBox: itemBoxSprite() };
  return assets;
}

// The race music: "Natho Town" by Zalith9 (the Kat Kart OST). Played with
// Web Audio so the loop has no gap; falls back to a plain <audio> loop.
export const RACE_SONG = { title: 'Natho Town', artist: 'Zalith9', src: 'sounds/kat-kart-music.mp3' };

function createRaceMusic() {
  let ctx = null;
  let buffer = null;
  let loading = null;
  let source = null;
  let gain = null;
  let fallback = null;
  const load = () => {
    loading ??= fetch(RACE_SONG.src)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('no music'))))
      .then((data) => ctx.decodeAudioData(data))
      .then((b) => (buffer = b))
      .catch(() => null);
    return loading;
  };
  const stopSource = () => {
    try {
      source?.stop();
    } catch {
      // Already stopped.
    }
    source = null;
  };
  return {
    unlock() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx ??= new AC();
      ctx.resume?.().catch(() => {});
      if (!gain) {
        gain = ctx.createGain();
        gain.gain.value = 0.7;
        gain.connect(ctx.destination);
      }
      load();
    },
    async play() {
      this.unlock();
      if (!ctx) {
        fallback ??= Object.assign(new Audio(RACE_SONG.src), { loop: true, volume: 0.7 });
        fallback.currentTime = 0;
        fallback.play().catch(() => {});
        return;
      }
      await load();
      if (!buffer) return;
      stopSource();
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      source.start();
    },
    pause() {
      stopSource();
      fallback?.pause();
    },
  };
}

/** A spinning rainbow "?" box, in chunky pixels like the rest of the game. */
function itemBoxSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 16, 16);
  ['#ff4f6d', '#ffcc00', '#3ddc84', '#4aa3ff', '#b05cff'].forEach((col, i, all) => grad.addColorStop(i / (all.length - 1), col));
  g.fillStyle = '#000';
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = grad;
  g.fillRect(1, 1, 14, 14);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(2, 2, 12, 3);
  g.fillStyle = '#fff';
  // A pixel "?"
  for (const [x, y] of [[6, 4], [7, 4], [8, 4], [9, 4], [5, 5], [10, 5], [10, 6], [9, 7], [8, 8], [7, 8], [7, 9], [7, 11], [8, 11], [7, 12], [8, 12]]) g.fillRect(x, y, 1, 1);
  return c;
}

/** Distant hills, scrolled as you turn. */
function buildSky(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#4aa3ff');
  sky.addColorStop(1, '#bfe3ff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, height);
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 6; i++) {
    const x = (i / 6) * canvas.width + 20;
    const y = height * (0.2 + (i % 3) * 0.12);
    for (const [ox, r] of [[0, 9], [10, 12], [22, 8]]) {
      ctx.beginPath();
      ctx.arc(x + ox, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const hills = (color, base, amp, freq) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= canvas.width; x += 4) {
      const t = (x / canvas.width) * Math.PI * 2;
      ctx.lineTo(x, height - base - amp * (0.5 + 0.5 * Math.sin(t * freq) * Math.cos(t * (freq + 1))));
    }
    ctx.lineTo(canvas.width, height);
    ctx.fill();
  };
  hills('#7fbf7a', 6, height * 0.35, 3);
  hills('#4f9a52', 2, height * 0.2, 5);
  return canvas;
}

/**
 * Kat Kart in its screen. `els` holds the canvas, HUD and overlay elements;
 * `onFinish(results)` shows the podium.
 */
export function createKatKart(els) {
  const { canvas, minimap } = els;
  const ctx = canvas.getContext('2d');
  let race = null;
  let frame = 0;
  let input = { left: false, right: false };
  const music = createRaceMusic();

  function size() {
    const rect = canvas.parentElement.getBoundingClientRect();
    // Wide windows (PC) get a wider picture.
    const w = rect.width > rect.height ? 384 : 256;
    const h = Math.max(160, Math.min(560, Math.round((w * rect.height) / Math.max(rect.width, 1))));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      race && (race.view = makeView(w, h));
    }
  }
  function makeView(w, h) {
    const horizon = Math.round(h * (h > w ? 0.42 : 0.36));
    return { w, h, horizon, focal: Math.min(w, h * 1.15) * 0.95, image: ctx.createImageData(w, h), sky: buildSky(w, horizon + 1) };
  }

  /**
   * Start a race.
   *   { mode: 'solo', level }: against seven computer Kats; level 1 is easy.
   *   { mode: 'online', mySlot, players: [{ slot, name }], startAt, sync }:
   *     `startAt` is GO in this phone's time; `sync(state)` sends your kart and
   *     resolves with the race from the server.
   */
  async function start(opts = { mode: 'solo', level: 1 }) {
    const a = await loadAssets();
    size();
    const n = a.line.length;
    const online = opts.mode === 'online';
    const level = Math.max(1, Math.min(15, opts.level ?? 1));
    // Bots' top speed compared with yours: 78% at level 1, about 3% more each level.
    const botBase = 0.78 + (level - 1) * 0.03;
    const entrants = online
      ? opts.players.map((p) => ({ ...RACERS[p.slot], slot: p.slot, name: p.slot === opts.mySlot ? 'You' : p.name, player: p.slot === opts.mySlot, remote: p.slot !== opts.mySlot }))
      : RACERS.map((r, i) => ({ ...r, slot: i }));
    const racers = entrants.map((r) => {
      const i = r.slot;
      // Two by two on the grid, behind the line; you start at the back.
      const order = RACERS.length - 1 - i;
      const idx = (n - 6 - Math.floor(order / 2) * 7) % n;
      const [x, y] = a.line[idx];
      const [x2, y2] = a.line[(idx + 1) % n];
      const heading = Math.atan2(y2 - y, x2 - x);
      const side = order % 2 ? 1 : -1;
      return {
        ...r,
        sprite: a.sprites[i],
        target: null,
        x: x - Math.sin(heading) * side * 12,
        y: y + Math.cos(heading) * side * 12,
        heading,
        speed: 0,
        seg: idx,
        lap: -1,
        boost: 0,
        finished: null,
        item: null, // power-up waiting to be used
        rollUntil: 0, // the item box roulette is spinning until then
        useAt: 0, // computer Kats use theirs at this time
        boostMul: 1,
        boostUntil: 0,
        slowMul: 1,
        slowUntil: 0,
        slowKind: null,
        // Computer Kats: a little slower or faster, and each likes its own line.
        skill: r.player || r.remote ? 1 : botBase + (((i * 37) % 7) - 3) / 100,
        lane: r.player ? 0 : ((i * 53) % 21) - 10,
        wobble: Math.random() * Math.PI * 2,
      };
    });
    const player = racers.find((r) => r.player);
    race = {
      a,
      racers,
      player,
      online,
      level,
      sync: opts.sync,
      view: makeView(canvas.width, canvas.height),
      state: 'countdown',
      // GO is 3 seconds from now (solo) or when the server says (online).
      goAt: online ? opts.startAt : performance.now() + 3000,
      startTime: 0,
      now: 0,
      camHeading: player.heading,
      last: performance.now(),
      acc: 0,
      finishedAt: 0,
      boxesTakenUntil: new Map(), // item box -> when it comes back
      pendingUses: [], // online: power-ups to tell the others about
      seenEvents: new Set(),
      flashUntil: 0,
    };
    renderItem();
    els.countdown.hidden = false;
    els.podium.hidden = true;
    cancelAnimationFrame(frame);
    clearInterval(syncTimer);
    if (online) syncTimer = setInterval(sendSync, 100);
    frame = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(frame);
    clearInterval(syncTimer);
    music.pause();
    race = null;
  }

  // ---------- online: share where you are, see where everyone else is ----------
  let syncTimer = null;
  let syncing = false;
  async function sendSync() {
    if (!race?.online || syncing) return;
    const me = race.player;
    syncing = true;
    try {
      const room = await race.sync({
        x: me.x,
        y: me.y,
        h: me.heading,
        v: me.speed,
        progress: me.progress ?? me.seg - race.a.line.length,
        lap: me.lap,
        finished: me.finished,
        uses: race.pendingUses.splice(0),
      });
      if (!race || !room) return;
      // Power-ups the others used on everyone (you included).
      for (const ev of room.events ?? []) {
        if (race.seenEvents.has(ev.id)) continue;
        race.seenEvents.add(ev.id);
        if (ev.slot === race.player.slot || POWERUPS[ev.kind]?.self) continue;
        const from = race.racers.find((x) => x.slot === ev.slot);
        hit(race.player, ev.kind, from);
      }
      for (const p of room.players) {
        const r = race.racers.find((x) => x.slot === p.slot);
        if (!r || !r.remote) continue;
        r.gone = p.gone;
        if (p.finished != null && r.finished == null) r.finished = p.finished;
        if (p.st) r.target = p.st;
      }
      if (room.state === 'done' && race.state !== 'done') endOnline(room.results);
    } catch {
      // A missed update: the next one catches up.
    } finally {
      syncing = false;
    }
  }

  const onRoad = (x, y) => {
    const ix = x | 0;
    const iy = y | 0;
    return ix >= 0 && iy >= 0 && ix < MAP && iy < MAP && race.a.road[iy * MAP + ix] === 1;
  };

  function updateSeg(r) {
    const line = race.a.line;
    const n = line.length;
    let best = r.seg;
    let bestD = Infinity;
    for (let k = -15; k <= 40; k++) {
      const i = (r.seg + k + n) % n;
      const d = (line[i][0] - r.x) ** 2 + (line[i][1] - r.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const delta = best - r.seg;
    if (delta < -n / 2) r.lap += 1; // crossed the line going forwards
    else if (delta > n / 2) r.lap -= 1; // backwards
    r.seg = best;
    r.progress = r.lap * n + best;
  }

  function step() {
    const { racers, a } = race;
    const n = a.line.length;
    const player = race.player;
    for (const r of racers) {
      if (r.remote) {
        // Someone else's kart: keep it moving between updates, and ease it
        // towards where they said they were.
        const t = r.target;
        if (t) {
          r.speed = t.v;
          let dh = t.h - r.heading;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          r.heading += dh * 0.3;
          r.x += Math.cos(r.heading) * r.speed;
          r.y += Math.sin(r.heading) * r.speed;
          r.x += (t.x - r.x) * 0.15;
          r.y += (t.y - r.y) * 0.15;
          t.x += Math.cos(t.h) * t.v;
          t.y += Math.sin(t.h) * t.v;
          r.lap = t.lap;
          updateSeg(r);
          r.progress = Math.max(r.progress ?? -Infinity, t.progress);
        }
        continue;
      }
      let steer;
      const autopilot = !r.player || r.finished != null || AUTOPILOT;
      if (autopilot) {
        // Aim at a point a little further round the track, on its favourite line.
        const look = (r.seg + 16) % n;
        const [tx, ty] = a.line[look];
        const [nx, ny] = a.line[(look + 1) % n];
        const h = Math.atan2(ny - ty, nx - tx);
        const lane = r.lane + Math.sin(race.now / 900 + r.wobble) * 4;
        const gx = tx - Math.sin(h) * lane;
        const gy = ty + Math.cos(h) * lane;
        let diff = Math.atan2(gy - r.y, gx - r.x) - r.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        steer = Math.max(-1, Math.min(1, diff * 3));
      } else {
        // Touch or keyboard (A/D, arrows); otherwise a controller's D-pad or sticks.
        steer = (input.right ? 1 : 0) - (input.left ? 1 : 0) || gamepadSteer();
      }
      const road = onRoad(r.x, r.y);
      let max = road ? 2.6 : 1.1;
      if (!r.player) {
        // Keep the race close: Kats far behind you speed up a bit, far ahead slow down.
        const gap = (player.progress ?? 0) - (r.progress ?? 0);
        max *= r.skill * (1 + Math.max(-0.08, Math.min(0.1, gap / 1500)));
      }
      if (r.boost > 0) {
        max = 3.8;
        r.boost -= 1;
      }
      // Power-ups: your own speed boost, and slow-downs from the others.
      if (race.now < r.boostUntil) max *= r.boostMul;
      if (race.now < r.slowUntil) {
        max *= r.slowMul;
        if (r.slowMul === 0) r.speed = 0; // Thunder: frozen
      } else r.slowKind = null;
      if (r.finished != null && r.player) max *= 0.8;
      r.speed += (max - r.speed) * (r.speed < max ? 0.025 : 0.08);
      r.heading += steer * 0.042 * Math.min(1, r.speed / 1.2);
      r.x = Math.max(4, Math.min(MAP - 4, r.x + Math.cos(r.heading) * r.speed));
      r.y = Math.max(4, Math.min(MAP - 4, r.y + Math.sin(r.heading) * r.speed));
      updateSeg(r);
      for (const b of a.boosts) {
        const d = (r.seg - b.index + n) % n;
        if (d < 5) {
          const [bx, by] = a.line[b.index];
          if (Math.hypot(r.x - bx, r.y - by) < 20) r.boost = 50;
        }
      }
      pickUpItems(r);
      if (!r.player && r.item && race.now >= r.useAt && r.finished == null) useItem(r);
      if (r.finished == null && r.lap >= LAPS && !r.remote) {
        r.finished = race.now - race.startTime;
        if (r.player) race.finishedAt = race.now;
      }
    }
    // Bump into each other.
    for (let i = 0; i < racers.length; i++) for (let j = i + 1; j < racers.length; j++) {
      const p = racers[i];
      const q = racers[j];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < 9) {
        // Only karts this phone drives get pushed (others move on their own phones).
        const push = (9 - d) / (p.remote || q.remote ? 1 : 2);
        if (!p.remote) {
          p.x -= (dx / d) * push;
          p.y -= (dy / d) * push;
        }
        if (!q.remote) {
          q.x += (dx / d) * push;
          q.y += (dy / d) * push;
        }
        p.speed *= 0.97;
        q.speed *= 0.97;
      }
    }
  }

  // ---------- power-ups ----------
  function pickUpItems(r) {
    const { itemSpots } = race.a;
    const n = race.a.line.length;
    for (let i = 0; i < itemSpots.length; i++) {
      const spot = itemSpots[i];
      if ((race.boxesTakenUntil.get(i) ?? 0) > race.now) continue;
      if ((r.seg - spot.index + n) % n > 8) continue;
      if (Math.hypot(r.x - spot.x, r.y - spot.y) > 9) continue;
      race.boxesTakenUntil.set(i, race.now + ITEM_RESPAWN);
      if (r.item || race.now < r.rollUntil || r.finished != null) continue;
      r.rollUntil = race.now + ROULETTE;
      const kind = randomPowerup();
      setTimeout(() => {
        if (!race) return;
        r.item = kind;
        r.useAt = race.now + 800 + Math.random() * 3000;
        if (r.player) renderItem();
      }, ROULETTE);
    }
  }

  function useItem(r) {
    const kind = r.item;
    if (!kind) return;
    r.item = null;
    const p = POWERUPS[kind];
    if (p.self) {
      r.boostMul = p.mul;
      r.boostUntil = race.now + p.ms;
    } else {
      for (const other of race.racers) if (other !== r && !other.remote) hit(other, kind, r);
    }
    if (r.player) {
      if (race.online) race.pendingUses.push({ id: `${r.slot}-${Math.random().toString(36).slice(2, 10)}`, kind });
      renderItem();
      alertText(p.self ? `${p.name}! ×${p.mul}` : `${p.name}! Everyone else slows down`, kind);
    }
  }

  function hit(r, kind, from) {
    if (r.finished != null) return;
    const p = POWERUPS[kind];
    r.slowMul = p.mul;
    r.slowUntil = race.now + p.ms;
    r.slowKind = kind;
    if (r.player) {
      if (kind === 'thunder') race.flashUntil = race.now + 250;
      alertText(`${p.name} from ${from?.player ? 'you' : from?.name ?? 'someone'}!`, kind);
    }
  }

  function renderItem() {
    const b = els.item;
    if (!b || !race) return;
    const me = race.player;
    const rolling = race.now < me.rollUntil;
    b.hidden = !me.item && !rolling;
    b.classList.toggle('rolling', rolling);
    const kind = rolling ? POWERUP_KINDS[Math.floor(race.now / 90) % POWERUP_KINDS.length] : me.item;
    const img = b.querySelector('img');
    if (kind && img.dataset.kind !== kind) {
      img.src = POWERUPS[kind].icon;
      img.dataset.kind = kind;
      b.setAttribute('aria-label', rolling ? 'Spinning…' : `Use ${POWERUPS[kind].name}`);
    }
  }

  let alertTimer = null;
  function alertText(text, kind) {
    const a = els.alert;
    if (!a) return;
    a.replaceChildren();
    if (kind) {
      const img = document.createElement('img');
      img.src = POWERUPS[kind].icon;
      img.alt = '';
      a.append(img);
    }
    a.append(text);
    a.hidden = false;
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => (a.hidden = true), 1800);
  }

  function usePlayerItem() {
    if (!race || race.state !== 'racing' || race.now < race.player.rollUntil) return;
    useItem(race.player);
  }

  // A controller's A, X or a shoulder button uses your power-up.
  let padUseHeld = false;
  function pollPadUse() {
    let down = false;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (pad && [0, 2, 5, 7].some((i) => pad.buttons[i]?.pressed)) down = true;
    }
    if (down && !padUseHeld) usePlayerItem();
    padUseHeld = down;
  }

  function standings() {
    return race.racers.slice().sort((p, q) => {
      if (p.finished != null || q.finished != null) {
        if (p.finished == null) return 1;
        if (q.finished == null) return -1;
        return p.finished - q.finished;
      }
      return (q.progress ?? 0) - (p.progress ?? 0);
    });
  }

  function render() {
    const { view, a, player } = race;
    const { w, h, horizon, focal, image, sky } = view;
    // Camera: behind the kart, turning a little after it.
    let diff = player.heading - race.camHeading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    race.camHeading += diff * 0.25;
    const ch = race.camHeading;
    const fx = Math.cos(ch);
    const fy = Math.sin(ch);
    const rx = -fy;
    const ry = fx;
    const camX = player.x - fx * CAM_BACK;
    const camY = player.y - fy * CAM_BACK;
    const out = new Uint32Array(image.data.buffer);
    const tex = a.texture;
    const grass = tex[5];
    for (let y = horizon + 1; y < h; y++) {
      const dist = (CAM_HEIGHT * focal) / (y - horizon);
      const half = (w / 2) * (dist / focal);
      let wx = camX + fx * dist - rx * half;
      let wy = camY + fy * dist - ry * half;
      const sx = (rx * dist) / focal;
      const sy = (ry * dist) / focal;
      let o = y * w;
      for (let x = 0; x < w; x++) {
        const ix = wx | 0;
        const iy = wy | 0;
        out[o++] = ix >= 0 && iy >= 0 && ix < MAP && iy < MAP ? tex[iy * MAP + ix] : grass;
        wx += sx;
        wy += sy;
      }
    }
    ctx.putImageData(image, 0, 0, 0, horizon, w, h - horizon);
    // Sky and hills, sliding as you turn.
    const offset = (((ch / (Math.PI * 2)) * sky.width) % sky.width + sky.width) % sky.width;
    ctx.drawImage(sky, -offset, 0);
    ctx.drawImage(sky, sky.width - offset, 0);
    if (offset < sky.width - w) ctx.drawImage(sky, -offset + sky.width, 0);

    // Karts and item boxes, far ones first.
    const visible = [];
    const project = (x, y) => {
      const dx = x - camX;
      const dy = y - camY;
      return { dz: dx * fx + dy * fy, lx: dx * rx + dy * ry };
    };
    for (const r of race.racers) {
      const { dz, lx } = project(r.x, r.y);
      if (dz < 6) continue;
      visible.push({ r, dz, lx });
    }
    a.itemSpots.forEach((spot, i) => {
      if ((race.boxesTakenUntil.get(i) ?? 0) > race.now) return;
      const { dz, lx } = project(spot.x, spot.y);
      if (dz < 6 || dz > 500) return;
      visible.push({ box: true, dz, lx });
    });
    visible.sort((p, q) => q.dz - p.dz);
    ctx.imageSmoothingEnabled = false;
    for (const { r, box, dz, lx } of visible) {
      if (box) {
        const size = (6 * focal) / dz;
        const bx = w / 2 + (lx * focal) / dz;
        const by = horizon + (CAM_HEIGHT * focal) / dz - size * (1.2 + 0.15 * Math.sin(race.now / 200 + dz));
        ctx.drawImage(a.itemBox, bx - size / 2, by, size, size);
        continue;
      }
      const sizePx = (KART_SIZE * focal) / dz;
      const sx = w / 2 + (lx * focal) / dz;
      const sy = horizon + (CAM_HEIGHT * focal) / dz;
      const bob = r.speed > 0.5 ? Math.sin(race.now / 60 + r.wobble) * sizePx * 0.015 : 0;
      ctx.drawImage(r.sprite, sx - sizePx / 2, sy - sizePx * 0.92 + bob, sizePx, sizePx);
      if ((r.boost > 0 || race.now < r.boostUntil) && dz < 200) {
        ctx.fillStyle = 'rgba(255,170,0,0.8)';
        ctx.fillRect(sx - sizePx * 0.15, sy - sizePx * 0.05, sizePx * 0.3, sizePx * 0.12);
      }
      // Slowed down: the power-up that hit them floats above them.
      if (r.slowKind && race.now < r.slowUntil) {
        const icon = a.icons[r.slowKind];
        const s2 = Math.max(8, sizePx * 0.45);
        ctx.drawImage(icon, sx - s2 / 2, sy - sizePx * 1.05 - s2, s2, s2);
      }
    }
    if (race.now < race.flashUntil) {
      ctx.fillStyle = 'rgba(255, 230, 80, 0.45)';
      ctx.fillRect(0, 0, w, h);
    }
    drawMinimap();
    drawHud();
  }

  function drawMinimap() {
    const m = minimap.getContext('2d');
    const s = minimap.width / MAP;
    m.clearRect(0, 0, minimap.width, minimap.height);
    m.save();
    m.scale(s, s);
    m.lineJoin = m.lineCap = 'round';
    trackPath(m, race.a.line);
    m.strokeStyle = 'rgba(0,0,0,0.45)';
    m.lineWidth = ROAD_HALF * 2 + 26;
    m.stroke();
    m.strokeStyle = '#fff';
    m.lineWidth = ROAD_HALF * 1.4;
    m.stroke();
    for (const r of race.racers.slice().reverse()) {
      m.beginPath();
      m.arc(r.x, r.y, r.player ? 34 : 26, 0, Math.PI * 2);
      m.fillStyle = r.color;
      m.fill();
      m.lineWidth = r.player ? 12 : 6;
      m.strokeStyle = r.player ? '#fff' : '#000';
      m.stroke();
    }
    m.restore();
  }

  function drawHud() {
    if (race.now < race.player.rollUntil || els.item?.classList.contains('rolling')) renderItem();
    const order = standings();
    const place = order.indexOf(race.player) + 1;
    els.place.textContent = ordinal(place);
    els.place.dataset.place = String(place);
    const lap = Math.min(LAPS, Math.max(1, race.player.lap + 1));
    els.lap.textContent = `Lap ${lap}/${LAPS}`;
    const t = race.state === 'countdown' ? 0 : (race.player.finished ?? race.now - race.startTime);
    els.time.textContent = formatRaceTime(t);
    els.board.replaceChildren(
      ...order.slice(0, 8).map((r, i) => {
        const row = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'kk-dot';
        dot.style.background = r.color;
        row.className = `${r.player ? 'me' : ''}${r.gone ? ' gone' : ''}`;
        row.append(`${i + 1}`, dot, r.player ? 'You' : r.name.replace(/ Kat$/, ''));
        return row;
      })
    );
  }

  function loop(t) {
    if (!race || race.state === 'done') return;
    race.now = t;
    if (race.state === 'countdown') {
      // 3, 2, 1, GO! (silent)
      const left = Math.ceil((race.goAt - t) / 1000);
      els.countdown.textContent = left > 3 ? 'Get ready…' : left > 0 ? String(left) : 'GO!';
      els.countdown.classList.toggle('go', left <= 0);
      if (left <= 0) {
        race.state = 'racing';
        race.startTime = t;
        race.last = t;
        music.play();
        showNowPlaying();
        setTimeout(() => race && (els.countdown.hidden = true), 700);
      }
    } else {
      pollPadUse();
      race.acc += Math.min(250, t - race.last);
      race.last = t;
      while (race.acc >= STEP) {
        step();
        race.acc -= STEP;
      }
      // After you finish, the others get a few seconds to cross the line too.
      if (race.state === 'racing' && race.player.finished != null) {
        race.state = 'finishing';
        els.finish.hidden = false;
      }
      // Solo: the bots get a few seconds to finish. Online: the server decides when it's over.
      if (race.state === 'finishing' && race.online && t - race.finishedAt > 45000) return end(); // lost touch with the server
      if (race.state === 'finishing' && !race.online) {
        // Wait for the podium (top 3) to fill, but not forever.
        const done = race.racers.filter((r) => r.finished != null).length;
        const waited = t - race.finishedAt;
        if (done === race.racers.length || (waited > 6000 && done >= 3) || waited > 20000) return end();
      }
    }
    render();
    frame = requestAnimationFrame(loop);
  }

  function end() {
    const order = standings();
    const results = order.map((r, i) => ({
      place: i + 1,
      name: r.name,
      color: r.color,
      player: Boolean(r.player),
      time: r.finished,
      sprite: r.sprite.toDataURL('image/png'),
    }));
    finishRace(results);
  }

  function endOnline(serverResults) {
    const results = serverResults.map((p) => {
      const r = race.racers.find((x) => x.slot === p.slot);
      return {
        place: p.place,
        name: r?.player ? 'You' : p.name,
        color: RACERS[p.slot].color,
        player: Boolean(r?.player),
        time: p.time,
        gone: p.gone,
        sprite: (r ?? race.racers[0]).sprite.toDataURL('image/png'),
      };
    });
    finishRace(results);
  }

  function finishRace(results) {
    music.pause();
    clearInterval(syncTimer);
    els.finish.hidden = true;
    race.state = 'done';
    render();
    els.onFinish(results, { mode: race.online ? 'online' : 'solo', level: race.level });
  }

  // Controls: hold the left or right half of the screen (or the arrow keys / A, D).
  function setTouch(e) {
    if (!race) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    let left = false;
    let right = false;
    for (const p of activePointers.values()) {
      if (p < rect.left + rect.width / 2) left = true;
      else right = true;
    }
    input.left = left;
    input.right = right;
    e?.preventDefault?.();
  }
  const activePointers = new Map();
  const stage = canvas.parentElement;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    activePointers.set(e.pointerId, e.clientX);
    stage.setPointerCapture?.(e.pointerId);
    setTouch(e);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, e.clientX);
    setTouch(e);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stage.addEventListener(type, (e) => {
      activePointers.delete(e.pointerId);
      setTouch(e);
    });
  }
  function onKey(e, down) {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') input.left = down;
    else if (k === 'arrowright' || k === 'd') input.right = down;
    else if (k === ' ' || k === 'w' || k === 'arrowup' || k === 'e') {
      if (down && !e.repeat) usePlayerItem();
    } else return;
    e.preventDefault();
  }
  window.addEventListener('resize', () => race && size());
  els.item?.addEventListener('click', usePlayerItem);

  function showNowPlaying() {
    const note = els.nowPlaying;
    if (!note) return;
    note.hidden = false;
    note.classList.remove('show');
    void note.offsetWidth;
    note.classList.add('show');
    clearTimeout(note.timer);
    note.timer = setTimeout(() => {
      note.classList.remove('show');
      note.timer = setTimeout(() => (note.hidden = true), 500);
    }, 4500);
  }

  return {
    start,
    stop,
    // Call from a tap (phones only allow sound after one), before the race starts.
    unlockAudio: () => music.unlock(),
    keyDown: (e) => onKey(e, true),
    keyUp: (e) => onKey(e, false),
    get running() {
      return Boolean(race);
    },
    previewTrack: async () => (await loadAssets()).preview,
  };
}

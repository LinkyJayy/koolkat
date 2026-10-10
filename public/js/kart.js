import { gamepadSteer, onPress } from './input.js';
import { KART_MAPS, KART_MAP_SCALE, KART_MAP_SIZE, kartMap } from './kart-maps.js';

// Kat Kart: a kart race, like Mario Kart, with KoolKat cats, over three laps
// of a track (Kool Kircuit, Nighttime, Crystal Cavern, Kingdom or Gold Mine). Solo: you (always blue) race seven computer Kats, each
// in its own colour, and they get better when you win and easier when you
// don't. Online: up to 8 friends race each other, each in their slot's colour. The road is drawn in pseudo-3D ("Mode 7", like the old
// SNES games): every row of the screen below the horizon is a slice of the
// track map seen from just behind your kart.

const MAP = KART_MAP_SIZE; // the track map is MAP × MAP world units (1 unit = 1 pixel of the map)
const ROAD_HALF = 30;
const LAPS = 3;
const STEP = 1000 / 60;
const KART_SIZE = 11; // world units across
const CAM_BACK = 34;
const CAM_HEIGHT = 15;
const FAR = 1100; // how far you can see
const DEPTH_ROWS = 64; // how finely we remember how far away the ground on each part of the screen is (for hiding karts behind hills)

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

export { KART_MAPS };
const BOOST_AT = [0.18, 0.43, 0.7, 0.9]; // boost pads, as a fraction of the way round
const ITEM_ROWS_AT = [0.08, 0.3, 0.52, 0.78]; // rows of item boxes
const ITEM_LANES = [-18, -6, 6, 18];
const ITEM_RESPAWN = 900; // boxes come back quickly, so the Kats behind get one too
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
function buildCenterline(points) {
  const TRACK = points.map(([x, y]) => [x * KART_MAP_SCALE, y * KART_MAP_SCALE]);
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

/** A repeatable random number generator, so a map's scenery is the same every time. */
function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** A gem with rainbow facets, `s` across, centred on (x, y). */
function rainbowGem(ctx, x, y, s, hue = 0) {
  const grad = ctx.createLinearGradient(x - s / 2, y - s / 2, x + s / 2, y + s / 2);
  for (let k = 0; k <= 6; k++) grad.addColorStop(k / 6, `hsl(${(hue + k * 60) % 360} 95% 60%)`);
  ctx.fillStyle = grad;
  ctx.strokeStyle = 'rgba(40,20,80,0.8)';
  ctx.lineWidth = Math.max(1, s / 12);
  ctx.beginPath();
  ctx.moveTo(x - s * 0.5, y - s * 0.15);
  ctx.lineTo(x - s * 0.25, y - s * 0.45);
  ctx.lineTo(x + s * 0.25, y - s * 0.45);
  ctx.lineTo(x + s * 0.5, y - s * 0.15);
  ctx.lineTo(x, y + s * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.moveTo(x - s * 0.25, y - s * 0.45);
  ctx.lineTo(x, y - s * 0.15);
  ctx.lineTo(x - s * 0.5, y - s * 0.15);
  ctx.closePath();
  ctx.fill();
}

/** Scenery on the ground away from the road (the road is drawn over it). */
const GROUND_DECOR = {
  'rainbow-wonderland'(ctx, rand) {
    // Rainbow ground: bands of colour sweeping across the map, with a light checker for speed.
    const grad = ctx.createLinearGradient(0, 0, MAP, MAP);
    for (let k = 0; k <= 18; k++) grad.addColorStop(k / 18, `hsl(${(k * 60) % 360} 85% 62%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, MAP, MAP);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    for (let y = 0; y < MAP; y += 32) for (let x = (y / 32) % 2 ? 32 : 0; x < MAP; x += 64) ctx.fillRect(x, y, 32, 32);
    // Rainbow gems everywhere, and sparkles.
    for (let i = 0; i < 520; i++) rainbowGem(ctx, rand() * MAP, rand() * MAP, 8 + rand() * 14, rand() * 360);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(rand() * MAP, rand() * MAP, 2, 2);
    }
  },
  nighttime(ctx, rand) {
    // City blocks with lit windows.
    for (let i = 0; i < 140; i++) {
      const [x, y, w, h] = [rand() * MAP, rand() * MAP, 30 + rand() * 50, 30 + rand() * 50];
      ctx.fillStyle = rand() < 0.5 ? '#1c1f2c' : '#232737';
      ctx.fillRect(x, y, w, h);
      for (let wy = y + 5; wy < y + h - 6; wy += 9) for (let wx = x + 5; wx < x + w - 6; wx += 9) {
        if (rand() < 0.45) {
          ctx.fillStyle = rand() < 0.8 ? '#ffd86b' : '#7fd3ff';
          ctx.fillRect(wx, wy, 4, 4);
        }
      }
    }
  },
  'crystal-cavern'(ctx, rand) {
    // Rocky floor and glowing crystals.
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rand() < 0.5 ? '#1d142c' : '#32264a';
      ctx.fillRect(rand() * MAP, rand() * MAP, 6 + rand() * 14, 4 + rand() * 10);
    }
    const colors = ['#5ef2ff', '#ff5ed8', '#b47cff', '#7dffb2'];
    for (let i = 0; i < 260; i++) {
      const [x, y, s] = [rand() * MAP, rand() * MAP, 6 + rand() * 12];
      ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s * 0.55, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s * 0.55, y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(x - 1, y - s * 0.6, 2, s * 0.6);
    }
  },
  kingdom(ctx, rand) {
    // Inside the castle: a flagstone floor, rugs, stone pillars and torches.
    ctx.strokeStyle = 'rgba(40,36,52,0.55)';
    ctx.lineWidth = 2;
    for (let y = 0; y < MAP; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(MAP, y);
      ctx.stroke();
      for (let x = (y / 48) % 2 ? 32 : 0; x < MAP; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + 48);
        ctx.stroke();
      }
    }
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
      ctx.fillRect(Math.floor(rand() * 32) * 64, Math.floor(rand() * 43) * 48, 62, 46);
    }
    // Royal rugs.
    for (let i = 0; i < 26; i++) {
      const [x, y, w, h] = [rand() * MAP, rand() * MAP, 70 + rand() * 60, 50 + rand() * 40];
      ctx.fillStyle = '#e8c040';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = rand() < 0.5 ? '#2a3fa8' : '#7a1a8a';
      ctx.fillRect(x + 5, y + 5, w - 10, h - 10);
      ctx.fillStyle = '#e8c040';
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y + 12);
      ctx.lineTo(x + w - 14, y + h / 2);
      ctx.lineTo(x + w / 2, y + h - 12);
      ctx.lineTo(x + 14, y + h / 2);
      ctx.closePath();
      ctx.fill();
    }
    // Stone pillars in rows, with a torch glowing by every other one.
    for (let y = 80; y < MAP; y += 200) for (let x = (y / 200) % 2 ? 180 : 80; x < MAP; x += 200) {
      const [px, py] = [x + (rand() - 0.5) * 30, y + (rand() - 0.5) * 30];
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.arc(px + 5, py + 6, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#6d6878';
      ctx.fillRect(px - 20, py - 20, 40, 40);
      ctx.fillStyle = '#c9c4d2';
      ctx.beginPath();
      ctx.arc(px, py, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e6e2ec';
      ctx.beginPath();
      ctx.arc(px - 4, py - 4, 7, 0, Math.PI * 2);
      ctx.fill();
      if (rand() < 0.5) {
        const glow = ctx.createRadialGradient(px + 26, py, 0, px + 26, py, 26);
        glow.addColorStop(0, 'rgba(255,200,80,0.9)');
        glow.addColorStop(1, 'rgba(255,140,40,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(px, py - 26, 52, 52);
        ctx.fillStyle = '#ff9a1f';
        ctx.fillRect(px + 23, py - 3, 6, 6);
      }
    }
  },
  'gold-mine'(ctx, rand) {
    // Rocks and gold nuggets in the dirt.
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = rand() < 0.5 ? '#6f4c28' : '#7d5a34';
      ctx.beginPath();
      ctx.arc(rand() * MAP, rand() * MAP, 3 + rand() * 9, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 320; i++) {
      const [x, y, s] = [rand() * MAP, rand() * MAP, 3 + rand() * 6];
      ctx.fillStyle = '#ffcc33';
      ctx.fillRect(x, y, s, s * 0.8);
      ctx.fillStyle = '#fff2a8';
      ctx.fillRect(x, y, s * 0.4, s * 0.3);
    }
  },
};

/** Stroke a line running alongside the centre line, `off` units to its side. */
function offsetPath(ctx, line, off) {
  ctx.beginPath();
  line.forEach(([x, y], i) => {
    const [x2, y2] = line[(i + 1) % line.length];
    const h = Math.atan2(y2 - y, x2 - x);
    const px = x - Math.sin(h) * off;
    const py = y + Math.cos(h) * off;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  });
  ctx.closePath();
  ctx.stroke();
}

/** Extras on top of the road. */
const ROAD_DECOR = {
  'rainbow-wonderland'(ctx, line) {
    // A rainbow road: its colour changes all the way round (three rainbows a lap),
    // with rainbow-striped curbs.
    const n = line.length;
    const seg = (i, width, color) => {
      const [x0, y0] = line[i];
      const [x1, y1] = line[(i + 1) % n];
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) if (Math.floor(i / 4) % 2) seg(i, ROAD_HALF * 2 + 10, `hsl(${(i / n) * 1080 + 180} 95% 60%)`);
    for (let i = 0; i < n; i++) seg(i, ROAD_HALF * 2, `hsl(${(i / n) * 1080} 75% 50%)`);
    // A shine down the middle.
    for (let i = 0; i < n; i++) seg(i, ROAD_HALF * 0.7, `hsl(${(i / n) * 1080 + 20} 85% 62%)`);
  },
  nighttime(ctx, line) {
    // Streetlights along both sides, glowing.
    for (let i = 0; i < line.length; i += 24) {
      const [x, y] = line[i];
      const [x2, y2] = line[(i + 1) % line.length];
      const h = Math.atan2(y2 - y, x2 - x);
      for (const side of [-1, 1]) {
        const lx = x - Math.sin(h) * side * (ROAD_HALF + 20);
        const ly = y + Math.cos(h) * side * (ROAD_HALF + 20);
        const glow = ctx.createRadialGradient(lx, ly, 0, lx, ly, 14);
        glow.addColorStop(0, 'rgba(255,230,140,0.95)');
        glow.addColorStop(1, 'rgba(255,230,140,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(lx - 14, ly - 14, 28, 28);
      }
    }
  },
  kingdom(ctx, line) {
    // The red carpet, with gold trim down both sides.
    ctx.strokeStyle = '#e8c040';
    ctx.lineWidth = 2.5;
    for (const side of [-1, 1]) offsetPath(ctx, line, side * (ROAD_HALF - 5));
    ctx.strokeStyle = 'rgba(255,215,90,0.35)';
    ctx.lineWidth = 1.5;
    for (const side of [-1, 1]) offsetPath(ctx, line, side * (ROAD_HALF - 10));
  },
  'gold-mine'(ctx, line) {
    // Mine-cart rails on wooden sleepers down the middle.
    trackPath(ctx, line);
    ctx.setLineDash([4, 7]);
    ctx.strokeStyle = '#4a3018';
    ctx.lineWidth = 30;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#a7b0ba';
    ctx.lineWidth = 2.5;
    for (const side of [-1, 1]) offsetPath(ctx, line, side * 10);
  },
};

/** Draws the track map (ground, curbs, road, start line, boost pads) and the "is this road?" mask. */
function buildTrack(line, boosts, map) {
  const colors = map.colors;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MAP;
  const ctx = canvas.getContext('2d');
  // The ground, in a checker so you can feel the speed.
  for (let y = 0; y < MAP; y += 32) for (let x = 0; x < MAP; x += 32) {
    ctx.fillStyle = (x + y) % 64 ? colors.ground[0] : colors.ground[1];
    ctx.fillRect(x, y, 32, 32);
  }
  GROUND_DECOR[map.id]?.(ctx, seeded(map.id.length * 7919));
  ctx.lineJoin = ctx.lineCap = 'round';
  trackPath(ctx, line);
  ctx.strokeStyle = colors.curbEdge;
  ctx.lineWidth = ROAD_HALF * 2 + 26;
  ctx.stroke();
  ctx.strokeStyle = colors.curbA;
  ctx.lineWidth = ROAD_HALF * 2 + 10;
  ctx.stroke();
  ctx.setLineDash([12, 12]);
  ctx.strokeStyle = colors.curbB;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = colors.road;
  ctx.lineWidth = ROAD_HALF * 2;
  ctx.stroke();
  ROAD_DECOR[map.id]?.(ctx, line);
  trackPath(ctx, line);
  ctx.setLineDash([10, 18]);
  ctx.strokeStyle = colors.lane;
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

// ---------- height: every map has hills ----------
// The ground's height comes from a heightmap, HM × HM cells of HCELL world
// units. Big, smooth hills run under everything (the road rides over them, so
// it stays flat from side to side); away from the road there are bumpier
// hills on top.
const HM = 512;
const HCELL = MAP / HM;
const INV_HCELL = 1 / HCELL;

/** Build the heightmap from the road mask, and shade the track picture so the hills show. */
function buildHeight(map, road, texture) {
  const { amp = 24, bumps = 46, seed = 1 } = map.hills ?? {};
  const rand = seeded(seed * 7907 + map.id.length);
  const ph = Array.from({ length: 8 }, () => rand() * Math.PI * 2);
  const k = (wavelength) => (Math.PI * 2) / wavelength;
  const smooth = (x, y) =>
    amp * (0.55 * Math.sin(x * k(900) + ph[0]) * Math.cos(y * k(760) + ph[1]) + 0.3 * Math.sin((x + y) * k(620) + ph[2]) + 0.15 * Math.sin((x - y) * k(1300) + ph[3]));
  const bumpy = (x, y) => bumps * Math.max(0, 0.5 + 0.5 * Math.sin(x * k(260) + ph[4]) * Math.sin(y * k(300) + ph[5]) + 0.25 * Math.sin((x + 2 * y) * k(410) + ph[6]) - 0.2);
  // How far each cell is from the road (a two-pass chamfer distance, in cells).
  const far = new Float32Array(HM * HM);
  for (let cy = 0; cy < HM; cy++) for (let cx = 0; cx < HM; cx++) {
    const x = (cx * HCELL + HCELL / 2) | 0;
    const y = (cy * HCELL + HCELL / 2) | 0;
    far[cy * HM + cx] = road[y * MAP + x] ? 0 : 1e9;
  }
  const D1 = 1;
  const D2 = Math.SQRT2;
  for (let cy = 0; cy < HM; cy++) for (let cx = 0; cx < HM; cx++) {
    const i = cy * HM + cx;
    let v = far[i];
    if (cx > 0) v = Math.min(v, far[i - 1] + D1);
    if (cy > 0) {
      v = Math.min(v, far[i - HM] + D1);
      if (cx > 0) v = Math.min(v, far[i - HM - 1] + D2);
      if (cx < HM - 1) v = Math.min(v, far[i - HM + 1] + D2);
    }
    far[i] = v;
  }
  for (let cy = HM - 1; cy >= 0; cy--) for (let cx = HM - 1; cx >= 0; cx--) {
    const i = cy * HM + cx;
    let v = far[i];
    if (cx < HM - 1) v = Math.min(v, far[i + 1] + D1);
    if (cy < HM - 1) {
      v = Math.min(v, far[i + HM] + D1);
      if (cx < HM - 1) v = Math.min(v, far[i + HM + 1] + D2);
      if (cx > 0) v = Math.min(v, far[i + HM - 1] + D2);
    }
    far[i] = v;
  }
  const height = new Float32Array(HM * HM);
  for (let cy = 0; cy < HM; cy++) for (let cx = 0; cx < HM; cx++) {
    const i = cy * HM + cx;
    const x = cx * HCELL;
    const y = cy * HCELL;
    // 0 by the road, rising to 1 about 100 units away.
    const t = Math.max(0, Math.min(1, (far[i] * HCELL - 24) / 100));
    const w = t * t * (3 - 2 * t);
    height[i] = smooth(x, y) + bumpy(x, y) * w;
  }
  // Light from the top left: slopes facing it are brighter.
  const shade = new Float32Array(HM * HM);
  for (let cy = 0; cy < HM; cy++) for (let cx = 0; cx < HM; cx++) {
    const hx = height[cy * HM + Math.min(HM - 1, cx + 1)] - height[cy * HM + Math.max(0, cx - 1)];
    const hy = height[Math.min(HM - 1, cy + 1) * HM + cx] - height[Math.max(0, cy - 1) * HM + cx];
    shade[cy * HM + cx] = Math.max(0.72, Math.min(1.22, 1 - (hx + hy) * 0.045));
  }
  for (let y = 0; y < MAP; y++) {
    const cy = Math.min(HM - 1, (y / HCELL) | 0);
    for (let x = 0; x < MAP; x++) {
      const s = shade[cy * HM + Math.min(HM - 1, (x / HCELL) | 0)];
      if (s === 1) continue;
      const i = y * MAP + x;
      const c = texture[i];
      const r = Math.min(255, (c & 255) * s);
      const g = Math.min(255, ((c >> 8) & 255) * s);
      const b = Math.min(255, ((c >> 16) & 255) * s);
      texture[i] = (c & 0xff000000) | (b << 16) | (g << 8) | r;
    }
  }
  return height;
}

/** The ground's height at (x, y): smoothly between the heightmap's cells. */
function heightAt(height, x, y) {
  let gx = x / HCELL - 0.5;
  let gy = y / HCELL - 0.5;
  gx = gx < 0 ? 0 : gx > HM - 1.001 ? HM - 1.001 : gx;
  gy = gy < 0 ? 0 : gy > HM - 1.001 ? HM - 1.001 : gy;
  const x0 = gx | 0;
  const y0 = gy | 0;
  const fx = gx - x0;
  const fy = gy - y0;
  const i = y0 * HM + x0;
  const a = height[i] + (height[i + 1] - height[i]) * fx;
  const b = height[i + HM] + (height[i + HM + 1] - height[i + HM]) * fx;
  return a + (b - a) * fy;
}

/** A colour from its hue (0-360), fully bright: [r, g, b]. */
function hueRgb(hue, light = 0.5) {
  const c = (1 - Math.abs(2 * light - 1));
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = light - c / 2;
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
}

/** A picture with its blue parts (a shirt, pom-poms) turned to another hue. */
function hueShifted(image, hue) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0);
  const data = g.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const [cr, cg, cb] = hueRgb(hue);
  for (let i = 0; i < px.length; i += 4) {
    const [r, gg, b] = [px[i], px[i + 1], px[i + 2]];
    if (b > 100 && b > r + 60 && b > gg + 50) {
      const k = b / 255;
      px[i] = Math.round(cr * k);
      px[i + 1] = Math.round(cg * k);
      px[i + 2] = Math.round(cb * k);
    }
  }
  g.putImageData(data, 0, 0);
  return canvas;
}

/**
 * Things standing by the track (drawn like the karts, on the hills):
 * Kool Kircuit's cheerleaders, each in their own colour; Rainbow Wonderland's gems.
 */
function buildScenery(map, line, images) {
  const n = line.length;
  const beside = (f, side, out = 0) => {
    const i = Math.floor((((f % 1) + 1) % 1) * n);
    const [x, y] = line[i];
    const [x2, y2] = line[(i + 1) % n];
    const h = Math.atan2(y2 - y, x2 - x);
    const d = side * (ROAD_HALF + 30 + out);
    return { x: x - Math.sin(h) * d, y: y + Math.cos(h) * d };
  };
  const scenery = [];
  if (map.id === 'kool-kircuit') {
    // A squad by the start line on both sides, and a few more round the lap.
    const spots = [
      [-0.012, -1], [-0.006, -1], [0, -1], [0.006, -1], [0.012, -1],
      [-0.009, 1], [-0.003, 1], [0.003, 1], [0.009, 1],
      [0.25, 1], [0.255, 1], [0.5, -1], [0.505, -1], [0.75, 1], [0.755, 1],
    ];
    spots.forEach(([f, side], i) => {
      const hue = (225 + (i * 360) / spots.length) % 360; // everyone's colour is different (the first is the picture's blue)
      scenery.push({ ...beside(f, side, (i % 2) * 6), sprite: hueShifted(images.cheerleader, hue), size: 17, hop: true, phase: i * 0.7 });
    });
  }
  if (map.rainbow) {
    // Big rainbow gems all around the track, floating.
    const rand = seeded(97);
    for (let i = 0; i < 46; i++) {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      rainbowGem(c.getContext('2d'), 16, 16, 28, rand() * 360);
      scenery.push({ ...beside(i / 46 + rand() * 0.01, i % 2 ? 1 : -1, 10 + rand() * 90), sprite: c, size: 12 + rand() * 10, hop: false, phase: rand() * 6 });
    }
  }
  return scenery;
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

// The karts and icons are the same on every map; only the last map's track is
// kept (each is a big picture).
let shared = null;
let assets = null;
async function loadAssets(mapId) {
  const map = kartMap(mapId);
  if (assets?.map === map) return assets;
  shared ??= (async () => {
    const image = await loadImage('icons/kat-kart.png');
    const sprites = RACERS.map((r) => kartSprite(image, r.color));
    const icons = Object.fromEntries(await Promise.all(POWERUP_KINDS.map(async (k) => [k, await loadImage(POWERUPS[k].icon)])));
    const cheerleader = await loadImage('icons/kart/cheerleader.png');
    return { sprites, icons, itemBox: itemBoxSprite(), cheerleader };
  })().catch((err) => {
    shared = null;
    throw err;
  });
  const { sprites, icons, itemBox, cheerleader } = await shared;
  if (assets?.map === map) return assets;
  const line = buildCenterline(map.points);
  const boosts = BOOST_AT.map((f) => ({ index: Math.floor(f * line.length) }));
  const track = buildTrack(line, boosts, map);
  const height = buildHeight(map, track.road, track.texture);
  const maxHeight = height.reduce((m, v) => (v > m ? v : m), -Infinity);
  const itemSpots = ITEM_ROWS_AT.flatMap((f) => {
    const i = Math.floor(f * line.length);
    const [x, y] = line[i];
    const [x2, y2] = line[(i + 1) % line.length];
    const h = Math.atan2(y2 - y, x2 - x);
    return ITEM_LANES.map((off) => ({ index: i, x: x - Math.sin(h) * off, y: y + Math.cos(h) * off }));
  });
  assets = { map, line, boosts, ...track, height, maxHeight, sprites, icons, itemSpots, itemBox, scenery: buildScenery(map, line, { cheerleader }) };
  return assets;
}

// The race music: the Kat Kart OST by Zalith9. Each race (and each KatEscape
// run) picks one, never the same one twice in a row. Played with Web Audio so
// the loop has no gap; falls back to a plain <audio> loop.
export const RACE_SONGS = [
  { id: 'natho-town', title: 'Natho Town', artist: 'Zalith9', src: 'sounds/kat-kart-music.mp3' },
  { id: 'crystal-cavern', title: 'Crystal Cavern', artist: 'Zalith9', src: 'sounds/crystal-cavern.mp3' },
  { id: 'kingdom-dominance', title: 'Kingdom Dominance', artist: 'Zalith9', src: 'sounds/kingdom-dominance.mp3' },
  { id: 'gold-mine', title: 'Gold Mine', artist: 'Zalith9', src: 'sounds/gold-mine.mp3' },
  { id: 'rainbow-wonderland', title: 'Rainbow Wonderland', artist: 'Zalith9', src: 'sounds/rainbow-wonderland.mp3' },
];

// "No song": pick it and the game is quiet (pick() gives null, play(null) plays nothing).
export const NO_SONG = 'none';

// One mute for all the Playables' music, remembered on this device.
const MUTE_KEY = 'koolkat.games.muted';
let gamesMuted = false;
try {
  gamesMuted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  // Not remembered: start with the sound on.
}
const players = new Set(); // every game's music player (they all follow the mute)
const VOLUME = 0.7;
export const isGameMusicMuted = () => gamesMuted;
export function setGameMusicMuted(muted) {
  gamesMuted = Boolean(muted);
  try {
    localStorage.setItem(MUTE_KEY, gamesMuted ? '1' : '0');
  } catch {
    // Only for this visit.
  }
  for (const p of players) p.applyMute();
}

export function createRaceMusic() {
  let ctx = null;
  let gain = null;
  let source = null;
  let fallback = null;
  let last = null;
  let current = null; // the song that's on (null: none)
  const muteButtons = new Set();
  const buffers = new Map(); // src -> Promise<AudioBuffer | null>
  const load = (song) => {
    if (!buffers.has(song.src)) {
      buffers.set(
        song.src,
        fetch(song.src)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('no music'))))
          .then((data) => ctx.decodeAudioData(data))
          .catch(() => null)
      );
    }
    return buffers.get(song.src);
  };
  const stopSource = () => {
    try {
      source?.stop();
    } catch {
      // Already stopped.
    }
    source = null;
  };
  /** The mute button shows while a song's on, and says whether it's muted. */
  const renderMute = () => {
    for (const b of muteButtons) {
      b.hidden = !current;
      b.textContent = gamesMuted ? '🔇' : '🔊';
      b.setAttribute('aria-label', gamesMuted ? 'Turn the music on' : 'Mute the music');
      b.setAttribute('aria-pressed', String(gamesMuted));
      b.classList.toggle('muted', gamesMuted);
    }
  };
  let playing = 0; // so a song that finishes loading late doesn't start after pause()
  const player = {
    unlock() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx ??= new AC();
      ctx.resume?.().catch(() => {});
      if (!gain) {
        gain = ctx.createGain();
        gain.gain.value = gamesMuted ? 0 : VOLUME;
        gain.connect(ctx.destination);
      }
      for (const song of RACE_SONGS) load(song);
    },
    /** The next song: the one asked for by id, none for "No song", or a random one (not the one just played). */
    pick(id) {
      if (id === NO_SONG) return null;
      const chosen = RACE_SONGS.find((song) => song.id === id);
      if (chosen) return (last = chosen);
      const choices = RACE_SONGS.filter((song) => song !== last);
      last = choices[Math.floor(Math.random() * choices.length)] ?? RACE_SONGS[0];
      return last;
    },
    async play(song = this.pick()) {
      const run = ++playing;
      stopSource();
      fallback?.pause();
      current = song ?? null;
      renderMute();
      if (!song) return null; // No song
      this.unlock();
      if (!ctx) {
        fallback = Object.assign(new Audio(song.src), { loop: true, volume: VOLUME, muted: gamesMuted });
        fallback.play().catch(() => {});
        return song;
      }
      const buffer = await load(song);
      if (!buffer || run !== playing) return song;
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      source.start();
      return song;
    },
    pause() {
      playing++;
      stopSource();
      fallback?.pause();
    },
    /** A 🔊/🔇 button for this game: hidden when there's no song. */
    bindMute(button) {
      if (!button || muteButtons.has(button)) return;
      muteButtons.add(button);
      button.addEventListener('pointerdown', (e) => e.stopPropagation()); // not a steer / swipe / shot
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        setGameMusicMuted(!gamesMuted);
      });
      renderMute();
    },
    applyMute() {
      if (gain) gain.gain.value = gamesMuted ? 0 : VOLUME;
      if (fallback) fallback.muted = gamesMuted;
      renderMute();
    },
  };
  players.add(player);
  return player;
}

/** Show "Now Playing - Song: Artist" for a few seconds. */
export function showNowPlaying(note, song) {
  if (!note || !song) return;
  const title = document.createElement('strong');
  title.textContent = song.title;
  const icon = document.createElement('span');
  icon.className = 'kart-np-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '♪';
  const text = document.createElement('span');
  text.append('Now Playing - ', title, `: ${song.artist}`);
  note.replaceChildren(icon, text);
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

/** The sky and the far-off scenery, scrolled as you turn: each map has its own. */
function buildSky(width, height, mapId) {
  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const rand = seeded(mapId.length * 104729 + width);
  const gradient = (top, bottom) => {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, top);
    sky.addColorStop(1, bottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, height);
  };
  const clouds = (color) => {
    ctx.fillStyle = color;
    for (let i = 0; i < 6; i++) {
      const x = (i / 6) * W + 20;
      const y = height * (0.2 + (i % 3) * 0.12);
      for (const [ox, r] of [[0, 9], [10, 12], [22, 8]]) {
        ctx.beginPath();
        ctx.arc(x + ox, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  // Rolling hills (they wrap round, so the picture joins up as you turn).
  const hills = (color, base, amp, freq) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= W; x += 4) {
      const t = (x / W) * Math.PI * 2;
      ctx.lineTo(x, height - base - amp * (0.5 + 0.5 * Math.sin(t * freq) * Math.cos(t * (freq + 1))));
    }
    ctx.lineTo(W, height);
    ctx.fill();
  };
  const stars = (count) => {
    for (let i = 0; i < count; i++) {
      ctx.fillStyle = rand() < 0.8 ? '#ffffff' : '#bfe3ff';
      ctx.fillRect(Math.floor(rand() * W), Math.floor(rand() * height * 0.75), 1, 1);
    }
  };

  if (mapId === 'rainbow-wonderland') {
    // A pastel rainbow sky: soft colours sweeping round as you turn, lighter near the ground.
    const across = ctx.createLinearGradient(0, 0, W, 0);
    for (let k = 0; k <= 12; k++) across.addColorStop(k / 12, `hsl(${(k * 60) % 360} 90% 86%)`);
    ctx.fillStyle = across;
    ctx.fillRect(0, 0, W, height);
    const fade = ctx.createLinearGradient(0, 0, 0, height);
    fade.addColorStop(0, 'rgba(255,255,255,0)');
    fade.addColorStop(1, 'rgba(255,255,255,0.55)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, W, height);
    // A pastel rainbow arch and fluffy clouds.
    for (let k = 0; k < 7; k++) {
      ctx.strokeStyle = `hsl(${k * 45} 85% 80%)`;
      ctx.lineWidth = Math.max(2, height * 0.04);
      ctx.beginPath();
      ctx.arc(W * 0.3, height * 1.05, height * (0.85 - k * 0.05), Math.PI, 0);
      ctx.stroke();
    }
    clouds('#ffffff');
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(Math.floor(rand() * W), Math.floor(rand() * height * 0.7), 1, 1);
    }
    // Rainbow hills (bright, not pastel), with gems on them.
    const rainbowHills = (base, amp, freq, light) => {
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      for (let k = 0; k <= 12; k++) grad.addColorStop(k / 12, `hsl(${(k * 60 + 30) % 360} 85% ${light}%)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let x = 0; x <= W; x += 4) {
        const t = (x / W) * Math.PI * 2;
        ctx.lineTo(x, height - base - amp * (0.5 + 0.5 * Math.sin(t * freq) * Math.cos(t * (freq + 1))));
      }
      ctx.lineTo(W, height);
      ctx.fill();
    };
    rainbowHills(6, height * 0.35, 3, 68);
    rainbowHills(2, height * 0.2, 5, 55);
    for (let i = 0; i < 14; i++) rainbowGem(ctx, rand() * W, height * (0.7 + rand() * 0.25), Math.max(4, height * 0.06), rand() * 360);
    return canvas;
  }
  if (mapId === 'nighttime') {
    gradient('#050820', '#26306a');
    stars(140);
    // The moon.
    ctx.fillStyle = '#fff6d0';
    ctx.beginPath();
    ctx.arc(W * 0.3, height * 0.28, Math.max(6, height * 0.12), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8ddb0';
    ctx.beginPath();
    ctx.arc(W * 0.3 + 3, height * 0.28 - 2, Math.max(2, height * 0.03), 0, Math.PI * 2);
    ctx.fill();
    // The city skyline, windows lit.
    for (let x = 0; x < W; ) {
      const bw = 10 + Math.floor(rand() * 16);
      const bh = height * (0.18 + rand() * 0.45);
      ctx.fillStyle = rand() < 0.5 ? '#0d1022' : '#141833';
      ctx.fillRect(x, height - bh, bw, bh);
      for (let wy = height - bh + 3; wy < height - 3; wy += 4) for (let wx = x + 2; wx < x + bw - 2; wx += 3) {
        if (rand() < 0.3) {
          ctx.fillStyle = '#ffd86b';
          ctx.fillRect(wx, wy, 1, 2);
        }
      }
      x += bw + Math.floor(rand() * 3);
    }
    return canvas;
  }
  if (mapId === 'crystal-cavern') {
    gradient('#0e0618', '#3a2560');
    // Glowing specks in the rock.
    for (let i = 0; i < 80; i++) {
      ctx.fillStyle = ['#5ef2ff', '#ff5ed8', '#b47cff'][i % 3];
      ctx.fillRect(Math.floor(rand() * W), Math.floor(rand() * height * 0.6), 1, 1);
    }
    // Stalactites hanging from the cave roof.
    ctx.fillStyle = '#1a1028';
    ctx.fillRect(0, 0, W, Math.max(2, height * 0.05));
    for (let x = 0; x < W; x += 6 + Math.floor(rand() * 10)) {
      const len = height * (0.08 + rand() * 0.3);
      ctx.beginPath();
      ctx.moveTo(x - 4, 0);
      ctx.lineTo(x + 4, 0);
      ctx.lineTo(x, len);
      ctx.closePath();
      ctx.fill();
    }
    hills('#24183a', 2, height * 0.4, 4);
    // Big crystals on the horizon.
    const colors = ['#5ef2ff', '#ff5ed8', '#b47cff', '#7dffb2'];
    for (let x = 6; x < W; x += 18 + Math.floor(rand() * 26)) {
      const ch = height * (0.15 + rand() * 0.35);
      const cw = 4 + rand() * 6;
      ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
      ctx.beginPath();
      ctx.moveTo(x - cw, height);
      ctx.lineTo(x - cw * 0.7, height - ch * 0.8);
      ctx.lineTo(x, height - ch);
      ctx.lineTo(x + cw * 0.7, height - ch * 0.8);
      ctx.lineTo(x + cw, height);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillRect(x - 1, height - ch * 0.85, 1.5, ch * 0.7);
    }
    return canvas;
  }
  if (mapId === 'kingdom') {
    // Inside the throne room: the far wall, with stained-glass windows,
    // royal banners, torches, pillars and chandeliers.
    gradient('#4a4458', '#6e677e');
    ctx.strokeStyle = 'rgba(30,26,40,0.45)';
    ctx.lineWidth = 1;
    for (let y = 0, row = 0; y < height; y += 6, row++) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
      for (let x = row % 2 ? 6 : 0; x < W; x += 12) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, y);
        ctx.lineTo(x + 0.5, y + 6);
        ctx.stroke();
      }
    }
    const glass = ['#e5172f', '#1f4fff', '#ffcc00', '#1aa33a', '#8a2be2'];
    const bays = 6;
    for (let i = 0; i < bays; i++) {
      const cx = ((i + 0.5) / bays) * W;
      // Stained-glass window with a pointed arch.
      const ww = Math.max(8, height * 0.13);
      const top = height * 0.18;
      const bottom = height * 0.72;
      ctx.fillStyle = '#2a2536';
      ctx.fillRect(cx - ww / 2 - 2, top, ww + 4, bottom - top + 2);
      ctx.beginPath();
      ctx.moveTo(cx - ww / 2 - 2, top);
      ctx.lineTo(cx, top - ww * 0.8);
      ctx.lineTo(cx + ww / 2 + 2, top);
      ctx.fill();
      const panes = 6;
      for (let p = 0; p < panes; p++) for (let q = 0; q < 2; q++) {
        ctx.fillStyle = glass[(p + q + i) % glass.length];
        ctx.fillRect(cx - ww / 2 + q * (ww / 2) + 0.5, top + p * ((bottom - top) / panes) + 0.5, ww / 2 - 1, (bottom - top) / panes - 1);
      }
      ctx.fillStyle = glass[i % glass.length];
      ctx.beginPath();
      ctx.moveTo(cx - ww / 2, top);
      ctx.lineTo(cx, top - ww * 0.65);
      ctx.lineTo(cx + ww / 2, top);
      ctx.fill();
      // A banner and a torch between the windows.
      const bx = cx + W / bays / 2;
      const bw = Math.max(6, height * 0.09);
      ctx.fillStyle = '#b3122e';
      ctx.beginPath();
      ctx.moveTo(bx - bw / 2, height * 0.08);
      ctx.lineTo(bx + bw / 2, height * 0.08);
      ctx.lineTo(bx + bw / 2, height * 0.55);
      ctx.lineTo(bx, height * 0.47);
      ctx.lineTo(bx - bw / 2, height * 0.55);
      ctx.fill();
      ctx.fillStyle = '#e8c040';
      ctx.fillRect(bx - bw / 2, height * 0.08, bw, 2);
      ctx.beginPath();
      ctx.arc(bx, height * 0.25, bw * 0.22, 0, Math.PI * 2);
      ctx.fill();
      const ty = height * 0.66;
      const glow = ctx.createRadialGradient(bx, ty, 0, bx, ty, height * 0.12);
      glow.addColorStop(0, 'rgba(255,200,90,0.75)');
      glow.addColorStop(1, 'rgba(255,160,60,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(bx - height * 0.12, ty - height * 0.12, height * 0.24, height * 0.24);
      ctx.fillStyle = '#5b3b25';
      ctx.fillRect(bx - 1, ty, 2, height * 0.06);
      ctx.fillStyle = '#ffb02e';
      ctx.fillRect(bx - 1.5, ty - 3, 3, 3);
    }
    // Pillars in front of the wall.
    for (let i = 0; i < bays; i++) {
      const px = (i / bays) * W;
      const pw = Math.max(6, height * 0.08);
      ctx.fillStyle = '#9a95a6';
      ctx.fillRect(px - pw / 2, 0, pw, height);
      ctx.fillStyle = '#b9b4c4';
      ctx.fillRect(px - pw / 2, 0, pw * 0.35, height);
      ctx.fillStyle = '#7d788a';
      ctx.fillRect(px - pw / 2 - 2, height - 5, pw + 4, 5);
    }
    // Chandeliers hanging from the ceiling.
    for (let i = 0; i < 3; i++) {
      const cx = ((i + 0.25) / 3) * W;
      const cy = height * 0.12;
      ctx.fillStyle = '#3a2a10';
      ctx.fillRect(cx, 0, 1, cy);
      ctx.fillStyle = '#c79a20';
      ctx.fillRect(cx - 12, cy, 25, 2);
      for (let k = -2; k <= 2; k++) {
        const glow = ctx.createRadialGradient(cx + k * 5, cy - 2, 0, cx + k * 5, cy - 2, 6);
        glow.addColorStop(0, 'rgba(255,240,170,1)');
        glow.addColorStop(1, 'rgba(255,220,120,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(cx + k * 5 - 6, cy - 8, 12, 12);
      }
    }
    // Where the wall meets the floor.
    ctx.fillStyle = '#3a3546';
    ctx.fillRect(0, height - 3, W, 3);
    return canvas;
  }
  if (mapId === 'gold-mine') {
    gradient('#ff9a4a', '#ffe0a0');
    // The sun going down.
    ctx.fillStyle = '#fff1b8';
    ctx.beginPath();
    ctx.arc(W * 0.65, height * 0.55, Math.max(6, height * 0.16), 0, Math.PI * 2);
    ctx.fill();
    // Flat-topped mesas.
    for (let x = 0; x < W; ) {
      const mw = 30 + rand() * 50;
      const mh = height * (0.2 + rand() * 0.35);
      ctx.fillStyle = rand() < 0.5 ? '#b0582c' : '#9a4a26';
      ctx.beginPath();
      ctx.moveTo(x, height);
      ctx.lineTo(x + mw * 0.15, height - mh);
      ctx.lineTo(x + mw * 0.85, height - mh);
      ctx.lineTo(x + mw, height);
      ctx.fill();
      x += mw * (0.6 + rand() * 0.6);
    }
    hills('#7d5a34', 2, height * 0.16, 4);
    // Mine entrances with wooden frames.
    for (const fx of [0.2, 0.55, 0.9]) {
      const mx = W * fx;
      const s = Math.max(6, height * 0.16);
      ctx.fillStyle = '#5a3a1c';
      ctx.fillRect(mx - s, height - s * 1.6, s * 2, s * 1.6);
      ctx.fillStyle = '#120a04';
      ctx.fillRect(mx - s * 0.7, height - s * 1.3, s * 1.4, s * 1.3);
    }
    return canvas;
  }
  // The Kool Kircuit: a sunny day.
  gradient('#4aa3ff', '#bfe3ff');
  clouds('#ffffff');
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
  music.bindMute(els.mute);

  function size() {
    const rect = canvas.parentElement.getBoundingClientRect();
    // Wide windows (PC) get a wider picture.
    const w = rect.width > rect.height ? 384 : 256;
    const h = Math.max(160, Math.min(560, Math.round((w * rect.height) / Math.max(rect.width, 1))));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      race && (race.view = makeView(w, h, race.a.map.id));
    }
  }
  function makeView(w, h, mapId) {
    const horizon = Math.round(h * (h > w ? 0.42 : 0.36));
    const sky = buildSky(w, horizon + 1, mapId);
    const skyData = sky.getContext('2d').getImageData(0, 0, sky.width, sky.height);
    return {
      w,
      h,
      horizon,
      focal: Math.min(w, h * 1.15) * 0.95,
      image: ctx.createImageData(w, h),
      ybuf: new Int32Array(w),
      depth: new Float32Array(w * DEPTH_ROWS),
      sky,
      skyPixels: { width: sky.width, data: new Uint32Array(skyData.data.buffer) },
    };
  }

  /**
   * Start a race.
   *   { mode: 'solo', level }: against seven computer Kats; level 1 is easy.
   *   Either way, `map` is the track's id (see kart-maps.js).
   *   { mode: 'online', mySlot, players: [{ slot, name }], startAt, sync }:
   *     `startAt` is GO in this phone's time; `sync(state)` sends your kart and
   *     resolves with the race from the server.
   */
  async function start(opts = { mode: 'solo', level: 1 }) {
    const a = await loadAssets(opts.map);
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
      // The host's pick (or yours, solo); 'map' is the map's own song.
      song: opts.song === 'map' ? a.map.song : opts.song ?? 'random',
      view: makeView(canvas.width, canvas.height, a.map.id),
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
    tilt.listen(tilt.enabled);
    frame = requestAnimationFrame(loop);
  }

  // ---------- tilt to steer (phone held sideways) ----------
  // The motion sensor says which way gravity pulls; turned into the screen's
  // own directions, its sideways part is how far you've turned the phone, like
  // a steering wheel. Only in landscape, and only if it's switched on.
  const IOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
  const tilt = {
    enabled: false,
    value: 0, // -1 (left) to 1 (right), smoothed
    seenAt: 0,
    listening: false,
    onMotion(e) {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null || g.y == null) return;
      const angle = ((screen.orientation?.angle ?? window.orientation ?? 0) * Math.PI) / 180;
      // The device's x/y turned into the screen's left-right.
      let sx = g.x * Math.cos(angle) + g.y * Math.sin(angle);
      if (IOS) sx = -sx; // iPhones report it the other way round
      // The phone's right side down: steer right. (On real phones the reading's
      // sign is this way round; it was the other way and steered backwards.)
      const lean = Math.max(-1, Math.min(1, sx / 9.81));
      const DEAD = 0.07; // about 4° either way is straight on
      const FULL = 0.42; // about 25° is a full turn
      const mag = Math.max(0, Math.abs(lean) - DEAD) / (FULL - DEAD);
      const target = Math.sign(lean) * Math.min(1, mag);
      tilt.value += (target - tilt.value) * 0.35;
      tilt.seenAt = performance.now();
    },
    listen(on) {
      if (on === tilt.listening || typeof window === 'undefined') return;
      tilt.listening = on;
      if (on) window.addEventListener('devicemotion', tilt.handler);
      else window.removeEventListener('devicemotion', tilt.handler);
      tilt.value = 0;
    },
    /** How far to steer from the tilt (0 when it's off, not sideways, or there's no sensor). */
    steer() {
      if (!tilt.enabled || innerWidth <= innerHeight || performance.now() - tilt.seenAt > 500) return 0;
      return Math.abs(tilt.value) < 0.02 ? 0 : tilt.value;
    },
  };
  tilt.handler = (e) => tilt.onMotion(e);

  function stop() {
    tilt.listen(false);
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
        // (Tilting the phone, held sideways like a steering wheel, steers too.)
        steer = (input.right ? 1 : 0) - (input.left ? 1 : 0) || gamepadSteer() || tilt.steer();
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
      // Hills: a little slower going up, a little faster coming down.
      const slope = (heightAt(a.height, r.x + Math.cos(r.heading) * 6, r.y + Math.sin(r.heading) * 6) - heightAt(a.height, r.x, r.y)) / 6;
      max *= Math.max(0.8, Math.min(1.15, 1 - slope * 1.2));
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
      // (A computer Kat that's been slowed down uses its speed boost straight away to get out of it.)
      const slowed = race.now < r.slowUntil && r.item && POWERUPS[r.item].self;
      if (!r.player && r.item && (race.now >= r.useAt || slowed) && r.finished == null) useItem(r);
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
    let shookOff = null;
    if (p.self) {
      r.boostMul = p.mul;
      r.boostUntil = race.now + p.ms;
      // A speed boost gets you out of a slow-down (Mouse, Food Bowl, even Thunder).
      if (race.now < r.slowUntil) {
        shookOff = r.slowKind;
        r.slowUntil = 0;
        r.slowMul = 1;
        r.slowKind = null;
      }
    } else {
      for (const other of race.racers) if (other !== r && !other.remote) hit(other, kind, r);
    }
    if (r.player) {
      if (race.online) race.pendingUses.push({ id: `${r.slot}-${Math.random().toString(36).slice(2, 10)}`, kind });
      renderItem();
      const text = shookOff ? `${p.name}! ×${p.mul} You shook off the ${POWERUPS[shookOff].name}!` : p.self ? `${p.name}! ×${p.mul}` : `${p.name}! Everyone else slows down`;
      alertText(text, kind);
    }
  }

  function hit(r, kind, from) {
    if (r.finished != null) return;
    const p = POWERUPS[kind];
    // Going at Double or Triple Speed: slow-downs don't touch you.
    if (race.now < r.boostUntil) {
      if (r.player) alertText(`${p.name} from ${from?.player ? 'you' : from?.name ?? 'someone'}, but you're too fast for it!`, r.boostMul >= 2 ? 'triple' : 'double');
      return;
    }
    r.slowMul = p.mul;
    r.slowUntil = race.now + p.ms;
    r.slowKind = kind;
    // It bites straight away (the kart doesn't just coast down to the slower speed).
    r.speed *= p.mul;
    r.spinUntil = race.now + 600;
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
    // The camera floats above the ground (over the higher of where it is and
    // where your kart is, so it never dips into a hill), smoothly.
    const groundZ = Math.max(heightAt(a.height, camX, camY), heightAt(a.height, player.x, player.y));
    race.camZ = race.camZ == null ? groundZ : race.camZ + (groundZ - race.camZ) * 0.15;
    const camZ = race.camZ + CAM_HEIGHT;
    // The ground, column by column, near to far (like the old "voxel space"
    // games): each step along the ray is drawn from where the last one
    // reached up to where this one is on screen, so hills hide what's behind.
    const out = new Uint32Array(image.data.buffer);
    const tex = a.texture;
    // The sky slides round as you turn.
    const skyW = view.skyPixels.width;
    const skyPx = view.skyPixels.data;
    const skyOff = ((((ch / (Math.PI * 2)) * skyW) % skyW) + skyW) % skyW | 0;
    const hm = a.height;
    const grass = tex[5];
    const ybuf = view.ybuf;
    const depth = view.depth;
    depth.fill(Infinity);
    const rowsPer = h / DEPTH_ROWS;
    // Slow phone? Draw every other column of ground (each twice as wide).
    const stride = race.groundMs > 6 ? 2 : 1;
    const t0 = performance.now();
    for (let x = 0; x < w; x += stride) {
      const off = (x - w / 2) / focal;
      const dx = fx + rx * off;
      const dy = fy + ry * off;
      let top = h; // the highest row drawn so far in this column
      let z = 4;
      const base = x * DEPTH_ROWS;
      while (z < FAR && top > 0) {
        // Nothing further off can reach above what's drawn: this column's done.
        if (top <= horizon + ((camZ - a.maxHeight) * focal) / z) break;
        const wx = camX + dx * z;
        const wy = camY + dy * z;
        // The ground's height there (smooth close up, nearest cell further off).
        let gx = wx * INV_HCELL - 0.5;
        let gy = wy * INV_HCELL - 0.5;
        gx = gx < 0 ? 0 : gx > HM - 1.001 ? HM - 1.001 : gx;
        gy = gy < 0 ? 0 : gy > HM - 1.001 ? HM - 1.001 : gy;
        const x0 = gx | 0;
        const y0 = gy | 0;
        const i = y0 * HM + x0;
        let gz;
        if (z < 120) {
          const tx = gx - x0;
          const ty = gy - y0;
          const h0 = hm[i] + (hm[i + 1] - hm[i]) * tx;
          gz = h0 + (hm[i + HM] + (hm[i + HM + 1] - hm[i + HM]) * tx - h0) * ty;
        } else gz = hm[i];
        let y = (horizon + ((camZ - gz) * focal) / z) | 0;
        if (y < top) {
          if (y < 0) y = 0;
          const ix = wx | 0;
          const iy = wy | 0;
          const color = ix >= 0 && iy >= 0 && ix < MAP && iy < MAP ? tex[iy * MAP + ix] : grass;
          for (let yy = y; yy < top; yy++) out[yy * w + x] = color;
          if (stride === 2 && x + 1 < w) for (let yy = y; yy < top; yy++) out[yy * w + x + 1] = color;
          // Remember how far away the ground on these rows is.
          for (let r = (y / rowsPer) | 0, r1 = ((top - 1) / rowsPer) | 0; r <= r1; r++) if (depth[base + r] === Infinity) depth[base + r] = z;
          top = y;
        }
        z += 0.45 + z * 0.018;
      }
      ybuf[x] = top;
      // Above the ground: the sky (and the ground colour in any gap down to the horizon).
      const sc = (x + skyOff) % skyW;
      const skyRows = Math.min(top, horizon + 1);
      for (let yy = 0; yy < skyRows; yy++) out[yy * w + x] = skyPx[yy * skyW + sc];
      for (let yy = skyRows; yy < top; yy++) out[yy * w + x] = grass;
      if (stride === 2 && x + 1 < w) {
        ybuf[x + 1] = top;
        depth.copyWithin(base + DEPTH_ROWS, base, base + DEPTH_ROWS);
        const sc2 = (x + 1 + skyOff) % skyW;
        for (let yy = 0; yy < skyRows; yy++) out[yy * w + x + 1] = skyPx[yy * skyW + sc2];
        for (let yy = skyRows; yy < top; yy++) out[yy * w + x + 1] = grass;
      }
    }
    race.groundMs = (race.groundMs ?? 0) * 0.95 + (performance.now() - t0) * (stride === 2 ? 2 : 1) * 0.05;
    ctx.putImageData(image, 0, 0);

    // Karts and item boxes, far ones first.
    const visible = [];
    const project = (x, y) => {
      const dx = x - camX;
      const dy = y - camY;
      // How far up the screen the ground there is (it's not flat any more).
      return { dz: dx * fx + dy * fy, lx: dx * rx + dy * ry, lift: camZ - heightAt(hm, x, y) };
    };
    for (const r of race.racers) {
      const { dz, lx, lift } = project(r.x, r.y);
      if (dz < 6) continue;
      visible.push({ r, dz, lx, lift });
    }
    a.itemSpots.forEach((spot, i) => {
      if ((race.boxesTakenUntil.get(i) ?? 0) > race.now) return;
      const { dz, lx, lift } = project(spot.x, spot.y);
      if (dz < 6 || dz > 500) return;
      visible.push({ box: true, dz, lx, lift });
    });
    // Scenery: cheerleaders, gems.
    for (const sc of a.scenery) {
      const { dz, lx, lift } = project(sc.x, sc.y);
      if (dz < 8 || dz > 700 || Math.abs(lx) > dz * 1.2) continue;
      visible.push({ sc, dz, lx, lift });
    }
    visible.sort((p, q) => q.dz - p.dz);
    ctx.imageSmoothingEnabled = false;
    // Hidden behind a hill? (The ground in that column reached higher up the screen, nearer.)
    const hidden = (sx, sy, dz) => {
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) return false;
      const ground = view.depth[(sx | 0) * DEPTH_ROWS + Math.min(DEPTH_ROWS - 1, ((sy - 3) / (h / DEPTH_ROWS)) | 0)];
      return ground < dz * 0.85 - 8; // the ground just above its feet is much nearer: a hill's in the way
    };
    for (const { r, box, sc, dz, lx, lift } of visible) {
      if (sc) {
        const size = (sc.size * focal) / dz;
        const sx = w / 2 + (lx * focal) / dz;
        const sy = horizon + (lift * focal) / dz;
        if (hidden(sx, sy, dz)) continue;
        const hop = sc.hop ? Math.abs(Math.sin(race.now / 180 + sc.phase)) * size * 0.25 : Math.sin(race.now / 400 + sc.phase) * size * 0.06;
        ctx.drawImage(sc.sprite, sx - size / 2, sy - size * 0.95 - hop, size, size);
        continue;
      }
      if (box) {
        const size = (6 * focal) / dz;
        const bx = w / 2 + (lx * focal) / dz;
        const by = horizon + (lift * focal) / dz - size * (1.2 + 0.15 * Math.sin(race.now / 200 + dz));
        if (hidden(bx, by + size, dz)) continue;
        ctx.drawImage(a.itemBox, bx - size / 2, by, size, size);
        continue;
      }
      const sizePx = (KART_SIZE * focal) / dz;
      const sx = w / 2 + (lx * focal) / dz;
      const sy = horizon + (lift * focal) / dz;
      if (hidden(sx, sy, dz)) continue;
      const bob = r.speed > 0.5 ? Math.sin(race.now / 60 + r.wobble) * sizePx * 0.015 : 0;
      if (race.now < (r.spinUntil ?? 0)) {
        // Just got hit: a quick wobble, so you can see it land.
        ctx.save();
        ctx.translate(sx, sy - sizePx * 0.42);
        ctx.rotate(Math.sin(race.now / 40) * 0.35);
        ctx.drawImage(r.sprite, -sizePx / 2, -sizePx * 0.5 + bob, sizePx, sizePx);
        ctx.restore();
      } else ctx.drawImage(r.sprite, sx - sizePx / 2, sy - sizePx * 0.92 + bob, sizePx, sizePx);
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
    const k = KART_MAP_SCALE; // keep the lines and dots the same size on screen
    m.clearRect(0, 0, minimap.width, minimap.height);
    m.save();
    m.scale(s, s);
    m.lineJoin = m.lineCap = 'round';
    trackPath(m, race.a.line);
    m.strokeStyle = 'rgba(0,0,0,0.45)';
    m.lineWidth = (ROAD_HALF * 2 + 26) * k;
    m.stroke();
    m.strokeStyle = '#fff';
    m.lineWidth = ROAD_HALF * 1.4 * k;
    m.stroke();
    for (const r of race.racers.slice().reverse()) {
      m.beginPath();
      m.arc(r.x, r.y, (r.player ? 34 : 26) * k, 0, Math.PI * 2);
      m.fillStyle = r.color;
      m.fill();
      m.lineWidth = (r.player ? 12 : 6) * k;
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
        const song = music.pick(race.song);
        music.play(song);
        showNowPlaying(els.nowPlaying, song);
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
  // Multi-touch: every finger counts; with fingers on both sides, the one put
  // down last steers (so you can switch sides without letting go). The
  // power-up button works with another finger still steering.
  function setTouch(e) {
    if (!race) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    let newest = null;
    for (const p of activePointers.values()) if (!newest || p.at > newest.at) newest = p;
    const side = newest ? (newest.x < rect.left + rect.width / 2 ? 'left' : 'right') : null;
    input.left = side === 'left';
    input.right = side === 'right';
    e?.preventDefault?.();
  }
  const activePointers = new Map();
  const stage = canvas.parentElement;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    activePointers.set(e.pointerId, { x: e.clientX, at: performance.now() });
    stage.setPointerCapture?.(e.pointerId);
    setTouch(e);
  });
  stage.addEventListener('pointermove', (e) => {
    const p = activePointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
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
  onPress(els.item, usePlayerItem);


  return {
    start,
    stop,
    // Call from a tap (phones only allow sound after one), before the race starts.
    unlockAudio: () => music.unlock(),
    keyDown: (e) => onKey(e, true),
    /** Tilt to steer, when the phone's sideways. */
    setTilt(on) {
      tilt.enabled = Boolean(on);
      tilt.listen(tilt.enabled && Boolean(race));
    },
    /** Is the phone's motion sensor steering right now? */
    get tilting() {
      return tilt.enabled && tilt.listening && performance.now() - tilt.seenAt < 500 && innerWidth > innerHeight;
    },
    keyUp: (e) => onKey(e, false),
    get running() {
      return Boolean(race);
    },
    previewTrack: async (mapId) => (await loadAssets(mapId)).preview,
  };
}

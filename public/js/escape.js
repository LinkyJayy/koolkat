// KatEscape: an endless runner, like Subway Surfers. KoolKat runs down three
// train tracks with a cop on its tail; switch lanes, jump and roll to dodge
// trains and barriers, and collect bolts. Stumble (clip a barrier or the side
// of a train) and the cop catches up; stumble again before you've got away,
// or hit a train head-on, and you're caught. The bolts make a trail along the safe way through.
// Every 750 bolts gives you Double Speed, every 2500 Triple Speed; speed
// boosts also smash you through anything in your way. Thunder (found on the
// track) clears the obstacles ahead. Drawn in chunky pixels like Kat Kart.

import { gamepadSteer } from './input.js';

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
const BEST_KEY = 'koolkat.katEscape.best';

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

export function createKatEscape(els) {
  const { canvas } = els;
  const ctx = canvas.getContext('2d');
  let game = null;
  let frame = 0;
  let assets = null;

  async function loadAssets() {
    if (assets) return assets;
    const [bolt, double, triple, cat, cop] = await Promise.all(
      [BOLT_ICON, BOOSTS.double.icon, BOOSTS.triple.icon, 'icons/escape-cat.png', 'icons/escape-cop.png'].map(loadImage)
    );
    assets = { bolt, icons: { double, triple, thunder: bolt }, cat, cop };
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

  async function start() {
    await loadAssets();
    size();
    game = {
      ...view(canvas.width, canvas.height),
      state: 'ready',
      dist: 0,
      speed: BASE_SPEED,
      time: 0,
      lane: 0,
      x: 0,
      jumpT: -1,
      rollT: -1,
      y: 0,
      objects: [], // obstacles, bolts and power-ups (z = how far ahead)
      nextRow: 22,
      safe: 0, // the lane the bolt trail follows
      bolts: 0,
      boost: null, // { kind, until }
      flash: 0,
      last: performance.now(),
      runFrame: 0,
      copZ: -0.9, // the cop starts right behind you
      copUntil: 3, // ...and stays close for the first 3 seconds
      stumbleUntil: 0,
    };
    els.over.hidden = true;
    els.hint.hidden = false;
    for (let i = 0; i < 6; i++) spawnRow();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(loop);
    hud();
  }

  function stop() {
    cancelAnimationFrame(frame);
    game = null;
  }

  // ---------- the track ahead ----------
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  /** One row of obstacles, with at least one way through and a bolt trail along it. */
  function spawnRow() {
    const z = game.nextRow;
    const difficulty = Math.min(1, game.dist / 3000);
    // The safe lane moves at most one lane at a time, so the trail can be followed.
    const prevSafe = game.safe;
    const safe = Math.max(-1, Math.min(1, prevSafe + pick([-1, 0, 0, 1])));
    game.safe = safe;
    let trainLen = 0;
    for (const lane of [-1, 0, 1]) {
      if (lane === safe) continue;
      const roll = Math.random();
      if (roll < 0.15 + 0.15 * (1 - difficulty)) continue; // nothing
      if (roll < 0.62) {
        const len = 8 + Math.floor(Math.random() * 10);
        trainLen = Math.max(trainLen, len);
        game.objects.push({ type: 'train', lane, z, len, moving: Math.random() < 0.25 + 0.25 * difficulty, color: pick(['#d7263d', '#2e86de', '#f4a300', '#8e44ad']) });
      } else if (roll < 0.82) game.objects.push({ type: 'low', lane, z, len: 0.5 });
      else game.objects.push({ type: 'high', lane, z, len: 0.5 });
    }
    // Sometimes the safe lane needs a jump or a roll too.
    if (Math.random() < 0.35 + 0.3 * difficulty) game.objects.push({ type: Math.random() < 0.5 ? 'low' : 'high', lane: safe, z: z + 3, len: 0.5 });
    // Bolts: a trail from the last row to this one, then along the safe lane.
    const from = z - 12;
    for (let bz = from; bz < z + Math.max(4, trainLen); bz += 1.6) {
      const lane = bz < z - 5 ? prevSafe + (safe - prevSafe) * Math.min(1, Math.max(0, (bz - from) / 6)) : safe;
      game.objects.push({ type: 'bolt', lane, z: bz, len: 0.4, y: 0.6 });
    }
    // Now and then Thunder on the track. (Double and Triple Speed only come from bolts.)
    if (Math.random() < 0.06) game.objects.push({ type: 'power', kind: 'thunder', lane: safe, z: z - 6, len: 0.5, y: 0.8 });
    game.nextRow = z + Math.max(trainLen, 4) + 14 - 4 * difficulty;
  }

  // ---------- controls ----------
  function move(dir) {
    if (!game || game.state === 'over') return;
    if (game.state === 'ready') begin();
    if (dir === 'left' || dir === 'right') {
      const lane = Math.max(-1, Math.min(1, game.lane + (dir === 'left' ? -1 : 1)));
      // Running into the side of a train: bounce back and stumble.
      const blocked = !(game.boost && game.time < game.boost.until) &&
        game.objects.some((o) => o.type === 'train' && !o.gone && o.lane === lane && o.z < 0.6 && o.z + o.len > -0.3);
      if (blocked) stumble();
      else game.lane = lane;
    }
    else if (dir === 'up' && game.jumpT < 0) {
      game.jumpT = 0;
      game.rollT = -1;
    } else if (dir === 'down') {
      game.rollT = 0;
      game.jumpT = -1; // dive down out of a jump
    }
  }
  function begin() {
    game.state = 'running';
    game.last = performance.now();
    els.hint.hidden = true;
  }

  // Swipes
  let touch = null;
  canvas.parentElement.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
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

  function keyDown(e) {
    const dir = { arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', arrowup: 'up', w: 'up', ' ': 'up', arrowdown: 'down', s: 'down' }[e.key.toLowerCase()];
    if (!dir || e.repeat) return;
    e.preventDefault();
    move(dir);
  }

  // Controllers: D-pad or stick to move (one lane per push), A to jump, B to roll.
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
    }
    for (const d of now) if (!padHeld.has(d)) move(d);
    padHeld.clear();
    for (const d of now) padHeld.add(d);
  }

  // ---------- the game ----------
  function update(dt) {
    const g = game;
    g.time += dt;
    const boosted = g.boost && g.time < g.boost.until;
    if (g.boost && !boosted) g.boost = null;
    g.speed = Math.min(MAX_SPEED, BASE_SPEED + g.time * 0.18);
    const speed = g.speed * (boosted ? BOOSTS[g.boost.kind].mul : 1);
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
    for (const o of g.objects) o.z -= step + (o.moving ? g.speed * 0.45 * dt : 0);
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
      } else if (boosted) {
        o.gone = true; // smash through
        g.flash = 0.08;
      } else if (o.type === 'train') {
        return crash('train');
      } else if ((o.type === 'low' && g.y < 0.75) || (o.type === 'high' && g.rollT < 0)) {
        o.gone = true;
        if (stumble()) return;
      }
    }
    g.objects = g.objects.filter((o) => !o.gone && o.z + o.len > CAM_Z + 0.5);
    while (g.nextRow - g.dist < DRAW_TO + 30) {
      const ahead = g.nextRow;
      g.nextRow = ahead - g.dist; // spawnRow works in "distance ahead"
      spawnRow();
      g.nextRow += g.dist;
    }
    if (g.flash > 0) g.flash -= dt;
    // The cop: close behind while he's chasing, falling back once you get away.
    const copTarget = g.time < g.copUntil ? -0.9 : -9;
    g.copZ += (copTarget - g.copZ) * Math.min(1, dt * (copTarget > g.copZ ? 4 : 0.8));
  }

  /** Clipped something: the cop catches up. A second time while he's close and he gets you. */
  function stumble() {
    const g = game;
    if (g.time < g.stumbleUntil) {
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

  let announceTimer = null;
  function announce(text, kind) {
    const a = els.alert;
    a.replaceChildren();
    if (kind) {
      const img = document.createElement('img');
      img.src = kind === 'thunder' ? BOLT_ICON : BOOSTS[kind].icon;
      img.alt = '';
      a.append(img);
    }
    a.append(text);
    a.hidden = false;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => (a.hidden = true), 1800);
  }

  const score = () => Math.floor(game.dist) + game.bolts * 5;

  function crash(reason = 'train') {
    const g = game;
    g.state = 'over';
    g.flash = 0;
    if (reason === 'caught') g.copZ = -0.4; // he's got you
    render();
    const final = score();
    let best = 0;
    try {
      best = Number(localStorage.getItem(BEST_KEY)) || 0;
      if (final > best) localStorage.setItem(BEST_KEY, String(final));
    } catch {
      // Just for fun.
    }
    els.onOver({ score: final, bolts: g.bolts, distance: Math.floor(g.dist), best: Math.max(best, final), newBest: final > best, reason });
  }

  // ---------- drawing ----------
  function project(x, y, z) {
    const dz = z - CAM_Z;
    if (dz <= 0.1) return null;
    return { x: game.w / 2 + ((x - game.x * 0.35) * game.focal) / dz, y: game.horizon + ((CAM_H - y) * game.focal) / dz, s: game.focal / dz };
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

  function render() {
    const g = game;
    const { w, h, horizon } = g;
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
      const bx = (((i * 41 - g.dist * 0.4) % (w + 40)) + w + 40) % (w + 40) - 20;
      ctx.fillStyle = i % 2 ? '#7a4c6e' : '#5e3a5a';
      ctx.fillRect(Math.round(bx), horizon - bh, bw, bh);
    }
    // Ground
    ctx.fillStyle = '#6b6b6b';
    ctx.fillRect(0, horizon, w, h - horizon);
    const edge = LANE * 1.9;
    for (let z = DRAW_TO; z > CAM_Z + 0.4; z -= 2) {
      const z2 = Math.max(CAM_Z + 0.4, z - 2);
      const band = Math.floor((z + g.dist) / 2) % 2;
      quad(project(-40, 0, z), project(-edge, 0, z), project(-edge, 0, z2), project(-40, 0, z2), band ? '#4f8a3a' : '#5a9a43');
      quad(project(edge, 0, z), project(40, 0, z), project(40, 0, z2), project(edge, 0, z2), band ? '#4f8a3a' : '#5a9a43');
    }
    // Tracks: gravel, sleepers and rails for each lane.
    quad(project(-edge, 0, DRAW_TO), project(edge, 0, DRAW_TO), project(edge, 0, CAM_Z + 0.4), project(-edge, 0, CAM_Z + 0.4), '#8a7f74');
    const sleeperGap = 1.1;
    const first = sleeperGap - ((g.dist % sleeperGap) + sleeperGap) % sleeperGap;
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
    // Things on the track, far first; the cat goes in at z = 0.
    const items = g.objects.filter((o) => o.z < DRAW_TO).slice();
    items.push({ type: 'cat', z: 0, len: 0 });
    if (g.copZ > CAM_Z + 0.7) items.push({ type: 'cop', z: g.copZ, len: 0 });
    items.sort((p, q) => q.z - p.z);
    for (const o of items) drawObject(o);
    if (g.flash > 0) {
      ctx.fillStyle = `rgba(255, 240, 120, ${Math.min(0.6, g.flash * 3)})`;
      ctx.fillRect(0, 0, w, h);
    }
    hud();
  }

  function box(x0, x1, y0, y1, z0, z1, front, side, top) {
    // Top
    quad(project(x0, y1, z1), project(x1, y1, z1), project(x1, y1, z0), project(x0, y1, z0), top);
    // Sides (only the one facing the camera shows)
    const camX = game.x * 0.35;
    if (x1 < camX) quad(project(x1, y1, z0), project(x1, y1, z1), project(x1, y0, z1), project(x1, y0, z0), side);
    if (x0 > camX) quad(project(x0, y1, z0), project(x0, y1, z1), project(x0, y0, z1), project(x0, y0, z0), side);
    // Front
    quad(project(x0, y1, z0), project(x1, y1, z0), project(x1, y0, z0), project(x0, y0, z0), front);
  }

  function drawObject(o) {
    const g = game;
    const cx = o.lane * LANE;
    const z0 = Math.max(o.z, CAM_Z + 0.5);
    if (o.type === 'cat' || o.type === 'cop') {
      const cop = o.type === 'cop';
      // The cop runs just behind you, a little to one side so you can see both.
      const x = cop ? g.x + 0.75 : g.x;
      const y = cop ? 0 : g.y;
      const p = project(x, y, o.z);
      if (!p) return;
      const img = cop ? assets.cop : assets.cat;
      const size = p.s * (cop ? 0.85 : 1.2);
      // Running: a bounce; rolling: squashed into a ball.
      const rolling = !cop && g.rollT >= 0;
      const bounce = g.state === 'running' && y < 0.05 && !rolling ? Math.abs(Math.sin((g.runFrame + (cop ? 0.5 : 0)) * Math.PI)) * size * 0.07 : 0;
      const hgt = rolling ? size * 0.55 : size;
      const wid = size * (img.width / img.height) * (rolling ? 1.1 : 1);
      const sh = project(x, 0, o.z);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(Math.round(sh.x - wid * 0.4), Math.round(sh.y - size * 0.05), Math.round(wid * 0.8), Math.max(1, Math.round(size * 0.08)));
      ctx.drawImage(img, Math.round(p.x - wid / 2), Math.round(p.y - hgt - bounce), Math.round(wid), Math.round(hgt));
      if (cop) return;
      if (g.boost) {
        ctx.fillStyle = g.boost.kind === 'triple' ? '#00c8d4' : '#00d26a';
        ctx.fillRect(Math.round(p.x - size * 0.3), Math.round(p.y - 2), Math.round(size * 0.6), 2);
      }
      return;
    }
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
    } else if (o.type === 'bolt' || o.type === 'power') {
      const x = typeof o.lane === 'number' ? o.lane * LANE : 0;
      const bob = Math.sin((g.time + o.z) * 6) * 0.08;
      const p = project(x, (o.y ?? 0.6) + bob, z0);
      if (!p) return;
      const size = p.s * (o.type === 'power' ? 0.85 : 0.55);
      const img = o.type === 'power' ? assets.icons[o.kind] : assets.bolt;
      // Spin: squash sideways.
      const squash = o.type === 'bolt' ? Math.abs(Math.cos((g.time * 4 + o.z) % Math.PI)) * 0.7 + 0.3 : 1;
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
    if (!game) return;
    els.score.textContent = score().toLocaleString();
    els.bolts.textContent = game.bolts.toLocaleString();
    const b = game.boost;
    els.boost.hidden = !b;
    if (b) {
      const img = els.boost.querySelector('img');
      if (img.dataset.kind !== b.kind) {
        img.src = BOOSTS[b.kind].icon;
        img.dataset.kind = b.kind;
      }
      els.boost.querySelector('span').style.width = `${Math.max(0, ((b.until - game.time) / BOOSTS[b.kind].secs) * 100)}%`;
    }
  }

  function loop(t) {
    if (!game) return;
    pollPad();
    if (game.state === 'running') {
      const dt = Math.min(0.05, (t - game.last) / 1000);
      game.last = t;
      update(dt);
    } else game.last = t;
    if (!game || game.state === 'over') return;
    render();
    frame = requestAnimationFrame(loop);
  }

  window.addEventListener('resize', () => game && size());

  return {
    start,
    stop,
    keyDown,
    get running() {
      return Boolean(game) && game.state !== 'over';
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

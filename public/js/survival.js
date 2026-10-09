import { onPress } from './input.js';
import { TEAM_COLORS } from './teams.js';
import { createRaceMusic, showNowPlaying } from './kart.js';
import {
  ANIMALS,
  CAMPFIRE_RECIPE,
  FIRE,
  NODES,
  PLAYER,
  PREP_MS,
  TOTAL_MS,
  WORLD,
  act,
  createGame,
  isWarm,
  movePlayer,
  resolveMove,
  step,
  survivalGems,
  worldNodes,
} from './survival-rules.js';

// Kat Survival (Playables), seen from above: get wood and stone, keep a
// campfire going, and survive the night. Solo, the world (survival-rules.js)
// runs right here; online the server runs it and this draws what it sends,
// with your own Kat moving straight away.

const ICONS = ['kat-front', 'kat-back', 'cow', 'pig', 'bear', 'tree', 'rock', 'fire-out', 'fire-1', 'fire-2', 'food', 'wood', 'stone', 'sword'];
const SIZE = { kat: 40, cow: [48, 36], pig: [40, 30], bear: [62, 46], tree: 64, rock: [40, 34], fire: 40 };
const SYNC_MS = 100;
const VIEW = 520; // about this many world units across, however big the screen
// For testing: ?katsurvival-night starts Solo just before nightfall.
const NIGHT_SOON = typeof location !== 'undefined' && /[?&]katsurvival-night\b/.test(location.search);

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
let images = null;
async function loadImages() {
  images ??= Promise.all(ICONS.map((n) => loadImage(`icons/survival/${n}.png`))).then((list) => Object.fromEntries(ICONS.map((n, i) => [n, list[i]])));
  return images;
}

/** The Kat with its blue shirt in a team's colour. */
const katCache = new Map();
function katSprite(img, view, team) {
  const key = `${view}:${team}`;
  if (katCache.has(key)) return katCache.get(key);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  const n = parseInt((TEAM_COLORS[team] ?? '#1f4fff').slice(1), 16);
  const [cr, cg, cb] = [n >> 16, (n >> 8) & 255, n & 255];
  for (let i = 0; i < px.length; i += 4) {
    const [r, gg, b] = [px[i], px[i + 1], px[i + 2]];
    if (b > 120 && b > r + 80 && b > gg + 60) {
      const k = b / 255;
      px[i] = Math.round(cr * k);
      px[i + 1] = Math.round(cg * k);
      px[i + 2] = Math.round(cb * k);
    }
  }
  g.putImageData(data, 0, 0);
  katCache.set(key, c);
  return c;
}

/** The grass, as a tile with a few tufts and flowers. */
function grassTile() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#4c9a3f';
  g.fillRect(0, 0, 128, 128);
  let s = 7;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = rand() < 0.5 ? '#438c37' : '#57a84a';
    g.fillRect(Math.floor(rand() * 32) * 4, Math.floor(rand() * 32) * 4, 8, 4);
  }
  for (let i = 0; i < 4; i++) {
    g.fillStyle = ['#fff36b', '#ffffff', '#ff8fb8'][i % 3];
    g.fillRect(Math.floor(rand() * 30) * 4, Math.floor(rand() * 30) * 4, 4, 4);
  }
  return c;
}

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Kat Survival in its screen. `els` holds the canvas and the HUD; `onOver(result)`
 * shows how it went.
 */
export function createKatSurvival(els) {
  const { canvas } = els;
  const ctx = canvas.getContext('2d');
  const music = createRaceMusic();
  let run = null;
  let frame = 0;
  let syncTimer = null;
  const keys = new Set();
  const stick = { id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
  let grass = null;

  function size() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(200, Math.round(rect.width));
    const h = Math.max(200, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  /**
   * Start.
   *   { mode: 'solo', team, name }
   *   { mode: 'online', seed, me, players, startAt, song, sync }: `sync(body)`
   *     sends your Kat and what it did, and resolves with { room, game, outcomes }.
   */
  async function start(opts) {
    stop();
    const img = await loadImages();
    grass ??= grassTile();
    size();
    const online = opts.mode === 'online';
    const meId = online ? opts.me : 'me';
    const seed = online ? opts.seed : Math.floor(Math.random() * 2 ** 31);
    // Solo: the whole world is here. Online: what the server last sent.
    const game = online ? null : createGame(seed, [{ id: 'me', name: opts.name, team: opts.team }]);
    if (game && NIGHT_SOON) game.t = PREP_MS - 6000;
    const view = online
      ? { t: 0, phase: 'day', players: opts.players.map((p, i) => ({ ...p, x: WORLD / 2, y: WORLD / 2, hp: PLAYER.hp, hunger: 100, alive: true, inv: {}, i })), animals: [], fires: [], nodes: worldNodes(seed), events: [] }
      : game;
    run = {
      online,
      meId,
      seed,
      game,
      view,
      img,
      sync: opts.sync,
      startAt: online ? opts.startAt : performance.now() + 3000,
      me: { x: WORLD / 2, y: WORLD / 2, angle: Math.PI / 2, moving: false },
      shown: new Map(), // id -> {x, y} drawn (smoothed) positions of everyone else
      actions: [],
      seen: 0,
      floaters: [],
      shake: 0,
      hurtAt: -1e9,
      last: performance.now(),
      acc: 0,
      snapAt: performance.now(),
      over: false,
      song: opts.song,
    };
    const mine = view.players.find((p) => p.id === meId);
    if (game) Object.assign(run.me, { x: mine.x, y: mine.y });
    else {
      const i = opts.players.findIndex((p) => p.id === meId);
      const n = opts.players.length;
      Object.assign(run.me, { x: WORLD / 2 + Math.cos((i / n) * Math.PI * 2) * 60, y: WORLD / 2 + Math.sin((i / n) * Math.PI * 2) * 60 });
    }
    els.countdown.hidden = false;
    els.over.hidden = true;
    renderHud();
    if (online) syncTimer = setInterval(sendSync, SYNC_MS);
    frame = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(frame);
    clearInterval(syncTimer);
    music.pause();
    run = null;
    keys.clear();
    stick.id = null;
  }

  // ---------- online ----------
  let syncing = false;
  async function sendSync() {
    if (!run?.online || syncing || run.over) return;
    if (performance.now() < run.startAt) return;
    syncing = true;
    const actions = run.actions.splice(0, 6);
    const r = run;
    try {
      const { room, game, outcomes } = await r.sync({ x: Math.round(r.me.x * 10) / 10, y: Math.round(r.me.y * 10) / 10, angle: Math.round(r.me.angle * 100) / 100, actions });
      if (run !== r) return;
      for (const o of outcomes ?? []) if (o.error) alert(o.error);
      if (game) applySnapshot(game);
      if (room?.state === 'done' && room.results) finishOnline(room.results);
    } catch {
      // Try again in a moment.
    } finally {
      syncing = false;
    }
  }

  function applySnapshot(snap) {
    const v = run.view;
    const nodeHp = new Map(snap.nodes);
    for (const n of v.nodes) n.hp = nodeHp.get(n.id) ?? NODES[n.kind].hp;
    Object.assign(v, { t: snap.t, phase: snap.phase, players: snap.players, animals: snap.animals, fires: snap.fires, events: snap.events, results: snap.results });
    run.snapAt = performance.now();
    // The server has the last word on where you are (trees, running too fast).
    const me = snap.players.find((p) => p.id === run.meId);
    if (me && Math.hypot(me.x - run.me.x, me.y - run.me.y) > 80) Object.assign(run.me, { x: me.x, y: me.y });
    handleEvents(snap.events);
  }

  function finishOnline(results) {
    if (run.over) return;
    run.over = true;
    clearInterval(syncTimer);
    const me = results.find((r) => r.id === run.meId);
    els.onOver({ mode: 'online', results, me, gems: me ? survivalGems(me) : 1 });
  }

  // ---------- what happened: little numbers and shakes ----------
  function float(x, y, text, color = '#fff') {
    run.floaters.push({ x, y, text, color, at: performance.now() });
  }
  function handleEvents(events) {
    for (const e of events ?? []) {
      if (e.id <= run.seen) continue;
      run.seen = e.id;
      const mine = e.by === run.meId || e.who === run.meId;
      if (e.type === 'gather' && e.by === run.meId) float(e.x, e.y - 20, `+${e.amount} ${e.gives}`, '#ffe9a8');
      if (e.type === 'hit') float(e.x, e.y - 24, e.killed ? `+${e.food} food` : '-10', e.killed ? '#ffd27a' : '#fff');
      if (e.type === 'bite') {
        float(e.x, e.y - 30, `-${e.damage}`, '#ff5b5b');
        if (e.who === run.meId) {
          run.shake = 8;
          run.hurtAt = performance.now();
          navigator.vibrate?.(30);
        }
      }
      if (e.type === 'fuel' && mine) float(e.x, e.y - 30, `+${e.amount} wood 🔥`, '#ffb347');
      if (e.type === 'craft' && mine) float(e.x, e.y - 30, '+1 campfire', '#ffb347');
      if (e.type === 'eat' && mine) float(e.x, e.y - 30, '+food', '#9cff8a');
      if (e.type === 'night') alert('🌙 Night has fallen! Stay by a campfire and watch out for bears!');
      if (e.type === 'died' && e.who === run.meId) {
        const why = { bear: 'A bear got you!', cold: 'You froze in the dark!', hunger: 'You starved!' }[e.by] ?? 'You were knocked out!';
        alert(`💀 ${why}${run.online ? ' Watching the others…' : ''}`);
      } else if (e.type === 'died') {
        const p = run.view.players.find((q) => q.id === e.who);
        if (p) alert(`💀 ${p.name} is out!`);
      }
    }
  }

  let alertTimer = 0;
  function alert(text) {
    els.alert.textContent = text;
    els.alert.hidden = false;
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => (els.alert.hidden = true), 2600);
  }

  // ---------- doing things ----------
  function doAction(type, extra = {}) {
    if (!run || run.over || performance.now() < run.startAt) return;
    const me = run.view.players.find((p) => p.id === run.meId);
    if (!me?.alive) return;
    if (type === 'swing') run.swingShown = performance.now();
    if (type === 'fuel') extra = { amount: Math.min(5, me.inv.wood || 1), ...extra };
    if (run.online) {
      run.actions.push({ type, ...extra });
      return;
    }
    movePlayer(run.game, 'me', run.me.x, run.me.y, run.me.angle);
    const out = act(run.game, 'me', { type, ...extra });
    if (out.error && type !== 'swing') alert(out.error);
    handleEvents(run.game.events);
    renderHud();
  }
  onPress(els.swing, () => doAction('swing'));
  onPress(els.eat, () => doAction('eat'));
  onPress(els.place, () => doAction('place'));
  onPress(els.fuel, () => doAction('fuel'));
  onPress(els.craft, () => doAction('craft'));

  // Hold the swing button (or Space) to keep swinging.
  let holdSwing = false;
  els.swing.addEventListener('pointerdown', () => (holdSwing = true));
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) els.swing.addEventListener(ev, () => (holdSwing = false));

  // ---------- moving: a thumbstick wherever you put a finger (left side), or keys ----------
  const stage = canvas.parentElement;
  stage.addEventListener('pointerdown', (e) => {
    if (!run || e.target.closest('button') || stick.id != null) return;
    const rect = canvas.getBoundingClientRect();
    if (e.pointerType !== 'mouse' && e.clientX - rect.left > rect.width * 0.6) return;
    stick.id = e.pointerId;
    stick.ox = e.clientX - rect.left;
    stick.oy = e.clientY - rect.top;
    stick.dx = stick.dy = 0;
    stage.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stick.id) return;
    const rect = canvas.getBoundingClientRect();
    let dx = e.clientX - rect.left - stick.ox;
    let dy = e.clientY - rect.top - stick.oy;
    const d = Math.hypot(dx, dy);
    if (d > 44) {
      dx *= 44 / d;
      dy *= 44 / d;
    }
    stick.dx = dx / 44;
    stick.dy = dy / 44;
  });
  const endStick = (e) => {
    if (e.pointerId !== stick.id) return;
    stick.id = null;
    stick.dx = stick.dy = 0;
  };
  stage.addEventListener('pointerup', endStick);
  stage.addEventListener('pointercancel', endStick);

  function onKey(e, down) {
    if (!run) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const move = ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (move.includes(k)) {
      if (down) keys.add(k);
      else keys.delete(k);
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'j') {
      holdSwing = down;
      if (down && !e.repeat) doAction('swing');
      e.preventDefault();
      return;
    }
    if (!down || e.repeat) return;
    const action = { e: 'eat', f: 'fuel', q: 'place', p: 'place', c: 'craft' }[k];
    if (action) {
      doAction(action);
      e.preventDefault();
    }
  }

  let padHeld = {};
  function input() {
    let x = (keys.has('d') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('a') || keys.has('ArrowLeft') ? 1 : 0);
    let y = (keys.has('s') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('w') || keys.has('ArrowUp') ? 1 : 0);
    if (stick.id != null) {
      x = stick.dx;
      y = stick.dy;
    }
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue;
      const [ax = 0, ay = 0] = pad.axes;
      if (Math.hypot(ax, ay) > 0.25) [x, y] = [ax, ay];
      if (pad.buttons[12]?.pressed) y = -1;
      if (pad.buttons[13]?.pressed) y = 1;
      if (pad.buttons[14]?.pressed) x = -1;
      if (pad.buttons[15]?.pressed) x = 1;
      // A swing, X eat, B add wood, Y put down a campfire, RB make one.
      const map = { 0: 'swing', 2: 'eat', 1: 'fuel', 3: 'place', 5: 'craft' };
      for (const [i, type] of Object.entries(map)) {
        const down = Boolean(pad.buttons[i]?.pressed);
        if (down && (!padHeld[i] || type === 'swing')) doAction(type);
        padHeld[i] = down;
      }
    }
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  // ---------- the loop ----------
  function loop(t) {
    frame = requestAnimationFrame(loop);
    if (!run) return;
    size();
    const dt = Math.min(100, t - run.last);
    run.last = t;
    const started = t >= run.startAt;
    if (!started) els.countdown.textContent = String(Math.ceil((run.startAt - t) / 1000));
    else if (!els.countdown.hidden) {
      els.countdown.hidden = true;
      music.play(music.pick(run.song)).then((song) => showNowPlaying(els.nowPlaying, song));
      alert('☀️ Get wood and stone, and food from cows and pigs. Night comes in 5 minutes!');
    }
    const v = run.view;
    const me = v.players.find((p) => p.id === run.meId);
    if (started && !run.over && me?.alive) {
      const dir = input();
      if (Math.hypot(dir.x, dir.y) > 0.1) {
        run.me.angle = Math.atan2(dir.y, dir.x);
        const sp = (PLAYER.speed * dt) / 1000;
        Object.assign(run.me, resolveMove(v, run.me.x + dir.x * sp, run.me.y + dir.y * sp));
        run.me.moving = true;
      } else run.me.moving = false;
      if (holdSwing && performance.now() - (run.swingShown ?? 0) > 400) doAction('swing');
    }
    if (started && !run.online && !run.over) {
      movePlayer(run.game, 'me', run.me.x, run.me.y, run.me.angle);
      run.acc += dt;
      while (run.acc >= 50) {
        step(run.game, 50);
        run.acc -= 50;
      }
      handleEvents(run.game.events);
      if (run.game.over) {
        run.over = true;
        const r = run.game.results[0];
        els.onOver({ mode: 'solo', results: run.game.results, me: r, gems: survivalGems(r) });
      }
    }
    render(t);
    renderHud();
  }

  /** The time in the game now (online: what the server said, plus since then). */
  const gameTime = () => (run.online ? run.view.t + (run.view.phase === 'over' ? 0 : performance.now() - run.snapAt) : run.game.t);

  function render(now) {
    const { img, view: v } = run;
    const W = canvas.width;
    const H = canvas.height;
    const zoom = Math.max(0.8, Math.min(W, H * 1.4) / VIEW);
    const me = v.players.find((p) => p.id === run.meId);
    // Out of it? Watch someone still going.
    let focus = run.me;
    if (me && !me.alive) {
      const other = v.players.find((p) => p.alive && !p.gone);
      if (other) focus = smoothed(other, 0);
    }
    run.shake *= 0.85;
    const camX = focus.x - W / zoom / 2 + (Math.random() - 0.5) * run.shake;
    const camY = focus.y - H / zoom / 2 + (Math.random() - 0.5) * run.shake;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#1d4d22';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(zoom, 0, 0, zoom, -camX * zoom, -camY * zoom);
    // The ground.
    const pattern = ctx.createPattern(grass, 'repeat');
    ctx.fillStyle = pattern;
    ctx.fillRect(Math.max(0, camX), Math.max(0, camY), Math.min(WORLD, camX + W / zoom) - Math.max(0, camX), Math.min(WORLD, camY + H / zoom) - Math.max(0, camY));
    ctx.strokeStyle = '#143a18';
    ctx.lineWidth = 8;
    ctx.strokeRect(-4, -4, WORLD + 8, WORLD + 8);
    const inView = (x, y, m = 80) => x > camX - m && y > camY - m && x < camX + W / zoom + m && y < camY + H / zoom + m;
    // Campfires and rocks are flat, so they go first; then everything else, back to front.
    const flicker = Math.floor(now / 160) % 2;
    for (const f of v.fires) {
      if (!inView(f.x, f.y)) continue;
      const lit = f.fuel > 0 && gameTime() >= PREP_MS;
      const sprite = lit ? img[flicker ? 'fire-1' : 'fire-2'] : img['fire-out']; // they burn at night
      ctx.drawImage(sprite, f.x - SIZE.fire / 2, f.y - SIZE.fire / 2 - 6, SIZE.fire, SIZE.fire);
      // How much wood is left (seconds of fire).
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(f.x - 18, f.y + 16, 36, 4);
      ctx.fillStyle = '#ffb347';
      ctx.fillRect(f.x - 18, f.y + 16, (36 * Math.min(FIRE.maxFuel, f.fuel)) / FIRE.maxFuel, 4);
    }
    const things = [];
    for (const n of v.nodes) if (n.hp > 0 && inView(n.x, n.y)) things.push({ y: n.y, draw: () => drawNode(n) });
    for (const a of v.animals) {
      const s = smoothed(a, now);
      if (inView(s.x, s.y)) things.push({ y: s.y, draw: () => drawAnimal(a, s) });
    }
    for (const p of v.players) {
      if (p.gone) continue;
      const pos = p.id === run.meId ? run.me : smoothed(p, now);
      if (inView(pos.x, pos.y)) things.push({ y: pos.y, draw: () => drawKat(p, pos, now) });
    }
    things.sort((a, b) => a.y - b.y);
    for (const t of things) t.draw();
    // Floating numbers.
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    run.floaters = run.floaters.filter((f) => now - f.at < 1100);
    for (const f of run.floaters) {
      const k = (now - f.at) / 1100;
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = '#000';
      ctx.fillText(f.text, f.x + 1, f.y - k * 26 + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - k * 26);
    }
    ctx.globalAlpha = 1;
    drawDark(now, camX, camY, zoom);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Hurt: a red edge.
    const hurt = now - run.hurtAt;
    if (hurt < 350) {
      ctx.fillStyle = `rgba(255,0,0,${0.3 * (1 - hurt / 350)})`;
      ctx.fillRect(0, 0, W, H);
    }
    // The thumbstick.
    if (stick.id != null) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(stick.ox, stick.oy, 48, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(stick.ox + stick.dx * 44, stick.oy + stick.dy * 44, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    drawMinimap(focus);
  }

  /** Everyone else glides towards where the server last said they were. */
  function smoothed(thing, now) {
    if (!run.online) return thing;
    let s = run.shown.get(thing.id);
    if (!s) {
      s = { x: thing.x, y: thing.y, at: now };
      run.shown.set(thing.id, s);
    }
    const dt = Math.min(100, Math.max(0, now - s.at));
    s.at = now;
    const k = Math.min(1, dt / 90);
    s.x += (thing.x - s.x) * k;
    s.y += (thing.y - s.y) * k;
    if (Math.hypot(thing.x - s.x, thing.y - s.y) > 200) Object.assign(s, { x: thing.x, y: thing.y });
    return s;
  }

  function drawNode(n) {
    const { img } = run;
    const max = NODES[n.kind].hp;
    if (n.kind === 'tree') ctx.drawImage(img.tree, n.x - SIZE.tree / 2, n.y - SIZE.tree / 2 - 8, SIZE.tree, SIZE.tree);
    else ctx.drawImage(img.rock, n.x - SIZE.rock[0] / 2, n.y - SIZE.rock[1] / 2, ...SIZE.rock);
    if (n.hp < max) bar(n.x, n.y - 30, n.hp / max, '#ffe9a8');
  }

  function drawAnimal(a, s) {
    const [w, h] = SIZE[a.kind];
    ctx.save();
    ctx.translate(s.x, s.y);
    if (a.face < 0) ctx.scale(-1, 1);
    ctx.drawImage(run.img[a.kind], -w / 2, -h / 2 - 6, w, h);
    ctx.restore();
    if (a.hp < ANIMALS[a.kind].hp) bar(s.x, s.y - h / 2 - 12, a.hp / ANIMALS[a.kind].hp, a.kind === 'bear' ? '#ff5b5b' : '#9cff8a');
  }

  function drawKat(p, pos, now) {
    const { img } = run;
    const angle = p.id === run.meId ? run.me.angle : p.angle;
    const back = Math.sin(angle) < -0.45; // walking away (up the screen): the back of its head
    const sprite = katSprite(img[back ? 'kat-back' : 'kat-front'], back ? 'back' : 'front', p.team);
    const moving = p.id === run.meId ? run.me.moving : false;
    const bob = moving ? Math.sin(now / 70) * 1.5 : 0;
    ctx.globalAlpha = p.alive ? 1 : 0.35;
    // Shadow, Kat, and the sword in its hand (swinging when it swings).
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y + 16, 13, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    const swingAge = p.id === run.meId ? now - (run.swingShown ?? -1e9) : (gameTime() - (p.swingAt ?? -1e9));
    const swing = swingAge < 250 ? Math.sin((swingAge / 250) * Math.PI) : 0;
    const drawSword = () => {
      ctx.save();
      ctx.translate(pos.x + Math.cos(angle) * 14, pos.y + 6 + Math.sin(angle) * 10);
      ctx.rotate(angle + Math.PI / 4 - 0.9 + swing * 1.8);
      ctx.drawImage(img.sword, -2, -18, 20, 20);
      ctx.restore();
    };
    if (back) drawSword();
    ctx.drawImage(sprite, pos.x - SIZE.kat / 2, pos.y - SIZE.kat / 2 - 6 + bob, SIZE.kat, SIZE.kat);
    if (!back && p.alive) drawSword();
    ctx.globalAlpha = 1;
    if (p.id !== run.meId) {
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000';
      ctx.fillText(p.name, pos.x + 1, pos.y - 29);
      ctx.fillStyle = '#fff';
      ctx.fillText(p.name, pos.x, pos.y - 30);
      if (p.alive) bar(pos.x, pos.y - 26, p.hp / PLAYER.hp, '#ff5b5b');
    }
  }

  function bar(x, y, k, color) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 15, y, 30, 4);
    ctx.fillStyle = color;
    ctx.fillRect(x - 15, y, 30 * Math.max(0, Math.min(1, k)), 4);
  }

  // Night: dark, except round burning campfires (and a little round each Kat).
  let dark = null;
  function drawDark(now, camX, camY, zoom) {
    const t = gameTime();
    const dusk = Math.max(0, Math.min(1, (t - (PREP_MS - 25000)) / 25000));
    const dawn = Math.max(0, Math.min(1, (t - (TOTAL_MS - 8000)) / 8000));
    const level = 0.88 * dusk * (1 - dawn);
    if (level <= 0.01) return;
    const W = canvas.width;
    const H = canvas.height;
    dark ??= document.createElement('canvas');
    if (dark.width !== W || dark.height !== H) {
      dark.width = W;
      dark.height = H;
    }
    const g = dark.getContext('2d');
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
    g.fillStyle = `rgba(6, 8, 30, ${level})`;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'destination-out';
    const hole = (wx, wy, r) => {
      const x = (wx - camX) * zoom;
      const y = (wy - camY) * zoom;
      const rr = r * zoom;
      const grad = g.createRadialGradient(x, y, rr * 0.2, x, y, rr);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.7, 'rgba(0,0,0,0.75)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    };
    const lit = t >= PREP_MS;
    for (const f of run.view.fires) if (f.fuel > 0 && lit) hole(f.x, f.y, FIRE.warmth * 1.2 + Math.sin(now / 120 + f.id) * 4);
    for (const p of run.view.players) if (p.alive && !p.gone) {
      const pos = p.id === run.meId ? run.me : smoothed(p, now);
      hole(pos.x, pos.y, 70);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(dark, 0, 0);
    // A warm glow on top.
    ctx.globalCompositeOperation = 'lighter';
    for (const f of run.view.fires) {
      if (!(f.fuel > 0 && lit)) continue;
      const x = (f.x - camX) * zoom;
      const y = (f.y - camY) * zoom;
      const r = 60 * zoom;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(255,150,40,${0.25 * level})`);
      grad.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawMinimap(focus) {
    const m = els.minimap.getContext('2d');
    const s = els.minimap.width / WORLD;
    m.clearRect(0, 0, els.minimap.width, els.minimap.height);
    m.fillStyle = 'rgba(30,70,30,0.85)';
    m.fillRect(0, 0, els.minimap.width, els.minimap.height);
    const dot = (x, y, r, color) => {
      m.fillStyle = color;
      m.fillRect(Math.round(x * s - r), Math.round(y * s - r), r * 2, r * 2);
    };
    for (const f of run.view.fires) dot(f.x, f.y, 2, f.fuel > 0 ? '#ffb347' : '#6b4422');
    for (const a of run.view.animals) if (a.kind === 'bear' && Math.hypot(a.x - focus.x, a.y - focus.y) < 700) dot(a.x, a.y, 1.5, '#ff4040');
    for (const p of run.view.players) {
      if (p.gone || !p.alive) continue;
      const pos = p.id === run.meId ? run.me : p;
      dot(pos.x, pos.y, p.id === run.meId ? 2.5 : 2, TEAM_COLORS[p.team] ?? '#fff');
    }
  }

  // ---------- the HUD ----------
  function renderHud() {
    if (!run) return;
    const v = run.view;
    const me = v.players.find((p) => p.id === run.meId);
    const t = Math.min(TOTAL_MS, gameTime());
    const night = t >= PREP_MS;
    els.clock.textContent = night ? `🌙 ${fmt(TOTAL_MS - t)} until morning` : `☀️ ${fmt(PREP_MS - t)} until night`;
    els.clock.classList.toggle('night', night);
    if (!me) return;
    els.hp.style.setProperty('--fill', `${Math.max(0, me.hp)}%`);
    els.hunger.style.setProperty('--fill', `${Math.max(0, me.hunger)}%`);
    els.hpText.textContent = String(Math.ceil(me.hp));
    els.hungerText.textContent = String(Math.ceil(me.hunger));
    const inv = me.inv ?? {};
    els.food.textContent = String(inv.food ?? 0);
    els.wood.textContent = String(inv.wood ?? 0);
    els.stone.textContent = String(inv.stone ?? 0);
    els.campfires.textContent = String(inv.campfire ?? 0);
    const near = v.fires.some((f) => Math.hypot(f.x - run.me.x, f.y - run.me.y) <= FIRE.near);
    els.fuel.disabled = !near || !(inv.wood > 0);
    els.place.disabled = !(inv.campfire > 0);
    els.craft.disabled = !(inv.wood >= CAMPFIRE_RECIPE.wood && inv.stone >= CAMPFIRE_RECIPE.stone);
    els.eat.disabled = !(inv.food > 0);
    const cold = night && me.alive && !isWarm({ t, fires: v.fires }, run.me);
    els.cold.hidden = !cold;
  }

  window.addEventListener('resize', () => run && size());

  return {
    start,
    stop,
    unlockAudio: () => music.unlock(),
    keyDown: (e) => onKey(e, true),
    keyUp: (e) => onKey(e, false),
    get running() {
      return Boolean(run) && !run.over;
    },
  };
}

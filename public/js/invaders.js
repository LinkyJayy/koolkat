// Kat Invaders (Playables): mice come down from the top; shoot as many as
// you can in 2 minutes. Each mouse is worth 10 to 50 points. Mice can't hurt
// you, unless one gets close to you: then you lose a life. Lives depend on
// the difficulty: Easy 5, Medium 3, Hard 1. Drawn in chunky pixels like Kat
// Kart and KatEscape.
//
// Swipe left / right to move, swipe up or tap to shoot. Keyboard: ← → or
// A D to move, Space / W / ↑ to shoot. Controller: D-pad or stick, A to shoot.
//
// Modes: solo; practice (against bots); online (everyone gets the same mice,
// from the same seed, and races for points).

import { gamepadSteer } from './input.js';
import { createRaceMusic, showNowPlaying } from './kart.js';
import { ALL_TEAMS, BASE_TEAMS } from './teams.js';

export const GAME_SECONDS = 120;
export const LIVES = { easy: 5, medium: 3, hard: 1 };
export const DIFFICULTIES = [
  ['easy', 'Easy', '5 lives'],
  ['medium', 'Medium', '3 lives'],
  ['hard', 'Hard', '1 life'],
];
const W = 180;
const H = 320;
const PLAYER_Y = H - 24;
const MOVE_SPEED = 150; // px per second
const BULLET_SPEED = 300;
const FIRE_GAP = 0.2;
const HURT_GAP = 1.2; // after losing a life, a moment where nothing can hurt you
const TOUCH = 15; // a mouse this close gets you
const BEST_KEY = 'koolkat.katInvaders.best';
const BOT_NAMES = ['Whiskers', 'Mittens', 'Nala', 'Tigger'];

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

function seeded(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same seed, same mice: when each one comes, where, how fast, and how many points. */
export function mouseSchedule(seed, seconds = GAME_SECONDS) {
  const r = seeded(seed);
  const mice = [];
  let t = 1.2;
  let id = 0;
  while (t < seconds) {
    const k = t / seconds; // it gets busier
    mice.push({
      id: id++,
      t,
      x: 14 + r() * (W - 28),
      speed: 26 + k * 34 + r() * 14,
      amp: r() * 16,
      phase: r() * Math.PI * 2,
      points: (1 + Math.floor(r() * 5)) * 10,
    });
    t += 1.15 - 0.7 * k + r() * 0.35;
  }
  return mice;
}

/** Where a mouse is at time t (or null before it comes). */
export function mousePos(m, t) {
  if (t < m.t) return null;
  const dt = t - m.t;
  return { x: m.x + Math.sin(m.phase + dt * 2.2) * m.amp, y: -12 + m.speed * dt };
}

export function createKatInvaders(els) {
  const { canvas } = els;
  const ctx = canvas.getContext('2d');
  canvas.width = W;
  canvas.height = H;
  let game = null;
  let frame = 0;
  let assets = null;
  const music = createRaceMusic();

  async function loadAssets() {
    if (assets) return assets;
    const teams = ALL_TEAMS;
    const imgs = await Promise.all([...teams.map((t) => `icons/invaders/team-${t}.png`), 'icons/invaders/mouse.png'].map(loadImage));
    // The mouse is loaded last, after one cat for every team.
    assets = { cats: Object.fromEntries(teams.map((t, i) => [t, imgs[i]])), mouse: imgs.at(-1) };
    return assets;
  }

  /**
   * opts: { mode: 'solo' | 'practice' | 'online', difficulty, team, name, seed,
   *   startAt (performance.now() of GO, online), song, bots (practice),
   *   others: [{ id, name, team }] (online), sync(state) -> Promise<room> }
   */
  async function start(opts) {
    await loadAssets();
    stop();
    const mode = opts.mode ?? 'solo';
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    const lives = LIVES[opts.difficulty] ?? 3;
    game = {
      mode,
      difficulty: opts.difficulty ?? 'medium',
      team: opts.team ?? 'red',
      name: opts.name ?? 'You',
      sync: opts.sync ?? null,
      song: opts.song ?? null,
      state: mode === 'online' ? 'countdown' : 'ready',
      startAt: opts.startAt ?? null,
      time: 0,
      last: performance.now(),
      x: W / 2,
      score: 0,
      lives,
      maxLives: lives,
      hurtUntil: -10,
      fireAt: 0,
      bullets: [],
      pops: [], // "+30" floating up
      mice: mouseSchedule(seed),
      gone: new Set(), // mice you've shot (or that got you)
      others: new Map(), // id -> { name, team, x, score, lives, status, bot? }
      held: { left: false, right: false, fire: false },
      flash: 0,
      finished: false,
    };
    for (const p of opts.others ?? []) game.others.set(p.id, { name: p.name, team: p.team, x: 0.5, score: 0, lives, status: 'playing' });
    if (mode === 'practice') {
      const teams = BASE_TEAMS.filter((t) => t !== game.team);
      const n = opts.bots ?? 3;
      for (let i = 0; i < n; i++) game.others.set(`bot-${i + 1}`, makeBot(`🤖 ${BOT_NAMES[i]}`, teams[i], lives, (i + 1) / (n + 1)));
    }
    els.over.hidden = true;
    els.hint.hidden = mode === 'online';
    els.countdown.hidden = true;
    hud();
    frame = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(frame);
    music.pause();
    if (game) game.finished = true;
    game = null;
    els.countdown.hidden = true;
  }

  // ---------- Practice bots: they get some mice, miss some, and now and then one gets them ----------
  function makeBot(name, team, lives, x) {
    const skill = 0.25 + Math.random() * 0.2; // how many of the mice it gets
    // Each bot keeps a little to one side, so they don't all pile up.
    return { name, team, bot: true, skill, x, offset: (x - 0.5) * 40, score: 0, lives, status: 'playing', plan: new Map(), hurtUntil: -10 };
  }
  function planBot(bot, m) {
    const roll = Math.random();
    if (roll < bot.skill) bot.plan.set(m.id, { at: m.t + 0.8 + Math.random() * 2.2, hit: true });
    else if (roll < bot.skill + (1 - bot.skill) * 0.06) bot.plan.set(m.id, { at: m.t + (PLAYER_Y + 12) / m.speed, hit: false });
  }
  function updateBots(t) {
    for (const bot of game.others.values()) {
      if (!bot.bot || bot.status !== 'playing') continue;
      let aim = null;
      for (const m of game.mice) {
        if (m.t > t) break;
        if (!bot.plan.has(m.id) && !bot.planned?.has(m.id)) {
          (bot.planned ??= new Set()).add(m.id);
          planBot(bot, m);
        }
        const p = bot.plan.get(m.id);
        if (!p) continue;
        if (t >= p.at) {
          bot.plan.delete(m.id);
          if (p.hit) bot.score += m.points;
          else if (t > bot.hurtUntil) {
            bot.lives -= 1;
            bot.hurtUntil = t + HURT_GAP;
            if (bot.lives <= 0) bot.status = 'out';
          }
        } else if (p.hit && (!aim || p.at < aim.at)) aim = { at: p.at, m };
      }
      // Slide towards the mouse it's going for.
      const target = (aim ? mousePos(aim.m, t)?.x ?? W / 2 : W / 2) + bot.offset;
      bot.x += (target / W - bot.x) * 0.08;
    }
  }
  /** You're done in Practice: play the bots' games out to the end, straight away. */
  function finishBots() {
    for (let t = game.time; t <= GAME_SECONDS; t += 0.25) updateBots(t);
  }

  // ---------- controls ----------
  function begin() {
    const g = game;
    g.state = 'playing';
    g.last = performance.now();
    els.hint.hidden = true;
    els.countdown.hidden = true;
    const song = music.pick(g.song ?? els.song?.value);
    g.songPlaying = song;
    music.play(song);
    showNowPlaying(els.nowPlaying, song);
  }
  function fire() {
    const g = game;
    if (!g) return;
    if (g.state === 'ready') return begin();
    if (g.state !== 'playing' || g.time < g.fireAt) return;
    g.fireAt = g.time + FIRE_GAP;
    // Out of the blaster, on the cat's right.
    g.bullets.push({ x: g.x + 12, y: PLAYER_Y - 10 });
  }

  // Swipes: drag left / right to move, swipe up or tap to shoot.
  let touch = null;
  const stage = canvas.parentElement;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, select, label')) return;
    touch = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, shot: false };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!touch || !game) return;
    const scale = W / Math.max(1, canvas.getBoundingClientRect().width);
    const dx = e.clientX - touch.x;
    touch.x = e.clientX;
    if (Math.abs(e.clientX - touch.sx) > 6) touch.moved = true;
    if (game.state === 'playing') game.x = Math.max(10, Math.min(W - 18, game.x + dx * scale * 1.2));
    // A flick upwards shoots.
    if (!touch.shot && touch.sy - e.clientY > 30 && Math.abs(e.clientY - touch.sy) > Math.abs(e.clientX - touch.sx)) {
      touch.shot = true;
      fire();
    }
  });
  stage.addEventListener('pointerup', () => {
    if (touch && !touch.moved && !touch.shot) fire();
    touch = null;
  });
  stage.addEventListener('pointercancel', () => (touch = null));

  const KEYS = { arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', ' ': 'fire', w: 'fire', arrowup: 'fire', enter: 'fire' };
  function keyDown(e) {
    const k = KEYS[e.key.toLowerCase()];
    if (!k || !game) return;
    e.preventDefault();
    game.held[k] = true;
    if (k === 'fire' && !e.repeat) fire();
  }
  function keyUp(e) {
    const k = KEYS[e.key.toLowerCase()];
    if (k && game) game.held[k] = false;
  }
  let padFire = false;
  function pollPad() {
    let fireNow = false;
    let steer = 0;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue;
      steer = gamepadSteer();
      if (pad.buttons[0]?.pressed || pad.buttons[7]?.pressed || pad.buttons[5]?.pressed) fireNow = true;
    }
    if (game) {
      game.padSteer = steer;
      if (fireNow && (!padFire || game.time >= game.fireAt)) fire();
    }
    padFire = fireNow;
  }

  // ---------- the game ----------
  function update(dt) {
    const g = game;
    g.time += dt;
    const t = g.time;
    // Move
    const dir = (g.held.right ? 1 : 0) - (g.held.left ? 1 : 0) || g.padSteer || 0;
    g.x = Math.max(10, Math.min(W - 18, g.x + dir * MOVE_SPEED * dt));
    if (g.held.fire && t >= g.fireAt) fire();
    // Bullets
    for (const b of g.bullets) b.y -= BULLET_SPEED * dt;
    g.bullets = g.bullets.filter((b) => b.y > -8 && !b.hit);
    // Mice
    for (const m of g.mice) {
      if (m.t > t) break;
      if (g.gone.has(m.id)) continue;
      const p = mousePos(m, t);
      if (p.y > H + 14) {
        g.gone.add(m.id); // got past: no harm done
        continue;
      }
      for (const b of g.bullets) {
        if (!b.hit && Math.abs(b.x - p.x) < 9 && Math.abs(b.y - p.y) < 11) {
          b.hit = true;
          g.gone.add(m.id);
          g.score += m.points;
          g.pops.push({ x: p.x, y: p.y, text: `+${m.points}`, until: t + 0.8 });
          break;
        }
      }
      if (g.gone.has(m.id)) continue;
      // Too close: you lose a life.
      if (t > g.hurtUntil && Math.abs(p.x - g.x) < TOUCH && Math.abs(p.y - (PLAYER_Y - 4)) < TOUCH) {
        g.gone.add(m.id);
        g.lives -= 1;
        g.hurtUntil = t + HURT_GAP;
        g.flash = 0.25;
        announce(g.lives > 0 ? `🐭 A mouse got you! ${g.lives} ${g.lives === 1 ? 'life' : 'lives'} left` : '🐭 Out of lives!');
        if (g.lives <= 0) return end('out');
      }
    }
    g.pops = g.pops.filter((p) => p.until > t);
    if (g.flash > 0) g.flash -= dt;
    if (g.mode === 'practice') updateBots(t);
    if (t >= GAME_SECONDS) end('time');
  }

  /** Your game's over: out of lives, or the 2 minutes are up. */
  function end(why) {
    const g = game;
    g.state = 'over';
    g.why = why;
    music.pause();
    render();
    const survived = why === 'time' && g.lives > 0;
    if (g.mode === 'online') {
      // Wait for everyone (the server says when).
      els.onWaiting({ score: g.score, why });
      return;
    }
    if (g.mode === 'practice') finishBots();
    let best = 0;
    try {
      best = Number(localStorage.getItem(BEST_KEY)) || 0;
      if (g.mode === 'solo' && g.score > best) localStorage.setItem(BEST_KEY, String(g.score));
    } catch {
      // Just for fun.
    }
    g.finished = true;
    els.onOver({ mode: g.mode, why, survived, score: g.score, best: Math.max(best, g.score), newBest: g.mode === 'solo' && g.score > best, players: standings(), lives: g.lives });
  }

  const ranked = (list) =>
    [...list].sort((a, b) => b.score - a.score).map((p, i, all) => ({ ...p, place: all.findIndex((q) => q.score === p.score) + 1 }));
  const standings = () => ranked([{ id: 'me', name: game.name, team: game.team, score: game.score, me: true }, ...[...game.others.entries()].map(([id, o]) => ({ id, name: o.name, team: o.team, score: o.score }))]);

  let announceTimer = null;
  function announce(text) {
    els.alert.textContent = text;
    els.alert.hidden = false;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => (els.alert.hidden = true), 1600);
  }

  // ---------- online ----------
  let syncing = false;
  let lastSync = 0;
  function maybeSync(t) {
    const g = game;
    if (!g.sync || syncing || g.finished || g.state === 'countdown' || t - lastSync < 150) return;
    syncing = true;
    lastSync = t;
    g.sync({ x: g.x / W, score: g.score, lives: Math.max(0, g.lives), status: g.state === 'over' ? 'out' : 'playing' })
      .then((room) => {
        if (game === g && room) applyRoom(room);
      })
      .catch(() => {})
      .finally(() => (syncing = false));
  }
  function applyRoom(room) {
    const g = game;
    for (const p of room.players) {
      const o = g.others.get(p.id);
      if (!o) continue;
      if (p.st) Object.assign(o, { x: p.st.x, score: p.st.score, lives: p.st.lives });
      o.status = p.gone ? 'out' : p.status;
    }
    if (room.state === 'done' && room.results) {
      g.finished = true;
      g.sync = null;
      music.pause();
      els.onOver({ mode: 'online', why: g.why ?? 'time', survived: g.lives > 0, score: g.score, players: room.results, lives: g.lives });
    }
  }

  // ---------- drawing ----------
  const stars = Array.from({ length: 40 }, (_, i) => ({ x: (i * 53) % W, y: (i * 97) % H, s: 6 + (i % 5) * 5 }));
  function render() {
    const g = game;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#120c2b';
    ctx.fillRect(0, 0, W, H);
    // Stars drifting down
    for (const s of stars) {
      const y = (s.y + g.time * s.s) % H;
      ctx.fillStyle = s.s > 20 ? '#8f86d9' : '#4b4380';
      ctx.fillRect(s.x, Math.floor(y), 1, 1);
    }
    // The ground line
    ctx.fillStyle = '#2b2160';
    ctx.fillRect(0, PLAYER_Y + 18, W, H - PLAYER_Y - 18);
    // Mice, with their points
    ctx.font = 'bold 7px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const m of g.mice) {
      if (m.t > g.time) break;
      if (g.gone.has(m.id)) continue;
      const p = mousePos(m, g.time);
      if (p.y > H + 14) continue;
      const wob = Math.round(Math.sin(g.time * 10 + m.id) * 0.8);
      ctx.drawImage(assets.mouse, Math.round(p.x - 9), Math.round(p.y - 10 + wob));
      outlineText(String(m.points), Math.round(p.x), Math.round(p.y - 12), m.points >= 40 ? '#ffd400' : '#fff');
    }
    // Bullets: little pixel bolts
    for (const b of g.bullets) {
      ctx.fillStyle = '#ffd400';
      ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 4, 2, 6);
      ctx.fillStyle = '#fff6a8';
      ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 4, 2, 2);
    }
    // Everyone else (see-through), then you
    for (const o of g.others.values()) {
      if (o.status === 'out') continue;
      ctx.globalAlpha = 0.45;
      const ox = o.x * W;
      ctx.drawImage(assets.cats[o.team], Math.round(ox - 20), PLAYER_Y - 20, 40, 40);
      ctx.globalAlpha = 0.8;
      outlineText(o.name.replace('🤖 ', ''), Math.round(ox), PLAYER_Y - 22, '#fff');
      ctx.globalAlpha = 1;
    }
    if (g.state !== 'over' || g.lives > 0) {
      const blink = g.time < g.hurtUntil && Math.floor(g.time * 12) % 2;
      ctx.globalAlpha = blink ? 0.3 : 1;
      ctx.drawImage(assets.cats[g.team], Math.round(g.x - 20), PLAYER_Y - 20, 40, 40);
      ctx.globalAlpha = 1;
    }
    for (const p of g.pops) outlineText(p.text, Math.round(p.x), Math.round(p.y - (0.8 - (p.until - g.time)) * 24), '#8dff6a');
    if (g.flash > 0) {
      ctx.fillStyle = `rgba(255, 60, 60, ${Math.min(0.5, g.flash * 2)})`;
      ctx.fillRect(0, 0, W, H);
    }
    hud();
  }
  function outlineText(text, x, y, color) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function hud() {
    const g = game;
    if (!g) return;
    els.score.textContent = g.score.toLocaleString();
    els.lives.textContent = '❤️'.repeat(Math.max(0, g.lives)) + '🖤'.repeat(Math.max(0, g.maxLives - Math.max(0, g.lives)));
    const left = Math.max(0, Math.ceil(GAME_SECONDS - g.time));
    els.time.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    // Scoreboard (when playing with others)
    if (g.others.size) {
      const rows = standings();
      const sig = rows.map((r) => `${r.id}:${r.score}:${g.others.get(r.id)?.status ?? ''}`).join();
      if (els.board.dataset.sig !== sig) {
        els.board.dataset.sig = sig;
        els.board.replaceChildren(
          ...rows.map((r) => {
            const li = document.createElement('li');
            if (r.me) li.className = 'me';
            if (g.others.get(r.id)?.status === 'out') li.classList.add('out');
            const img = document.createElement('img');
            img.src = `icons/invaders/team-${r.team}.png`;
            img.alt = '';
            const name = document.createElement('span');
            name.textContent = r.me ? 'You' : r.name.replace('🤖 ', '');
            const pts = document.createElement('strong');
            pts.textContent = r.score.toLocaleString();
            li.append(img, name, pts);
            return li;
          })
        );
      }
    }
    els.board.hidden = !g.others.size;
  }

  function loop(t) {
    const g = game;
    if (!g || g.finished && g.state === 'over' && !g.sync) return;
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
    if (g.state === 'playing') update(dt);
    if (game !== g) return;
    render();
    maybeSync(t);
    if (!g.finished || g.sync) frame = requestAnimationFrame(loop);
  }

  return {
    start,
    stop,
    keyDown,
    keyUp,
    unlockAudio: () => music.unlock(),
    get running() {
      return Boolean(game) && ['ready', 'countdown', 'playing'].includes(game.state);
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

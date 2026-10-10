import { isGameMusicMuted, onGameMusicMute, setGameMusicMuted } from './kart.js';
import { BASS, DRUMS, LOOP, SYNTH } from './msk-katisland.js';

// My Singing Katz (Playables), like My Singing Monsters but with Kats: on
// KatIsland, KatSynth, KatDrums and KatBass each sing their own part of the
// song (Zalith9's three parts, all looping together in time). They move with
// their part: KatSynth and KatBass open their mouths and rise with the pitch
// of each note, KatDrums hits the hi-hat, kick and snare as they play (and
// squashes down a little with each hit). Tap a Kat to put it to sleep (mute
// it) or wake it up.

const IMAGES = ['synth-idle', 'synth-sing', 'bass-idle', 'bass-sing', 'drums-idle', 'drums-hat', 'drums-kick', 'drums-snare'];
const KATS = [
  { id: 'synth', name: 'KatSynth', src: 'sounds/msk/synth.mp3', notes: SYNTH, x: 0.19, y: 0.72, size: 0.24 },
  { id: 'drums', name: 'KatDrums', src: 'sounds/msk/drums.mp3', hits: DRUMS, x: 0.5, y: 0.6, size: 0.36 },
  { id: 'bass', name: 'KatBass', src: 'sounds/msk/bass.mp3', notes: BASS, x: 0.81, y: 0.72, size: 0.24 },
];
const VOLUME = 0.8;
const HIT_MS = 130; // how long a drum hit shows

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

/** The last item in a time-sorted list that's started by time t (or -1). */
function lastBefore(list, t) {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function createSingingKatz(els) {
  const { canvas } = els;
  const g = canvas.getContext('2d');
  let images = null;
  let ctx = null; // Web Audio
  let master = null;
  let buffers = null;
  let sources = [];
  let startAt = 0; // when the song started (audio clock)
  let offset = 0; // leading silence the decoder added
  let running = false;
  let paused = false;
  let frame = 0;
  const state = Object.fromEntries(KATS.map((k) => [k.id, { awake: true, lift: 0, gain: null, notes: [] }]));
  const floaters = []; // ♪ notes floating up from whoever's singing
  let lastSung = {};

  // The pitch range of each singer, so their highest note lifts them highest.
  for (const k of KATS) {
    if (!k.notes) continue;
    const ps = k.notes.map((n) => n[2]);
    k.low = Math.min(...ps);
    k.high = Math.max(...ps);
  }

  function unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    ctx.resume?.().catch(() => {});
  }

  async function load() {
    images ??= Object.fromEntries(await Promise.all(IMAGES.map(async (n) => [n, await loadImage(`icons/msk/${n}.png`)])));
    if (!ctx) throw new Error("This browser can't play My Singing Katz");
    buffers ??= await Promise.all(
      KATS.map((k) =>
        fetch(k.src)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("Couldn't load the song"))))
          .then((data) => ctx.decodeAudioData(data))
      )
    );
    // Some decoders put a moment of silence before the music: start (and loop) after it.
    const ch = buffers[0].getChannelData(0);
    let first = 0;
    while (first < ch.length && Math.abs(ch[first]) < 1e-3) first++;
    offset = Math.min(0.1, first / buffers[0].sampleRate);
  }

  async function start() {
    unlock();
    els.status.textContent = 'Tuning up…';
    els.status.hidden = false;
    await load();
    stopSound();
    master = ctx.createGain();
    master.gain.value = isGameMusicMuted() ? 0 : VOLUME;
    master.connect(ctx.destination);
    const at = ctx.currentTime + 0.1;
    sources = KATS.map((k, i) => {
      const src = ctx.createBufferSource();
      src.buffer = buffers[i];
      src.loop = true;
      src.loopStart = offset;
      src.loopEnd = offset + LOOP;
      const gain = ctx.createGain();
      gain.gain.value = state[k.id].awake ? 1 : 0;
      state[k.id].gain = gain;
      src.connect(gain).connect(master);
      src.start(at, offset);
      return src;
    });
    startAt = at;
    running = true;
    paused = false;
    els.status.hidden = true;
    renderControls();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(loop);
  }

  function stopSound() {
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
    }
    sources = [];
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frame);
    stopSound();
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    paused = false;
  }

  /** Where we are in the song (seconds, looping), as you hear it. */
  const songTime = () => {
    if (!ctx || !running) return 0;
    const t = ctx.currentTime - startAt - (ctx.outputLatency || ctx.baseLatency || 0);
    return ((t % LOOP) + LOOP) % LOOP;
  };

  function setAwake(id, awake) {
    const s = state[id];
    s.awake = awake;
    if (s.gain && ctx) s.gain.gain.setTargetAtTime(awake ? 1 : 0, ctx.currentTime, 0.04);
    renderControls();
  }
  const toggle = (id) => setAwake(id, !state[id].awake);

  async function togglePause() {
    if (!ctx || !running) return;
    if (paused) await ctx.resume();
    else await ctx.suspend();
    paused = !paused;
    renderControls();
  }

  onGameMusicMute((muted) => {
    if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : VOLUME, ctx.currentTime, 0.04);
    renderControls();
  });

  function renderControls() {
    els.pause.textContent = paused ? '▶️ Play' : '⏸ Pause';
    els.mute.textContent = isGameMusicMuted() ? '🔇' : '🔊';
    els.mute.setAttribute('aria-label', isGameMusicMuted() ? 'Turn the sound on' : 'Mute');
    for (const b of els.toggles.querySelectorAll('[data-kat]')) {
      const awake = state[b.dataset.kat].awake;
      b.setAttribute('aria-pressed', String(awake));
      b.classList.toggle('asleep', !awake);
      b.querySelector('.msk-state').textContent = awake ? '🎵' : '💤';
    }
  }
  els.pause.addEventListener('click', togglePause);
  els.mute.addEventListener('click', () => setGameMusicMuted(!isGameMusicMuted()));
  for (const b of els.toggles.querySelectorAll('[data-kat]')) b.addEventListener('click', () => toggle(b.dataset.kat));

  // ---------- drawing KatIsland ----------
  function size() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, Math.round(rect.width * dpr));
    const h = Math.max(200, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  /** Where each Kat stands, in canvas pixels (the island fits the screen). */
  function layout() {
    const W = canvas.width;
    const H = canvas.height;
    const unit = Math.min(W, H * 1.15);
    const ox = (W - unit) / 2;
    return { W, H, unit, place: (k) => ({ x: ox + k.x * unit, y: H * k.y, s: k.size * unit }) };
  }

  function drawIsland(now, L) {
    const { W, H, unit } = L;
    // Sky, sun, clouds.
    const sky = g.createLinearGradient(0, 0, 0, H * 0.55);
    sky.addColorStop(0, '#62b6ff');
    sky.addColorStop(1, '#c9ecff');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff3a6';
    g.beginPath();
    g.arc(W * 0.85, H * 0.12, unit * 0.06, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 4; i++) {
      const cx = ((i * 0.31 + now / 90000) % 1.3) * W - W * 0.15;
      const cy = H * (0.08 + (i % 2) * 0.1);
      for (const [dx, r] of [[0, 0.035], [0.04, 0.045], [0.085, 0.03]]) {
        g.beginPath();
        g.arc(cx + dx * unit, cy, r * unit, 0, Math.PI * 2);
        g.fill();
      }
    }
    // The sea, with waves.
    const seaTop = H * 0.48;
    const sea = g.createLinearGradient(0, seaTop, 0, H);
    sea.addColorStop(0, '#2e9be0');
    sea.addColorStop(1, '#155e9e');
    g.fillStyle = sea;
    g.fillRect(0, seaTop, W, H - seaTop);
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = Math.max(2, unit * 0.004);
    for (let row = 0; row < 6; row++) {
      const y = seaTop + (row + 0.5) * ((H - seaTop) / 6);
      g.beginPath();
      for (let x = 0; x <= W; x += W / 40) {
        const yy = y + Math.sin(x / (unit * 0.05) + now / 600 + row) * unit * 0.006;
        if (x === 0) g.moveTo(x, yy);
        else g.lineTo(x, yy);
      }
      g.stroke();
    }
    // KatIsland: sand, then grass on top.
    const cx = W / 2;
    const iy = H * 0.66;
    g.fillStyle = '#f2d58a';
    g.beginPath();
    g.ellipse(cx, iy + unit * 0.05, unit * 0.52, unit * 0.2, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#5cbf4a';
    g.beginPath();
    g.ellipse(cx, iy, unit * 0.47, unit * 0.16, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#4aa83a';
    g.beginPath();
    g.ellipse(cx, iy + unit * 0.03, unit * 0.4, unit * 0.1, 0, 0, Math.PI * 2);
    g.fill();
    // A palm tree and some flowers.
    const px = cx - unit * 0.42;
    const py = iy - unit * 0.02;
    g.strokeStyle = '#8b5a2b';
    g.lineWidth = unit * 0.018;
    g.beginPath();
    g.moveTo(px, py);
    g.quadraticCurveTo(px - unit * 0.03, py - unit * 0.12, px + unit * 0.01, py - unit * 0.24);
    g.stroke();
    g.fillStyle = '#2f9a3a';
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.7;
      g.beginPath();
      g.ellipse(px + 0.01 * unit + Math.cos(a) * unit * 0.06, py - unit * 0.24 + Math.sin(a) * unit * 0.03, unit * 0.075, unit * 0.022, a, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 14; i++) {
      const fx = cx + Math.cos(i * 2.4) * unit * 0.38 * ((i % 3) / 3 + 0.4);
      const fy = iy + Math.sin(i * 1.7) * unit * 0.09;
      g.fillStyle = ['#ff6fa8', '#fff36b', '#ffffff', '#b47cff'][i % 4];
      g.beginPath();
      g.arc(fx, fy, unit * 0.007, 0, Math.PI * 2);
      g.fill();
    }
  }

  function drawKat(k, t, L, now) {
    const st = state[k.id];
    const { x, y, s } = L.place(k);
    // A shadow on the grass.
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.beginPath();
    g.ellipse(x, y, s * 0.36, s * 0.07, 0, 0, Math.PI * 2);
    g.fill();
    let img;
    let sy = 1; // squash (drums)
    let lift = 0;
    let singing = false;
    if (k.notes) {
      const i = st.awake && !paused ? lastBefore(k.notes, t) : -1;
      const note = i >= 0 ? k.notes[i] : null;
      singing = Boolean(note && t < note[0] + note[1]);
      img = images[`${k.id}-${singing ? 'sing' : 'idle'}`];
      // The higher the note, the higher it goes.
      const target = singing ? 0.05 + 0.2 * ((note[2] - k.low) / Math.max(1, k.high - k.low)) : 0;
      st.lift += (target - st.lift) * 0.35;
      lift = st.lift;
      if (singing && lastSung[k.id] !== i) {
        lastSung[k.id] = i;
        floaters.push({ x: x + s * 0.32, y: y - s * 1.0, at: now, color: k.id === 'bass' ? '#ff4fb3' : '#1f4fff' });
      }
    } else {
      const i = st.awake && !paused ? lastBefore(k.hits, t) : -1;
      const hit = i >= 0 ? k.hits[i] : null;
      const age = hit ? (t - hit[0]) * 1000 : Infinity;
      if (age < HIT_MS) {
        img = images[`drums-${hit[1]}`];
        sy = 1 - 0.07 * (1 - age / HIT_MS); // squashed down a little by the hit
        singing = true;
      } else img = images['drums-idle'];
    }
    const w = s;
    const h = (s * img.height) / img.width;
    g.save();
    g.globalAlpha = st.awake ? 1 : 0.55;
    g.translate(x, y - lift * s);
    g.scale(1, sy);
    g.drawImage(img, -w / 2, -h, w, h);
    g.restore();
    // Asleep: z z z.
    if (!st.awake) {
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.lineWidth = 3;
      g.font = `900 ${Math.round(s * 0.12)}px system-ui, sans-serif`;
      for (let j = 0; j < 3; j++) {
        const p = ((now / 1400 + j / 3) % 1);
        const zx = x + s * (0.25 + p * 0.15);
        const zy = y - h * (0.85 + p * 0.3);
        g.globalAlpha = 1 - p;
        g.strokeText('z', zx, zy);
        g.fillText('z', zx, zy);
      }
      g.globalAlpha = 1;
    }
    // The name under its feet.
    g.font = `800 ${Math.max(12, Math.round(s * 0.085))}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillText(k.name, x + 1.5, y + s * 0.13 + 1.5);
    g.fillStyle = '#fff';
    g.fillText(k.name, x, y + s * 0.13);
    k.hitBox = { x0: x - w / 2, x1: x + w / 2, y0: y - h - lift * s, y1: y + s * 0.15 };
  }

  function loop(now) {
    frame = requestAnimationFrame(loop);
    if (!running) return;
    size();
    const L = layout();
    const t = songTime();
    drawIsland(now, L);
    // Back to front.
    for (const k of [...KATS].sort((a, b) => a.y - b.y)) drawKat(k, t, L, now);
    // ♪ notes floating up.
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const p = (now - f.at) / 1200;
      if (p >= 1) {
        floaters.splice(i, 1);
        continue;
      }
      g.globalAlpha = 1 - p;
      g.fillStyle = f.color;
      g.font = `900 ${Math.round(L.unit * 0.05)}px system-ui, sans-serif`;
      g.fillText('♪', f.x + Math.sin(p * 6) * L.unit * 0.01, f.y - p * L.unit * 0.12);
      g.globalAlpha = 1;
    }
  }

  // Tap a Kat: put it to sleep, or wake it up.
  canvas.addEventListener('click', (e) => {
    if (!running) return;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * canvas.width;
    const y = ((e.clientY - r.top) / r.height) * canvas.height;
    const hit = [...KATS].reverse().find((k) => k.hitBox && x >= k.hitBox.x0 && x <= k.hitBox.x1 && y >= k.hitBox.y0 && y <= k.hitBox.y1);
    if (hit) toggle(hit.id);
  });

  return {
    start,
    stop,
    unlock,
    toggle,
    get running() {
      return running;
    },
    /** For testing: where the song is, and what each Kat's doing. */
    debug: () => ({ t: songTime(), awake: Object.fromEntries(KATS.map((k) => [k.id, state[k.id].awake])), paused }),
  };
}

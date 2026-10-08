// Circle Chaos (Playables): 2 to 5 teams take turns taking circles from the
// Deck that the bot spilled out of the bag (each team only takes its own
// colour and the rainbow circles). Online the server keeps the deck; in
// Practice the same rules (circle-rules.js) run here against bots. This draws the table in chunky pixels like
// Kat Kart and KatEscape, and shows what each circle did.

export const TEAMS = ['red', 'yellow', 'green', 'blue', 'purple'];
export const TEAM_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' };
export const TEAM_COLORS = { red: '#ff0000', yellow: '#ffe400', green: '#37ff00', blue: '#004cff', purple: '#9d00ff' };
export const TURNS = 15;
const CIRCLE_NAMES = { red: 'a Red circle', yellow: 'a Yellow circle', green: 'a Green circle', blue: 'a Blue circle', purple: 'a Purple circle', lose2: 'Lose 2', lose4: 'Lose 4', lucky: 'a Lucky Card' };
export const circleIcon = (kind) => `icons/circles/${kind}.png`;
export const teamIcon = (team) => `icons/circles/team-${team}.png`;

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

/** Who's who in words: "Red (Finn)". */
export function teamLabel(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? `${TEAM_NAMES[p.team]} (${p.name})` : 'Someone';
}

/** What happened, in words. */
export function describeEvent(room, e) {
  const who = (id) => teamLabel(room, id);
  const by = who(e.by);
  const auto = e.auto ? ' (the bot played for them)' : '';
  if (e.type === 'deal') return `🤖 The bot spilled the bag: ${e.count} circles in the Deck!`;
  if (e.type === 'left') return `👋 ${by} left`;
  if (e.type === 'done') return '🏁 That was the last turn!';
  if (e.type === 'penalty') return `${e.circle === 'lose4' ? '➖4' : '➖2'} ${by} made ${who(e.target)} lose ${e.lost} circle${e.lost === 1 ? '' : 's'}${auto}`;
  if (e.type !== 'draw') return '';
  const refill = e.refill ? '🤖 The Deck ran out, so the bot spilled the bag again! ' : '';
  const took = `${refill}${by} took ${CIRCLE_NAMES[e.circle]}`;
  if (TEAMS.includes(e.circle)) return `${took} (+1)${auto}`;
  if (e.choose) return `${took}! Picking who loses ${e.circle === 'lose4' ? 4 : 2}…`;
  if (e.circle === 'lose2' || e.circle === 'lose4') return `${took} → ${who(e.target)} loses ${e.lost}${auto}`;
  const lucky = {
    'everyone-none': 'Everyone has no circles!',
    'everyone-none-but-player': `Everyone has no circles, except for ${by}!`,
    flip: 'The turn order is Flipped!',
    'random-next': `${who(e.target)} can go next!`,
    'everyone-4': 'Everyone gets 4 circles!',
    'next-all': `${who(e.target)} (next) loses all circles!`,
    'next-4': `${who(e.target)} (next) loses 4 circles!`,
    'prev-all': `${who(e.target)} (previous) loses all circles!`,
    'prev-4': `${who(e.target)} (previous) loses 4 circles!`,
  }[e.outcome];
  return `${took}! 🍀 ${lucky}${auto}`;
}

/** The table: the bot, the bag and the Deck, drawn on a small canvas and scaled up. */
export function createCircleTable(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  let sprites = null;
  let pile = []; // the random pile (just for looks: the real order is a secret)
  let deal = null; // { start } while the bot is spilling the bag
  let flying = null; // { kind, start } a circle being taken
  let count = 0;
  let frame = 0;
  const kinds = ['red', 'yellow', 'green', 'blue', 'purple', 'lose2', 'lose4', 'lucky'];

  async function load() {
    if (sprites) return sprites;
    const names = [...kinds, 'bag', 'bot'];
    const imgs = await Promise.all(names.map((n) => loadImage(`icons/circles/${n}.png`)));
    sprites = Object.fromEntries(names.map((n, i) => [n, imgs[i]]));
    return sprites;
  }

  // Where the pile is, and the bot and bag beside it.
  const PILE = { x: W * 0.62, y: H * 0.58 };
  const BAG = { x: W * 0.24, y: H * 0.5 };
  function makePile(teams) {
    const bag = [...teams, ...teams, 'lose2', 'lucky', ...teams, 'lose4', ...teams, 'lucky', 'lose2'];
    pile = Array.from({ length: 34 }, (_, i) => {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 34;
      return { kind: bag[i % bag.length], x: PILE.x + Math.cos(a) * r * 1.3, y: PILE.y + Math.sin(a) * r * 0.55, size: 15 + Math.floor(Math.random() * 4), delay: i * 55 };
    });
  }

  const ease = (t) => 1 - (1 - t) ** 3;
  function draw(t) {
    if (!sprites) return;
    ctx.imageSmoothingEnabled = false;
    // Felt table with a pixel checker.
    ctx.fillStyle = '#1e5a3a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#226542';
    for (let y = 0; y < H; y += 8) for (let x = (y / 8) % 2 ? 8 : 0; x < W; x += 16) ctx.fillRect(x, y, 8, 8);
    ctx.fillStyle = '#5b3b25';
    ctx.fillRect(0, H - 6, W, 6);
    // The bot, tipping the bag out while dealing.
    const dealing = deal && t - deal.start < 3200;
    const tip = dealing ? Math.min(1, (t - deal.start) / 500) * (t - deal.start < 2700 ? 1 : Math.max(0, 1 - (t - deal.start - 2700) / 500)) : 0;
    const bob = Math.round(Math.sin(t / 300) * 1);
    ctx.drawImage(sprites.bot, Math.round(BAG.x - 46), Math.round(BAG.y - 18 + bob), 32, 32);
    ctx.save();
    ctx.translate(Math.round(BAG.x), Math.round(BAG.y));
    ctx.rotate(tip * 1.9);
    ctx.drawImage(sprites.bag, -16, -16, 32, 32);
    ctx.restore();
    // The pile.
    const shown = dealing ? pile : pile.slice(0, Math.max(0, Math.min(pile.length, Math.ceil(count / 2))));
    for (const c of shown) {
      let { x, y } = c;
      if (dealing) {
        const p = Math.max(0, Math.min(1, (t - deal.start - 350 - c.delay) / 700));
        if (p <= 0) continue;
        const e = ease(p);
        x = BAG.x + 14 + (c.x - BAG.x - 14) * e;
        y = BAG.y - 4 + (c.y - BAG.y + 4) * e - Math.sin(p * Math.PI) * 26;
      }
      ctx.drawImage(sprites[c.kind], Math.round(x - c.size / 2), Math.round(y - c.size / 2), c.size, c.size);
    }
    // A circle being taken: up out of the pile, big, then gone.
    if (flying) {
      const p = Math.min(1, (t - flying.start) / 650);
      const size = Math.round(16 + 40 * ease(p));
      const x = PILE.x + (W / 2 - PILE.x) * ease(p);
      const y = PILE.y - 20 * ease(p) - Math.sin(p * Math.PI) * 10;
      ctx.drawImage(sprites[flying.kind], Math.round(x - size / 2), Math.round(y - size / 2), size, size);
      if (p >= 1 && t - flying.start > 1300) flying = null;
    }
  }

  function loop(t) {
    draw(t);
    frame = requestAnimationFrame(loop);
  }

  return {
    async start(teams) {
      await load();
      makePile(teams);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    },
    stop: () => cancelAnimationFrame(frame),
    /** The bot spills the bag. */
    deal() {
      deal = { start: performance.now() };
    },
    /** Someone took a circle. */
    take(kind) {
      flying = { kind, start: performance.now() };
    },
    setCount(n) {
      count = n;
    },
  };
}

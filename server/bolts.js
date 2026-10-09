import { fail } from './http.js';

// Bolts ⚡: the currency for all Playables.
//  - Win any game: +5 bolts.
//  - KatEscape: the further you run, the more you get, up to 15 a run
//    (1 for every 200 m).
// Online games pay out from the server when the game ends (it knows who
// won). Solo and Practice games are on your phone, so it tells us; those
// are limited (one reward per game every 20 seconds, 400 bolts a day).

export const WIN_BOLTS = 5;
export const RUN_METRES_PER_BOLT = 200;
export const MAX_RUN_BOLTS = 15;
export const BOLT_GAMES = ['kart', 'wordle', 'escape', 'circles', 'invaders'];
const CLAIM_GAP = 20 * 1000;
const DAILY_CAP = 400;
const DAY = 24 * 60 * 60 * 1000;

/** How many bolts a KatEscape run of this many metres is worth. */
export const runBolts = (metres) => Math.max(0, Math.min(MAX_RUN_BOLTS, Math.floor((Number(metres) || 0) / RUN_METRES_PER_BOLT)));

export function createBolts({ db, clock }) {
  const q = {
    balance: db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM bolt_rewards WHERE user_id = ?'),
    today: db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM bolt_rewards WHERE user_id = ? AND ref IS NULL AND created_at > ?"),
    lastClaim: db.prepare('SELECT MAX(created_at) AS at FROM bolt_rewards WHERE user_id = ? AND game = ? AND reason = ? AND ref IS NULL'),
    add: db.prepare('INSERT OR IGNORE INTO bolt_rewards (user_id, game, reason, amount, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  };
  return {
    balance: (userId) => Number(q.balance.get(userId).n),
    /** Pay out an online game's result (once per `ref`). Returns how many were added. */
    award(userId, game, reason, amount, ref) {
      if (!userId || amount <= 0) return 0;
      return Number(q.add.run(userId, game, reason, amount, ref, clock()).changes) ? amount : 0;
    },
    /** Solo / Practice: what the phone says it earned, within the limits. */
    claim(userId, game, reason, amount) {
      const now = clock();
      const last = q.lastClaim.get(userId, game, reason).at;
      if (last && now - last < CLAIM_GAP) return 0;
      const room = Math.max(0, DAILY_CAP - Number(q.today.get(userId, now - DAY).n));
      const n = Math.min(amount, room);
      if (n <= 0) return 0;
      q.add.run(userId, game, reason, n, null, now);
      return n;
    },
  };
}

export function registerBoltRoutes({ api, auth, wrap, bolts }) {
  api.get(
    '/bolts',
    auth,
    wrap((req) => ({ bolts: bolts.balance(req.user.id) }))
  );

  // A Solo or Practice game finished: { game, reason: 'win' } or, for KatEscape, { game: 'escape', reason: 'run', distance }.
  api.post(
    '/bolts/earn',
    auth,
    wrap((req) => {
      const game = String(req.body?.game ?? '');
      const reason = String(req.body?.reason ?? '');
      if (!BOLT_GAMES.includes(game)) fail(400, 'Unknown game');
      let amount;
      if (reason === 'win') amount = WIN_BOLTS;
      else if (reason === 'run' && game === 'escape') amount = runBolts(req.body?.distance);
      else fail(400, 'Bolts are for winning (or running far in KatEscape)');
      const earned = amount > 0 ? bolts.claim(req.user.id, game, reason, amount) : 0;
      return { earned, bolts: bolts.balance(req.user.id) };
    })
  );
}

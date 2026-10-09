import { fail } from './http.js';
import { transaction } from './db.js';
import { BOLTS_PER_GEM, MAX_GEMS, MIN_GEMS } from '../public/js/rewards.js';

// Bolts ⚡ and gems 💎: the currencies for all Playables.
//  - Win any game: +100 bolts.
//  - KatEscape: when your run's over, every bolt you collected is yours.
// Online games pay out from the server when the game ends (it knows who
// won). Solo and Practice games are on your phone, so it tells us; those
// are limited (one reward per game every 20 seconds, and a daily cap).

export const WIN_BOLTS = 100;
export const MAX_RUN_BOLTS = 10000; // more than anyone collects in one run
export const BOLT_GAMES = ['kart', 'wordle', 'escape', 'circles', 'invaders'];
const CLAIM_GAP = 20 * 1000;
const DAILY_CAP = 25000;
const DAY = 24 * 60 * 60 * 1000;

/** The bolts collected in a KatEscape run (a whole number, within reason). */
export const runBolts = (collected) => Math.max(0, Math.min(MAX_RUN_BOLTS, Math.floor(Number(collected) || 0)));

const GEM_DAILY_CAP = 300;

/** A currency ledger (bolts or gems): one row per change, the balance is the sum. */
function ledger(db, clock, table, dailyCap) {
  const q = {
    balance: db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM ${table} WHERE user_id = ?`),
    today: db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM ${table} WHERE user_id = ? AND ref IS NULL AND created_at > ?`),
    lastClaim: db.prepare(`SELECT MAX(created_at) AS at FROM ${table} WHERE user_id = ? AND game = ? AND reason = ? AND ref IS NULL`),
    add: db.prepare(`INSERT OR IGNORE INTO ${table} (user_id, game, reason, amount, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
  };
  return {
    balance: (userId) => Number(q.balance.get(userId).n),
    award(userId, game, reason, amount, ref) {
      if (!userId || amount <= 0) return 0;
      return Number(q.add.run(userId, game, reason, amount, ref, clock()).changes) ? amount : 0;
    },
    /** A change with a ref (shop, swaps): any amount, even negative. */
    change: (userId, game, reason, amount, ref) => q.add.run(userId, game, reason, amount, ref, clock()),
    claim(userId, game, reason, amount) {
      const now = clock();
      const last = q.lastClaim.get(userId, game, reason).at;
      if (last && now - last < CLAIM_GAP) return 0;
      const room = Math.max(0, dailyCap - Number(q.today.get(userId, now - DAY).n));
      const n = Math.min(amount, room);
      if (n <= 0) return 0;
      q.add.run(userId, game, reason, n, null, now);
      return n;
    },
  };
}

/** Gems 💎: 1 to 10 after each Playable; online games pay out from the server. */
export const createGems = ({ db, clock }) => ledger(db, clock, 'gem_rewards', GEM_DAILY_CAP);

export function createBolts({ db, clock }) {
  const q = {
    balance: db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM bolt_rewards WHERE user_id = ?'),
    today: db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM bolt_rewards WHERE user_id = ? AND ref IS NULL AND created_at > ?"),
    lastClaim: db.prepare('SELECT MAX(created_at) AS at FROM bolt_rewards WHERE user_id = ? AND game = ? AND reason = ? AND ref IS NULL'),
    add: db.prepare('INSERT OR IGNORE INTO bolt_rewards (user_id, game, reason, amount, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  };
  return {
    balance: (userId) => Number(q.balance.get(userId).n),
    /** A change with a ref (shop, swaps): any amount, even negative. */
    change: (userId, game, reason, amount, ref) => q.add.run(userId, game, reason, amount, ref, clock()),
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

export function registerBoltRoutes({ api, auth, wrap, bolts, gems, db, clock }) {
  const wallet = (userId) => ({ bolts: bolts.balance(userId), gems: gems.balance(userId) });
  api.get(
    '/bolts',
    auth,
    wrap((req) => wallet(req.user.id))
  );

  // Finished a Solo or Practice game: { game, gems } (1 to 10, worked out by the app from how well you did).
  api.post(
    '/gems/earn',
    auth,
    wrap((req) => {
      const game = String(req.body?.game ?? '');
      if (!BOLT_GAMES.includes(game)) fail(400, 'Unknown game');
      const amount = Math.max(MIN_GEMS, Math.min(MAX_GEMS, Math.floor(Number(req.body?.gems) || 0)));
      const earned = gems.claim(req.user.id, game, 'finish', amount);
      return { earned, ...wallet(req.user.id) };
    })
  );

  // Swap: { to: 'gems' | 'bolts', gems } — 1 gem = 100 bolts, either way.
  api.post(
    '/gems/convert',
    auth,
    wrap((req) => {
      const to = String(req.body?.to ?? '');
      const n = Math.floor(Number(req.body?.gems));
      if (!['gems', 'bolts'].includes(to)) fail(400, 'Swap to gems or to bolts');
      if (!Number.isFinite(n) || n < 1 || n > 1e6) fail(400, 'How many gems?');
      return transaction(db, () => {
        const userId = req.user.id;
        const now = clock();
        const ref = `swap:${to}:${now}:${Math.random().toString(36).slice(2, 8)}`;
        if (to === 'gems') {
          const cost = n * BOLTS_PER_GEM;
          const have = bolts.balance(userId);
          if (have < cost) fail(402, `You need ${(cost - have).toLocaleString('en-US')} more bolts`);
          bolts.change(userId, 'swap', 'to-gems', -cost, ref);
          gems.change(userId, 'swap', 'from-bolts', n, ref);
        } else {
          if (gems.balance(userId) < n) fail(402, "You don't have that many gems");
          gems.change(userId, 'swap', 'to-bolts', -n, ref);
          bolts.change(userId, 'swap', 'from-gems', n * BOLTS_PER_GEM, ref);
        }
        return wallet(userId);
      });
    })
  );

  // A Solo or Practice game finished: { game, reason: 'win' } or, for KatEscape, { game: 'escape', reason: 'run', bolts } (the bolts collected).
  api.post(
    '/bolts/earn',
    auth,
    wrap((req) => {
      const game = String(req.body?.game ?? '');
      const reason = String(req.body?.reason ?? '');
      if (!BOLT_GAMES.includes(game)) fail(400, 'Unknown game');
      let amount;
      if (reason === 'win') amount = WIN_BOLTS;
      else if (reason === 'run' && game === 'escape') amount = runBolts(req.body?.bolts);
      else fail(400, 'Bolts are for winning (or collecting them in KatEscape)');
      const earned = amount > 0 ? bolts.claim(req.user.id, game, reason, amount) : 0;
      return { earned, bolts: bolts.balance(req.user.id) };
    })
  );
}

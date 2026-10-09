import { fail } from './http.js';
import { transaction } from './db.js';
import { BASE_TEAMS, SHOP_TEAMS, TEAM_NAMES, TEAM_PRICE } from '../public/js/teams.js';

// The Bolt Shop and the Gem Shop: spend bolts (or gems) on team colours,
// KoolKat Unlimited and a badge (the Bolt Badge is bolts only, the Gem Badge
// gems only). Gem prices match bolt prices at 1 gem = 100 bolts. Anything
// you bought can be sold back for everything you paid, in what you paid with.
// KoolKat Unlimited (however you got it) includes all the team colours.

export const CURRENCIES = ['bolts', 'gems'];
// price: in bolts (null = not in the Bolt Shop); gemPrice: in gems (null = not in the Gem Shop).
export const SHOP_ITEMS = [
  ...SHOP_TEAMS.map((team) => ({ id: `team-${team}`, kind: 'team', team, name: `${TEAM_NAMES[team]} team`, price: TEAM_PRICE, gemPrice: TEAM_PRICE / 100 })),
  { id: 'bolt-badge', kind: 'badge', flag: 'bolt_badge', name: 'Bolt Badge', price: 5000, gemPrice: null },
  { id: 'gem-badge', kind: 'badge', flag: 'gem_badge', name: 'Gem Badge', price: null, gemPrice: 50 },
  { id: 'unlimited-trial', kind: 'trial', name: 'KoolKat Unlimited · 30-day trial', price: 2500, gemPrice: 25, days: 30 },
  { id: 'unlimited', kind: 'unlimited', name: 'KoolKat Unlimited · Lifetime', price: 10000, gemPrice: 100 },
];
const priceIn = (item, currency) => (currency === 'gems' ? item.gemPrice : item.price);
const DAY_MS = 24 * 60 * 60 * 1000;
const ITEM = Object.fromEntries(SHOP_ITEMS.map((i) => [i.id, i]));

export function createShop({ db, clock, bolts, gems, hasUnlimitedUser }) {
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    owned: db.prepare('SELECT item, price, currency FROM shop_items WHERE user_id = ?'),
    one: db.prepare('SELECT price, currency, bought_at FROM shop_items WHERE user_id = ? AND item = ?'),
    setTrial: db.prepare('UPDATE users SET bolt_trial_until = ? WHERE id = ?'),
    add: db.prepare('INSERT INTO shop_items (user_id, item, price, currency, bought_at) VALUES (?, ?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM shop_items WHERE user_id = ? AND item = ?'),
    setUnlimited: db.prepare('UPDATE users SET bolt_unlimited = ? WHERE id = ?'),
    setFlag: {
      bolt_badge: db.prepare('UPDATE users SET bolt_badge = ? WHERE id = ?'),
      gem_badge: db.prepare('UPDATE users SET gem_badge = ? WHERE id = ?'),
    },
  };
  const wallets = { bolts, gems };
  /** A trial that's run out isn't yours any more. */
  function tidyTrial(userId) {
    const user = q.user.get(userId);
    if (q.one.get(userId, 'unlimited-trial') && !((user?.bolt_trial_until ?? 0) > clock())) {
      q.remove.run(userId, 'unlimited-trial');
      q.setTrial.run(0, userId);
    }
  }
  const ownedMap = (userId) => {
    tidyTrial(userId);
    return new Map(q.owned.all(userId).map((r) => [r.item, { price: r.price, currency: r.currency }]));
  };
  // Unlimited from a gift, code or request (not from the Bolt Shop).
  const planUnlimited = (user) => hasUnlimitedUser({ ...user, bolt_unlimited: 0, bolt_trial_until: 0 });

  /** The team colours someone can play as. */
  function teamsFor(userId) {
    const user = q.user.get(userId);
    if (!user) return new Set(BASE_TEAMS);
    if (hasUnlimitedUser(user)) return new Set([...BASE_TEAMS, ...SHOP_TEAMS]);
    const owned = ownedMap(userId);
    return new Set([...BASE_TEAMS, ...SHOP_TEAMS.filter((t) => owned.has(`team-${t}`))]);
  }

  function describe(userId) {
    const owned = ownedMap(userId);
    const user = q.user.get(userId);
    const fromPlan = planUnlimited(user);
    const unlimited = hasUnlimitedUser(user);
    return {
      bolts: bolts.balance(userId),
      gems: gems?.balance(userId) ?? 0,
      unlimited,
      trialUntil: owned.has('unlimited-trial') ? user.bolt_trial_until : null,
      teams: [...teamsFor(userId)],
      items: SHOP_ITEMS.map((item) => ({
        ...item,
        owned: owned.has(item.id),
        paid: owned.get(item.id)?.price ?? null,
        paidIn: owned.get(item.id)?.currency ?? null,
        // Already yours another way: no need to buy it.
        included:
          !owned.has(item.id) &&
          ((item.kind === 'team' && unlimited) || (item.kind === 'unlimited' && (fromPlan || Boolean(user.bolt_unlimited))) || (item.kind === 'trial' && unlimited)),
      })),
    };
  }

  function buy(userId, itemId, currency = 'bolts') {
    const item = ITEM[itemId];
    const shopName = currency === 'gems' ? 'Gem Shop' : 'Bolt Shop';
    if (!CURRENCIES.includes(currency)) fail(400, 'Pay with bolts or gems');
    if (!item || priceIn(item, currency) == null) fail(404, `That's not in the ${shopName}`);
    const price = priceIn(item, currency);
    return transaction(db, () => {
      tidyTrial(userId);
      const user = q.user.get(userId);
      if (q.one.get(userId, item.id)) fail(409, 'You already have that');
      // Lifetime: fine during a trial (it's an upgrade), but not if you have Unlimited another way.
      if (item.kind === 'unlimited' && planUnlimited(user)) fail(409, 'You already have KoolKat Unlimited');
      if (item.kind === 'trial' && hasUnlimitedUser(user)) fail(409, 'You already have KoolKat Unlimited');
      if (item.kind === 'team' && hasUnlimitedUser(user)) fail(409, 'Team colours already come with your KoolKat Unlimited');
      const balance = wallets[currency].balance(userId);
      if (balance < price) fail(402, `You need ${(price - balance).toLocaleString('en-US')} more ${currency}`);
      const now = clock();
      q.add.run(userId, item.id, price, currency, now);
      wallets[currency].change(userId, 'shop', 'buy', -price, `shop:buy:${item.id}:${now}`);
      if (item.kind === 'unlimited') q.setUnlimited.run(1, userId);
      if (item.kind === 'trial') q.setTrial.run(now + item.days * DAY_MS, userId);
      if (item.kind === 'badge') q.setFlag[item.flag].run(1, userId);
      return describe(userId);
    });
  }

  /** Sell something back: you get everything you paid for it (in bolts or gems, whichever you paid with). */
  function sell(userId, itemId) {
    const item = ITEM[itemId];
    if (!item) fail(404, "That's not in the shop");
    return transaction(db, () => {
      tidyTrial(userId);
      const row = q.one.get(userId, item.id);
      if (!row) fail(409, "You don't have that");
      const now = clock();
      q.remove.run(userId, item.id);
      wallets[row.currency === 'gems' ? 'gems' : 'bolts'].change(userId, 'shop', 'sell', row.price, `shop:sell:${item.id}:${now}`);
      if (item.kind === 'unlimited') q.setUnlimited.run(0, userId);
      if (item.kind === 'trial') q.setTrial.run(0, userId);
      if (item.kind === 'badge') q.setFlag[item.flag].run(0, userId);
      return describe(userId);
    });
  }

  return { describe, buy, sell, teamsFor, canUseTeam: (userId, team) => teamsFor(userId).has(team) };
}

export function registerShopRoutes({ api, auth, wrap, shop }) {
  api.get(
    '/shop',
    auth,
    wrap((req) => ({ shop: shop.describe(req.user.id) }))
  );
  api.post(
    '/shop/buy',
    auth,
    wrap((req) => ({ shop: shop.buy(req.user.id, String(req.body?.item ?? ''), String(req.body?.currency ?? 'bolts')) }))
  );
  api.post(
    '/shop/sell',
    auth,
    wrap((req) => ({ shop: shop.sell(req.user.id, String(req.body?.item ?? '')) }))
  );
}

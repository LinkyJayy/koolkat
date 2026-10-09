import { fail } from './http.js';
import { transaction } from './db.js';
import { BASE_TEAMS, SHOP_TEAMS, TEAM_NAMES, TEAM_PRICE } from '../public/js/teams.js';

// The Bolt Shop: spend bolts on team colours, KoolKat Unlimited and the
// Bolt Badge. Anything you bought can be sold back for every bolt you paid.
// KoolKat Unlimited (however you got it) includes all the team colours.

export const SHOP_ITEMS = [
  ...SHOP_TEAMS.map((team) => ({ id: `team-${team}`, kind: 'team', team, name: `${TEAM_NAMES[team]} team`, price: TEAM_PRICE })),
  { id: 'bolt-badge', kind: 'badge', name: 'Bolt Badge', price: 5000 },
  { id: 'unlimited', kind: 'unlimited', name: 'KoolKat Unlimited', price: 10000 },
];
const ITEM = Object.fromEntries(SHOP_ITEMS.map((i) => [i.id, i]));

export function createShop({ db, clock, bolts, hasUnlimitedUser }) {
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    owned: db.prepare('SELECT item, price FROM shop_items WHERE user_id = ?'),
    one: db.prepare('SELECT price FROM shop_items WHERE user_id = ? AND item = ?'),
    add: db.prepare('INSERT INTO shop_items (user_id, item, price, bought_at) VALUES (?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM shop_items WHERE user_id = ? AND item = ?'),
    ledger: db.prepare('INSERT INTO bolt_rewards (user_id, game, reason, amount, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    setUnlimited: db.prepare('UPDATE users SET bolt_unlimited = ? WHERE id = ?'),
    setBadge: db.prepare('UPDATE users SET bolt_badge = ? WHERE id = ?'),
  };
  const ownedMap = (userId) => new Map(q.owned.all(userId).map((r) => [r.item, r.price]));

  /** The team colours someone can play as. */
  function teamsFor(userId) {
    const user = q.user.get(userId);
    if (!user) return new Set(BASE_TEAMS);
    if (hasUnlimitedUser(user)) return new Set([...BASE_TEAMS, ...SHOP_TEAMS]);
    const owned = ownedMap(userId);
    return new Set([...BASE_TEAMS, ...SHOP_TEAMS.filter((t) => owned.has(`team-${t}`))]);
  }

  function describe(userId) {
    const user = q.user.get(userId);
    const owned = ownedMap(userId);
    // Unlimited from a gift, code or request (not bought here) includes the team colours.
    const planUnlimited = hasUnlimitedUser({ ...user, bolt_unlimited: 0 });
    const unlimited = hasUnlimitedUser(user);
    return {
      bolts: bolts.balance(userId),
      unlimited,
      teams: [...teamsFor(userId)],
      items: SHOP_ITEMS.map((item) => ({
        ...item,
        owned: owned.has(item.id),
        paid: owned.get(item.id) ?? null,
        // Already yours another way: no need to buy it.
        included: !owned.has(item.id) && ((item.kind === 'team' && unlimited) || (item.kind === 'unlimited' && planUnlimited)),
      })),
    };
  }

  function buy(userId, itemId) {
    const item = ITEM[itemId];
    if (!item) fail(404, "That's not in the Bolt Shop");
    return transaction(db, () => {
      const user = q.user.get(userId);
      if (q.one.get(userId, item.id)) fail(409, 'You already have that');
      if (item.kind === 'unlimited' && hasUnlimitedUser(user)) fail(409, 'You already have KoolKat Unlimited');
      if (item.kind === 'team' && hasUnlimitedUser(user)) fail(409, 'Team colours already come with your KoolKat Unlimited');
      const balance = bolts.balance(userId);
      if (balance < item.price) fail(402, `You need ${(item.price - balance).toLocaleString('en-US')} more bolts`);
      const now = clock();
      q.add.run(userId, item.id, item.price, now);
      q.ledger.run(userId, 'shop', 'buy', -item.price, `shop:buy:${item.id}:${now}`, now);
      if (item.kind === 'unlimited') q.setUnlimited.run(1, userId);
      if (item.kind === 'badge') q.setBadge.run(1, userId);
      return describe(userId);
    });
  }

  /** Sell something back: you get every bolt you paid for it. */
  function sell(userId, itemId) {
    const item = ITEM[itemId];
    if (!item) fail(404, "That's not in the Bolt Shop");
    return transaction(db, () => {
      const row = q.one.get(userId, item.id);
      if (!row) fail(409, "You don't have that");
      const now = clock();
      q.remove.run(userId, item.id);
      q.ledger.run(userId, 'shop', 'sell', row.price, `shop:sell:${item.id}:${now}`, now);
      if (item.kind === 'unlimited') q.setUnlimited.run(0, userId);
      if (item.kind === 'badge') q.setBadge.run(0, userId);
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
    wrap((req) => ({ shop: shop.buy(req.user.id, String(req.body?.item ?? '')) }))
  );
  api.post(
    '/shop/sell',
    auth,
    wrap((req) => ({ shop: shop.sell(req.user.id, String(req.body?.item ?? '')) }))
  );
}

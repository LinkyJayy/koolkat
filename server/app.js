import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { transaction } from './db.js';
import {
  createSession,
  destroySession,
  hashAuthSecret,
  rateLimiter,
  requireAuth,
  verifyAuthSecret,
} from './auth.js';
import { applySnapToStreak, describeStreak } from './streaks.js';
import { createPusher, parseSubscription } from './push.js';
import {
  CODE_RE,
  FOREVER,
  FREE_STORAGE,
  UNLIMITED_STORAGE,
  DEFAULT_FLAIR,
  adminUsernames,
  cleanFlair,
  cleanText,
  generateCode,
  hasUnlimited,
  isAdmin,
  normaliseCode,
  perks,
  unlimitedUntil,
} from './plans.js';
import { DAY_MS } from './streaks.js';
import { HttpError, base64Field, fail, pair, parseUserId, validatePublicKey } from './http.js';
import { registerChatRoutes } from './chats.js';
import { registerNewsRoutes } from './news.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const INBOX_PAGE_SIZE = 50;
export const MAX_SNAP_BYTES = 8 * 1024 * 1024;
export const MAX_RECIPIENTS = 50;

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

/** Origins (e.g. a GitHub Pages site) allowed to call the API from another domain. */
export function parseAllowedOrigins(value = process.env.ALLOWED_ORIGINS || '') {
  return value
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function createApp({
  db,
  clock = Date.now,
  serveStatic = true,
  pusher = createPusher({ db, clock }),
  allowedOrigins = parseAllowedOrigins(),
  admins = adminUsernames(),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Number of reverse proxies in front of the server (so rate limiting sees the
  // real client IP). Railway has one.
  const proxyHops = Number(process.env.TRUST_PROXY ?? (process.env.RAILWAY_ENVIRONMENT ? 1 : 0));
  app.set('trust proxy', Number.isInteger(proxyHops) && proxyHops > 0 ? proxyHops : false);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
        "style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; " +
        "base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), microphone=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    next();
  });

  const api = express.Router();
  // Cross-origin access for a separately hosted frontend. The API uses bearer
  // tokens rather than cookies, so no credentials mode is needed.
  api.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowedOrigins.includes(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  });
  api.use(express.json({ limit: '12mb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const auth = requireAuth(db, clock);
  const loginLimiter = rateLimiter({ limit: 10, windowMs: 15 * 60 * 1000, clock });
  const registerLimiter = rateLimiter({ limit: 20, windowMs: 60 * 60 * 1000, clock });

  // ---------- statements ----------
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(`
      INSERT INTO users (username, display_name, auth_hash, auth_salt, public_key,
                         encrypted_private_key, private_key_iv, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    friendship: db.prepare('SELECT * FROM friendships WHERE user_low = ? AND user_high = ?'),
    friendshipsOf: db.prepare(`
      SELECT f.*, u.id AS other_id, u.username, u.display_name, u.public_key,
             u.plan_until, u.flair
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
      WHERE f.user_low = ? OR f.user_high = ?`),
    insertFriendship: db.prepare(`
      INSERT INTO friendships (user_low, user_high, requester_id, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)`),
    acceptFriendship: db.prepare(`
      UPDATE friendships SET status = 'accepted', accepted_at = ?
      WHERE user_low = ? AND user_high = ?`),
    deleteFriendship: db.prepare('DELETE FROM friendships WHERE user_low = ? AND user_high = ?'),
    updateStreak: db.prepare(`
      UPDATE friendships
      SET low_last_day = ?, high_last_day = ?, streak_count = ?, streak_day = ?
      WHERE user_low = ? AND user_high = ?`),
    searchUsers: db.prepare(`
      SELECT id, username, display_name, plan_until, flair FROM users
      WHERE username LIKE ? ESCAPE '\\' AND id != ?
      ORDER BY length(username), username LIMIT 20`),
    insertSnap: db.prepare(`
      INSERT INTO snaps (id, sender_id, iv, ephemeral_key, ciphertext, size, created_at, expires_at,
                         sender_wrapped_key, sender_wrap_iv)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertRecipient: db.prepare(`
      INSERT INTO snap_recipients (snap_id, recipient_id, wrapped_key, wrap_iv)
      VALUES (?, ?, ?, ?)`),
    // Received snaps from people who are still friends, newest first, one page at a time.
    inbox: db.prepare(`
      SELECT s.id, s.created_at, s.size, s.ciphertext IS NOT NULL AS available, r.viewed_at,
             u.id AS sender_id, u.username, u.display_name, u.plan_until, u.flair
      FROM snap_recipients r
      JOIN snaps s ON s.id = r.snap_id
      JOIN users u ON u.id = s.sender_id
      JOIN friendships f ON f.status = 'accepted'
        AND f.user_low = MIN(r.recipient_id, s.sender_id) AND f.user_high = MAX(r.recipient_id, s.sender_id)
      WHERE r.recipient_id = ? AND s.created_at < ?
      ORDER BY s.created_at DESC LIMIT ?`),
    sent: db.prepare(`
      SELECT s.id, s.created_at, s.sender_wrapped_key IS NOT NULL AND s.ciphertext IS NOT NULL AS viewable,
             r.viewed_at, u.id AS recipient_id, u.username, u.display_name, u.plan_until, u.flair
      FROM snaps s
      JOIN snap_recipients r ON r.snap_id = s.id
      JOIN users u ON u.id = r.recipient_id
      WHERE s.sender_id = ?
      ORDER BY s.created_at DESC LIMIT 200`),
    snapForRecipient: db.prepare(`
      SELECT s.*, r.wrapped_key, r.wrap_iv, r.viewed_at,
             u.username AS sender_username, u.display_name AS sender_display_name,
             u.plan_until, u.flair
      FROM snaps s
      JOIN snap_recipients r ON r.snap_id = s.id AND r.recipient_id = ?
      JOIN users u ON u.id = s.sender_id
      WHERE s.id = ?`),
    markViewed: db.prepare(`
      UPDATE snap_recipients SET viewed_at = ?
      WHERE snap_id = ? AND recipient_id = ? AND viewed_at IS NULL`),
    removeRecipient: db.prepare('DELETE FROM snap_recipients WHERE snap_id = ? AND recipient_id = ?'),
    recipientCount: db.prepare('SELECT COUNT(*) AS n FROM snap_recipients WHERE snap_id = ?'),
    deleteSnap: db.prepare('DELETE FROM snaps WHERE id = ?'),
    snapForSender: db.prepare('SELECT * FROM snaps WHERE id = ? AND sender_id = ?'),
    snapRecipients: db.prepare(`
      SELECT u.id, u.username, u.display_name, u.plan_until, u.flair
      FROM snap_recipients r JOIN users u ON u.id = r.recipient_id WHERE r.snap_id = ?`),
    storageUsed: db.prepare(
      'SELECT COALESCE(SUM(size), 0) AS used FROM snaps WHERE sender_id = ? AND ciphertext IS NOT NULL'
    ),
    setFlair: db.prepare('UPDATE users SET flair = ? WHERE id = ?'),
    setPlanUntil: db.prepare('UPDATE users SET plan_until = ? WHERE id = ?'),
    favoriteIds: db.prepare('SELECT snap_id FROM favorites WHERE user_id = ?'),
    addFavorite: db.prepare('INSERT OR IGNORE INTO favorites (user_id, snap_id, created_at) VALUES (?, ?, ?)'),
    removeFavorite: db.prepare('DELETE FROM favorites WHERE user_id = ? AND snap_id = ?'),
    favorites: db.prepare(`
      SELECT f.created_at AS favorited_at, s.id, s.sender_id, s.created_at, s.ciphertext IS NOT NULL AS available,
             s.sender_wrapped_key IS NOT NULL AS sender_viewable,
             u.username, u.display_name, u.plan_until, u.flair
      FROM favorites f
      JOIN snaps s ON s.id = f.snap_id
      JOIN users u ON u.id = s.sender_id
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC`),
    latestRequest: db.prepare('SELECT * FROM unlimited_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1'),
    request: db.prepare('SELECT * FROM unlimited_requests WHERE id = ?'),
    insertRequest: db.prepare('INSERT INTO unlimited_requests (user_id, message, created_at) VALUES (?, ?, ?)'),
    pendingRequests: db.prepare(`
      SELECT r.*, u.username, u.display_name, u.plan_until, u.flair
      FROM unlimited_requests r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'pending' ORDER BY r.created_at`),
    handleRequest: db.prepare(
      "UPDATE unlimited_requests SET status = ?, handled_by = ?, handled_at = ?, grant_days = ? WHERE id = ? AND status = 'pending'"
    ),
    adminIds: db.prepare('SELECT id, username FROM users'),
    code: db.prepare('SELECT * FROM codes WHERE code = ?'),
    codes: db.prepare('SELECT * FROM codes ORDER BY created_at DESC'),
    insertCode: db.prepare(`
      INSERT INTO codes (code, created_by, created_at, expires_at, max_uses, grant_days)
      VALUES (?, ?, ?, ?, ?, ?)`),
    deleteCode: db.prepare('DELETE FROM codes WHERE code = ?'),
    useCode: db.prepare('UPDATE codes SET uses = uses + 1 WHERE code = ?'),
    redemption: db.prepare('SELECT 1 FROM code_redemptions WHERE code = ? AND user_id = ?'),
    insertRedemption: db.prepare('INSERT INTO code_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)'),
  };

  // Name plus the KoolKat Unlimited badge and flair, if they have it.
  const publicUser = (u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    ...perks(u, clock(), admins),
  });

  const describeRequest = (r) =>
    r ? { id: r.id, status: r.status, createdAt: r.created_at, handledAt: r.handled_at, message: r.message } : null;

  const planFor = (u) => {
    const now = clock();
    const unlimited = hasUnlimited(u, now, admins);
    const until = unlimitedUntil(u, admins);
    return {
      plan: unlimited ? 'unlimited' : 'free',
      unlimitedUntil: unlimited ? (until >= FOREVER ? null : until) : null,
      forever: unlimited && until >= FOREVER,
      storageUsed: q.storageUsed.get(u.id).used,
      storageLimit: unlimited ? UNLIMITED_STORAGE : FREE_STORAGE,
      flair: unlimited ? u.flair || DEFAULT_FLAIR : null,
      request: describeRequest(q.latestRequest.get(u.id)),
      isAdmin: isAdmin(u.username, admins),
    };
  };

  /** Add days of Unlimited (null = forever) on top of whatever they already have. */
  const grantUnlimited = (user, days) => {
    const now = clock();
    const current = user.plan_until ?? 0;
    let until;
    if (days == null || current >= FOREVER) until = FOREVER;
    else until = Math.max(now, current) + days * DAY_MS;
    q.setPlanUntil.run(until, user.id);
    return until;
  };

  const areFriends = (a, b) => {
    const [low, high] = pair(a, b);
    return q.friendship.get(low, high)?.status === 'accepted';
  };

  const notifyAccepted = (requesterId, accepter) =>
    pusher.notify(requesterId, {
      body: `${accepter.displayName} accepted your friend request 🎉`,
      tag: `accepted-${accepter.id}`,
      view: 'friends',
    });

  // Runs a route handler (sync or async) and sends what it returns as JSON.
  const wrap = (handler) => (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .then((result) => {
        if (result !== undefined && !res.headersSent) res.json(result);
      })
      .catch(next);
  };

  const requireAdmin = (req, res, next) => {
    if (!isAdmin(req.user?.username, admins)) return res.status(403).json({ error: 'Admins only' });
    next();
  };

  const version = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.KOOLKAT_VERSION || 'dev').slice(0, 7);
  api.get('/health', (req, res) => res.json({ ok: true, version }));

  // ---------- accounts ----------
  api.post(
    '/auth/register',
    wrap((req, res) => {
      if (!registerLimiter(`ip:${req.ip}`)) fail(429, 'Too many sign-ups, try again later');
      const { username, displayName, authSecret, publicKey, encryptedPrivateKey, privateKeyIv } =
        req.body ?? {};
      if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        fail(400, 'Username must be 3-20 characters: letters, numbers, _ or .');
      }
      const name = typeof displayName === 'string' ? displayName.trim() : '';
      if (name.length < 1 || name.length > 40) fail(400, 'Display name must be 1-40 characters');
      if (typeof authSecret !== 'string' || !HEX64_RE.test(authSecret)) fail(400, 'Invalid auth secret');
      validatePublicKey(publicKey);
      base64Field(encryptedPrivateKey, 'encryptedPrivateKey', { min: 64, max: 512 });
      base64Field(privateKeyIv, 'privateKeyIv', { min: 12, max: 12 });

      if (q.userByName.get(username)) fail(409, 'That username is taken');
      const { hash, salt } = hashAuthSecret(authSecret);
      const now = clock();
      let userId;
      try {
        userId = Number(
          q.insertUser.run(username, name, hash, salt, publicKey, encryptedPrivateKey, privateKeyIv, now)
            .lastInsertRowid
        );
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) fail(409, 'That username is taken');
        throw err;
      }
      const token = createSession(db, userId, now);
      res.status(201);
      return { token, user: publicUser(q.userById.get(userId)) };
    })
  );

  api.post(
    '/auth/login',
    wrap((req) => {
      const { username, authSecret } = req.body ?? {};
      if (typeof username !== 'string' || typeof authSecret !== 'string') {
        fail(400, 'Username and password are required');
      }
      if (!loginLimiter(`${req.ip}:${username.toLowerCase()}`)) {
        fail(429, 'Too many attempts, try again in a few minutes');
      }
      // Usernames aren't secret (sign-up and friend search already reveal them),
      // so say which part is wrong: it makes a lost or mistyped account obvious.
      const user = q.userByName.get(username.trim());
      if (!user) fail(401, 'There is no account with that username. Check the spelling, or sign up.');
      if (!verifyAuthSecret(authSecret, user.auth_salt, user.auth_hash)) fail(401, 'Wrong password');
      return {
        token: createSession(db, user.id, clock()),
        user: publicUser(user),
        publicKey: user.public_key,
        encryptedPrivateKey: user.encrypted_private_key,
        privateKeyIv: user.private_key_iv,
      };
    })
  );

  api.post(
    '/auth/logout',
    auth,
    wrap((req) => {
      destroySession(db, req.token);
      return { ok: true };
    })
  );

  api.get(
    '/me',
    auth,
    wrap((req) => {
      const user = q.userById.get(req.user.id);
      return {
        user: publicUser(user),
        publicKey: user.public_key,
        encryptedPrivateKey: user.encrypted_private_key,
        privateKeyIv: user.private_key_iv,
        plan: planFor(user),
      };
    })
  );

  api.post(
    '/me/flair',
    auth,
    wrap((req) => {
      const user = q.userById.get(req.user.id);
      if (!hasUnlimited(user, clock(), admins)) fail(403, 'Kool flair is part of KoolKat Unlimited');
      const flair = cleanFlair(req.body?.flair);
      if (flair == null) fail(400, 'Flair must be text');
      // Empty resets to the default.
      q.setFlair.run(flair || null, user.id);
      return { flair: flair || DEFAULT_FLAIR };
    })
  );

  // ---------- KoolKat Unlimited: codes ----------
  api.post(
    '/codes/redeem',
    auth,
    wrap((req) => {
      const code = normaliseCode(req.body?.code);
      const row = code && q.code.get(code);
      const now = clock();
      if (!row) fail(404, "That code doesn't exist");
      if (row.expires_at != null && row.expires_at <= now) fail(410, 'That code has expired');
      if (row.max_uses != null && row.uses >= row.max_uses) fail(410, 'That code has been used up');
      if (q.redemption.get(code, req.user.id)) fail(409, "You've already used this code");
      const until = transaction(db, () => {
        q.useCode.run(code);
        q.insertRedemption.run(code, req.user.id, now);
        return grantUnlimited(q.userById.get(req.user.id), row.grant_days);
      });
      return { ok: true, forever: until >= FOREVER, unlimitedUntil: until >= FOREVER ? null : until };
    })
  );

  // ---------- admin ----------
  const describeCode = (c) => ({
    code: c.code,
    createdAt: c.created_at,
    expiresAt: c.expires_at,
    maxUses: c.max_uses,
    uses: c.uses,
    grantDays: c.grant_days,
  });

  const optionalPositiveInt = (value, name, max) => {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) fail(400, `${name} must be a whole number from 1 to ${max}`);
    return n;
  };

  api.get(
    '/admin/codes',
    auth,
    requireAdmin,
    wrap(() => ({ codes: q.codes.all().map(describeCode) }))
  );

  api.post(
    '/admin/codes',
    auth,
    requireAdmin,
    wrap((req, res) => {
      const body = req.body ?? {};
      const code = body.code ? normaliseCode(body.code) : generateCode();
      if (!CODE_RE.test(code)) fail(400, 'Codes are 4-32 letters, numbers or dashes');
      if (q.code.get(code)) fail(409, 'That code already exists');
      const maxUses = optionalPositiveInt(body.maxUses, 'Usage limit', 1_000_000);
      const grantDays = optionalPositiveInt(body.grantDays, 'Days of Unlimited', 36_500);
      let expiresAt = null;
      if (body.expiresAt != null && body.expiresAt !== '') {
        expiresAt = Number(body.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= clock()) fail(400, 'Expiry must be in the future');
      }
      q.insertCode.run(code, req.user.id, clock(), expiresAt, maxUses, grantDays);
      res.status(201);
      return { code: describeCode(q.code.get(code)) };
    })
  );

  api.delete(
    '/admin/codes/:code',
    auth,
    requireAdmin,
    wrap((req) => {
      const code = normaliseCode(req.params.code);
      if (!q.code.get(code)) fail(404, 'No such code');
      q.deleteCode.run(code);
      return { ok: true };
    })
  );

  api.post(
    '/admin/grant',
    auth,
    requireAdmin,
    wrap((req) => {
      const target = q.userByName.get(String(req.body?.username ?? '').trim());
      if (!target) fail(404, 'No user with that username');
      const days = optionalPositiveInt(req.body?.days, 'Days', 36_500);
      const until = grantUnlimited(target, days);
      return { user: publicUser(q.userById.get(target.id)), forever: until >= FOREVER, unlimitedUntil: until >= FOREVER ? null : until };
    })
  );

  api.post(
    '/admin/revoke',
    auth,
    requireAdmin,
    wrap((req) => {
      const target = q.userByName.get(String(req.body?.username ?? '').trim());
      if (!target) fail(404, 'No user with that username');
      // Removes gifted / code / approved-request time. (Admins always keep theirs.)
      q.setPlanUntil.run(null, target.id);
      return { user: publicUser(q.userById.get(target.id)) };
    })
  );


  // ---------- friends ----------
  api.get(
    '/users/search',
    auth,
    wrap((req) => {
      const term = String(req.query.q ?? '').trim();
      if (term.length < 1 || term.length > 20) return { users: [] };
      const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
      const users = q.searchUsers.all(`${escaped}%`, req.user.id).map((u) => {
        const [low, high] = pair(req.user.id, u.id);
        const f = q.friendship.get(low, high);
        let relationship = 'none';
        if (f?.status === 'accepted') relationship = 'friends';
        else if (f) relationship = f.requester_id === req.user.id ? 'outgoing' : 'incoming';
        return { ...publicUser(u), relationship };
      });
      return { users };
    })
  );

  api.get(
    '/friends',
    auth,
    wrap((req) => {
      const me = req.user.id;
      const now = clock();
      const friends = [];
      const incoming = [];
      const outgoing = [];
      for (const row of q.friendshipsOf.all(me, me, me)) {
        const user = publicUser({ ...row, id: row.other_id });
        if (row.status === 'accepted') {
          friends.push({
            ...user,
            publicKey: row.public_key,
            friendsSince: row.accepted_at,
            streak: describeStreak(row, me, now),
          });
        } else if (row.requester_id === me) {
          outgoing.push({ ...user, requestedAt: row.created_at });
        } else {
          incoming.push({ ...user, requestedAt: row.created_at });
        }
      }
      friends.sort(
        (a, b) => b.streak.count - a.streak.count || a.displayName.localeCompare(b.displayName)
      );
      return { friends, incoming, outgoing };
    })
  );

  api.post(
    '/friends/request',
    auth,
    wrap((req, res) => {
      const { username } = req.body ?? {};
      if (typeof username !== 'string') fail(400, 'Username is required');
      const target = q.userByName.get(username);
      if (!target) fail(404, 'No user with that username');
      if (target.id === req.user.id) fail(400, "You can't add yourself");
      const [low, high] = pair(req.user.id, target.id);
      const now = clock();
      const existing = q.friendship.get(low, high);
      if (existing?.status === 'accepted') fail(409, 'You are already friends');
      if (existing && existing.requester_id === req.user.id) fail(409, 'Request already sent');
      if (existing) {
        // They already asked us: adding them back accepts the request.
        q.acceptFriendship.run(now, low, high);
        notifyAccepted(target.id, req.user);
        return { status: 'accepted', user: publicUser(target) };
      }
      q.insertFriendship.run(low, high, req.user.id, now);
      pusher.notify(target.id, {
        body: `${req.user.displayName} (@${req.user.username}) wants to be friends`,
        tag: `request-${req.user.id}`,
        view: 'friends',
      });
      res.status(201);
      return { status: 'pending', user: publicUser(target) };
    })
  );


  api.post(
    '/friends/:userId/accept',
    auth,
    wrap((req) => {
      const other = parseUserId(req.params.userId);
      const [low, high] = pair(req.user.id, other);
      const f = q.friendship.get(low, high);
      if (!f || f.status !== 'pending' || f.requester_id === req.user.id) {
        fail(404, 'No pending request from that user');
      }
      q.acceptFriendship.run(clock(), low, high);
      notifyAccepted(other, req.user);
      return { status: 'accepted' };
    })
  );

  // Decline an incoming request, cancel an outgoing one, or unfriend.
  api.delete(
    '/friends/:userId',
    auth,
    wrap((req) => {
      const other = parseUserId(req.params.userId);
      const [low, high] = pair(req.user.id, other);
      if (!q.friendship.get(low, high)) fail(404, 'Not found');
      q.deleteFriendship.run(low, high);
      return { ok: true };
    })
  );

  // ---------- snaps ----------
  api.post(
    '/snaps',
    auth,
    wrap((req, res) => {
      const { iv, ephemeralPublicKey, ciphertext, recipients, senderWrappedKey, senderWrapIv } = req.body ?? {};
      base64Field(iv, 'iv', { min: 12, max: 12 });
      validatePublicKey(ephemeralPublicKey, 'ephemeralPublicKey');
      const blob = base64Field(ciphertext, 'ciphertext', { min: 17, max: MAX_SNAP_BYTES });
      if (!Array.isArray(recipients) || recipients.length < 1) fail(400, 'Pick at least one friend');
      if (recipients.length > MAX_RECIPIENTS) fail(400, `At most ${MAX_RECIPIENTS} recipients`);

      const seen = new Set();
      const me = req.user.id;
      for (const r of recipients) {
        const id = parseUserId(r?.userId);
        if (seen.has(id)) fail(400, 'Duplicate recipient');
        seen.add(id);
        if (id === me || !areFriends(me, id)) fail(403, 'You can only send Klicks to friends');
        base64Field(r.wrappedKey, 'wrappedKey', { min: 48, max: 48 });
        base64Field(r.wrapIv, 'wrapIv', { min: 12, max: 12 });
      }
      // Optional copy of the snap key for the sender, so they can view it later.
      if (senderWrappedKey != null || senderWrapIv != null) {
        base64Field(senderWrappedKey, 'senderWrappedKey', { min: 48, max: 48 });
        base64Field(senderWrapIv, 'senderWrapIv', { min: 12, max: 12 });
      }

      const sender = q.userById.get(me);
      const plan = planFor(sender);
      if (plan.storageUsed + blob.length > plan.storageLimit) {
        fail(
          413,
          plan.plan === 'unlimited'
            ? 'Your KoolKat storage is full. Delete some of your sent Klicks to make room.'
            : 'Your 512 MB of KoolKat storage is full. Delete some of your sent Klicks, or ask an admin for KoolKat Unlimited (2.5 GB, free).'
        );
      }

      const id = crypto.randomUUID();
      const now = clock();
      transaction(db, () => {
        // expires_at is left over from when snaps expired; 0 means "never".
        q.insertSnap.run(id, me, iv, ephemeralPublicKey, blob, blob.length, now, 0, senderWrappedKey ?? null, senderWrapIv ?? null);
        for (const r of recipients) {
          const other = Number(r.userId);
          q.insertRecipient.run(id, other, r.wrappedKey, r.wrapIv);
          const [low, high] = pair(me, other);
          const s = applySnapToStreak(q.friendship.get(low, high), me, now);
          q.updateStreak.run(s.low_last_day, s.high_last_day, s.streak_count, s.streak_day, low, high);
        }
      });
      for (const r of recipients) {
        pusher.notify(Number(r.userId), {
          body: `${req.user.displayName} sent you a Klick 📸`,
          tag: `snap-${me}`,
          view: 'inbox',
        });
      }
      res.status(201);
      return { id, createdAt: now };
    })
  );

  api.get(
    '/snaps/inbox',
    auth,
    wrap((req) => {
      const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
      const rows = q.inbox.all(req.user.id, before, INBOX_PAGE_SIZE + 1);
      const favorites = favoriteSet(req.user.id);
      return {
        snaps: rows.slice(0, INBOX_PAGE_SIZE).map((s) => ({
          id: s.id,
          from: publicUser({ ...s, id: s.sender_id }),
          createdAt: s.created_at,
          size: s.size,
          opened: s.viewed_at != null,
          openedAt: s.viewed_at,
          available: Boolean(s.available),
          favorite: favorites.has(s.id),
        })),
        hasMore: rows.length > INBOX_PAGE_SIZE,
      };
    })
  );

  api.get(
    '/snaps/sent',
    auth,
    wrap((req) => {
      const byId = new Map();
      const favorites = favoriteSet(req.user.id);
      for (const row of q.sent.all(req.user.id)) {
        if (!byId.has(row.id)) {
          byId.set(row.id, {
            id: row.id,
            createdAt: row.created_at,
            viewable: Boolean(row.viewable),
            favorite: favorites.has(row.id),
            recipients: [],
          });
        }
        byId.get(row.id).recipients.push({
          ...publicUser({ ...row, id: row.recipient_id }),
          opened: row.viewed_at != null,
          openedAt: row.viewed_at,
        });
      }
      return { snaps: [...byId.values()] };
    })
  );

  api.get(
    '/snaps/:id',
    auth,
    wrap((req) => {
      const id = String(req.params.id);
      // The sender viewing their own snap.
      const own = q.snapForSender.get(id, req.user.id);
      if (own) {
        if (!own.sender_wrapped_key) fail(410, 'Klicks sent before this update can only be viewed by their recipients');
        if (own.ciphertext == null) fail(410, 'This Klick is no longer available');
        return {
          id: own.id,
          own: true,
          favorite: favoriteSet(req.user.id).has(own.id),
          from: publicUser(q.userById.get(req.user.id)),
          to: q.snapRecipients.all(id).map(publicUser),
          createdAt: own.created_at,
          iv: own.iv,
          ephemeralPublicKey: own.ephemeral_key,
          wrappedKey: own.sender_wrapped_key,
          wrapIv: own.sender_wrap_iv,
          ciphertext: Buffer.from(own.ciphertext).toString('base64'),
        };
      }
      const snap = q.snapForRecipient.get(req.user.id, id);
      if (!snap) fail(404, 'Klick not found');
      if (!areFriends(req.user.id, snap.sender_id)) fail(403, 'Klicks are only visible to friends');
      // Only snaps from before snaps were kept can be missing their data.
      if (snap.ciphertext == null) fail(410, 'This Klick is no longer available');
      return {
        id: snap.id,
        from: publicUser({ ...snap, id: snap.sender_id, username: snap.sender_username, display_name: snap.sender_display_name }),
        favorite: favoriteSet(req.user.id).has(snap.id),
        createdAt: snap.created_at,
        iv: snap.iv,
        ephemeralPublicKey: snap.ephemeral_key,
        wrappedKey: snap.wrapped_key,
        wrapIv: snap.wrap_iv,
        ciphertext: Buffer.from(snap.ciphertext).toString('base64'),
      };
    })
  );

  api.post(
    '/snaps/:id/viewed',
    auth,
    wrap((req) => {
      const id = String(req.params.id);
      const snap = q.snapForRecipient.get(req.user.id, id);
      if (!snap) fail(404, 'Klick not found');
      q.markViewed.run(clock(), id, req.user.id);
      return { ok: true };
    })
  );

  // The sender deletes a snap for everyone (freeing their storage), or a
  // recipient removes it from their inbox. When no recipient has it any more,
  // the encrypted data is deleted from the server.
  api.delete(
    '/snaps/:id',
    auth,
    wrap((req) => {
      const id = String(req.params.id);
      if (q.snapForSender.get(id, req.user.id)) {
        q.deleteSnap.run(id);
        return { ok: true, deletedForEveryone: true };
      }
      if (!q.snapForRecipient.get(req.user.id, id)) fail(404, 'Klick not found');
      transaction(db, () => {
        q.removeRecipient.run(id, req.user.id);
        if (q.recipientCount.get(id).n === 0) q.deleteSnap.run(id);
      });
      return { ok: true };
    })
  );

  // ---------- requests for KoolKat Unlimited ----------
  const REQUEST_RETRY_MS = DAY_MS; // after a decline, people can ask again the next day

  const notifyAdmins = (payload) => {
    for (const u of q.adminIds.all()) if (isAdmin(u.username, admins)) pusher.notify(u.id, payload);
  };

  api.post(
    '/unlimited/request',
    auth,
    wrap((req, res) => {
      const user = q.userById.get(req.user.id);
      const now = clock();
      if (hasUnlimited(user, now, admins)) fail(409, 'You already have KoolKat Unlimited');
      const last = q.latestRequest.get(user.id);
      if (last?.status === 'pending') fail(409, "You've already asked. An admin will look at it soon.");
      if (last?.status === 'declined' && now - (last.handled_at ?? 0) < REQUEST_RETRY_MS) {
        fail(429, 'Your last request was declined. You can ask again tomorrow.');
      }
      const message = cleanText(req.body?.message ?? '', 200, { multiline: true }) || null;
      q.insertRequest.run(user.id, message, now);
      notifyAdmins({
        body: `🎁 ${user.display_name} (@${user.username}) asked for KoolKat Unlimited`,
        tag: 'unlimited-requests',
        view: 'camera',
      });
      res.status(201);
      return { request: describeRequest(q.latestRequest.get(user.id)) };
    })
  );

  api.get(
    '/admin/requests',
    auth,
    requireAdmin,
    wrap(() => ({
      requests: q.pendingRequests.all().map((r) => ({
        ...describeRequest(r),
        user: publicUser({ ...r, id: r.user_id }),
      })),
    }))
  );

  const pendingRequest = (req) => {
    const r = q.request.get(Number(req.params.id));
    if (!r) fail(404, 'Request not found');
    if (r.status !== 'pending') fail(409, 'That request was already handled');
    return r;
  };

  api.post(
    '/admin/requests/:id/approve',
    auth,
    requireAdmin,
    wrap((req) => {
      const r = pendingRequest(req);
      const days = optionalPositiveInt(req.body?.days, 'Days', 36_500);
      const until = transaction(db, () => {
        q.handleRequest.run('approved', req.user.id, clock(), days, r.id);
        return grantUnlimited(q.userById.get(r.user_id), days);
      });
      pusher.notify(r.user_id, {
        body: until >= FOREVER ? '🎉 You got KoolKat Unlimited, forever!' : '🎉 Your KoolKat Unlimited request was approved!',
        tag: 'unlimited-request',
        view: 'camera',
      });
      return { ok: true, forever: until >= FOREVER, unlimitedUntil: until >= FOREVER ? null : until };
    })
  );

  api.post(
    '/admin/requests/:id/decline',
    auth,
    requireAdmin,
    wrap((req) => {
      const r = pendingRequest(req);
      q.handleRequest.run('declined', req.user.id, clock(), null, r.id);
      pusher.notify(r.user_id, {
        body: "Your KoolKat Unlimited request wasn't approved this time. Keep an eye on News for codes!",
        tag: 'unlimited-request',
        view: 'news',
      });
      return { ok: true };
    })
  );

  // ---------- favorites ----------
  const favoriteSet = (userId) => new Set(q.favoriteIds.all(userId).map((r) => r.snap_id));

  /** Can this user open this Klick right now? (Its sender, or a recipient who's still a friend.) */
  const canView = (id, userId) => {
    const own = q.snapForSender.get(id, userId);
    if (own) return Boolean(own.sender_wrapped_key);
    const received = q.snapForRecipient.get(userId, id);
    return Boolean(received && areFriends(userId, received.sender_id));
  };

  api.post(
    '/snaps/:id/favorite',
    auth,
    wrap((req) => {
      const id = String(req.params.id);
      if (!canView(id, req.user.id)) fail(404, 'Klick not found');
      q.addFavorite.run(req.user.id, id, clock());
      return { favorite: true };
    })
  );

  api.delete(
    '/snaps/:id/favorite',
    auth,
    wrap((req) => {
      q.removeFavorite.run(req.user.id, String(req.params.id));
      return { favorite: false };
    })
  );

  api.get(
    '/favorites',
    auth,
    wrap((req) => {
      const me = req.user.id;
      const favorites = [];
      for (const row of q.favorites.all(me)) {
        const own = row.sender_id === me;
        // Favorites from people you're no longer friends with stay hidden, like their Klicks.
        if (!own && !areFriends(me, row.sender_id)) continue;
        if (own && !row.sender_viewable) continue;
        favorites.push({
          id: row.id,
          own,
          from: publicUser({ ...row, id: row.sender_id }),
          to: own ? q.snapRecipients.all(row.id).map(publicUser) : undefined,
          createdAt: row.created_at,
          favoritedAt: row.favorited_at,
          available: Boolean(row.available),
          favorite: true,
        });
      }
      return { favorites };
    })
  );

  // ---------- chats ----------
  registerChatRoutes({ api, db, clock, auth, wrap, publicUser, areFriends, pusher });

  // ---------- news ----------
  const isAdminUser = (user) => isAdmin(user?.username, admins);
  registerNewsRoutes({ api, db, clock, auth, wrap, publicUser, isAdminUser, pusher });

  // ---------- push notifications ----------
  api.get('/push/key', (req, res) => res.json({ publicKey: pusher.publicKey }));

  api.post(
    '/push/subscribe',
    auth,
    wrap((req) => {
      const subscription = parseSubscription(req.body);
      if (!subscription) fail(400, 'Invalid push subscription');
      pusher.subscribe(req.user.id, subscription);
      return { ok: true };
    })
  );

  api.post(
    '/push/unsubscribe',
    auth,
    wrap((req) => {
      pusher.unsubscribe(req.user.id, req.body?.endpoint);
      return { ok: true };
    })
  );

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That Klick is too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  app.use('/api', api);
  if (serveStatic) {
    app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  }
  return app;
}

/** Delete expired sessions. Called periodically by the server. (Snaps are kept.) */
export function cleanup(db, now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

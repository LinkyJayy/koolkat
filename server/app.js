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

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const SNAP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // unopened snaps vanish after 30 days
export const MAX_SNAP_BYTES = 8 * 1024 * 1024;
export const MAX_RECIPIENTS = 50;

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

function base64Field(value, name, { min = 1, max = Infinity } = {}) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    fail(400, `${name} must be base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < min || bytes.length > max) fail(400, `${name} has an invalid length`);
  return bytes;
}

/** Accept only an uncompressed P-256 ECDH public key in SPKI/DER form. */
function validatePublicKey(value, name = 'publicKey') {
  const der = base64Field(value, name, { max: 200 });
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('wrong curve');
    }
  } catch {
    fail(400, `${name} must be a P-256 public key`);
  }
  return value;
}

const pair = (a, b) => (a < b ? [a, b] : [b, a]);

export function createApp({ db, clock = Date.now, serveStatic = true } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1');

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
      SELECT f.*, u.id AS other_id, u.username, u.display_name, u.public_key
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
      SELECT id, username, display_name FROM users
      WHERE username LIKE ? ESCAPE '\\' AND id != ?
      ORDER BY length(username), username LIMIT 20`),
    insertSnap: db.prepare(`
      INSERT INTO snaps (id, sender_id, iv, ephemeral_key, ciphertext, size, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    insertRecipient: db.prepare(`
      INSERT INTO snap_recipients (snap_id, recipient_id, wrapped_key, wrap_iv)
      VALUES (?, ?, ?, ?)`),
    inbox: db.prepare(`
      SELECT s.id, s.created_at, s.size, r.viewed_at, u.id AS sender_id, u.username, u.display_name
      FROM snap_recipients r
      JOIN snaps s ON s.id = r.snap_id
      JOIN users u ON u.id = s.sender_id
      WHERE r.recipient_id = ? AND s.expires_at > ?
      ORDER BY s.created_at DESC LIMIT 100`),
    sent: db.prepare(`
      SELECT s.id, s.created_at, r.viewed_at, u.id AS recipient_id, u.username, u.display_name
      FROM snaps s
      JOIN snap_recipients r ON r.snap_id = s.id
      JOIN users u ON u.id = r.recipient_id
      WHERE s.sender_id = ? AND s.expires_at > ?
      ORDER BY s.created_at DESC LIMIT 200`),
    snapForRecipient: db.prepare(`
      SELECT s.*, r.wrapped_key, r.wrap_iv, r.viewed_at,
             u.username AS sender_username, u.display_name AS sender_display_name
      FROM snaps s
      JOIN snap_recipients r ON r.snap_id = s.id AND r.recipient_id = ?
      JOIN users u ON u.id = s.sender_id
      WHERE s.id = ?`),
    markViewed: db.prepare(`
      UPDATE snap_recipients SET viewed_at = ?
      WHERE snap_id = ? AND recipient_id = ? AND viewed_at IS NULL`),
    unviewedCount: db.prepare(
      'SELECT COUNT(*) AS n FROM snap_recipients WHERE snap_id = ? AND viewed_at IS NULL'
    ),
    dropCiphertext: db.prepare('UPDATE snaps SET ciphertext = NULL WHERE id = ?'),
  };

  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.display_name });

  const areFriends = (a, b) => {
    const [low, high] = pair(a, b);
    return q.friendship.get(low, high)?.status === 'accepted';
  };

  const wrap = (handler) => (req, res, next) => {
    try {
      const result = handler(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (err) {
      next(err);
    }
  };

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
      const user = q.userByName.get(username);
      // Hash even for unknown users so response time doesn't reveal which usernames exist.
      let ok = false;
      if (user) ok = verifyAuthSecret(authSecret, user.auth_salt, user.auth_hash);
      else hashAuthSecret(authSecret);
      if (!ok) fail(401, 'Wrong username or password');
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
      };
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
        const user = { id: row.other_id, username: row.username, displayName: row.display_name };
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
        return { status: 'accepted', user: publicUser(target) };
      }
      q.insertFriendship.run(low, high, req.user.id, now);
      res.status(201);
      return { status: 'pending', user: publicUser(target) };
    })
  );

  const parseUserId = (value) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'Invalid user id');
    return id;
  };

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
      const { iv, ephemeralPublicKey, ciphertext, recipients } = req.body ?? {};
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
        if (id === me || !areFriends(me, id)) fail(403, 'You can only send snaps to friends');
        base64Field(r.wrappedKey, 'wrappedKey', { min: 48, max: 48 });
        base64Field(r.wrapIv, 'wrapIv', { min: 12, max: 12 });
      }

      const id = crypto.randomUUID();
      const now = clock();
      transaction(db, () => {
        q.insertSnap.run(id, me, iv, ephemeralPublicKey, blob, blob.length, now, now + SNAP_TTL_MS);
        for (const r of recipients) {
          const other = Number(r.userId);
          q.insertRecipient.run(id, other, r.wrappedKey, r.wrapIv);
          const [low, high] = pair(me, other);
          const s = applySnapToStreak(q.friendship.get(low, high), me, now);
          q.updateStreak.run(s.low_last_day, s.high_last_day, s.streak_count, s.streak_day, low, high);
        }
      });
      res.status(201);
      return { id, createdAt: now };
    })
  );

  api.get(
    '/snaps/inbox',
    auth,
    wrap((req) => ({
      snaps: q.inbox.all(req.user.id, clock()).map((s) => ({
        id: s.id,
        from: { id: s.sender_id, username: s.username, displayName: s.display_name },
        createdAt: s.created_at,
        size: s.size,
        opened: s.viewed_at != null,
        openedAt: s.viewed_at,
      })),
    }))
  );

  api.get(
    '/snaps/sent',
    auth,
    wrap((req) => {
      const byId = new Map();
      for (const row of q.sent.all(req.user.id, clock())) {
        if (!byId.has(row.id)) byId.set(row.id, { id: row.id, createdAt: row.created_at, recipients: [] });
        byId.get(row.id).recipients.push({
          id: row.recipient_id,
          username: row.username,
          displayName: row.display_name,
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
      const snap = q.snapForRecipient.get(req.user.id, String(req.params.id));
      if (!snap || snap.expires_at <= clock()) fail(404, 'Snap not found');
      if (!areFriends(req.user.id, snap.sender_id)) fail(403, 'Snaps are only visible to friends');
      if (snap.viewed_at != null || snap.ciphertext == null) fail(410, 'This snap was already opened');
      return {
        id: snap.id,
        from: { id: snap.sender_id, username: snap.sender_username, displayName: snap.sender_display_name },
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
      if (!snap) fail(404, 'Snap not found');
      transaction(db, () => {
        q.markViewed.run(clock(), id, req.user.id);
        // Once every recipient has opened it, the encrypted data is deleted for good.
        if (q.unviewedCount.get(id).n === 0) q.dropCiphertext.run(id);
      });
      return { ok: true };
    })
  );

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Snap is too large' });
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

/** Delete expired snaps and sessions. Called periodically by the server. */
export function cleanup(db, now = Date.now()) {
  db.prepare('DELETE FROM snaps WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

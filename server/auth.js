import crypto from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The client never sends the raw password. It derives an "auth secret" from
 * the password with PBKDF2 and sends only that. The server then hashes the
 * auth secret again with scrypt, so a database leak reveals neither the
 * password nor the key that protects the user's private encryption key.
 */
export function hashAuthSecret(secret, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(secret, salt, 32, SCRYPT_PARAMS).toString('hex');
  return { hash, salt };
}

export function verifyAuthSecret(secret, salt, expectedHash) {
  const { hash } = hashAuthSecret(secret, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function createSession(db, userId, now) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(sha256(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

export function destroySession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** Express middleware: requires `Authorization: Bearer <token>`. */
export function requireAuth(db, clock) {
  const lookup = db.prepare(`
    SELECT u.id, u.username, u.display_name, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `);
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    if (!match) return res.status(401).json({ error: 'Not signed in' });
    const row = lookup.get(sha256(match[1]));
    if (!row || row.expires_at < clock()) {
      return res.status(401).json({ error: 'Session expired, please sign in again' });
    }
    req.token = match[1];
    req.user = { id: row.id, username: row.username, displayName: row.display_name };
    next();
  };
}

/** Tiny in-memory fixed-window rate limiter, keyed by an arbitrary string. */
export function rateLimiter({ limit, windowMs, clock }) {
  const hits = new Map();
  return (key) => {
    const now = clock();
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    }
    return entry.count <= limit;
  };
}

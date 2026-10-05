import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  username               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name           TEXT NOT NULL,
  auth_hash              TEXT NOT NULL,
  auth_salt              TEXT NOT NULL,
  public_key             TEXT NOT NULL,
  encrypted_private_key  TEXT NOT NULL,
  private_key_iv         TEXT NOT NULL,
  created_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One row per pair of users. user_low < user_high so a pair is stored once.
CREATE TABLE IF NOT EXISTS friendships (
  user_low       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at     INTEGER NOT NULL,
  accepted_at    INTEGER,
  -- Streak bookkeeping (days are UTC day numbers: floor(ms / 86400000)).
  low_last_day   INTEGER,
  high_last_day  INTEGER,
  streak_count   INTEGER NOT NULL DEFAULT 0,
  streak_day     INTEGER,
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high)
);
CREATE INDEX IF NOT EXISTS idx_friendships_high ON friendships(user_high);

CREATE TABLE IF NOT EXISTS snaps (
  id             TEXT PRIMARY KEY,
  sender_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  iv             TEXT NOT NULL,
  ephemeral_key  TEXT NOT NULL,
  ciphertext     BLOB,
  size           INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snaps_sender ON snaps(sender_id);

CREATE TABLE IF NOT EXISTS snap_recipients (
  snap_id       TEXT NOT NULL REFERENCES snaps(id) ON DELETE CASCADE,
  recipient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key   TEXT NOT NULL,
  wrap_iv       TEXT NOT NULL,
  viewed_at     INTEGER,
  PRIMARY KEY (snap_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_snap_recipients_recipient ON snap_recipients(recipient_id);

-- Web Push subscriptions (one per browser/device a user turned notifications on for).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- Redeemable codes for KoolKat Unlimited, created by admins.
CREATE TABLE IF NOT EXISTS codes (
  code        TEXT PRIMARY KEY,           -- stored upper-case
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,                    -- NULL: never expires
  max_uses    INTEGER,                    -- NULL: unlimited uses
  uses        INTEGER NOT NULL DEFAULT 0,
  grant_days  INTEGER                     -- NULL: Unlimited forever
);

CREATE TABLE IF NOT EXISTS code_redemptions (
  code         TEXT NOT NULL REFERENCES codes(code) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at  INTEGER NOT NULL,
  PRIMARY KEY (code, user_id)
);

-- Server-wide key/value settings (e.g. generated VAPID keys).
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

// Columns added after the first release. Each is added if an older database lacks it.
const MIGRATIONS = [
  ['friendships', 'streak_reminded_day', 'INTEGER'],
  // KoolKat Unlimited: from gifts/codes (plan_until) or a paid subscription (sub_until).
  ['users', 'plan_until', 'INTEGER'],
  ['users', 'sub_until', 'INTEGER'],
  ['users', 'flair', 'TEXT'],
  ['users', 'stripe_customer_id', 'TEXT'],
  ['users', 'stripe_subscription_id', 'TEXT'],
  // Lets the sender open their own snaps (the snap key wrapped for the sender).
  ['snaps', 'sender_wrapped_key', 'TEXT'],
  ['snaps', 'sender_wrap_iv', 'TEXT'],
];

function migrate(db) {
  for (const [table, column, type] of MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * Where the database lives: KOOLKAT_DB if set, otherwise on the Railway volume
 * when one is attached (Railway sets RAILWAY_VOLUME_MOUNT_PATH), otherwise ./data.
 */
export function defaultDatabasePath(env = process.env) {
  if (env.KOOLKAT_DB) return env.KOOLKAT_DB;
  if (env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'koolkat.db');
  return 'data/koolkat.db';
}

export function openDatabase(file = defaultDatabasePath()) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Run fn inside a transaction, rolling back if it throws. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

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

-- Klicks a user has starred. Removed along with the Klick.
CREATE TABLE IF NOT EXISTS favorites (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snap_id     TEXT NOT NULL REFERENCES snaps(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, snap_id)
);

-- Chats: one-to-one ('direct') or group. Messages are end-to-end encrypted
-- like Klicks: each message has its own key, wrapped separately for every
-- member who was in the chat when it was sent.
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  name        TEXT,
  direct_key  TEXT UNIQUE,                -- "lowId:highId" for direct chats
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  last_message_at INTEGER
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at     INTEGER NOT NULL,
  last_read_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  chat_id        TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  iv             TEXT NOT NULL,
  ephemeral_key  TEXT NOT NULL,
  ciphertext     BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS message_keys (
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key  TEXT NOT NULL,
  wrap_iv      TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- Requests from users asking an admin for KoolKat Unlimited.
CREATE TABLE IF NOT EXISTS unlimited_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at  INTEGER NOT NULL,
  handled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at  INTEGER,
  grant_days  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_unlimited_requests_user ON unlimited_requests(user_id, created_at);

-- News posts written by admins (codes, events, updates). Readable by everyone signed in.
CREATE TABLE IF NOT EXISTS news (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  code        TEXT,                       -- optional code readers can redeem from the post
  created_at  INTEGER NOT NULL
);

-- Poll votes and comments on News posts (anyone signed in can vote and comment).
CREATE TABLE IF NOT EXISTS news_votes (
  post_id     INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  choice      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS news_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_comments_post ON news_comments(post_id, created_at);

-- Hearts and saves (Favorite Articles) on News posts.
CREATE TABLE IF NOT EXISTS news_likes (
  post_id     INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS news_saves (
  post_id     INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_news_saves_user ON news_saves(user_id, created_at);

-- Photos and videos uploaded for a News post that hasn't been posted yet.
-- (Files live in the media folder next to the database; see news.js.)
CREATE TABLE IF NOT EXISTS news_uploads (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,              -- 'image' | 'video'
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

-- BFFs (a KoolKat Unlimited feature): friends someone has hearted. Private to user_id.
CREATE TABLE IF NOT EXISTS bffs (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

-- Short-lived codes shown as a QR code to add friends in person.
CREATE TABLE IF NOT EXISTS friend_codes (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS friend_codes_user ON friend_codes (user_id, expires_at);

-- KoolKat Reels: short videos anyone with KoolKat Unlimited can post, like and
-- comment on, and everyone signed in can watch. (Files live in media/reels.)
CREATE TABLE IF NOT EXISTS reels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption      TEXT NOT NULL DEFAULT '',
  video_id     TEXT NOT NULL,
  video_type   TEXT NOT NULL,
  video_size   INTEGER NOT NULL,
  poster_id    TEXT,                      -- a still from the video, for thumbnails
  poster_type  TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reels_author ON reels(author_id, created_at);
CREATE TABLE IF NOT EXISTS reel_likes (
  reel_id     INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (reel_id, user_id)
);
CREATE TABLE IF NOT EXISTS reel_views (
  reel_id     INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (reel_id, user_id)
);
CREATE TABLE IF NOT EXISTS reel_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reel_id     INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reel_comments_reel ON reel_comments(reel_id, created_at);
-- Videos and thumbnails uploaded for a Reel that hasn't been posted yet.
CREATE TABLE IF NOT EXISTS reel_uploads (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,              -- 'video' | 'image'
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

-- KoolKat Music: songs posted by KoolKat Unlimited artists, with an album
-- cover and an optional music video. Anyone signed in can listen, heart and
-- comment. (Files live in media/music.)
CREATE TABLE IF NOT EXISTS songs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  album        TEXT,
  audio_id     TEXT NOT NULL,
  audio_type   TEXT NOT NULL,
  audio_size   INTEGER NOT NULL,
  video_id     TEXT,
  video_type   TEXT,
  cover_id     TEXT,
  cover_type   TEXT,
  duration     REAL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist_id, created_at);
CREATE TABLE IF NOT EXISTS song_likes (
  song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (song_id, user_id)
);
CREATE TABLE IF NOT EXISTS song_plays (
  song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_plays ON song_plays(song_id, user_id, created_at);
CREATE TABLE IF NOT EXISTS song_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_comments_song ON song_comments(song_id, created_at);
CREATE TABLE IF NOT EXISTS music_uploads (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,              -- 'audio' | 'video' | 'cover'
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

-- Bolts, the Playables currency: one row per reward (your balance is the sum).
-- ref is set for online games, so each game pays out once.
CREATE TABLE IF NOT EXISTS bolt_rewards (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  ref         TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bolt_rewards_user ON bolt_rewards(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS bolt_rewards_ref ON bolt_rewards(user_id, ref) WHERE ref IS NOT NULL;

-- Server-wide key/value settings (e.g. generated VAPID keys).
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

// Columns added after the first release. Each is added if an older database lacks it.
const MIGRATIONS = [
  ['friendships', 'streak_reminded_day', 'INTEGER'],
  // KoolKat Unlimited end time (gifts, codes, approved requests).
  ['users', 'plan_until', 'INTEGER'],
  // sub_until / stripe_*: unused, left from when Unlimited was a paid plan.
  ['users', 'sub_until', 'INTEGER'],
  ['users', 'flair', 'TEXT'],
  ['users', 'stripe_customer_id', 'TEXT'],
  ['users', 'stripe_subscription_id', 'TEXT'],
  // When the user last opened News (for the unread badge).
  ['users', 'news_seen_at', 'INTEGER'],
  // A photo or video on a News post (file in the media folder, see news.js).
  ['news', 'media_id', 'TEXT'],
  ['news', 'media_kind', 'TEXT'],
  ['news', 'media_type', 'TEXT'],
  // When an admin last edited the post.
  ['news', 'edited_at', 'INTEGER'],
  // A poll on the post: the question and its options (JSON array of strings).
  ['news', 'poll_question', 'TEXT'],
  ['news', 'poll_options', 'TEXT'],
  // KoolKat Unlimited customisation: app icon choice ('crown' | 'glow' | 'custom'),
  // an uploaded icon (served by a random public id), and a custom badge image.
  ['users', 'app_icon', 'TEXT'],
  ['users', 'app_icon_id', 'TEXT'],
  ['users', 'app_icon_512', 'BLOB'],
  ['users', 'app_icon_192', 'BLOB'],
  ['users', 'badge_id', 'TEXT'],
  ['users', 'badge_png', 'BLOB'],
  // Profile picture (everyone): a square JPEG, served by a random public id.
  ['users', 'avatar_id', 'TEXT'],
  ['users', 'avatar_jpeg', 'BLOB'],
  // Admins given by an owner in Admin tools (owners come from KOOLKAT_ADMINS).
  ['users', 'admin_granted_at', 'INTEGER'],
  ['users', 'admin_granted_by', 'INTEGER'],
  // Birthday (month and day only, never the year) and the time zone it's celebrated in.
  ['users', 'birth_month', 'INTEGER'],
  ['users', 'birth_day', 'INTEGER'],
  ['users', 'birth_tz', 'TEXT'],
  ['users', 'birthday_asked_at', 'INTEGER'],
  // A ✔ verified badge, given by the owner.
  ['users', 'verified_at', 'INTEGER'],
  // Social media links on the profile (JSON: site -> https link).
  ['users', 'socials', 'TEXT'],
  // KoolKat Unlimited accent colour (#rrggbb), used across the app instead of blue.
  ['users', 'accent_color', 'TEXT'],
  // KoolKat Music: songs the artist marked as explicit (E).
  ['songs', 'explicit', 'INTEGER NOT NULL DEFAULT 0'],
  // Lets the sender open their own snaps (the snap key wrapped for the sender).
  ['snaps', 'sender_wrapped_key', 'TEXT'],
  ['snaps', 'sender_wrap_iv', 'TEXT'],
  // KoolKat Unlimited Activity Bubble (what you're up to, shown to friends).
  ['users', 'activity_emoji', 'TEXT'],
  ['users', 'activity_text', 'TEXT'],
  ['users', 'activity_until', 'INTEGER'],
  // KoolKat Unlimited chat theme (JSON) and its optional background picture.
  ['users', 'chat_theme', 'TEXT'],
  ['users', 'chat_background', 'BLOB'],
  // Kat Map: who can see you ('friends' | 'bffs', NULL = off) and your last location.
  ['users', 'map_mode', 'TEXT'],
  ['users', 'map_lat', 'REAL'],
  ['users', 'map_lng', 'REAL'],
  ['users', 'map_accuracy', 'REAL'],
  ['users', 'map_at', 'INTEGER'],
  // Unused: left from Rich Presence (Spotify / Last.fm), which was removed. Their
  // contents (including Spotify tokens) are wiped on startup, see migrate().
  ['users', 'presence_source', 'TEXT'],
  ['users', 'lastfm_user', 'TEXT'],
  ['users', 'spotify_refresh', 'TEXT'],
  ['users', 'spotify_access', 'TEXT'],
  ['users', 'spotify_expires', 'INTEGER'],
  ['users', 'presence_track', 'TEXT'],
  ['users', 'presence_at', 'INTEGER'],
  ['users', 'presence_retry_at', 'INTEGER'],
  ['users', 'presence_error', 'TEXT'],
];

function migrate(db) {
  for (const [table, column, type] of MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  // Rich Presence was removed: don't keep anyone's Spotify tokens or listening data.
  db.exec(`UPDATE users SET presence_source = NULL, lastfm_user = NULL, spotify_refresh = NULL, spotify_access = NULL,
                            spotify_expires = NULL, presence_track = NULL, presence_at = NULL, presence_retry_at = NULL,
                            presence_error = NULL
           WHERE presence_source IS NOT NULL OR spotify_refresh IS NOT NULL OR presence_track IS NOT NULL`);
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

/**
 * Will the database survive an update? On Railway, only files on an attached
 * volume are kept between deploys; everything else is wiped with the old container.
 * Returns { persistent, reason }.
 */
export function storageStatus(file, env = process.env) {
  if (file === ':memory:') return { persistent: false, reason: 'in memory' };
  if (!env.RAILWAY_ENVIRONMENT) return { persistent: true, reason: 'local disk' };
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!mount) return { persistent: false, reason: 'no Railway volume is attached' };
  const resolved = path.resolve(file);
  const root = path.resolve(mount);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { persistent: false, reason: `the database (${resolved}) is outside the volume (${root}); remove the KOOLKAT_DB variable` };
  }
  return { persistent: true, reason: `Railway volume at ${root}` };
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

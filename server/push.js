import webpush from 'web-push';
import { DAY_MS, dayNumber } from './streaks.js';

// Push services run by the major browsers. Subscriptions pointing anywhere else
// are refused, so the server can't be made to send requests to arbitrary hosts.
const PUSH_HOST_SUFFIXES = [
  '.googleapis.com', // Chrome, Edge (FCM), Android
  '.mozilla.com', // Firefox
  '.push.apple.com', // Safari / iOS home-screen apps
  '.notify.windows.com', // legacy Edge
];

const MAX_SUBSCRIPTIONS_PER_USER = 10;
const STREAK_REMINDER_HOURS = 4; // remind when this many hours are left in the (UTC) day

const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

function decodedLength(value) {
  return typeof value === 'string' && BASE64URL_RE.test(value) ? Buffer.from(value, 'base64url').length : -1;
}

/** Returns a cleaned subscription, or null if it isn't a valid browser push subscription. */
export function parseSubscription(body) {
  const endpoint = body?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s))) return null;
  const { p256dh, auth } = body.keys ?? {};
  if (decodedLength(p256dh) !== 65 || decodedLength(auth) !== 16) return null;
  return { endpoint, p256dh, auth };
}

function loadVapidKeys(db) {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
  }
  // Otherwise generate a key pair once and keep it in the database, so existing
  // subscriptions keep working across restarts.
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get();
  if (stored) return JSON.parse(stored.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare("INSERT INTO settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  return keys;
}

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {() => number} [opts.clock]
 * @param {(sub: object, payload: string, options: object) => Promise<unknown>} [opts.send]
 *        Delivers one notification; defaults to web-push. Injected in tests.
 */
export function createPusher({ db, clock = Date.now, send = webpush.sendNotification } = {}) {
  const vapid = loadVapidKeys(db);
  const vapidDetails = {
    subject: process.env.VAPID_SUBJECT || 'https://github.com/LinkyJayy/koolkat',
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  };

  const q = {
    upsert: db.prepare(`
      INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
                                         auth = excluded.auth, created_at = excluded.created_at`),
    trim: db.prepare(`
      DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (
        SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`),
    remove: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?'),
    removeEndpoint: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    forUser: db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?'),
    dueStreaks: db.prepare(`
      SELECT f.*, lo.display_name AS low_name, hi.display_name AS high_name
      FROM friendships f
      JOIN users lo ON lo.id = f.user_low
      JOIN users hi ON hi.id = f.user_high
      WHERE f.status = 'accepted' AND f.streak_count > 0 AND f.streak_day = ?
        AND (f.streak_reminded_day IS NULL OR f.streak_reminded_day != ?)`),
    markReminded: db.prepare(
      'UPDATE friendships SET streak_reminded_day = ? WHERE user_low = ? AND user_high = ?'
    ),
  };

  function subscribe(userId, subscription) {
    q.upsert.run(subscription.endpoint, userId, subscription.p256dh, subscription.auth, clock());
    q.trim.run(userId, userId, MAX_SUBSCRIPTIONS_PER_USER);
  }

  function unsubscribe(userId, endpoint) {
    q.remove.run(String(endpoint), userId);
  }

  /**
   * Send a notification to every device of a user. Never throws: a failed push
   * must not break the request that triggered it.
   * Payloads only ever contain names and counts, never snap contents.
   */
  async function notify(userId, { title = 'KoolKat', body, tag, view }) {
    const payload = JSON.stringify({ title, body, tag, view });
    const subs = q.forUser.all(userId);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
            vapidDetails,
            TTL: 24 * 60 * 60,
            urgency: 'high',
          });
        } catch (err) {
          // 404/410: the browser unsubscribed or the subscription expired.
          if (err?.statusCode === 404 || err?.statusCode === 410) q.removeEndpoint.run(s.endpoint);
          else console.warn(`Push to user ${userId} failed:`, err?.statusCode ?? err?.message ?? err);
        }
      })
    );
  }

  /** Remind friends whose streak ends at midnight UTC if they haven't snapped yet today. */
  async function runStreakReminders(now = clock()) {
    const today = dayNumber(now);
    const hoursLeft = ((today + 1) * DAY_MS - now) / (60 * 60 * 1000);
    if (hoursLeft > STREAK_REMINDER_HOURS) return 0;
    const due = q.dueStreaks.all(today - 1, today);
    const left = Math.max(1, Math.ceil(hoursLeft));
    const jobs = [];
    for (const f of due) {
      q.markReminded.run(today, f.user_low, f.user_high);
      const sides = [
        [f.user_low, f.low_last_day, f.high_name],
        [f.user_high, f.high_last_day, f.low_name],
      ];
      for (const [userId, lastDay, friendName] of sides) {
        if (lastDay === today) continue; // this side already snapped today
        jobs.push(
          notify(userId, {
            title: `⌛ Your ${f.streak_count}🔥 streak is ending`,
            body: `Send ${friendName} a Klick in the next ${left} hour${left === 1 ? '' : 's'} to keep it going!`,
            tag: `streak-${f.user_low}-${f.user_high}`,
            view: 'camera',
          })
        );
      }
    }
    await Promise.all(jobs);
    return jobs.length;
  }

  return { publicKey: vapid.publicKey, subscribe, unsubscribe, notify, runStreakReminders };
}

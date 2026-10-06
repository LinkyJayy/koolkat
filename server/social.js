import crypto from 'node:crypto';
import { base64Field, fail, pair } from './http.js';
import { cleanText } from './plans.js';

// QR friending, Nearby friending, Activity Bubbles and chat themes.

/** How long a QR friend code works after it is created. */
export const FRIEND_CODE_TTL = 10 * 60 * 1000;
/** A code with less than this left is replaced when the QR screen asks again. */
const FRIEND_CODE_REFRESH = 4 * 60 * 1000;
const FRIEND_CODE_RE = /^[A-Za-z0-9_-]{22}$/;

/** People only show up on Nearby while they have it open (they check in every few seconds). */
export const NEARBY_TTL = 2 * 60 * 1000;
/** How close two people need to be (in metres) to see each other on Nearby. */
export const NEARBY_RADIUS = 150;
const NEARBY_MAX_ACCURACY = 1000;

export const MAX_ACTIVITY_LENGTH = 40;
const ACTIVITY_HOURS = [1, 4, 8, 24];

export const CHAT_BACKGROUNDS = ['default', 'midnight', 'sunset', 'ocean', 'forest', 'candy', 'color', 'image'];
const COLOR_RE = /^#[0-9a-f]{6}$/;
const MAX_CHAT_BACKGROUND_BYTES = 700 * 1024;
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** Distance in metres between two points (haversine). */
export function distanceMetres(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A user's Activity Bubble, or null when they have none (or no Unlimited). */
export function activityOf(u, now, hasUnlimitedUser) {
  if (!u.activity_text && !u.activity_emoji) return null;
  if (u.activity_until && u.activity_until <= now) return null;
  if (!hasUnlimitedUser(u)) return null;
  return { emoji: u.activity_emoji || '', text: u.activity_text || '', until: u.activity_until ?? null };
}

/** The saved chat theme, or null for the normal look. */
export function chatThemeOf(u) {
  if (!u.chat_theme) return null;
  try {
    return JSON.parse(u.chat_theme);
  } catch {
    return null;
  }
}

/** Keep one emoji (or short symbol sequence) for an activity. */
function cleanEmoji(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') fail(400, 'Emoji must be text');
  const graphemes = [...new Intl.Segmenter().segment(value.trim())].map((s) => s.segment);
  const first = graphemes[0] ?? '';
  if (first.length > 16 || /[\p{L}\p{N}<>]/u.test(first)) fail(400, 'Pick an emoji');
  return first;
}

function optionalColor(value, name) {
  if (value == null || value === '') return null;
  const color = String(value).toLowerCase();
  if (!COLOR_RE.test(color)) fail(400, `${name} must be a colour like #1e90ff`);
  return color;
}

export function registerSocialRoutes({
  api,
  db,
  clock,
  auth,
  wrap,
  publicUser,
  hasUnlimitedUser,
  pusher,
  rateLimiter,
}) {
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    codeFor: db.prepare(
      'SELECT * FROM friend_codes WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1'
    ),
    code: db.prepare('SELECT * FROM friend_codes WHERE token = ? AND expires_at > ?'),
    insertCode: db.prepare('INSERT INTO friend_codes (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    friendship: db.prepare('SELECT * FROM friendships WHERE user_low = ? AND user_high = ?'),
    insertAccepted: db.prepare(`
      INSERT INTO friendships (user_low, user_high, requester_id, status, created_at, accepted_at)
      VALUES (?, ?, ?, 'accepted', ?, ?)`),
    accept: db.prepare("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE user_low = ? AND user_high = ?"),
    setActivity: db.prepare(
      'UPDATE users SET activity_emoji = ?, activity_text = ?, activity_until = ? WHERE id = ?'
    ),
    setChatTheme: db.prepare('UPDATE users SET chat_theme = ? WHERE id = ?'),
    setChatBackground: db.prepare('UPDATE users SET chat_background = ? WHERE id = ?'),
    chatBackground: db.prepare('SELECT chat_background FROM users WHERE id = ?'),
  };

  const requireUnlimited = (req, what) => {
    const user = q.user.get(req.user.id);
    if (!hasUnlimitedUser(user)) fail(403, `${what} is part of KoolKat Unlimited`);
    return user;
  };

  const relationshipWith = (me, other) => {
    const [low, high] = pair(me, other);
    const f = q.friendship.get(low, high);
    if (f?.status === 'accepted') return 'friends';
    if (f) return f.requester_id === me ? 'outgoing' : 'incoming';
    return 'none';
  };

  // ---------- QR friend codes ----------
  // Your QR code holds a short-lived random code, so a screenshot of it stops
  // working after a few minutes.
  api.get(
    '/friend-code',
    auth,
    wrap((req) => {
      const now = clock();
      let code = q.codeFor.get(req.user.id, now);
      if (!code || code.expires_at - now < FRIEND_CODE_REFRESH) {
        const token = crypto.randomBytes(16).toString('base64url');
        q.insertCode.run(token, req.user.id, now, now + FRIEND_CODE_TTL);
        code = { token, expires_at: now + FRIEND_CODE_TTL };
      }
      return { code: code.token, expiresAt: code.expires_at };
    })
  );

  const scanLimiter = rateLimiter({ limit: 30, windowMs: 10 * 60 * 1000, clock });

  // Scanning someone's code makes you friends straight away: showing the code is their "yes".
  api.post(
    '/friends/qr',
    auth,
    wrap((req) => {
      if (!scanLimiter(req.user.id)) fail(429, 'Too many tries. Wait a few minutes and try again.');
      const token = String(req.body?.code ?? '').trim();
      if (!FRIEND_CODE_RE.test(token)) fail(400, "That isn't a KoolKat friend code");
      const now = clock();
      const code = q.code.get(token, now);
      if (!code) fail(404, 'That code has expired. Ask them to open their QR code again.');
      const me = req.user.id;
      if (code.user_id === me) fail(400, "That's your own code");
      const other = q.user.get(code.user_id);
      const [low, high] = pair(me, other.id);
      const existing = q.friendship.get(low, high);
      if (existing?.status === 'accepted') return { status: 'already', user: publicUser(other) };
      if (existing) q.accept.run(now, low, high);
      else q.insertAccepted.run(low, high, me, now, now);
      pusher.notify(other.id, {
        body: `You and ${req.user.displayName} (@${req.user.username}) are now friends 🎉`,
        tag: `accepted-${me}`,
        view: 'friends',
      });
      return { status: 'accepted', user: publicUser(other) };
    })
  );

  // ---------- Nearby ----------
  // Locations live only in memory, only while Nearby is open, and are never
  // sent to anyone: other people just see your name.
  const nearby = new Map(); // userId -> { lat, lng, accuracy, at }
  const prune = (now) => {
    for (const [id, spot] of nearby) if (now - spot.at > NEARBY_TTL) nearby.delete(id);
  };
  const nearbyLimiter = rateLimiter({ limit: 60, windowMs: 60 * 1000, clock });

  api.post(
    '/nearby',
    auth,
    wrap((req) => {
      if (!nearbyLimiter(req.user.id)) fail(429, 'Slow down a little');
      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      const accuracy = Number(req.body?.accuracy ?? 0);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        fail(400, 'Location is required');
      }
      if (!Number.isFinite(accuracy) || accuracy < 0) fail(400, 'Bad location accuracy');
      if (accuracy > NEARBY_MAX_ACCURACY) fail(422, "Your location isn't precise enough. Try going outside or turning on Wi-Fi.");
      const now = clock();
      prune(now);
      const me = req.user.id;
      const spot = { lat, lng, accuracy, at: now };
      nearby.set(me, spot);
      const people = [];
      for (const [id, other] of nearby) {
        if (id === me) continue;
        // Allow for how unsure both phones are about where they are (up to a point).
        const slack = Math.min(spot.accuracy + other.accuracy, 200);
        if (distanceMetres(spot, other) > NEARBY_RADIUS + slack) continue;
        const user = q.user.get(id);
        if (!user) continue;
        people.push({ ...publicUser(user), relationship: relationshipWith(me, id), lastSeen: other.at });
      }
      people.sort((a, b) => b.lastSeen - a.lastSeen);
      return { people: people.slice(0, 50) };
    })
  );

  api.delete(
    '/nearby',
    auth,
    wrap((req) => {
      nearby.delete(req.user.id);
      return { ok: true };
    })
  );

  // ---------- Activity Bubbles ----------
  api.post(
    '/me/activity',
    auth,
    wrap((req) => {
      const user = requireUnlimited(req, 'Activity Bubbles');
      const emoji = cleanEmoji(req.body?.emoji);
      const text = cleanText(req.body?.text, MAX_ACTIVITY_LENGTH);
      if (text == null) fail(400, 'Activity must be text');
      if (!text && !emoji) fail(400, 'Write what you are doing');
      const hours = req.body?.hours == null ? null : Number(req.body.hours);
      if (hours != null && !ACTIVITY_HOURS.includes(hours)) fail(400, 'Pick how long to show it for');
      const until = hours == null ? null : clock() + hours * 60 * 60 * 1000;
      q.setActivity.run(emoji || null, text || null, until, user.id);
      return { activity: { emoji, text, until } };
    })
  );

  api.delete(
    '/me/activity',
    auth,
    wrap((req) => {
      q.setActivity.run(null, null, null, req.user.id);
      return { activity: null };
    })
  );

  // ---------- chat themes ----------
  api.post(
    '/me/chat-theme',
    auth,
    wrap((req) => {
      const background = String(req.body?.background ?? 'default');
      if (!CHAT_BACKGROUNDS.includes(background)) fail(400, 'Unknown chat background');
      const bubble = optionalColor(req.body?.bubble, 'Bubble colour');
      if (background === 'default' && !bubble) {
        // Back to the normal look (keeps no picture around).
        q.setChatTheme.run(null, req.user.id);
        q.setChatBackground.run(null, req.user.id);
        return { chatTheme: null };
      }
      const user = requireUnlimited(req, 'Custom chat themes');
      const theme = { background, bubble };
      if (background === 'color') {
        theme.color = optionalColor(req.body?.color, 'Background colour');
        if (!theme.color) fail(400, 'Pick a background colour');
      }
      if (background === 'image') {
        if (req.body?.image) {
          const bytes = base64Field(req.body.image, 'image', { min: 100, max: MAX_CHAT_BACKGROUND_BYTES });
          if (!bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) fail(400, 'The picture must be a JPEG');
          q.setChatBackground.run(bytes, user.id);
          theme.imageVersion = clock();
        } else {
          const previous = chatThemeOf(user);
          if (!q.chatBackground.get(user.id).chat_background) fail(400, 'Pick a picture');
          theme.imageVersion = previous?.imageVersion ?? clock();
        }
      } else {
        q.setChatBackground.run(null, user.id);
      }
      q.setChatTheme.run(JSON.stringify(theme), user.id);
      return { chatTheme: theme };
    })
  );

  // Your chat background picture is only ever sent to you.
  api.get(
    '/me/chat-background',
    auth,
    wrap((req, res) => {
      const row = q.chatBackground.get(req.user.id);
      if (!row?.chat_background) fail(404, 'No chat background');
      res.set('Content-Type', 'image/jpeg');
      res.send(Buffer.from(row.chat_background));
    })
  );
}

/** Delete friend codes that no longer work. */
export function cleanupFriendCodes(db, now) {
  db.prepare('DELETE FROM friend_codes WHERE expires_at <= ?').run(now);
}

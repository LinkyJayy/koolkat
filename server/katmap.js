import { fail } from './http.js';

// Kat Map (KoolKat Unlimited): see where you and your friends are.
//
// Sharing is off until you turn it on, and you choose who sees you: all your
// friends, or only your BFFs. The app sends your location while it's open;
// friends see your last location with how long ago it was. Turning sharing
// off deletes your location from the server straight away.

export const MAP_MODES = ['off', 'friends', 'bffs'];
/** Locations older than this aren't shown. */
export const MAP_MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_ACCURACY = 5000;

export function registerKatMapRoutes({ api, db, clock, auth, wrap, publicUser, hasUnlimitedUser, rateLimiter, activityOf }) {
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    setMode: db.prepare('UPDATE users SET map_mode = ? WHERE id = ?'),
    clearLocation: db.prepare(
      'UPDATE users SET map_lat = NULL, map_lng = NULL, map_accuracy = NULL, map_at = NULL WHERE id = ?'
    ),
    setLocation: db.prepare('UPDATE users SET map_lat = ?, map_lng = ?, map_accuracy = ?, map_at = ? WHERE id = ?'),
    sharingFriends: db.prepare(`
      SELECT u.* FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
      WHERE (f.user_low = ? OR f.user_high = ?) AND f.status = 'accepted'
        AND u.map_mode IN ('friends', 'bffs') AND u.map_at > ?`),
    // Friends who made me their BFF.
    bffOf: db.prepare('SELECT user_id FROM bffs WHERE friend_id = ?'),
  };

  const requireUnlimited = (req) => {
    const user = q.user.get(req.user.id);
    if (!hasUnlimitedUser(user)) fail(403, 'Kat Map is part of KoolKat Unlimited');
    return user;
  };

  const location = (u) =>
    u.map_at == null ? null : { lat: u.map_lat, lng: u.map_lng, accuracy: u.map_accuracy, at: u.map_at };

  api.post(
    '/map/settings',
    auth,
    wrap((req) => {
      const mode = String(req.body?.mode ?? '');
      if (!MAP_MODES.includes(mode)) fail(400, 'Choose who can see you');
      if (mode === 'off') {
        q.setMode.run(null, req.user.id);
        q.clearLocation.run(req.user.id);
        return { mode: 'off' };
      }
      const user = requireUnlimited(req);
      q.setMode.run(mode, user.id);
      return { mode };
    })
  );

  const locationLimiter = rateLimiter({ limit: 30, windowMs: 60 * 1000, clock });

  api.post(
    '/map/location',
    auth,
    wrap((req) => {
      const user = requireUnlimited(req);
      if (!user.map_mode) fail(409, 'Turn on location sharing first');
      if (!locationLimiter(user.id)) fail(429, 'Slow down a little');
      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      const accuracy = Number(req.body?.accuracy ?? 0);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        fail(400, 'Location is required');
      }
      if (!Number.isFinite(accuracy) || accuracy < 0) fail(400, 'Bad location accuracy');
      q.setLocation.run(lat, lng, Math.min(Math.round(accuracy), MAX_ACCURACY), clock(), user.id);
      return { ok: true };
    })
  );

  api.get(
    '/map',
    auth,
    wrap((req) => {
      const user = requireUnlimited(req);
      const now = clock();
      const me = user.id;
      const bffOf = new Set(q.bffOf.all(me).map((r) => r.user_id));
      const friends = [];
      for (const f of q.sharingFriends.all(me, me, me, now - MAP_MAX_AGE)) {
        if (f.map_mode === 'bffs' && !bffOf.has(f.id)) continue;
        if (!hasUnlimitedUser(f)) continue;
        friends.push({ ...publicUser(f), location: location(f), activity: activityOf(f, now, hasUnlimitedUser) });
      }
      friends.sort((a, b) => b.location.at - a.location.at);
      return {
        mode: user.map_mode || 'off',
        location: user.map_mode && user.map_at > now - MAP_MAX_AGE ? location(user) : null,
        friends,
      };
    })
  );
}

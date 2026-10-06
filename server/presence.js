import crypto from 'node:crypto';
import { fail } from './http.js';

// KoolKat Rich Presence (KoolKat Unlimited): show friends what you're listening to.
//
//  - Spotify: connect your account (needs SPOTIFY_CLIENT_ID and
//    SPOTIFY_CLIENT_SECRET). The server checks what's playing every so often,
//    so it keeps working while KoolKat is closed.
//  - Last.fm: enter your Last.fm username (needs LASTFM_API_KEY). Works for
//    Apple Music and anything else that scrobbles to Last.fm.

/** A song only shows while the last check is this recent. */
export const PRESENCE_FRESH = 2 * 60 * 1000;

// How soon to check again. Checks are quick while music plays (and, on Spotify,
// right when the song ends), and slow down when nothing has played for a while
// so idle accounts don't use up Spotify's and Last.fm's request limits.
export const CHECK_PLAYING = 5 * 1000;
export const CHECK_LASTFM_PLAYING = 6 * 1000;
export const CHECK_RECENTLY_IDLE = 10 * 1000;
export const CHECK_IDLE = 30 * 1000;
const RECENTLY = 10 * 60 * 1000;
// At most this many requests per second to each service, however many people are connected.
const PER_SECOND = { spotify: 4, lastfm: 4 };
const STATE_TTL = 10 * 60 * 1000;
const LASTFM_USER_RE = /^[A-Za-z][A-Za-z0-9_-]{1,14}$/;
const ART_HOSTS = ['i.scdn.co', 'lastfm.freetls.fastly.net'];

export function presenceConfig(env = process.env) {
  return {
    spotifyId: env.SPOTIFY_CLIENT_ID?.trim() || null,
    spotifySecret: env.SPOTIFY_CLIENT_SECRET?.trim() || null,
    spotifyRedirect: env.SPOTIFY_REDIRECT_URI?.trim() || null,
    lastfmKey: env.LASTFM_API_KEY?.trim() || null,
  };
}

const httpsUrl = (value, hosts) => {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return null;
    if (hosts && !hosts.includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
};

const clip = (value, max = 120) => String(value ?? '').slice(0, max);

/** What a friend sees, or null when nothing is playing (or they don't have Unlimited). */
export function presenceOf(u, now, hasUnlimitedUser) {
  if (!u.presence_track || !u.presence_at || now - u.presence_at > PRESENCE_FRESH) return null;
  if (!hasUnlimitedUser(u)) return null;
  try {
    return JSON.parse(u.presence_track);
  } catch {
    return null;
  }
}

class RemoteError extends Error {
  constructor(message, { status, retryAfter, revoked } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.revoked = revoked;
  }
}

export function registerPresenceRoutes({
  api,
  db,
  clock,
  auth,
  wrap,
  hasUnlimitedUser,
  allowedOrigins,
  canonicalHost,
  env = process.env,
  fetchImpl = fetch,
}) {
  const config = presenceConfig(env);
  const spotifyAvailable = Boolean(config.spotifyId && config.spotifySecret);
  const lastfmAvailable = Boolean(config.lastfmKey);

  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    // presence_retry_at is when to check that account next.
    due: db.prepare(`
      SELECT * FROM users WHERE presence_source IS NOT NULL AND (presence_retry_at IS NULL OR presence_retry_at <= ?)
      ORDER BY COALESCE(presence_retry_at, 0) LIMIT 200`),
    friendsPresence: db.prepare(`
      SELECT u.id, u.username, u.plan_until, u.presence_track, u.presence_at FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
      WHERE (f.user_low = ? OR f.user_high = ?) AND f.status = 'accepted' AND u.presence_track IS NOT NULL`),
    setSpotify: db.prepare(`
      UPDATE users SET presence_source = 'spotify', lastfm_user = NULL, spotify_refresh = ?, spotify_access = ?,
             spotify_expires = ?, presence_track = NULL, presence_at = NULL, presence_retry_at = NULL
      WHERE id = ?`),
    setTokens: db.prepare('UPDATE users SET spotify_access = ?, spotify_expires = ?, spotify_refresh = ? WHERE id = ?'),
    setLastfm: db.prepare(`
      UPDATE users SET presence_source = 'lastfm', lastfm_user = ?, spotify_refresh = NULL, spotify_access = NULL,
             spotify_expires = NULL, presence_track = NULL, presence_at = NULL, presence_retry_at = NULL
      WHERE id = ?`),
    setTrack: db.prepare('UPDATE users SET presence_track = ?, presence_at = ?, presence_retry_at = ? WHERE id = ?'),
    setRetry: db.prepare('UPDATE users SET presence_retry_at = ? WHERE id = ?'),
    disconnect: db.prepare(`
      UPDATE users SET presence_source = NULL, lastfm_user = NULL, spotify_refresh = NULL, spotify_access = NULL,
             spotify_expires = NULL, presence_track = NULL, presence_at = NULL, presence_retry_at = NULL
      WHERE id = ?`),
  };

  const requireUnlimited = (req) => {
    const user = q.user.get(req.user.id);
    if (!hasUnlimitedUser(user)) fail(403, 'Rich Presence is part of KoolKat Unlimited');
    return user;
  };

  // ---------- Spotify ----------
  const redirectUri = (req) => {
    if (config.spotifyRedirect) return config.spotifyRedirect;
    const host = canonicalHost || req.get('host');
    return `${canonicalHost ? 'https' : req.protocol}://${host}/api/presence/spotify/callback`;
  };

  const spotifyToken = async (params) => {
    const res = await fetchImpl('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${config.spotifyId}:${config.spotifySecret}`).toString('base64')}`,
      },
      body: new URLSearchParams(params).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new RemoteError(`Spotify sign-in failed (${body.error || res.status})`, {
        status: res.status,
        revoked: body.error === 'invalid_grant',
      });
    }
    return body;
  };

  const spotifyAccess = async (user, { force = false } = {}) => {
    if (!force && user.spotify_access && user.spotify_expires > clock() + 60_000) return user.spotify_access;
    const tokens = await spotifyToken({ grant_type: 'refresh_token', refresh_token: user.spotify_refresh });
    const refresh = tokens.refresh_token || user.spotify_refresh;
    const expires = clock() + (Number(tokens.expires_in) || 3600) * 1000;
    q.setTokens.run(tokens.access_token, expires, refresh, user.id);
    Object.assign(user, { spotify_access: tokens.access_token, spotify_expires: expires, spotify_refresh: refresh });
    return tokens.access_token;
  };

  const pickArt = (images) => {
    if (!Array.isArray(images) || !images.length) return null;
    const sorted = [...images].sort((a, b) => Math.abs((a.width ?? 300) - 300) - Math.abs((b.width ?? 300) - 300));
    return httpsUrl(sorted[0].url, ART_HOSTS);
  };

  const spotifyNowPlaying = async (user, retried = false) => {
    const token = await spotifyAccess(user, { force: retried });
    const res = await fetchImpl('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && !retried) return spotifyNowPlaying(user, true);
    if (res.status === 204 || res.status === 202) return null;
    if (res.status === 429) {
      throw new RemoteError('Spotify rate limit', { status: 429, retryAfter: Number(res.headers.get('retry-after')) || 60 });
    }
    if (!res.ok) throw new RemoteError(`Spotify error ${res.status}`, { status: res.status });
    const body = await res.json().catch(() => null);
    const item = body?.item;
    if (!body?.is_playing || !item) return null;
    const episode = body.currently_playing_type === 'episode';
    const left = Number(item.duration_ms) - Number(body.progress_ms);
    return {
      // Not stored: used to check again right when the song ends.
      msLeft: Number.isFinite(left) && left > 0 ? left : null,
      source: 'spotify',
      title: clip(item.name),
      artist: clip(episode ? item.show?.name : (item.artists ?? []).map((a) => a.name).join(', ')),
      album: clip(episode ? '' : item.album?.name),
      art: pickArt(episode ? item.images : item.album?.images),
      url: httpsUrl(item.external_urls?.spotify, ['open.spotify.com']),
    };
  };

  // Logins in progress: state -> { userId, returnTo, expires }.
  const pending = new Map();

  api.post(
    '/presence/spotify/start',
    auth,
    wrap((req) => {
      if (!spotifyAvailable) fail(503, "Spotify isn't set up on this server yet");
      const user = requireUnlimited(req);
      const now = clock();
      for (const [key, value] of pending) if (value.expires <= now) pending.delete(key);
      // Where to come back to: this site, or a separately hosted frontend we allow.
      let returnTo = '/';
      try {
        const wanted = new URL(String(req.body?.returnTo ?? ''));
        const own = `${req.protocol}://${req.get('host')}`;
        const allowed =
          wanted.origin === own || allowedOrigins.includes(wanted.origin) || (canonicalHost && wanted.origin === `https://${canonicalHost}`);
        if (allowed) returnTo = wanted.origin + wanted.pathname;
      } catch {
        // Not a URL: come back to this site.
      }
      const state = crypto.randomBytes(18).toString('base64url');
      pending.set(state, { userId: user.id, returnTo, expires: now + STATE_TTL, redirect: redirectUri(req) });
      const url = new URL('https://accounts.spotify.com/authorize');
      url.search = new URLSearchParams({
        client_id: config.spotifyId,
        response_type: 'code',
        redirect_uri: redirectUri(req),
        scope: 'user-read-currently-playing',
        state,
      }).toString();
      return { url: url.href };
    })
  );

  // Spotify sends the browser back here after you approve (or cancel).
  api.get(
    '/presence/spotify/callback',
    wrap(async (req, res) => {
      const state = String(req.query.state ?? '');
      const login = pending.get(state);
      pending.delete(state);
      const back = (result) => res.redirect(303, `${login?.returnTo ?? '/'}#presence/${result}`);
      if (!login || login.expires <= clock()) return back('expired');
      if (req.query.error || !req.query.code) return back('cancelled');
      try {
        const tokens = await spotifyToken({
          grant_type: 'authorization_code',
          code: String(req.query.code),
          redirect_uri: login.redirect,
        });
        if (!tokens.refresh_token) return back('failed');
        q.setSpotify.run(tokens.refresh_token, tokens.access_token, clock() + (Number(tokens.expires_in) || 3600) * 1000, login.userId);
        await pollUser(q.user.get(login.userId)).catch(() => {});
        return back('spotify');
      } catch (err) {
        console.error('Spotify connect failed:', err.message);
        return back('failed');
      }
    })
  );

  // ---------- Last.fm ----------
  const lastfm = async (params) => {
    const url = new URL('https://ws.audioscrobbler.com/2.0/');
    url.search = new URLSearchParams({ ...params, api_key: config.lastfmKey, format: 'json' }).toString();
    const res = await fetchImpl(url.href, { headers: { 'user-agent': 'KoolKat/1.0' } });
    const body = await res.json().catch(() => ({}));
    if (body.error === 6) throw new RemoteError('No Last.fm user with that name', { status: 404 });
    if (body.error === 29) throw new RemoteError('Last.fm rate limit', { status: 429, retryAfter: 60 });
    if (!res.ok || body.error) throw new RemoteError(`Last.fm error ${body.error || res.status}`, { status: res.status });
    return body;
  };

  const lastfmNowPlaying = async (user) => {
    const body = await lastfm({ method: 'user.getrecenttracks', user: user.lastfm_user, limit: '1' });
    const tracks = [body.recenttracks?.track ?? []].flat();
    const track = tracks.find((t) => t?.['@attr']?.nowplaying === 'true');
    if (!track) return null;
    const art = [track.image ?? []].flat().find((i) => i.size === 'large') ?? [track.image ?? []].flat().at(-1);
    return {
      source: 'lastfm',
      title: clip(track.name),
      artist: clip(track.artist?.['#text'] ?? track.artist?.name),
      album: clip(track.album?.['#text']),
      art: httpsUrl(art?.['#text'], ART_HOSTS),
      url: httpsUrl(track.url, ['www.last.fm']),
    };
  };

  api.post(
    '/presence/lastfm',
    auth,
    wrap(async (req) => {
      if (!lastfmAvailable) fail(503, "Last.fm isn't set up on this server yet");
      const user = requireUnlimited(req);
      const name = String(req.body?.username ?? '').trim();
      if (!LASTFM_USER_RE.test(name)) fail(400, "That isn't a Last.fm username");
      try {
        const info = await lastfm({ method: 'user.getinfo', user: name });
        q.setLastfm.run(clip(info.user?.name || name, 15), user.id);
      } catch (err) {
        fail(err.status === 404 ? 404 : 502, err.status === 404 ? err.message : "Couldn't reach Last.fm. Try again in a minute.");
      }
      await pollUser(q.user.get(user.id)).catch(() => {});
      return describe(q.user.get(user.id));
    })
  );

  // ---------- shared ----------
  // When each account last had something playing (to decide how often to check).
  const lastPlaying = new Map();

  function nextCheck(user, track, now) {
    if (track) {
      lastPlaying.set(user.id, now);
      if (user.presence_source === 'lastfm') return now + CHECK_LASTFM_PLAYING;
      // Check again just after the song ends, if that's sooner.
      const end = track.msLeft != null ? track.msLeft + 1000 : CHECK_PLAYING;
      return now + Math.max(1000, Math.min(CHECK_PLAYING, end));
    }
    const recent = now - (lastPlaying.get(user.id) ?? 0) < RECENTLY;
    return now + (recent ? CHECK_RECENTLY_IDLE : CHECK_IDLE);
  }

  async function pollUser(user) {
    if (!user?.presence_source) return;
    try {
      const found = user.presence_source === 'spotify' ? await spotifyNowPlaying(user) : await lastfmNowPlaying(user);
      const now = clock();
      let track = null;
      if (found) {
        const { msLeft, ...rest } = found;
        track = rest;
      }
      q.setTrack.run(track ? JSON.stringify(track) : null, now, nextCheck(user, found, now), user.id);
    } catch (err) {
      if (err.revoked) {
        // They removed KoolKat from their Spotify account.
        q.disconnect.run(user.id);
        return;
      }
      q.setRetry.run(clock() + (err.retryAfter ?? 60) * 1000, user.id);
      throw err;
    }
  }

  const describe = (u) => ({
    spotifyAvailable,
    lastfmAvailable,
    source: u.presence_source ?? null,
    lastfmUser: u.lastfm_user ?? null,
    nowPlaying: presenceOf(u, clock(), () => true),
  });

  api.get(
    '/presence',
    auth,
    wrap((req) => describe(q.user.get(req.user.id)))
  );

  const refreshed = new Map();
  api.post(
    '/presence/refresh',
    auth,
    wrap(async (req) => {
      const user = requireUnlimited(req);
      const now = clock();
      if (user.presence_source && (refreshed.get(user.id) ?? 0) < now - 5000) {
        refreshed.set(user.id, now);
        await pollUser(user).catch(() => {});
      }
      return describe(q.user.get(user.id));
    })
  );

  // Just your friends' songs: cheap enough for the app to ask every few seconds.
  api.get(
    '/presence/friends',
    auth,
    wrap((req) => {
      const me = req.user.id;
      const now = clock();
      const playing = {};
      for (const f of q.friendsPresence.all(me, me, me)) {
        const np = presenceOf(f, now, hasUnlimitedUser);
        if (np) playing[f.id] = np;
      }
      return { playing };
    })
  );

  api.delete(
    '/presence',
    auth,
    wrap((req) => {
      q.disconnect.run(req.user.id);
      return describe(q.user.get(req.user.id));
    })
  );

  let polling = false;
  /** Check every account that's due. Run by the server every second. */
  async function pollAll() {
    if (polling) return;
    polling = true;
    try {
      const budget = { ...PER_SECOND };
      const batch = [];
      for (const user of q.due.all(clock())) {
        if (!hasUnlimitedUser(user) || !(budget[user.presence_source] > 0)) continue;
        budget[user.presence_source] -= 1;
        batch.push(
          pollUser(user).catch((err) => console.error(`Rich Presence (${user.presence_source}):`, err.message))
        );
      }
      await Promise.all(batch);
    } finally {
      polling = false;
    }
  }

  return { pollAll };
}

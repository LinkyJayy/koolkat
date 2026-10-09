import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fail } from './http.js';
import { cleanText } from './plans.js';
import { sniffMedia } from './news.js';

// KoolKat Music: like Spotify. Artists with KoolKat Unlimited post songs with
// an album cover and, if they like, a music video. Everyone signed in can
// listen, heart and comment. Songs are public to everyone on KoolKat.

export const MAX_SONG_TITLE = 80;
export const MAX_ALBUM = 80;
export const MAX_SONG_COMMENT = 500;
export const MAX_SONG_AUDIO = 50 * 1024 * 1024;
export const MAX_SONG_VIDEO = 200 * 1024 * 1024;
export const MAX_SONG_COVER = 5 * 1024 * 1024;
const SONGS_PER_DAY = 20;
const PAGE = 50;
const UPLOAD_TTL = 24 * 60 * 60 * 1000;
/** Listening again within this long doesn't count as another play. */
const REPLAY_GAP = 10 * 60 * 1000;
const FILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const LIMITS = { audio: MAX_SONG_AUDIO, video: MAX_SONG_VIDEO, cover: MAX_SONG_COVER };

/** What kind of audio file this really is, from its first bytes (null if it isn't one). */
export function sniffAudio(bytes) {
  if (bytes.length < 12) return null;
  const ascii = (start, end) => bytes.toString('latin1', start, end);
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0)) {
    // MP3 (with or without an ID3 tag); 0xFFF1/0xFFF9 is AAC (ADTS).
    if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'audio/aac';
    return 'audio/mpeg';
  }
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (/^(heic|heix|heim|heis|mif1|msf1|avif)/.test(brand)) return null;
    return 'audio/mp4'; // .m4a (and audio-only .mp4)
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm';
  return null;
}

const ARTIST_COLUMNS =
  'u.username, u.display_name, u.plan_until, u.flair, u.badge_id, u.avatar_id, u.birth_month, u.birth_day, u.birth_tz, u.verified_at, u.accent_color, u.bolt_unlimited, u.bolt_badge, u.bolt_trial_until';

export function registerMusicRoutes({ api, db, clock, auth, wrap, publicUser, hasUnlimitedUser, isAdminUser, pusher, mediaDir, rateLimiter }) {
  const dir = path.join(mediaDir, 'music');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = (id) => path.join(dir, id);
  const removeFile = (id) => id && fs.rm(filePath(id), { force: true }, () => {});

  const SELECT = `
    SELECT s.*, ${ARTIST_COLUMNS},
      (SELECT COUNT(*) FROM song_likes l WHERE l.song_id = s.id) AS like_count,
      (SELECT COUNT(*) FROM song_comments c WHERE c.song_id = s.id) AS comment_count,
      (SELECT COUNT(*) FROM song_plays p WHERE p.song_id = s.id) AS play_count,
      EXISTS (SELECT 1 FROM song_likes l WHERE l.song_id = s.id AND l.user_id = ?) AS liked
    FROM songs s JOIN users u ON u.id = s.artist_id`;
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    song: db.prepare(`${SELECT} WHERE s.id = ?`),
    newest: db.prepare(`${SELECT} WHERE s.id < ? ORDER BY s.id DESC LIMIT ?`),
    byArtist: db.prepare(`${SELECT} WHERE s.artist_id = ? AND s.id < ? ORDER BY s.id DESC LIMIT ?`),
    search: db.prepare(`${SELECT}
      WHERE s.title LIKE ? ESCAPE '\\' OR s.album LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\'
      ORDER BY s.id DESC LIMIT ?`),
    top: db.prepare(`${SELECT} ORDER BY play_count DESC, like_count DESC, s.id DESC LIMIT ?`),
    liked: db.prepare(`${SELECT} JOIN song_likes ml ON ml.song_id = s.id AND ml.user_id = ? ORDER BY ml.created_at DESC LIMIT ?`),
    file: db.prepare(`
      SELECT audio_type AS mime FROM songs WHERE audio_id = ?
      UNION ALL SELECT video_type FROM songs WHERE video_id = ?
      UNION ALL SELECT cover_type FROM songs WHERE cover_id = ?`),
    upload: db.prepare('SELECT * FROM music_uploads WHERE id = ?'),
    insertUpload: db.prepare('INSERT INTO music_uploads (id, kind, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    removeUpload: db.prepare('DELETE FROM music_uploads WHERE id = ?'),
    oldUploads: db.prepare('SELECT id FROM music_uploads WHERE created_at <= ?'),
    postedToday: db.prepare('SELECT COUNT(*) AS n FROM songs WHERE artist_id = ? AND created_at > ?'),
    insert: db.prepare(`
      INSERT INTO songs (artist_id, title, album, audio_id, audio_type, audio_size, video_id, video_type, cover_id, cover_type, duration, explicit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    remove: db.prepare('DELETE FROM songs WHERE id = ?'),
    like: db.prepare('INSERT OR IGNORE INTO song_likes (song_id, user_id, created_at) VALUES (?, ?, ?)'),
    unlike: db.prepare('DELETE FROM song_likes WHERE song_id = ? AND user_id = ?'),
    likeCount: db.prepare('SELECT COUNT(*) AS n FROM song_likes WHERE song_id = ?'),
    recentPlay: db.prepare('SELECT 1 FROM song_plays WHERE song_id = ? AND user_id = ? AND created_at > ? LIMIT 1'),
    play: db.prepare('INSERT INTO song_plays (song_id, user_id, created_at) VALUES (?, ?, ?)'),
    playCount: db.prepare('SELECT COUNT(*) AS n FROM song_plays WHERE song_id = ?'),
    comments: db.prepare(`
      SELECT c.*, ${ARTIST_COLUMNS} FROM song_comments c JOIN users u ON u.id = c.user_id
      WHERE c.song_id = ? ORDER BY c.created_at, c.id`),
    comment: db.prepare('SELECT c.*, s.artist_id AS song_artist FROM song_comments c JOIN songs s ON s.id = c.song_id WHERE c.id = ?'),
    insertComment: db.prepare('INSERT INTO song_comments (song_id, user_id, body, created_at) VALUES (?, ?, ?, ?)'),
    removeComment: db.prepare('DELETE FROM song_comments WHERE id = ?'),
    stats: db.prepare('SELECT COUNT(*) AS n FROM songs WHERE artist_id = ?'),
  };

  const userOf = (req) => q.user.get(req.user.id);
  const requireUnlimited = (req) => {
    const user = userOf(req);
    if (!hasUnlimitedUser(user)) fail(403, 'Posting songs on KoolKat Music is part of KoolKat Unlimited');
    return user;
  };

  const media = (id) => (id ? `music/media/${id}` : null);
  const describe = (s, viewer) => ({
    id: s.id,
    title: s.title,
    album: s.album || null,
    // The artist marked it explicit (shown with an E).
    explicit: Boolean(s.explicit),
    audio: { url: media(s.audio_id), type: s.audio_type },
    video: s.video_id ? { url: media(s.video_id), type: s.video_type } : null,
    cover: media(s.cover_id),
    duration: s.duration ?? null,
    createdAt: s.created_at,
    artist: publicUser({ ...s, id: s.artist_id }),
    likes: s.like_count,
    liked: Boolean(s.liked),
    comments: s.comment_count,
    plays: s.play_count,
    mine: s.artist_id === viewer.id,
    canDelete: s.artist_id === viewer.id || isAdminUser(viewer),
  });

  const songOr404 = (req) => {
    const id = Number(req.params.id);
    const song = Number.isInteger(id) ? q.song.get(req.user.id, id) : null;
    if (!song) fail(404, 'That song was deleted');
    return song;
  };

  // Newest first; ?user=ID for an artist's songs; ?q= to search; ?before=ID for more.
  api.get(
    '/music',
    auth,
    wrap((req) => {
      const before = Number(req.query.before) > 0 ? Number(req.query.before) : Number.MAX_SAFE_INTEGER;
      const limit = Math.min(Math.max(Number(req.query.limit) || PAGE, 1), 100);
      const userId = Number(req.query.user);
      const text = String(req.query.q ?? '').trim().slice(0, 60);
      let rows;
      if (text) {
        const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        rows = q.search.all(req.user.id, like, like, like, like, limit);
      } else if (Number.isInteger(userId) && userId > 0) rows = q.byArtist.all(req.user.id, userId, before, limit);
      else rows = q.newest.all(req.user.id, before, limit);
      return { songs: rows.map((s) => describe(s, req.user)), more: !text && rows.length === limit, canPost: hasUnlimitedUser(userOf(req)) };
    })
  );

  // The front page: most played, and the songs you've hearted (Liked Songs).
  api.get(
    '/music/home',
    auth,
    wrap((req) => ({
      top: q.top.all(req.user.id, 10).map((s) => describe(s, req.user)),
      liked: q.liked.all(req.user.id, req.user.id, 100).map((s) => describe(s, req.user)),
      canPost: hasUnlimitedUser(userOf(req)),
    }))
  );

  // Step 1: upload each file on its own: ?kind=audio (the song), video (music video) or cover.
  api.post(
    '/music/upload',
    auth,
    express.raw({ type: () => true, limit: MAX_SONG_VIDEO }),
    wrap(async (req, res) => {
      const user = requireUnlimited(req);
      const kind = String(req.query.kind ?? '');
      if (!LIMITS[kind]) fail(400, 'Upload a song, a music video or an album cover');
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let mime = null;
      if (kind === 'audio') mime = sniffAudio(bytes);
      else {
        const found = sniffMedia(bytes);
        if (found?.kind === (kind === 'video' ? 'video' : 'image') && found.mime !== 'image/gif') mime = found.mime;
      }
      if (!mime) {
        fail(415, {
          audio: "That isn't a song KoolKat can play (MP3, M4A, WAV, OGG, FLAC or AAC)",
          video: "That isn't a video KoolKat can play (MP4, MOV or WebM)",
          cover: 'Album covers can be JPEG, PNG or WebP pictures',
        }[kind]);
      }
      if (bytes.length > LIMITS[kind]) fail(413, `That file is too big (up to ${Math.round(LIMITS[kind] / 1024 / 1024)} MB)`);
      const id = crypto.randomBytes(16).toString('base64url');
      await fs.promises.writeFile(filePath(id), bytes);
      q.insertUpload.run(id, kind, mime, bytes.length, user.id, clock());
      res.status(201);
      return { uploadId: id, kind };
    })
  );

  const postLimiter = rateLimiter({ limit: 5, windowMs: 60 * 1000, clock });

  // Step 2: post the song with its title (and album name).
  api.post(
    '/music',
    auth,
    wrap((req, res) => {
      const user = requireUnlimited(req);
      if (!postLimiter(user.id)) fail(429, 'Slow down a little');
      if (q.postedToday.get(user.id, clock() - 24 * 60 * 60 * 1000).n >= SONGS_PER_DAY) {
        fail(429, `You can post up to ${SONGS_PER_DAY} songs a day`);
      }
      const mine = (id, kind) => {
        if (!id) return null;
        const up = q.upload.get(String(id));
        if (!up || up.created_by !== user.id || up.kind !== kind) fail(400, 'That file has expired. Choose it again.');
        return up;
      };
      const title = cleanText(req.body?.title, MAX_SONG_TITLE);
      if (!title) fail(400, 'Give your song a title');
      const album = cleanText(req.body?.album ?? '', MAX_ALBUM) || null;
      const audio = mine(req.body?.audioId, 'audio');
      if (!audio) fail(400, 'Choose the song first');
      const video = mine(req.body?.videoId, 'video');
      const cover = mine(req.body?.coverId, 'cover');
      const duration = Number(req.body?.duration);
      const id = Number(
        q.insert.run(
          user.id, title, album, audio.id, audio.mime, audio.size,
          video?.id ?? null, video?.mime ?? null, cover?.id ?? null, cover?.mime ?? null,
          Number.isFinite(duration) && duration > 0 && duration < 24 * 60 * 60 ? duration : null,
          req.body?.explicit === true ? 1 : 0,
          clock()
        ).lastInsertRowid
      );
      for (const up of [audio, video, cover]) if (up) q.removeUpload.run(up.id);
      res.status(201);
      return { song: describe(q.song.get(user.id, id), req.user) };
    })
  );

  api.get('/music/media/:id', (req, res, next) => {
    const id = String(req.params.id);
    if (!FILE_ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const type = q.file.get(id, id, id)?.mime;
    if (!type) return res.status(404).json({ error: 'Not found' });
    res.set({ 'Cache-Control': 'private, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.sendFile(filePath(id), { headers: { 'Content-Type': type }, cacheControl: false, lastModified: false }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  api.get(
    '/music/:id',
    auth,
    wrap((req) => ({ song: describe(songOr404(req), req.user) }))
  );

  api.delete(
    '/music/:id',
    auth,
    wrap((req) => {
      const song = songOr404(req);
      if (song.artist_id !== req.user.id && !isAdminUser(req.user)) fail(403, 'You can only delete your own songs');
      q.remove.run(song.id);
      for (const id of [song.audio_id, song.video_id, song.cover_id]) removeFile(id);
      return { ok: true };
    })
  );

  api.post(
    '/music/:id/like',
    auth,
    wrap((req) => {
      const song = songOr404(req);
      q.like.run(song.id, req.user.id, clock());
      return { liked: true, likes: q.likeCount.get(song.id).n };
    })
  );

  api.delete(
    '/music/:id/like',
    auth,
    wrap((req) => {
      const song = songOr404(req);
      q.unlike.run(song.id, req.user.id);
      return { liked: false, likes: q.likeCount.get(song.id).n };
    })
  );

  // A play, counted after listening for a while (not again for 10 minutes).
  api.post(
    '/music/:id/play',
    auth,
    wrap((req) => {
      const song = songOr404(req);
      const now = clock();
      if (!q.recentPlay.get(song.id, req.user.id, now - REPLAY_GAP)) q.play.run(song.id, req.user.id, now);
      return { plays: q.playCount.get(song.id).n };
    })
  );

  // ---------- comments (anyone) ----------
  const describeComment = (c, viewer, artistId) => ({
    id: c.id,
    body: c.body,
    createdAt: c.created_at,
    author: publicUser({ ...c, id: c.user_id }),
    mine: c.user_id === viewer.id,
    canDelete: c.user_id === viewer.id || artistId === viewer.id || isAdminUser(viewer),
  });

  api.get(
    '/music/:id/comments',
    auth,
    wrap((req) => {
      const song = songOr404(req);
      return { comments: q.comments.all(song.id).map((c) => describeComment(c, req.user, song.artist_id)) };
    })
  );

  const commentLimiter = rateLimiter({ limit: 10, windowMs: 60 * 1000, clock });

  api.post(
    '/music/:id/comments',
    auth,
    wrap((req, res) => {
      const song = songOr404(req);
      const user = userOf(req);
      if (!commentLimiter(user.id)) fail(429, "You're commenting a lot. Wait a minute and try again.");
      const body = cleanText(req.body?.body, MAX_SONG_COMMENT, { multiline: true });
      if (!body) fail(400, 'Write a comment first');
      const id = Number(q.insertComment.run(song.id, user.id, body, clock()).lastInsertRowid);
      if (song.artist_id !== user.id) {
        pusher.notify(song.artist_id, {
          body: `💬 ${user.display_name} commented on “${song.title}”: ${[...body].slice(0, 60).join('')}`,
          tag: `song-comment-${song.id}`,
          view: 'music',
          kind: 'song-comment',
        });
      }
      const row = q.comments.all(song.id).find((c) => c.id === id);
      res.status(201);
      return { comment: describeComment(row, req.user, song.artist_id) };
    })
  );

  api.delete(
    '/music/comments/:commentId',
    auth,
    wrap((req) => {
      const c = q.comment.get(Number(req.params.commentId));
      if (!c) fail(404, 'Comment not found');
      if (c.user_id !== req.user.id && c.song_artist !== req.user.id && !isAdminUser(req.user)) {
        fail(403, 'You can only delete your own comments');
      }
      q.removeComment.run(c.id);
      return { ok: true };
    })
  );

  function cleanupUploads(now = clock()) {
    for (const { id } of q.oldUploads.all(now - UPLOAD_TTL)) {
      q.removeUpload.run(id);
      removeFile(id);
    }
  }

  return { cleanupUploads, songCount: (userId) => q.stats.get(userId).n };
}

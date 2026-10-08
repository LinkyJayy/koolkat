import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fail } from './http.js';
import { cleanText } from './plans.js';
import { sniffMedia } from './news.js';

// KoolKat Reels: short videos, like TikTok. Everyone signed in can watch;
// posting, hearts and comments are part of KoolKat Unlimited. Reels are public
// to everyone on KoolKat (they are not end-to-end encrypted like Klicks).

export const MAX_REEL_CAPTION = 300;
export const MAX_REEL_COMMENT = 500;
export const MAX_REEL_VIDEO = 100 * 1024 * 1024;
export const MAX_REEL_POSTER = 2 * 1024 * 1024;
const REELS_PER_DAY = 20;
const PAGE = 20;
const UPLOAD_TTL = 24 * 60 * 60 * 1000;
const FILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

const AUTHOR_COLUMNS =
  'u.username, u.display_name, u.plan_until, u.flair, u.badge_id, u.avatar_id, u.birth_month, u.birth_day, u.birth_tz, u.verified_at';

export function registerReelRoutes({ api, db, clock, auth, wrap, publicUser, hasUnlimitedUser, isAdminUser, pusher, mediaDir, rateLimiter }) {
  const dir = path.join(mediaDir, 'reels');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = (id) => path.join(dir, id);
  const removeFile = (id) => id && fs.rm(filePath(id), { force: true }, () => {});

  const SELECT = `
    SELECT r.*, ${AUTHOR_COLUMNS},
      (SELECT COUNT(*) FROM reel_likes l WHERE l.reel_id = r.id) AS like_count,
      (SELECT COUNT(*) FROM reel_comments c WHERE c.reel_id = r.id) AS comment_count,
      (SELECT COUNT(*) FROM reel_views v WHERE v.reel_id = r.id) AS view_count,
      EXISTS (SELECT 1 FROM reel_likes l WHERE l.reel_id = r.id AND l.user_id = ?) AS liked
    FROM reels r JOIN users u ON u.id = r.author_id`;
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    reel: db.prepare(`${SELECT} WHERE r.id = ?`),
    feed: db.prepare(`${SELECT} WHERE r.id < ? ORDER BY r.id DESC LIMIT ?`),
    byAuthor: db.prepare(`${SELECT} WHERE r.author_id = ? AND r.id < ? ORDER BY r.id DESC LIMIT ?`),
    file: db.prepare('SELECT video_type AS mime FROM reels WHERE video_id = ? UNION ALL SELECT poster_type FROM reels WHERE poster_id = ?'),
    upload: db.prepare('SELECT * FROM reel_uploads WHERE id = ?'),
    insertUpload: db.prepare('INSERT INTO reel_uploads (id, kind, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    removeUpload: db.prepare('DELETE FROM reel_uploads WHERE id = ?'),
    oldUploads: db.prepare('SELECT id FROM reel_uploads WHERE created_at <= ?'),
    postedToday: db.prepare('SELECT COUNT(*) AS n FROM reels WHERE author_id = ? AND created_at > ?'),
    insert: db.prepare(
      'INSERT INTO reels (author_id, caption, video_id, video_type, video_size, poster_id, poster_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    remove: db.prepare('DELETE FROM reels WHERE id = ?'),
    like: db.prepare('INSERT OR IGNORE INTO reel_likes (reel_id, user_id, created_at) VALUES (?, ?, ?)'),
    unlike: db.prepare('DELETE FROM reel_likes WHERE reel_id = ? AND user_id = ?'),
    likeCount: db.prepare('SELECT COUNT(*) AS n FROM reel_likes WHERE reel_id = ?'),
    view: db.prepare('INSERT OR IGNORE INTO reel_views (reel_id, user_id, created_at) VALUES (?, ?, ?)'),
    viewCount: db.prepare('SELECT COUNT(*) AS n FROM reel_views WHERE reel_id = ?'),
    comments: db.prepare(`
      SELECT c.*, ${AUTHOR_COLUMNS} FROM reel_comments c JOIN users u ON u.id = c.user_id
      WHERE c.reel_id = ? ORDER BY c.created_at, c.id`),
    comment: db.prepare('SELECT c.*, r.author_id AS reel_author FROM reel_comments c JOIN reels r ON r.id = c.reel_id WHERE c.id = ?'),
    insertComment: db.prepare('INSERT INTO reel_comments (reel_id, user_id, body, created_at) VALUES (?, ?, ?, ?)'),
    removeComment: db.prepare('DELETE FROM reel_comments WHERE id = ?'),
    stats: db.prepare(`
      SELECT (SELECT COUNT(*) FROM reels WHERE author_id = ?) AS reels,
             (SELECT COUNT(*) FROM reel_likes l JOIN reels r ON r.id = l.reel_id WHERE r.author_id = ?) AS likes`),
  };

  const userOf = (req) => q.user.get(req.user.id);
  const requireUnlimited = (req, what) => {
    const user = userOf(req);
    if (!hasUnlimitedUser(user)) fail(403, `${what} is part of KoolKat Unlimited`);
    return user;
  };

  const describe = (r, viewer) => ({
    id: r.id,
    caption: r.caption,
    video: { url: `reels/media/${r.video_id}`, type: r.video_type },
    poster: r.poster_id ? `reels/media/${r.poster_id}` : null,
    createdAt: r.created_at,
    author: publicUser({ ...r, id: r.author_id }),
    likes: r.like_count,
    liked: Boolean(r.liked),
    comments: r.comment_count,
    views: r.view_count,
    mine: r.author_id === viewer.id,
    canDelete: r.author_id === viewer.id || isAdminUser(viewer),
  });

  const reelOr404 = (req) => {
    const id = Number(req.params.id);
    const reel = Number.isInteger(id) ? q.reel.get(req.user.id, id) : null;
    if (!reel) fail(404, 'That Reel was deleted');
    return reel;
  };

  // Newest first. ?user=ID for someone's Reels; ?before=ID for the next page.
  api.get(
    '/reels',
    auth,
    wrap((req) => {
      const before = Number(req.query.before) > 0 ? Number(req.query.before) : Number.MAX_SAFE_INTEGER;
      const limit = Math.min(Math.max(Number(req.query.limit) || PAGE, 1), 50);
      const userId = Number(req.query.user);
      const rows = Number.isInteger(userId) && userId > 0
        ? q.byAuthor.all(req.user.id, userId, before, limit)
        : q.feed.all(req.user.id, before, limit);
      return {
        reels: rows.map((r) => describe(r, req.user)),
        more: rows.length === limit,
        canPost: hasUnlimitedUser(userOf(req)),
      };
    })
  );

  // Step 1: upload the video and its thumbnail (raw bytes), each on its own.
  api.post(
    '/reels/upload',
    auth,
    express.raw({ type: () => true, limit: MAX_REEL_VIDEO }),
    wrap(async (req, res) => {
      const user = requireUnlimited(req, 'Posting Reels');
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const found = sniffMedia(bytes);
      if (!found || found.mime === 'image/gif') fail(415, "That isn't a video KoolKat can play (MP4, MOV or WebM)");
      if (found.kind === 'image' && bytes.length > MAX_REEL_POSTER) fail(413, 'That thumbnail is too big');
      const id = crypto.randomBytes(16).toString('base64url');
      await fs.promises.writeFile(filePath(id), bytes);
      q.insertUpload.run(id, found.kind, found.mime, bytes.length, user.id, clock());
      res.status(201);
      return { uploadId: id, kind: found.kind };
    })
  );

  const postLimiter = rateLimiter({ limit: 5, windowMs: 60 * 1000, clock });

  // Step 2: post it with a caption.
  api.post(
    '/reels',
    auth,
    wrap((req, res) => {
      const user = requireUnlimited(req, 'Posting Reels');
      if (!postLimiter(user.id)) fail(429, 'Slow down a little');
      if (q.postedToday.get(user.id, clock() - 24 * 60 * 60 * 1000).n >= REELS_PER_DAY) {
        fail(429, `You can post up to ${REELS_PER_DAY} Reels a day`);
      }
      const mine = (id, kind) => {
        if (!id) return null;
        const up = q.upload.get(String(id));
        if (!up || up.created_by !== user.id || up.kind !== kind) fail(400, 'That video has expired. Choose it again.');
        return up;
      };
      const video = mine(req.body?.videoId, 'video');
      if (!video) fail(400, 'Choose a video first');
      const poster = mine(req.body?.posterId, 'image');
      const caption = cleanText(req.body?.caption ?? '', MAX_REEL_CAPTION, { multiline: true }) ?? '';
      const id = Number(
        q.insert.run(user.id, caption, video.id, video.mime, video.size, poster?.id ?? null, poster?.mime ?? null, clock()).lastInsertRowid
      );
      q.removeUpload.run(video.id);
      if (poster) q.removeUpload.run(poster.id);
      res.status(201);
      return { reel: describe(q.reel.get(user.id, id), req.user) };
    })
  );

  // Videos and thumbnails. The links are unguessable, like News media.
  api.get('/reels/media/:id', (req, res, next) => {
    const id = String(req.params.id);
    if (!FILE_ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const type = q.file.get(id, id)?.mime;
    if (!type) return res.status(404).json({ error: 'Not found' });
    res.set({ 'Cache-Control': 'private, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.sendFile(filePath(id), { headers: { 'Content-Type': type }, cacheControl: false, lastModified: false }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  api.get(
    '/reels/:id',
    auth,
    wrap((req) => ({ reel: describe(reelOr404(req), req.user) }))
  );

  api.delete(
    '/reels/:id',
    auth,
    wrap((req) => {
      const reel = reelOr404(req);
      if (reel.author_id !== req.user.id && !isAdminUser(req.user)) fail(403, 'You can only delete your own Reels');
      q.remove.run(reel.id);
      removeFile(reel.video_id);
      removeFile(reel.poster_id);
      return { ok: true };
    })
  );

  api.post(
    '/reels/:id/like',
    auth,
    wrap((req) => {
      const reel = reelOr404(req);
      const user = requireUnlimited(req, 'Liking Reels');
      q.like.run(reel.id, user.id, clock());
      return { liked: true, likes: q.likeCount.get(reel.id).n };
    })
  );

  api.delete(
    '/reels/:id/like',
    auth,
    wrap((req) => {
      const reel = reelOr404(req);
      q.unlike.run(reel.id, req.user.id);
      return { liked: false, likes: q.likeCount.get(reel.id).n };
    })
  );

  // Counted once per person.
  api.post(
    '/reels/:id/view',
    auth,
    wrap((req) => {
      const reel = reelOr404(req);
      q.view.run(reel.id, req.user.id, clock());
      return { views: q.viewCount.get(reel.id).n };
    })
  );

  // ---------- comments ----------
  const describeComment = (c, viewer, reelAuthor) => ({
    id: c.id,
    body: c.body,
    createdAt: c.created_at,
    author: publicUser({ ...c, id: c.user_id }),
    mine: c.user_id === viewer.id,
    canDelete: c.user_id === viewer.id || reelAuthor === viewer.id || isAdminUser(viewer),
  });

  api.get(
    '/reels/:id/comments',
    auth,
    wrap((req) => {
      const reel = reelOr404(req);
      return {
        comments: q.comments.all(reel.id).map((c) => describeComment(c, req.user, reel.author_id)),
        canComment: hasUnlimitedUser(userOf(req)),
      };
    })
  );

  const commentLimiter = rateLimiter({ limit: 10, windowMs: 60 * 1000, clock });

  api.post(
    '/reels/:id/comments',
    auth,
    wrap((req, res) => {
      const reel = reelOr404(req);
      const user = requireUnlimited(req, 'Commenting on Reels');
      if (!commentLimiter(user.id)) fail(429, "You're commenting a lot. Wait a minute and try again.");
      const body = cleanText(req.body?.body, MAX_REEL_COMMENT, { multiline: true });
      if (!body) fail(400, 'Write a comment first');
      const id = Number(q.insertComment.run(reel.id, user.id, body, clock()).lastInsertRowid);
      if (reel.author_id !== user.id) {
        pusher.notify(reel.author_id, {
          body: `💬 ${user.display_name} commented on your Reel: ${[...body].slice(0, 60).join('')}`,
          tag: `reel-comment-${reel.id}`,
          view: 'reels',
          kind: 'reel-comment',
        });
      }
      const row = q.comments.all(reel.id).find((c) => c.id === id);
      res.status(201);
      return { comment: describeComment(row, req.user, reel.author_id) };
    })
  );

  api.delete(
    '/reels/comments/:commentId',
    auth,
    wrap((req) => {
      const c = q.comment.get(Number(req.params.commentId));
      if (!c) fail(404, 'Comment not found');
      if (c.user_id !== req.user.id && c.reel_author !== req.user.id && !isAdminUser(req.user)) {
        fail(403, 'You can only delete your own comments');
      }
      q.removeComment.run(c.id);
      return { ok: true };
    })
  );

  /** Delete uploads that were never posted. */
  function cleanupUploads(now = clock()) {
    for (const { id } of q.oldUploads.all(now - UPLOAD_TTL)) {
      q.removeUpload.run(id);
      removeFile(id);
    }
  }

  /** How many Reels someone has posted, and the hearts they've had. */
  const statsFor = (userId) => q.stats.get(userId, userId);

  return { cleanupUploads, statsFor };
}

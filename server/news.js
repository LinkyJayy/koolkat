import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fail } from './http.js';
import { CODE_RE, cleanText, normaliseCode } from './plans.js';

export const MAX_NEWS_TITLE = 80;
export const MAX_NEWS_BODY = 2000;
const NEWS_LIMIT = 100;
export const MAX_COMMENT = 500;
export const MAX_POLL_OPTION = 60;
export const MAX_POLL_OPTIONS = 4;
export const MAX_NEWS_IMAGE = 15 * 1024 * 1024;
export const MAX_NEWS_VIDEO = 100 * 1024 * 1024;
/** Uploads that never made it into a post are deleted after this long. */
const UPLOAD_TTL = 24 * 60 * 60 * 1000;
const MEDIA_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** What kind of photo or video the file really is, from its first bytes (null if neither). */
export function sniffMedia(bytes) {
  const ascii = (start, end) => bytes.toString('latin1', start, end);
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png' };
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { kind: 'image', mime: 'image/gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { kind: 'video', mime: 'video/webm' };
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (/^(heic|heix|heim|heis|mif1|msf1|avif)/.test(brand)) return null; // HEIC/AVIF photos: not supported everywhere
    return { kind: 'video', mime: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4' };
  }
  return null;
}

/**
 * News: announcements (codes, events, updates) that only admins can post and
 * everyone signed in can read. A post can include a redeem code, which
 * readers can redeem straight from the post.
 */
export function registerNewsRoutes({ api, db, clock, auth, wrap, publicUser, isAdminUser, pusher, mediaDir, rateLimiter }) {
  fs.mkdirSync(mediaDir, { recursive: true });
  const mediaPath = (id) => path.join(mediaDir, id);
  const removeFile = (id) => fs.rm(mediaPath(id), { force: true }, () => {});

  const q = {
    posts: db.prepare(`
      SELECT n.*, u.username, u.display_name, u.plan_until, u.flair, u.badge_id, u.avatar_id, u.birth_month, u.birth_day, u.birth_tz
      FROM news n LEFT JOIN users u ON u.id = n.author_id
      ORDER BY n.created_at DESC, n.id DESC LIMIT ?`),
    post: db.prepare('SELECT * FROM news WHERE id = ?'),
    postWithAuthor: db.prepare(`
      SELECT n.*, u.username, u.display_name, u.plan_until, u.flair, u.badge_id, u.avatar_id, u.birth_month, u.birth_day, u.birth_tz
      FROM news n LEFT JOIN users u ON u.id = n.author_id WHERE n.id = ?`),
    update: db.prepare(`
      UPDATE news SET title = ?, body = ?, code = ?, media_id = ?, media_kind = ?, media_type = ?, edited_at = ?
      WHERE id = ?`),
    likeCounts: db.prepare('SELECT post_id, COUNT(*) AS n FROM news_likes GROUP BY post_id'),
    likeCount: db.prepare('SELECT COUNT(*) AS n FROM news_likes WHERE post_id = ?'),
    myLikes: db.prepare('SELECT post_id FROM news_likes WHERE user_id = ?'),
    mySaves: db.prepare('SELECT post_id FROM news_saves WHERE user_id = ?'),
    like: db.prepare('INSERT OR IGNORE INTO news_likes (post_id, user_id, created_at) VALUES (?, ?, ?)'),
    unlike: db.prepare('DELETE FROM news_likes WHERE post_id = ? AND user_id = ?'),
    save: db.prepare('INSERT OR IGNORE INTO news_saves (post_id, user_id, created_at) VALUES (?, ?, ?)'),
    unsave: db.prepare('DELETE FROM news_saves WHERE post_id = ? AND user_id = ?'),
    saved: db.prepare(`
      SELECT n.*, u.username, u.display_name, u.plan_until, u.flair, u.badge_id, u.avatar_id, u.birth_month, u.birth_day, u.birth_tz, s.created_at AS saved_at
      FROM news_saves s JOIN news n ON n.id = s.post_id LEFT JOIN users u ON u.id = n.author_id
      WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT ?`),
    removeReactions: db.prepare('DELETE FROM news_likes WHERE post_id = ?'),
    removeSaves: db.prepare('DELETE FROM news_saves WHERE post_id = ?'),
    insert: db.prepare(`
      INSERT INTO news (author_id, title, body, code, created_at, media_id, media_kind, media_type, poll_question, poll_options)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setPoll: db.prepare('UPDATE news SET poll_question = ?, poll_options = ? WHERE id = ?'),
    clearVotes: db.prepare('DELETE FROM news_votes WHERE post_id = ?'),
    voteCounts: db.prepare('SELECT post_id, choice, COUNT(*) AS n FROM news_votes GROUP BY post_id, choice'),
    myVotes: db.prepare('SELECT post_id, choice FROM news_votes WHERE user_id = ?'),
    vote: db.prepare(`
      INSERT INTO news_votes (post_id, user_id, choice, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (post_id, user_id) DO UPDATE SET choice = excluded.choice, created_at = excluded.created_at`),
    unvote: db.prepare('DELETE FROM news_votes WHERE post_id = ? AND user_id = ?'),
    commentCounts: db.prepare('SELECT post_id, COUNT(*) AS n FROM news_comments GROUP BY post_id'),
    comments: db.prepare(`
      SELECT c.*, u.username, u.display_name, u.plan_until, u.flair, u.badge_id, u.avatar_id, u.birth_month, u.birth_day, u.birth_tz
      FROM news_comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ? ORDER BY c.created_at ASC, c.id ASC LIMIT 500`),
    comment: db.prepare('SELECT * FROM news_comments WHERE id = ?'),
    insertComment: db.prepare('INSERT INTO news_comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)'),
    removeComment: db.prepare('DELETE FROM news_comments WHERE id = ?'),
    removeComments: db.prepare('DELETE FROM news_comments WHERE post_id = ?'),
    upload: db.prepare('SELECT * FROM news_uploads WHERE id = ?'),
    insertUpload: db.prepare(
      'INSERT INTO news_uploads (id, kind, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    removeUpload: db.prepare('DELETE FROM news_uploads WHERE id = ?'),
    mediaById: db.prepare('SELECT media_type FROM news WHERE media_id = ?'),
    remove: db.prepare('DELETE FROM news WHERE id = ?'),
    seenAt: db.prepare('SELECT news_seen_at FROM users WHERE id = ?'),
    markSeen: db.prepare('UPDATE users SET news_seen_at = ? WHERE id = ?'),
    unread: db.prepare(
      'SELECT COUNT(*) AS n FROM news WHERE created_at > ? AND (author_id IS NULL OR author_id != ?)'
    ),
    codeExists: db.prepare('SELECT 1 FROM codes WHERE code = ?'),
    subscribers: db.prepare('SELECT DISTINCT user_id FROM push_subscriptions'),
  };

  const unreadFor = (userId) => q.unread.get(q.seenAt.get(userId)?.news_seen_at ?? 0, userId).n;

  /** Hearts and saves for the person reading. */
  const reactionsFor = (userId) => {
    const votes = new Map(); // post -> [count per option]
    for (const r of q.voteCounts.all()) {
      if (!votes.has(r.post_id)) votes.set(r.post_id, []);
      votes.get(r.post_id)[r.choice] = r.n;
    }
    return {
      counts: new Map(q.likeCounts.all().map((r) => [r.post_id, r.n])),
      liked: new Set(q.myLikes.all(userId).map((r) => r.post_id)),
      saved: new Set(q.mySaves.all(userId).map((r) => r.post_id)),
      comments: new Map(q.commentCounts.all().map((r) => [r.post_id, r.n])),
      votes,
      myVotes: new Map(q.myVotes.all(userId).map((r) => [r.post_id, r.choice])),
    };
  };

  const pollOf = (p, r) => {
    if (!p.poll_options) return null;
    let options;
    try {
      options = JSON.parse(p.poll_options);
    } catch {
      return null;
    }
    const counts = r?.votes.get(p.id) ?? [];
    const total = options.reduce((sum, _, i) => sum + (counts[i] ?? 0), 0);
    return {
      question: p.poll_question || null,
      options: options.map((text, i) => ({ text, votes: counts[i] ?? 0 })),
      total,
      myVote: r?.myVotes.has(p.id) ? r.myVotes.get(p.id) : null,
    };
  };

  const describe = (p, r) => ({
    id: p.id,
    likes: r ? r.counts.get(p.id) ?? 0 : 0,
    liked: r ? r.liked.has(p.id) : false,
    saved: r ? r.saved.has(p.id) : false,
    comments: r ? r.comments.get(p.id) ?? 0 : 0,
    poll: pollOf(p, r),
    editedAt: p.edited_at ?? null,
    title: p.title,
    body: p.body,
    code: p.code,
    media: p.media_id ? { kind: p.media_kind, type: p.media_type, url: `news/media/${p.media_id}` } : null,
    createdAt: p.created_at,
    author: p.author_id == null ? null : publicUser({ ...p, id: p.author_id }),
  });

  const requireAdmin = (req, res, next) => {
    if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Only admins can post news' });
    next();
  };

  api.get(
    '/news',
    auth,
    wrap((req) => {
      const r = reactionsFor(req.user.id);
      return {
        posts: q.posts.all(NEWS_LIMIT).map((p) => describe(p, r)),
        unread: unreadFor(req.user.id),
        canPost: isAdminUser(req.user),
      };
    })
  );

  // Favorite Articles: posts you've saved with the ⭐.
  api.get(
    '/news/saved',
    auth,
    wrap((req) => {
      const r = reactionsFor(req.user.id);
      return { posts: q.saved.all(req.user.id, NEWS_LIMIT).map((p) => ({ ...describe(p, r), savedAt: p.saved_at })) };
    })
  );

  const postOr404 = (req) => {
    const id = Number(req.params.id);
    const post = Number.isInteger(id) ? q.post.get(id) : null;
    if (!post) fail(404, 'Post not found');
    return post;
  };

  for (const [path_, add, remove, field] of [
    ['like', q.like, q.unlike, 'liked'],
    ['save', q.save, q.unsave, 'saved'],
  ]) {
    api.post(
      `/news/:id/${path_}`,
      auth,
      wrap((req) => {
        const post = postOr404(req);
        add.run(post.id, req.user.id, clock());
        return { [field]: true, likes: q.likeCount.get(post.id).n };
      })
    );
    api.delete(
      `/news/:id/${path_}`,
      auth,
      wrap((req) => {
        const post = postOr404(req);
        remove.run(post.id, req.user.id);
        return { [field]: false, likes: q.likeCount.get(post.id).n };
      })
    );
  }

  api.get(
    '/news/unread',
    auth,
    wrap((req) => ({ unread: unreadFor(req.user.id) }))
  );

  api.post(
    '/news/seen',
    auth,
    wrap((req) => {
      q.markSeen.run(clock(), req.user.id);
      return { ok: true };
    })
  );

  // Step 1 of a post with a photo or video: upload the file (raw bytes).
  api.post(
    '/news/media',
    auth,
    requireAdmin,
    express.raw({ type: () => true, limit: MAX_NEWS_VIDEO }),
    wrap(async (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const found = sniffMedia(bytes);
      if (!found) fail(415, 'That file isn\'t a supported photo (JPEG, PNG, GIF, WebP) or video (MP4, MOV, WebM)');
      if (found.kind === 'image' && bytes.length > MAX_NEWS_IMAGE) fail(413, 'Photos can be up to 15 MB');
      const id = crypto.randomBytes(16).toString('base64url');
      await fs.promises.writeFile(mediaPath(id), bytes);
      q.insertUpload.run(id, found.kind, found.mime, bytes.length, req.user.id, clock());
      res.status(201);
      return { mediaId: id, kind: found.kind, type: found.mime };
    })
  );

  // Photos and videos on posts. The links are unguessable; everyone signed in can see the posts.
  api.get('/news/media/:id', (req, res, next) => {
    const id = String(req.params.id);
    if (!MEDIA_ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const type = q.mediaById.get(id)?.media_type ?? q.upload.get(id)?.mime;
    if (!type) return res.status(404).json({ error: 'Not found' });
    res.set({
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    // sendFile handles Range requests, so videos can be skipped through.
    res.sendFile(mediaPath(id), { headers: { 'Content-Type': type }, cacheControl: false, lastModified: false }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  /** The title, text, code and (newly uploaded) photo/video of a post being written or edited. */
  function readPost(req) {
    const title = cleanText(req.body?.title, MAX_NEWS_TITLE);
    const body = cleanText(req.body?.body ?? '', MAX_NEWS_BODY, { multiline: true });
    if (!title) fail(400, 'Give the post a title');
    let code = null;
    if (req.body?.code) {
      code = normaliseCode(req.body.code);
      if (!CODE_RE.test(code)) fail(400, 'Codes are 4-32 letters, numbers or dashes');
      if (!q.codeExists.get(code)) fail(400, `There's no code called ${code}. Create it in Admin tools first.`);
    }
    let media = null;
    if (req.body?.mediaId) {
      media = q.upload.get(String(req.body.mediaId));
      if (!media || media.created_by !== req.user.id) fail(400, 'That photo or video has expired. Add it again.');
    }
    return { title, body: body ?? '', code, media, poll: readPoll(req.body?.poll) };
  }

  /** A poll from the post form: undefined (leave as is), null (no poll) or { question, options }. */
  function readPoll(value) {
    if (value === undefined) return undefined;
    if (value === null || value === false) return null;
    const question = cleanText(value.question ?? '', MAX_NEWS_TITLE) || null;
    if (!Array.isArray(value.options)) fail(400, 'A poll needs options');
    const options = value.options.map((o) => cleanText(o, MAX_POLL_OPTION)).filter(Boolean);
    if (options.length < 2) fail(400, 'A poll needs at least 2 options');
    if (options.length > MAX_POLL_OPTIONS) fail(400, `A poll can have up to ${MAX_POLL_OPTIONS} options`);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) fail(400, 'Each poll option must be different');
    return { question, options };
  }

  api.post(
    '/news',
    auth,
    requireAdmin,
    wrap((req, res) => {
      const { title, body, code, media, poll } = readPost(req);
      const now = clock();
      const id = Number(
        q.insert.run(
          req.user.id,
          title,
          body ?? '',
          code,
          now,
          media?.id ?? null,
          media?.kind ?? null,
          media?.mime ?? null,
          poll?.question ?? null,
          poll ? JSON.stringify(poll.options) : null
        ).lastInsertRowid
      );
      if (media) q.removeUpload.run(media.id);
      if (req.body?.notify) {
        for (const { user_id: userId } of q.subscribers.all()) {
          if (userId !== req.user.id) pusher.notify(userId, { title: '📣 KoolKat News', body: title, tag: `news-${id}`, view: 'news' });
        }
      }
      res.status(201);
      return { post: describe(q.postWithAuthor.get(id), reactionsFor(req.user.id)) };
    })
  );

  // ---------- polls (anyone can vote, once, and change their vote) ----------
  api.post(
    '/news/:id/vote',
    auth,
    wrap((req) => {
      const post = postOr404(req);
      const poll = pollOf(post, null);
      if (!poll) fail(404, 'This post has no poll');
      const choice = Number(req.body?.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= poll.options.length) fail(400, 'Pick one of the options');
      q.vote.run(post.id, req.user.id, choice, clock());
      return { poll: pollOf(post, reactionsFor(req.user.id)) };
    })
  );

  api.delete(
    '/news/:id/vote',
    auth,
    wrap((req) => {
      const post = postOr404(req);
      q.unvote.run(post.id, req.user.id);
      return { poll: pollOf(post, reactionsFor(req.user.id)) };
    })
  );

  // ---------- comments (anyone can comment; you or an admin can delete yours) ----------
  const describeComment = (c, user) => ({
    id: c.id,
    body: c.body,
    createdAt: c.created_at,
    author: publicUser({ ...c, id: c.user_id }),
    mine: c.user_id === user.id,
    canDelete: c.user_id === user.id || isAdminUser(user),
  });

  api.get(
    '/news/:id/comments',
    auth,
    wrap((req) => {
      const post = postOr404(req);
      return { comments: q.comments.all(post.id).map((c) => describeComment(c, req.user)) };
    })
  );

  const commentLimiter = rateLimiter({ limit: 10, windowMs: 60 * 1000, clock });

  api.post(
    '/news/:id/comments',
    auth,
    wrap((req, res) => {
      const post = postOr404(req);
      if (!commentLimiter(req.user.id)) fail(429, "You're commenting a lot. Wait a minute and try again.");
      const body = cleanText(req.body?.body, MAX_COMMENT, { multiline: true });
      if (!body) fail(400, 'Write a comment first');
      const id = Number(q.insertComment.run(post.id, req.user.id, body, clock()).lastInsertRowid);
      const row = q.comments.all(post.id).find((c) => c.id === id);
      res.status(201);
      return { comment: describeComment(row, req.user) };
    })
  );

  api.delete(
    '/news/comments/:commentId',
    auth,
    wrap((req) => {
      const c = q.comment.get(Number(req.params.commentId));
      if (!c) fail(404, 'Comment not found');
      if (c.user_id !== req.user.id && !isAdminUser(req.user)) fail(403, 'You can only delete your own comments');
      q.removeComment.run(c.id);
      return { ok: true };
    })
  );

  // Edit a post: new title/text/code, and keep, replace (mediaId) or remove (removeMedia) its photo/video.
  api.post(
    '/news/:id',
    auth,
    requireAdmin,
    wrap((req) => {
      const post = postOr404(req);
      const { title, body, code, media, poll } = readPost(req);
      if (poll !== undefined) {
        const options = poll ? JSON.stringify(poll.options) : null;
        // Changing the options starts the vote again (old votes might not match them).
        if (options !== post.poll_options) q.clearVotes.run(post.id);
        q.setPoll.run(poll?.question ?? null, options, post.id);
      }
      let keep = { id: post.media_id, kind: post.media_kind, mime: post.media_type };
      if (media || req.body?.removeMedia) {
        if (post.media_id) removeFile(post.media_id);
        keep = media ?? { id: null, kind: null, mime: null };
      }
      q.update.run(title, body, code, keep.id, keep.kind, keep.mime, clock(), post.id);
      if (media) q.removeUpload.run(media.id);
      return { post: describe(q.postWithAuthor.get(post.id), reactionsFor(req.user.id)) };
    })
  );

  api.delete(
    '/news/:id',
    auth,
    requireAdmin,
    wrap((req) => {
      const id = Number(req.params.id);
      const post = q.post.get(id);
      if (!post) fail(404, 'Post not found');
      q.removeReactions.run(id);
      q.removeSaves.run(id);
      q.clearVotes.run(id);
      q.removeComments.run(id);
      q.remove.run(id);
      if (post.media_id) removeFile(post.media_id);
      return { ok: true };
    })
  );

  /** Delete uploads that were never posted. */
  function cleanupUploads(now = clock()) {
    for (const u of db.prepare('SELECT id FROM news_uploads WHERE created_at <= ?').all(now - UPLOAD_TTL)) {
      q.removeUpload.run(u.id);
      removeFile(u.id);
    }
  }
  return { cleanupUploads };
}

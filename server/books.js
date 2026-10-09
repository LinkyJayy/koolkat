import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fail } from './http.js';
import { cleanText } from './plans.js';
import { transaction } from './db.js';
import { sniffMedia } from './news.js';
import { sniffAudio } from './music.js';

// KoolKat Books: write books made of pages, each with text, a picture, or
// both, and (if you like) add an audiobook: a recording of you reading it.
// Making and changing books is part of KoolKat Unlimited; everyone signed in
// can read, listen, heart and comment.

export const MAX_BOOK_TITLE = 100;
export const MAX_BOOK_DESCRIPTION = 500;
export const MAX_PAGE_TEXT = 5000;
export const MAX_PAGES = 200;
export const MAX_BOOK_COMMENT = 500;
export const MAX_BOOK_IMAGE = 10 * 1024 * 1024;
export const MAX_BOOK_AUDIO = 200 * 1024 * 1024; // an audiobook can be long
const BOOKS_PER_DAY = 20;
const PAGE = 40;
const UPLOAD_TTL = 24 * 60 * 60 * 1000;
const FILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const LIMITS = { image: MAX_BOOK_IMAGE, cover: MAX_BOOK_IMAGE, audio: MAX_BOOK_AUDIO };

const AUTHOR_COLUMNS =
  'u.username, u.display_name, u.plan_until, u.flair, u.badge_id, u.avatar_id, u.birth_month, u.birth_day, u.birth_tz, u.verified_at, u.accent_color, u.bolt_unlimited, u.bolt_badge, u.bolt_trial_until, u.gem_badge';

export function registerBookRoutes({ api, db, clock, auth, wrap, publicUser, hasUnlimitedUser, isAdminUser, pusher, mediaDir, rateLimiter }) {
  const dir = path.join(mediaDir, 'books');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = (id) => path.join(dir, id);
  const removeFile = (id) => id && fs.rm(filePath(id), { force: true }, () => {});

  const SELECT = `
    SELECT b.*, ${AUTHOR_COLUMNS},
      (SELECT COUNT(*) FROM book_pages p WHERE p.book_id = b.id) AS page_count,
      (SELECT COUNT(*) FROM book_likes l WHERE l.book_id = b.id) AS like_count,
      (SELECT COUNT(*) FROM book_comments c WHERE c.book_id = b.id) AS comment_count,
      EXISTS (SELECT 1 FROM book_likes l WHERE l.book_id = b.id AND l.user_id = ?) AS liked
    FROM books b JOIN users u ON u.id = b.author_id`;
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    book: db.prepare(`${SELECT} WHERE b.id = ?`),
    newest: db.prepare(`${SELECT} WHERE b.id < ? ORDER BY b.id DESC LIMIT ?`),
    byAuthor: db.prepare(`${SELECT} WHERE b.author_id = ? AND b.id < ? ORDER BY b.id DESC LIMIT ?`),
    search: db.prepare(`${SELECT}
      WHERE b.title LIKE ? ESCAPE '\\' OR b.description LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\'
      ORDER BY b.id DESC LIMIT ?`),
    pages: db.prepare('SELECT * FROM book_pages WHERE book_id = ? ORDER BY idx'),
    file: db.prepare(`
      SELECT cover_type AS mime FROM books WHERE cover_id = ?
      UNION ALL SELECT audio_type FROM books WHERE audio_id = ?
      UNION ALL SELECT image_type FROM book_pages WHERE image_id = ?`),
    upload: db.prepare('SELECT * FROM book_uploads WHERE id = ?'),
    insertUpload: db.prepare('INSERT INTO book_uploads (id, kind, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    removeUpload: db.prepare('DELETE FROM book_uploads WHERE id = ?'),
    oldUploads: db.prepare('SELECT id FROM book_uploads WHERE created_at <= ?'),
    madeToday: db.prepare('SELECT COUNT(*) AS n FROM books WHERE author_id = ? AND created_at > ?'),
    insert: db.prepare('INSERT INTO books (author_id, title, description, cover_id, cover_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE books SET title = ?, description = ?, cover_id = ?, cover_type = ?, updated_at = ? WHERE id = ?'),
    setAudio: db.prepare('UPDATE books SET audio_id = ?, audio_type = ?, audio_size = ?, audio_duration = ?, updated_at = ? WHERE id = ?'),
    insertPage: db.prepare('INSERT INTO book_pages (book_id, idx, body, image_id, image_type) VALUES (?, ?, ?, ?, ?)'),
    removePages: db.prepare('DELETE FROM book_pages WHERE book_id = ?'),
    remove: db.prepare('DELETE FROM books WHERE id = ?'),
    like: db.prepare('INSERT OR IGNORE INTO book_likes (book_id, user_id, created_at) VALUES (?, ?, ?)'),
    unlike: db.prepare('DELETE FROM book_likes WHERE book_id = ? AND user_id = ?'),
    likeCount: db.prepare('SELECT COUNT(*) AS n FROM book_likes WHERE book_id = ?'),
    comments: db.prepare(`
      SELECT c.*, ${AUTHOR_COLUMNS} FROM book_comments c JOIN users u ON u.id = c.user_id
      WHERE c.book_id = ? ORDER BY c.created_at, c.id`),
    comment: db.prepare('SELECT c.*, b.author_id AS book_author FROM book_comments c JOIN books b ON b.id = c.book_id WHERE c.id = ?'),
    insertComment: db.prepare('INSERT INTO book_comments (book_id, user_id, body, created_at) VALUES (?, ?, ?, ?)'),
    removeComment: db.prepare('DELETE FROM book_comments WHERE id = ?'),
  };

  const userOf = (req) => q.user.get(req.user.id);
  const requireUnlimited = (req) => {
    const user = userOf(req);
    if (!hasUnlimitedUser(user)) fail(403, 'Making books on KoolKat Books is part of KoolKat Unlimited');
    return user;
  };

  const media = (id) => (id ? `books/media/${id}` : null);
  const describe = (b, viewer, pages = null) => ({
    id: b.id,
    title: b.title,
    description: b.description || null,
    cover: media(b.cover_id),
    audiobook: b.audio_id ? { url: media(b.audio_id), type: b.audio_type, duration: b.audio_duration ?? null } : null,
    pageCount: b.page_count,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    author: publicUser({ ...b, id: b.author_id }),
    likes: b.like_count,
    liked: Boolean(b.liked),
    comments: b.comment_count,
    mine: b.author_id === viewer.id,
    canDelete: b.author_id === viewer.id || isAdminUser(viewer),
    ...(pages ? { pages: pages.map((p) => ({ text: p.body || null, image: media(p.image_id), imageId: p.image_id || null })) } : {}),
  });

  const bookOr404 = (req) => {
    const id = Number(req.params.id);
    const book = Number.isInteger(id) ? q.book.get(req.user.id, id) : null;
    if (!book) fail(404, 'That book was deleted');
    return book;
  };
  const ownBook = (req) => {
    const book = bookOr404(req);
    if (book.author_id !== req.user.id) fail(403, 'You can only change your own books');
    return book;
  };

  /** One of your uploads (of that kind), still waiting to be used. */
  const upload = (userId, id, kinds) => {
    const up = q.upload.get(String(id ?? ''));
    if (!up || up.created_by !== userId || !kinds.includes(up.kind)) fail(400, 'A picture or recording has expired. Choose it again.');
    return up;
  };

  /**
   * The pages, checked: each has text, a picture, or both. A picture is a new
   * upload ({ upload }) or, when changing a book, one it already has ({ keep }).
   */
  function readPages(userId, list, keepable = new Map()) {
    if (!Array.isArray(list) || !list.length) fail(400, 'A book needs at least one page');
    if (list.length > MAX_PAGES) fail(400, `Books can have up to ${MAX_PAGES} pages`);
    return list.map((p, i) => {
      const text = cleanText(p?.text ?? '', MAX_PAGE_TEXT, { multiline: true }) || null;
      let image = null;
      if (p?.image?.upload) {
        const up = upload(userId, p.image.upload, ['image']);
        image = { id: up.id, mime: up.mime, upload: true };
      } else if (p?.image?.keep) {
        const keep = keepable.get(String(p.image.keep));
        if (!keep) fail(400, `The picture on page ${i + 1} isn't in this book any more`);
        image = { id: keep.image_id, mime: keep.image_type };
      }
      if (!text && !image) fail(400, `Page ${i + 1} is empty: give it some text, a picture, or both`);
      return { text, image };
    });
  }

  // Newest first; ?user=ID for someone's books; ?q= to search; ?before=ID for more.
  api.get(
    '/books',
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
      } else if (Number.isInteger(userId) && userId > 0) rows = q.byAuthor.all(req.user.id, userId, before, limit);
      else rows = q.newest.all(req.user.id, before, limit);
      return { books: rows.map((b) => describe(b, req.user)), more: !text && rows.length === limit, canCreate: hasUnlimitedUser(userOf(req)) };
    })
  );

  // Upload each file on its own first: ?kind=image (a page's picture), cover, or audio (the audiobook).
  api.post(
    '/books/upload',
    auth,
    express.raw({ type: () => true, limit: MAX_BOOK_AUDIO }),
    wrap(async (req, res) => {
      const user = requireUnlimited(req);
      const kind = String(req.query.kind ?? '');
      if (!LIMITS[kind]) fail(400, 'Upload a picture, a cover or an audiobook');
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let mime = null;
      if (kind === 'audio') mime = sniffAudio(bytes);
      else {
        const found = sniffMedia(bytes);
        if (found?.kind === 'image') mime = found.mime;
      }
      if (!mime) {
        fail(415, kind === 'audio' ? "That isn't a recording KoolKat can play (MP3, M4A, WAV, OGG, FLAC or AAC)" : 'Pictures can be JPEG, PNG, GIF or WebP');
      }
      if (bytes.length > LIMITS[kind]) fail(413, `That file is too big (up to ${Math.round(LIMITS[kind] / 1024 / 1024)} MB)`);
      const id = crypto.randomBytes(16).toString('base64url');
      await fs.promises.writeFile(filePath(id), bytes);
      q.insertUpload.run(id, kind, mime, bytes.length, user.id, clock());
      res.status(201);
      return { uploadId: id, kind };
    })
  );

  const makeLimiter = rateLimiter({ limit: 5, windowMs: 60 * 1000, clock });
  const readMeta = (body) => {
    const title = cleanText(body?.title, MAX_BOOK_TITLE);
    if (!title) fail(400, 'Give your book a title');
    const description = cleanText(body?.description ?? '', MAX_BOOK_DESCRIPTION, { multiline: true }) || null;
    return { title, description };
  };
  const readAudio = (userId, body) => {
    if (!body?.audioId) return null;
    const up = upload(userId, body.audioId, ['audio']);
    const duration = Number(body.audioDuration);
    return { ...up, duration: Number.isFinite(duration) && duration > 0 && duration < 48 * 60 * 60 ? duration : null };
  };

  // Make a book: { title, description, coverId, pages: [{ text, image: { upload } }], audioId, audioDuration }.
  api.post(
    '/books',
    auth,
    wrap((req, res) => {
      const user = requireUnlimited(req);
      if (!makeLimiter(user.id)) fail(429, 'Slow down a little');
      if (q.madeToday.get(user.id, clock() - 24 * 60 * 60 * 1000).n >= BOOKS_PER_DAY) fail(429, `You can make up to ${BOOKS_PER_DAY} books a day`);
      const { title, description } = readMeta(req.body);
      const cover = req.body?.coverId ? upload(user.id, req.body.coverId, ['cover', 'image']) : null;
      const pages = readPages(user.id, req.body?.pages);
      const audio = readAudio(user.id, req.body);
      const now = clock();
      const id = transaction(db, () => {
        const bookId = Number(q.insert.run(user.id, title, description, cover?.id ?? null, cover?.mime ?? null, now, now).lastInsertRowid);
        pages.forEach((p, i) => q.insertPage.run(bookId, i, p.text, p.image?.id ?? null, p.image?.mime ?? null));
        if (audio) q.setAudio.run(audio.id, audio.mime, audio.size, audio.duration, now, bookId);
        for (const up of [cover, audio, ...pages.map((p) => p.image)]) if (up?.id) q.removeUpload.run(up.id);
        return bookId;
      });
      res.status(201);
      return { book: describe(q.book.get(user.id, id), req.user, q.pages.all(id)) };
    })
  );

  api.get('/books/media/:id', (req, res, next) => {
    const id = String(req.params.id);
    if (!FILE_ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const type = q.file.get(id, id, id)?.mime;
    if (!type) return res.status(404).json({ error: 'Not found' });
    res.set({ 'Cache-Control': 'private, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.sendFile(filePath(id), { headers: { 'Content-Type': type }, cacheControl: false, lastModified: false }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  // A book with all its pages.
  api.get(
    '/books/:id',
    auth,
    wrap((req) => {
      const book = bookOr404(req);
      return { book: describe(book, req.user, q.pages.all(book.id)) };
    })
  );

  // Change your book: the same as making one; pictures it already has are { keep: imageId }.
  // coverId: a new cover, or keepCover: true.
  api.put(
    '/books/:id',
    auth,
    wrap((req) => {
      const user = requireUnlimited(req);
      const book = ownBook(req);
      const { title, description } = readMeta(req.body);
      const oldPages = q.pages.all(book.id);
      const keepable = new Map(oldPages.filter((p) => p.image_id).map((p) => [p.image_id, p]));
      const pages = readPages(user.id, req.body?.pages, keepable);
      let cover = null;
      if (req.body?.coverId) cover = upload(user.id, req.body.coverId, ['cover', 'image']);
      else if (req.body?.keepCover && book.cover_id) cover = { id: book.cover_id, mime: book.cover_type };
      const now = clock();
      transaction(db, () => {
        q.update.run(title, description, cover?.id ?? null, cover?.mime ?? null, now, book.id);
        q.removePages.run(book.id);
        pages.forEach((p, i) => q.insertPage.run(book.id, i, p.text, p.image?.id ?? null, p.image?.mime ?? null));
        for (const up of [cover, ...pages.map((p) => p.image)]) if (up?.id) q.removeUpload.run(up.id);
      });
      // Pictures that aren't used any more.
      const still = new Set(pages.map((p) => p.image?.id).filter(Boolean));
      for (const p of oldPages) if (p.image_id && !still.has(p.image_id)) removeFile(p.image_id);
      if (book.cover_id && book.cover_id !== cover?.id) removeFile(book.cover_id);
      return { book: describe(q.book.get(user.id, book.id), req.user, q.pages.all(book.id)) };
    })
  );

  // Add (or replace) the audiobook: { audioId, audioDuration }.
  api.put(
    '/books/:id/audiobook',
    auth,
    wrap((req) => {
      const user = requireUnlimited(req);
      const book = ownBook(req);
      const audio = readAudio(user.id, req.body);
      if (!audio) fail(400, 'Choose the recording first');
      q.setAudio.run(audio.id, audio.mime, audio.size, audio.duration, clock(), book.id);
      q.removeUpload.run(audio.id);
      if (book.audio_id) removeFile(book.audio_id);
      return { book: describe(q.book.get(user.id, book.id), req.user, q.pages.all(book.id)) };
    })
  );

  api.delete(
    '/books/:id/audiobook',
    auth,
    wrap((req) => {
      const book = ownBook(req);
      q.setAudio.run(null, null, null, null, clock(), book.id);
      if (book.audio_id) removeFile(book.audio_id);
      return { book: describe(q.book.get(req.user.id, book.id), req.user, q.pages.all(book.id)) };
    })
  );

  api.delete(
    '/books/:id',
    auth,
    wrap((req) => {
      const book = bookOr404(req);
      if (book.author_id !== req.user.id && !isAdminUser(req.user)) fail(403, 'You can only delete your own books');
      const pages = q.pages.all(book.id);
      q.remove.run(book.id);
      for (const id of [book.cover_id, book.audio_id, ...pages.map((p) => p.image_id)]) removeFile(id);
      return { ok: true };
    })
  );

  api.post(
    '/books/:id/like',
    auth,
    wrap((req) => {
      const book = bookOr404(req);
      q.like.run(book.id, req.user.id, clock());
      return { liked: true, likes: q.likeCount.get(book.id).n };
    })
  );

  api.delete(
    '/books/:id/like',
    auth,
    wrap((req) => {
      const book = bookOr404(req);
      q.unlike.run(book.id, req.user.id);
      return { liked: false, likes: q.likeCount.get(book.id).n };
    })
  );

  // ---------- comments (anyone) ----------
  const describeComment = (c, viewer, authorId) => ({
    id: c.id,
    body: c.body,
    createdAt: c.created_at,
    author: publicUser({ ...c, id: c.user_id }),
    mine: c.user_id === viewer.id,
    canDelete: c.user_id === viewer.id || authorId === viewer.id || isAdminUser(viewer),
  });

  api.get(
    '/books/:id/comments',
    auth,
    wrap((req) => {
      const book = bookOr404(req);
      return { comments: q.comments.all(book.id).map((c) => describeComment(c, req.user, book.author_id)) };
    })
  );

  const commentLimiter = rateLimiter({ limit: 10, windowMs: 60 * 1000, clock });

  api.post(
    '/books/:id/comments',
    auth,
    wrap((req, res) => {
      const book = bookOr404(req);
      const user = userOf(req);
      const body = cleanText(req.body?.body, MAX_BOOK_COMMENT, { multiline: true });
      if (!body) fail(400, 'Write a comment first');
      if (!commentLimiter(user.id)) fail(429, "You're commenting a lot. Wait a minute and try again.");
      const id = Number(q.insertComment.run(book.id, user.id, body, clock()).lastInsertRowid);
      if (book.author_id !== user.id) {
        pusher.notify(book.author_id, {
          body: `💬 ${user.display_name} commented on your book “${book.title}”: ${[...body].slice(0, 60).join('')}`,
          tag: `book-comment-${book.id}`,
          view: 'books',
          kind: 'book-comment',
        });
      }
      const row = q.comments.all(book.id).find((c) => c.id === id);
      res.status(201);
      return { comment: describeComment(row, req.user, book.author_id) };
    })
  );

  api.delete(
    '/books/comments/:commentId',
    auth,
    wrap((req) => {
      const c = q.comment.get(Number(req.params.commentId));
      if (!c) fail(404, 'Comment not found');
      if (c.user_id !== req.user.id && c.book_author !== req.user.id && !isAdminUser(req.user)) fail(403, 'You can only delete your own comments');
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

  return { cleanupUploads };
}

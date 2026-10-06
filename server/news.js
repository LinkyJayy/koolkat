import { fail } from './http.js';
import { CODE_RE, cleanText, normaliseCode } from './plans.js';

export const MAX_NEWS_TITLE = 80;
export const MAX_NEWS_BODY = 2000;
const NEWS_LIMIT = 100;

/**
 * News: announcements (codes, events, updates) that only admins can post and
 * everyone signed in can read. A post can include a redeem code, which
 * readers can redeem straight from the post.
 */
export function registerNewsRoutes({ api, db, clock, auth, wrap, publicUser, isAdminUser, pusher }) {
  const q = {
    posts: db.prepare(`
      SELECT n.*, u.username, u.display_name, u.plan_until, u.flair
      FROM news n LEFT JOIN users u ON u.id = n.author_id
      ORDER BY n.created_at DESC, n.id DESC LIMIT ?`),
    post: db.prepare('SELECT * FROM news WHERE id = ?'),
    insert: db.prepare('INSERT INTO news (author_id, title, body, code, created_at) VALUES (?, ?, ?, ?, ?)'),
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

  const describe = (p) => ({
    id: p.id,
    title: p.title,
    body: p.body,
    code: p.code,
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
    wrap((req) => ({
      posts: q.posts.all(NEWS_LIMIT).map(describe),
      unread: unreadFor(req.user.id),
      canPost: isAdminUser(req.user),
    }))
  );

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

  api.post(
    '/news',
    auth,
    requireAdmin,
    wrap((req, res) => {
      const title = cleanText(req.body?.title, MAX_NEWS_TITLE);
      const body = cleanText(req.body?.body ?? '', MAX_NEWS_BODY, { multiline: true });
      if (!title) fail(400, 'Give the post a title');
      let code = null;
      if (req.body?.code) {
        code = normaliseCode(req.body.code);
        if (!CODE_RE.test(code)) fail(400, 'Codes are 4-32 letters, numbers or dashes');
        if (!q.codeExists.get(code)) fail(400, `There's no code called ${code}. Create it in Admin tools first.`);
      }
      const now = clock();
      const id = Number(q.insert.run(req.user.id, title, body ?? '', code, now).lastInsertRowid);
      if (req.body?.notify) {
        for (const { user_id: userId } of q.subscribers.all()) {
          if (userId !== req.user.id) pusher.notify(userId, { title: '📣 KoolKat News', body: title, tag: `news-${id}`, view: 'news' });
        }
      }
      res.status(201);
      return { post: describe({ ...q.post.get(id), username: req.user.username, display_name: req.user.displayName }) };
    })
  );

  api.delete(
    '/news/:id',
    auth,
    requireAdmin,
    wrap((req) => {
      const id = Number(req.params.id);
      if (!q.post.get(id)) fail(404, 'Post not found');
      q.remove.run(id);
      return { ok: true };
    })
  );
}

import { fail } from './http.js';
import { cleanText } from './plans.js';
import { BUG_CATEGORIES, SUGGESTION_CATEGORIES, categoryLabel } from '../public/js/feedback-categories.js';

// Suggestions and Bug reports, from KoolKat Unlimited users.
//  - Suggestions: the idea, what it could do, and a category. Only the owner
//    sees them all (search, sort, filter by category) and approves them.
//  - Bug reports: what's wrong, and a category. The owner can search, sort
//    and filter them; every admin can verify one (a blue check: "this is a
//    real bug, please fix it").
// Only the owner gets a notification for each new one.

export const MAX_IDEA = 300;
export const MAX_DOES = 1000;
export const MAX_BUG = 2000;
const PAGE = 100;
const SORTS = { new: 'DESC', old: 'ASC' };

export function registerFeedbackRoutes({ api, auth, wrap, db, clock, publicUser, hasUnlimitedUser, isAdminUser, isOwner, owners, pusher, rateLimiter }) {
  // The author's columns, prefixed (bug_reports has its own verified_at).
  const USER_COLS = ['id', 'username', 'display_name', 'plan_until', 'flair', 'badge_id', 'avatar_id', 'birth_month', 'birth_day', 'birth_tz', 'verified_at', 'accent_color', 'bolt_unlimited', 'bolt_badge', 'bolt_trial_until', 'gem_badge'];
  const userCols = USER_COLS.map((c) => `u.${c} AS u_${c}`).join(', ');
  const author = (r) => publicUser(Object.fromEntries(USER_COLS.map((c) => [c, r[`u_${c}`]])));
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    addSuggestion: db.prepare('INSERT INTO suggestions (user_id, category, idea, does, created_at) VALUES (?, ?, ?, ?, ?)'),
    addBug: db.prepare('INSERT INTO bug_reports (user_id, category, description, created_at) VALUES (?, ?, ?, ?)'),
    mySuggestions: db.prepare('SELECT * FROM suggestions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'),
    myBugs: db.prepare('SELECT * FROM bug_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'),
    suggestion: db.prepare('SELECT * FROM suggestions WHERE id = ?'),
    bug: db.prepare('SELECT * FROM bug_reports WHERE id = ?'),
    approve: db.prepare('UPDATE suggestions SET approved_at = ?, approved_by = ? WHERE id = ?'),
    verify: db.prepare('UPDATE bug_reports SET verified_at = ?, verified_by = ? WHERE id = ?'),
    ownerIds: db.prepare('SELECT id, username FROM users'),
    counts: {
      suggestions: db.prepare('SELECT category, COUNT(*) AS n, SUM(approved_at IS NOT NULL) AS done FROM suggestions GROUP BY category'),
      bugs: db.prepare('SELECT category, COUNT(*) AS n, SUM(verified_at IS NOT NULL) AS done FROM bug_reports GROUP BY category'),
    },
  };
  // One, with who sent it.
  const full = {
    suggestion: db.prepare(`SELECT t.*, ${userCols} FROM suggestions t JOIN users u ON u.id = t.user_id WHERE t.id = ?`),
    bug: db.prepare(`SELECT t.*, ${userCols} FROM bug_reports t JOIN users u ON u.id = t.user_id WHERE t.id = ?`),
  };
  const submitLimiter = rateLimiter({ limit: 10, windowMs: 60 * 60 * 1000, clock });

  const describeSuggestion = (r) => ({ id: r.id, category: r.category, idea: r.idea, does: r.does, approved: Boolean(r.approved_at), approvedAt: r.approved_at ?? null, createdAt: r.created_at, author: r.u_id ? author(r) : undefined });
  const describeBug = (r) => ({ id: r.id, category: r.category, description: r.description, verified: Boolean(r.verified_at), verifiedAt: r.verified_at ?? null, createdAt: r.created_at, author: r.u_id ? author(r) : undefined });

  const unlimitedOnly = (req) => {
    const user = q.user.get(req.user.id);
    if (!hasUnlimitedUser(user)) fail(403, 'Suggestions and bug reports are part of KoolKat Unlimited');
    if (!submitLimiter(req.user.id)) fail(429, "That's a lot for one hour. Try again later.");
    return user;
  };
  const ownerOnly = (req) => {
    if (!isOwner(req.user.username)) fail(403, 'Only the KoolKat owner can see these');
  };
  const adminOnly = (req) => {
    if (!isAdminUser(req.user)) fail(403, 'Only admins can see bug reports');
  };

  /** Tell the owner (only them) about something new. */
  function tellOwner(body, tag) {
    for (const u of q.ownerIds.all()) if (owners.has(u.username.toLowerCase())) pusher?.notify(u.id, { title: 'KoolKat', body, tag, view: 'feedback' });
  }

  // ---------- sending them (KoolKat Unlimited) ----------
  api.post(
    '/suggestions',
    auth,
    wrap((req, res) => {
      const user = unlimitedOnly(req);
      const category = String(req.body?.category ?? '');
      if (!SUGGESTION_CATEGORIES.some(([c]) => c === category)) fail(400, 'Pick a category');
      const idea = cleanText(req.body?.idea, MAX_IDEA);
      const does = cleanText(req.body?.does, MAX_DOES, { multiline: true });
      if (!idea) fail(400, "What's your suggestion?");
      if (!does) fail(400, 'Say what it could do');
      const id = Number(q.addSuggestion.run(user.id, category, idea, does, clock()).lastInsertRowid);
      tellOwner(`💡 ${user.display_name} suggested (${categoryLabel(SUGGESTION_CATEGORIES, category)}): ${idea}`, `suggestion-${id}`);
      res.status(201);
      return { suggestion: describeSuggestion(q.suggestion.get(id)) };
    })
  );
  api.get(
    '/suggestions/mine',
    auth,
    wrap((req) => ({ suggestions: q.mySuggestions.all(req.user.id).map(describeSuggestion) }))
  );

  api.post(
    '/bugs',
    auth,
    wrap((req, res) => {
      const user = unlimitedOnly(req);
      const category = String(req.body?.category ?? '');
      if (!BUG_CATEGORIES.some(([c]) => c === category)) fail(400, 'Pick a category');
      const description = cleanText(req.body?.description, MAX_BUG, { multiline: true });
      if (!description) fail(400, "Describe what's going wrong");
      const id = Number(q.addBug.run(user.id, category, description, clock()).lastInsertRowid);
      tellOwner(`🐞 ${user.display_name} reported a bug (${categoryLabel(BUG_CATEGORIES, category)}): ${description.slice(0, 120)}`, `bug-${id}`);
      res.status(201);
      return { bug: describeBug(q.bug.get(id)) };
    })
  );
  api.get(
    '/bugs/mine',
    auth,
    wrap((req) => ({ bugs: q.myBugs.all(req.user.id).map(describeBug) }))
  );

  // ---------- reading them ----------
  /** Search, filter by category and status, newest or oldest first. */
  function search(table, textCols, doneCol, query) {
    const where = [];
    const args = [];
    const text = String(query.q ?? '').trim().slice(0, 100);
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(`(${[...textCols.map((c) => `t.${c}`), 'u.display_name', 'u.username'].map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      args.push(...Array(textCols.length + 2).fill(like));
    }
    if (query.category) {
      where.push('t.category = ?');
      args.push(String(query.category));
    }
    if (query.status === 'done') where.push(`t.${doneCol} IS NOT NULL`);
    if (query.status === 'open') where.push(`t.${doneCol} IS NULL`);
    const order = SORTS[query.sort] ?? 'DESC';
    return db
      .prepare(`SELECT t.*, ${userCols} FROM ${table} t JOIN users u ON u.id = t.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at ${order} LIMIT ${PAGE}`)
      .all(...args);
  }
  const counts = (rows) => Object.fromEntries(rows.map((r) => [r.category, { total: r.n, done: Number(r.done ?? 0) }]));

  // Suggestions: the owner only.
  api.get(
    '/admin/suggestions',
    auth,
    wrap((req) => {
      ownerOnly(req);
      return { suggestions: search('suggestions', ['idea', 'does'], 'approved_at', req.query).map(describeSuggestion), counts: counts(q.counts.suggestions.all()) };
    })
  );
  api.post(
    '/admin/suggestions/:id/approve',
    auth,
    wrap((req) => {
      ownerOnly(req);
      const s = q.suggestion.get(Number(req.params.id));
      if (!s) fail(404, 'That suggestion is gone');
      const approve = req.body?.approved !== false;
      q.approve.run(approve ? clock() : null, approve ? req.user.id : null, s.id);
      return { suggestion: describeSuggestion(full.suggestion.get(s.id)) };
    })
  );

  // Bug reports: every admin can see and verify them; only the owner can search, sort and filter.
  api.get(
    '/admin/bugs',
    auth,
    wrap((req) => {
      adminOnly(req);
      const owner = isOwner(req.user.username);
      const rows = search('bug_reports', ['description'], 'verified_at', owner ? req.query : {});
      return { bugs: rows.map(describeBug), counts: owner ? counts(q.counts.bugs.all()) : null, canSearch: owner };
    })
  );
  api.post(
    '/admin/bugs/:id/verify',
    auth,
    wrap((req) => {
      adminOnly(req);
      const b = q.bug.get(Number(req.params.id));
      if (!b) fail(404, 'That bug report is gone');
      const verify = req.body?.verified !== false;
      q.verify.run(verify ? clock() : null, verify ? req.user.id : null, b.id);
      return { bug: describeBug(full.bug.get(b.id)) };
    })
  );
}

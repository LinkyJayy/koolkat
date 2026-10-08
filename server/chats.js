import crypto from 'node:crypto';
import { transaction } from './db.js';
import { base64Field, fail, pair, parseUserId, validatePublicKey } from './http.js';

export const MESSAGE_PAGE_SIZE = 50;
export const MAX_GROUP_MEMBERS = 32;
export const MAX_MESSAGE_BYTES = 16 * 1024; // encrypted size, plenty for a 2000-character message
const MAX_GROUP_NAME = 40;

/**
 * Chats between friends: one-to-one, or groups of three or more. Messages are
 * end-to-end encrypted on the device; the server only stores ciphertext and
 * a wrapped copy of each message's key for every member at the time it was sent.
 */
export function registerChatRoutes({ api, db, clock, auth, wrap, publicUser, areFriends, pusher, bffSet = () => new Set() }) {
  const q = {
    chat: db.prepare('SELECT * FROM chats WHERE id = ?'),
    chatByDirectKey: db.prepare('SELECT * FROM chats WHERE direct_key = ?'),
    insertChat: db.prepare(
      'INSERT INTO chats (id, kind, name, direct_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    insertMember: db.prepare(
      'INSERT OR IGNORE INTO chat_members (chat_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)'
    ),
    membership: db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?'),
    removeMember: db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?'),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?'),
    deleteChat: db.prepare('DELETE FROM chats WHERE id = ?'),
    members: db.prepare(`
      SELECT u.id, u.username, u.display_name, u.public_key, u.plan_until, u.flair, u.badge_id, u.avatar_id, u.birth_month, u.birth_day, u.birth_tz, u.verified_at
      FROM chat_members m JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = ? ORDER BY m.joined_at, u.id`),
    myChats: db.prepare(`
      SELECT c.*, m.last_read_at
      FROM chats c JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`),
    unread: db.prepare(`
      SELECT COUNT(*) AS n FROM messages msg
      JOIN message_keys k ON k.message_id = msg.id AND k.user_id = ?
      WHERE msg.chat_id = ? AND msg.created_at > ? AND (msg.sender_id IS NULL OR msg.sender_id != ?)`),
    insertMessage: db.prepare(
      'INSERT INTO messages (id, chat_id, sender_id, created_at, iv, ephemeral_key, ciphertext) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    insertKey: db.prepare('INSERT INTO message_keys (message_id, user_id, wrapped_key, wrap_iv) VALUES (?, ?, ?, ?)'),
    touchChat: db.prepare('UPDATE chats SET last_message_at = ? WHERE id = ?'),
    markRead: db.prepare('UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?'),
    messages: db.prepare(`
      SELECT msg.*, k.wrapped_key, k.wrap_iv,
             u.username, u.display_name, u.plan_until, u.flair, u.badge_id, u.avatar_id, u.birth_month, u.birth_day, u.birth_tz, u.verified_at
      FROM messages msg
      JOIN message_keys k ON k.message_id = msg.id AND k.user_id = ?
      LEFT JOIN users u ON u.id = msg.sender_id
      WHERE msg.chat_id = ? AND msg.created_at < ?
      ORDER BY msg.created_at DESC LIMIT ?`),
  };

  const memberIds = (chatId) => q.members.all(chatId).map((m) => m.id);

  /** The other person in a direct chat. */
  const otherMember = (chat, me) => q.members.all(chat.id).find((m) => m.id !== me);

  /** Direct chats only work while the two people are friends. */
  const usable = (chat, me) => {
    if (chat.kind !== 'direct') return true;
    const other = otherMember(chat, me);
    return Boolean(other && areFriends(me, other.id));
  };

  function describeChat(chat, me) {
    const members = q.members.all(chat.id).map((m) => ({ ...publicUser(m), publicKey: m.public_key }));
    const membership = q.membership.get(chat.id, me);
    const others = members.filter((m) => m.id !== me);
    return {
      id: chat.id,
      kind: chat.kind,
      name: chat.kind === 'group' ? chat.name || others.map((m) => m.displayName).join(', ') : others[0]?.displayName,
      customName: chat.kind === 'group' ? chat.name : null,
      members,
      createdAt: chat.created_at,
      lastMessageAt: chat.last_message_at,
      unread: q.unread.get(me, chat.id, membership?.last_read_at ?? 0, me).n,
    };
  }

  /** Load a chat the current user belongs to, or fail. */
  function myChat(req) {
    const chat = q.chat.get(String(req.params.id));
    if (!chat || !q.membership.get(chat.id, req.user.id)) fail(404, 'Chat not found');
    if (!usable(chat, req.user.id)) fail(403, 'You can only message friends');
    return chat;
  }

  const cleanName = (value) => {
    if (value == null) return null;
    if (typeof value !== 'string') fail(400, 'Group name must be text');
    const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    return [...name].slice(0, MAX_GROUP_NAME).join('') || null;
  };

  /** Validate a list of friend ids to add to a group. */
  function friendIds(list, me) {
    if (!Array.isArray(list)) fail(400, 'Pick some friends');
    const ids = [...new Set(list.map(parseUserId))].filter((id) => id !== me);
    for (const id of ids) if (!areFriends(me, id)) fail(403, 'You can only add your friends');
    return ids;
  }

  api.get(
    '/chats',
    auth,
    wrap((req) => {
      const me = req.user.id;
      const bffs = bffSet(me);
      const chats = q.myChats
        .all(me)
        .filter((c) => usable(c, me))
        .map((c) => {
          const chat = describeChat(c, me);
          const other = chat.kind === 'direct' ? chat.members.find((m) => m.id !== me) : null;
          return { ...chat, bff: Boolean(other && bffs.has(other.id)) };
        });
      // BFF chats are pinned to the top (newest first within each group).
      chats.sort((a, b) => Number(b.bff) - Number(a.bff));
      return { chats, unread: chats.reduce((n, c) => n + c.unread, 0) };
    })
  );

  // Open (or create) the one-to-one chat with a friend.
  api.post(
    '/chats/direct',
    auth,
    wrap((req) => {
      const me = req.user.id;
      const other = parseUserId(req.body?.userId);
      if (other === me || !areFriends(me, other)) fail(403, 'You can only message friends');
      const [low, high] = pair(me, other);
      const key = `${low}:${high}`;
      let chat = q.chatByDirectKey.get(key);
      if (!chat) {
        const id = crypto.randomUUID();
        const now = clock();
        transaction(db, () => {
          q.insertChat.run(id, 'direct', null, key, me, now);
          q.insertMember.run(id, me, now, now);
          q.insertMember.run(id, other, now, now);
        });
        chat = q.chat.get(id);
      }
      return { chat: describeChat(chat, me) };
    })
  );

  api.post(
    '/chats/group',
    auth,
    wrap((req, res) => {
      const me = req.user.id;
      const ids = friendIds(req.body?.memberIds, me);
      if (ids.length < 2) fail(400, 'Pick at least 2 friends for a group chat');
      if (ids.length + 1 > MAX_GROUP_MEMBERS) fail(400, `Groups can have up to ${MAX_GROUP_MEMBERS} people`);
      const id = crypto.randomUUID();
      const now = clock();
      transaction(db, () => {
        q.insertChat.run(id, 'group', cleanName(req.body?.name), null, me, now);
        for (const uid of [me, ...ids]) q.insertMember.run(id, uid, now, uid === me ? now : 0);
      });
      res.status(201);
      return { chat: describeChat(q.chat.get(id), me) };
    })
  );

  api.post(
    '/chats/:id/members',
    auth,
    wrap((req) => {
      const chat = myChat(req);
      if (chat.kind !== 'group') fail(400, 'You can only add people to group chats');
      const existing = new Set(memberIds(chat.id));
      const ids = friendIds(req.body?.userIds, req.user.id).filter((id) => !existing.has(id));
      if (!ids.length) fail(400, 'Pick friends who are not in the group yet');
      if (existing.size + ids.length > MAX_GROUP_MEMBERS) fail(400, `Groups can have up to ${MAX_GROUP_MEMBERS} people`);
      const now = clock();
      transaction(db, () => ids.forEach((uid) => q.insertMember.run(chat.id, uid, now, 0)));
      return { chat: describeChat(chat, req.user.id) };
    })
  );

  api.post(
    '/chats/:id/name',
    auth,
    wrap((req) => {
      const chat = myChat(req);
      if (chat.kind !== 'group') fail(400, 'Only group chats have names');
      db.prepare('UPDATE chats SET name = ? WHERE id = ?').run(cleanName(req.body?.name), chat.id);
      return { chat: describeChat(q.chat.get(chat.id), req.user.id) };
    })
  );

  api.post(
    '/chats/:id/leave',
    auth,
    wrap((req) => {
      const chat = q.chat.get(String(req.params.id));
      if (!chat || !q.membership.get(chat.id, req.user.id)) fail(404, 'Chat not found');
      if (chat.kind !== 'group') fail(400, 'You can only leave group chats');
      transaction(db, () => {
        q.removeMember.run(chat.id, req.user.id);
        if (q.memberCount.get(chat.id).n === 0) q.deleteChat.run(chat.id);
      });
      return { ok: true };
    })
  );

  api.get(
    '/chats/:id/messages',
    auth,
    wrap((req) => {
      const chat = myChat(req);
      const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
      const rows = q.messages.all(req.user.id, chat.id, before, MESSAGE_PAGE_SIZE + 1);
      const messages = rows
        .slice(0, MESSAGE_PAGE_SIZE)
        .reverse()
        .map((m) => ({
          id: m.id,
          sender: m.sender_id == null ? null : publicUser({ ...m, id: m.sender_id }),
          createdAt: m.created_at,
          iv: m.iv,
          ephemeralPublicKey: m.ephemeral_key,
          wrappedKey: m.wrapped_key,
          wrapIv: m.wrap_iv,
          ciphertext: Buffer.from(m.ciphertext).toString('base64'),
        }));
      return { chat: describeChat(chat, req.user.id), messages, hasMore: rows.length > MESSAGE_PAGE_SIZE };
    })
  );

  api.post(
    '/chats/:id/messages',
    auth,
    wrap((req, res) => {
      const chat = myChat(req);
      const me = req.user.id;
      const { iv, ephemeralPublicKey, ciphertext, keys } = req.body ?? {};
      base64Field(iv, 'iv', { min: 12, max: 12 });
      validatePublicKey(ephemeralPublicKey, 'ephemeralPublicKey');
      const blob = base64Field(ciphertext, 'ciphertext', { min: 17, max: MAX_MESSAGE_BYTES });
      if (!Array.isArray(keys)) fail(400, 'keys are required');

      // The message must be encrypted for exactly the current members (sender included).
      const members = memberIds(chat.id);
      const given = keys.map((k) => parseUserId(k?.userId));
      if (new Set(given).size !== given.length || given.length !== members.length || !members.every((id) => given.includes(id))) {
        fail(409, 'The people in this chat changed. Try sending again.');
      }
      for (const k of keys) {
        base64Field(k.wrappedKey, 'wrappedKey', { min: 48, max: 48 });
        base64Field(k.wrapIv, 'wrapIv', { min: 12, max: 12 });
      }

      const id = crypto.randomUUID();
      const now = clock();
      transaction(db, () => {
        q.insertMessage.run(id, chat.id, me, now, iv, ephemeralPublicKey, blob);
        for (const k of keys) q.insertKey.run(id, Number(k.userId), k.wrappedKey, k.wrapIv);
        q.touchChat.run(now, chat.id);
        q.markRead.run(now, chat.id, me);
      });

      const sender = req.user.displayName;
      const body =
        chat.kind === 'group'
          ? `${sender} in ${describeChat(chat, me).name}: new message 💬`
          : `${sender} sent you a message 💬`;
      for (const uid of members) {
        if (uid !== me) pusher.notify(uid, { body, tag: `chat-${chat.id}`, view: 'chats' });
      }
      res.status(201);
      return { id, createdAt: now };
    })
  );

  api.post(
    '/chats/:id/read',
    auth,
    wrap((req) => {
      const chat = myChat(req);
      q.markRead.run(clock(), chat.id, req.user.id);
      return { ok: true };
    })
  );
}

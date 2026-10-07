import crypto from 'node:crypto';
import { fail, parseUserId } from './http.js';

// Calls (voice) and FaceTime (video) between two friends.
//
// The audio and video go straight between the two phones over WebRTC, which
// encrypts them end to end (DTLS-SRTP). The server only passes along the
// messages that set the call up, and those are encrypted on the phones with a
// key only the two friends can work out (see callKey in crypto.js), so the
// server can't read them or slip itself into the call.
//
// Calls live in memory: if the server restarts, calls in progress end.

export const CALL_KINDS = ['audio', 'video'];
/** How long a call rings before it counts as missed. */
export const RING_TIMEOUT = 45 * 1000;
/** A call ends if one side's app stops checking in for this long (closed, lost signal). */
export const CALL_GONE_AFTER = 90 * 1000;
/** How long the app's event request waits for something to happen. */
const LONG_POLL = 25 * 1000;
const MAX_SIGNAL_BYTES = 64 * 1024;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,40}$/;
const CALL_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** STUN/TURN servers for WebRTC. TURN relays calls when phones can't reach each other directly. */
export function iceServersFor(userId, now, env = process.env) {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const urls = (env.TURN_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^turns?:/.test(u));
  if (urls.length) {
    if (env.TURN_SECRET) {
      // Time-limited credentials (coturn's "use-auth-secret").
      const username = `${Math.floor(now / 1000) + 12 * 60 * 60}:${userId}`;
      const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls, username, credential });
    } else if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
      servers.push({ urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
    }
  }
  return servers;
}

export function registerCallRoutes({
  api,
  db,
  clock,
  auth,
  wrap,
  publicUser,
  areFriends,
  pusher,
  env = process.env,
  ringTimeout = RING_TIMEOUT,
}) {
  const q = { user: db.prepare('SELECT * FROM users WHERE id = ?') };

  const calls = new Map(); // id -> call
  const callOf = new Map(); // userId -> call id (one call at a time)
  const queues = new Map(); // userId -> { seq, events, waiters }
  const lastSeen = new Map(); // userId -> time their app last checked in

  const queueFor = (userId) => {
    let queue = queues.get(userId);
    if (!queue) {
      queue = { seq: 0, events: [], waiters: new Set() };
      queues.set(userId, queue);
    }
    return queue;
  };

  // `device` sends an event to one of the user's phones/tabs; `notDevice` to all but one.
  const visibleTo = (event, device) =>
    (!event.device || event.device === device) && (!event.notDevice || event.notDevice !== device);

  function emit(userId, event) {
    const queue = queueFor(userId);
    queue.seq += 1;
    queue.events.push({ ...event, seq: queue.seq, at: clock() });
    if (queue.events.length > 200) queue.events.splice(0, queue.events.length - 200);
    for (const waiter of queue.waiters) waiter.check();
  }

  const peerOf = (call, userId) => (call.callerId === userId ? call.calleeId : call.callerId);

  const describe = (call, userId) => {
    const peer = q.user.get(peerOf(call, userId));
    return {
      id: call.id,
      kind: call.kind,
      state: call.state,
      outgoing: call.callerId === userId,
      callerId: call.callerId,
      calleeId: call.calleeId,
      createdAt: call.createdAt,
      answeredAt: call.answeredAt ?? null,
      peer: { ...publicUser(peer), publicKey: peer.public_key },
    };
  };

  const label = (call) => (call.kind === 'video' ? 'FaceTime' : 'call');

  function endCall(call, reason, byUserId = null) {
    if (!calls.has(call.id)) return;
    calls.delete(call.id);
    clearTimeout(call.ringTimer);
    if (callOf.get(call.callerId) === call.id) callOf.delete(call.callerId);
    if (callOf.get(call.calleeId) === call.id) callOf.delete(call.calleeId);
    for (const userId of [call.callerId, call.calleeId]) {
      emit(userId, { type: 'ended', callId: call.id, reason, by: byUserId });
    }
    // Never answered: let the person who was called know they missed it.
    if (call.state === 'ringing' && (reason === 'missed' || reason === 'cancelled')) {
      const caller = q.user.get(call.callerId);
      pusher.notify(call.calleeId, {
        body: `Missed ${label(call)} from ${caller.display_name}`,
        tag: `call-${call.id}`,
        view: 'chats',
        kind: 'missed-call',
      });
    }
  }

  const findCall = (req) => {
    const id = String(req.params.id ?? '');
    const call = CALL_ID_RE.test(id) ? calls.get(id) : null;
    if (!call || (call.callerId !== req.user.id && call.calleeId !== req.user.id)) fail(404, 'That call has ended');
    return call;
  };

  const readDevice = (value) => {
    const device = String(value ?? '');
    if (!DEVICE_RE.test(device)) fail(400, 'Missing device id');
    return device;
  };

  // ---------- starting and answering ----------
  api.post(
    '/calls',
    auth,
    wrap((req, res) => {
      const me = req.user.id;
      const to = parseUserId(req.body?.to);
      const kind = String(req.body?.kind ?? '');
      if (!CALL_KINDS.includes(kind)) fail(400, 'Choose a call or FaceTime');
      const device = readDevice(req.body?.device);
      if (to === me) fail(400, "You can't call yourself");
      if (!areFriends(me, to)) fail(403, 'You can only call friends');
      if (callOf.has(me)) fail(409, "You're already in a call");
      const callee = q.user.get(to);
      if (callOf.has(to)) fail(409, `${callee.display_name} is on another call`);

      const now = clock();
      const call = {
        id: crypto.randomBytes(16).toString('base64url'),
        kind,
        state: 'ringing',
        callerId: me,
        calleeId: to,
        callerDevice: device,
        calleeDevice: null,
        createdAt: now,
      };
      calls.set(call.id, call);
      callOf.set(me, call.id);
      callOf.set(to, call.id);
      call.ringTimer = setTimeout(() => endCall(call, 'missed'), ringTimeout);
      call.ringTimer.unref?.();

      emit(to, { type: 'incoming', call: describe(call, to) });
      pusher.notify(to, {
        title: kind === 'video' ? 'KoolKat FaceTime' : 'KoolKat Call',
        body:
          kind === 'video'
            ? `📹 ${req.user.displayName} wants to FaceTime`
            : `📞 ${req.user.displayName} is calling you`,
        tag: `call-${call.id}`,
        view: 'call',
        kind: 'call',
        ttl: Math.ceil(ringTimeout / 1000),
      });
      res.status(201);
      return { call: describe(call, me) };
    })
  );

  api.post(
    '/calls/:id/answer',
    auth,
    wrap((req) => {
      const call = findCall(req);
      const device = readDevice(req.body?.device);
      if (call.calleeId !== req.user.id) fail(403, 'Only the person being called can answer');
      if (call.state !== 'ringing') fail(409, 'This call was already answered');
      call.state = 'active';
      call.answeredAt = clock();
      call.calleeDevice = device;
      clearTimeout(call.ringTimer);
      emit(call.callerId, { type: 'answered', callId: call.id, device: call.callerDevice });
      // Stop it ringing on the person's other phones and tabs.
      emit(call.calleeId, { type: 'ended', callId: call.id, reason: 'answered-elsewhere', notDevice: device });
      pusher.notify(call.calleeId, { body: 'Call answered', tag: `call-${call.id}`, view: 'call', kind: 'call-ended' });
      return { call: describe(call, req.user.id) };
    })
  );

  api.post(
    '/calls/:id/decline',
    auth,
    wrap((req) => {
      const call = findCall(req);
      if (call.calleeId !== req.user.id || call.state !== 'ringing') fail(409, "That call can't be declined now");
      endCall(call, 'declined', req.user.id);
      return { ok: true };
    })
  );

  api.post(
    '/calls/:id/end',
    auth,
    wrap((req) => {
      const id = String(req.params.id ?? '');
      const call = calls.get(id);
      if (!call || (call.callerId !== req.user.id && call.calleeId !== req.user.id)) return { ok: true };
      const reason = call.state === 'ringing' ? (call.callerId === req.user.id ? 'cancelled' : 'declined') : 'ended';
      endCall(call, reason, req.user.id);
      return { ok: true };
    })
  );

  // Encrypted call setup messages (offer/answer/network candidates), passed to the other phone.
  api.post(
    '/calls/:id/signal',
    auth,
    wrap((req) => {
      const call = findCall(req);
      const device = readDevice(req.body?.device);
      const data = req.body?.data;
      if (call.state !== 'active') fail(409, "The call hasn't been answered yet");
      const mine = call.callerId === req.user.id ? call.callerDevice : call.calleeDevice;
      if (device !== mine) fail(409, 'This call is on another device');
      if (!data || typeof data.iv !== 'string' || typeof data.ciphertext !== 'string') fail(400, 'Bad signal');
      if (data.iv.length > 64 || data.ciphertext.length > MAX_SIGNAL_BYTES) fail(413, 'Signal too large');
      const to = peerOf(call, req.user.id);
      const toDevice = to === call.callerId ? call.callerDevice : call.calleeDevice;
      emit(to, { type: 'signal', callId: call.id, data: { iv: data.iv, ciphertext: data.ciphertext }, device: toDevice });
      return { ok: true };
    })
  );

  // ---------- staying in touch ----------
  // The app keeps one request open here while it runs; it returns as soon as
  // something happens (a call coming in, answered, ended, or a setup message).
  api.get(
    '/calls/events',
    auth,
    (req, res, next) => {
      const me = req.user.id;
      let device;
      try {
        device = readDevice(req.query.device);
      } catch (err) {
        return next(err);
      }
      lastSeen.set(me, clock());
      const queue = queueFor(me);
      let after = Number(req.query.after);
      // First request, or the server restarted since: start from now.
      if (!Number.isInteger(after) || after < 0 || after > queue.seq) {
        return res.json({ seq: queue.seq, events: [], reset: true });
      }
      const pending = () => queue.events.filter((e) => e.seq > after && visibleTo(e, device));
      const send = () => {
        cleanup();
        const events = pending().map(({ device: _d, notDevice: _n, ...e }) => e);
        lastSeen.set(me, clock());
        if (!res.headersSent) res.json({ seq: queue.seq, events });
      };
      const waiter = {
        check: () => {
          if (pending().length) send();
          else after = Math.max(after, queue.seq); // nothing for this device: skip ahead
        },
      };
      const timer = setTimeout(send, LONG_POLL);
      const cleanup = () => {
        clearTimeout(timer);
        queue.waiters.delete(waiter);
      };
      req.on('close', cleanup);
      if (pending().length) return send();
      queue.waiters.add(waiter);
    }
  );

  // After opening KoolKat from a call notification: the call that's ringing (or in progress).
  api.get(
    '/calls/active',
    auth,
    wrap((req) => {
      const id = callOf.get(req.user.id);
      const call = id && calls.get(id);
      return { call: call ? describe(call, req.user.id) : null };
    })
  );

  api.get(
    '/calls/ice',
    auth,
    wrap((req) => ({ iceServers: iceServersFor(req.user.id, clock(), env) }))
  );

  /** End calls where one side's app has gone quiet. Run by the server every few seconds. */
  function sweep(now = clock()) {
    for (const call of calls.values()) {
      if (call.state !== 'active') continue;
      for (const userId of [call.callerId, call.calleeId]) {
        if (now - (lastSeen.get(userId) ?? call.answeredAt) > CALL_GONE_AFTER) {
          endCall(call, 'lost');
          break;
        }
      }
    }
  }

  return { sweep, endCall, calls };
}

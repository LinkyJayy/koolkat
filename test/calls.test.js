import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { iceServersFor } from '../server/calls.js';
import { callKey, createIdentity, deriveKeysFromPassword, openSignal, sealSignal, unlockIdentity } from '../public/js/crypto.js';

const db = openDatabase(':memory:');
let now = Date.now();
const pushes = [];
const pusher = {
  publicKey: 'test',
  subscribe() {},
  unsubscribe() {},
  async notify(userId, payload) {
    pushes.push({ userId, ...payload });
  },
};
let app;
let server;
let base;
before(async () => {
  app = createApp({ db, admins: ['boss'], clock: () => now, pusher });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function register(username) {
  const { authSecret, vaultKey } = await deriveKeysFromPassword(username, 'password123', 1000);
  const id = await createIdentity(vaultKey);
  const res = await call('POST', '/auth/register', {
    body: { username, displayName: username, authSecret, publicKey: id.publicKey, encryptedPrivateKey: id.encryptedPrivateKey, privateKeyIv: id.privateKeyIv },
  });
  return { ...res.body.user, token: res.body.token };
}

const DEV = { ann: 'ann-phone-1', ann2: 'ann-laptop-1', ben: 'ben-phone-1', cat: 'cat-phone-1' };
/** Read a user's call events (starting from `after`) for one device. */
async function events(user, device, after) {
  const res = await call('GET', `/calls/events?device=${device}&after=${after}`, { token: user.token });
  return res.body;
}
const cursor = async (user, device) => (await call('GET', `/calls/events?device=${device}`, { token: user.token })).body.seq;

let ann, ben, cat;
before(async () => {
  [ann, ben, cat] = [await register('ann'), await register('ben'), await register('cat')];
  await call('POST', '/friends/request', { token: ann.token, body: { username: 'ben' } });
  await call('POST', `/friends/${ann.id}/accept`, { token: ben.token });
});

describe('Calls and FaceTime', () => {
  test('only friends, valid kinds, one call at a time', async () => {
    assert.equal((await call('POST', '/calls', { token: ann.token, body: { to: cat.id, kind: 'audio', device: DEV.ann } })).status, 403);
    assert.equal((await call('POST', '/calls', { token: ann.token, body: { to: ben.id, kind: 'hologram', device: DEV.ann } })).status, 400);
    assert.equal((await call('POST', '/calls', { token: ann.token, body: { to: ben.id, kind: 'audio' } })).status, 400, 'device id');
    assert.equal((await call('POST', '/calls', { token: ann.token, body: { to: ann.id, kind: 'audio', device: DEV.ann } })).status, 400);
  });

  test('a FaceTime rings, is answered, and passes setup messages only between the two phones', async () => {
    const benAt = await cursor(ben, DEV.ben);
    const annAt = await cursor(ann, DEV.ann);
    const annLaptopAt = await cursor(ann, DEV.ann2);
    pushes.length = 0;

    const started = await call('POST', '/calls', { token: ben.token, body: { to: ann.id, kind: 'video', device: DEV.ben } });
    assert.equal(started.status, 201);
    const id = started.body.call.id;
    assert.equal(started.body.call.outgoing, true);
    assert.equal(started.body.call.peer.username, 'ann');
    assert.ok(started.body.call.peer.publicKey, 'the key used to encrypt the call setup');
    assert.equal(pushes[0].userId, ann.id);
    assert.equal(pushes[0].kind, 'call');
    assert.match(pushes[0].body, /ben wants to FaceTime/);

    // Ringing on both of ann's devices.
    const ring = await events(ann, DEV.ann, annAt);
    assert.equal(ring.events[0].type, 'incoming');
    assert.equal(ring.events[0].call.kind, 'video');
    assert.equal(ring.events[0].call.outgoing, false);
    assert.equal((await events(ann, DEV.ann2, annLaptopAt)).events[0].type, 'incoming');
    assert.equal((await call('GET', '/calls/active', { token: ann.token })).body.call.id, id);

    // Busy: someone else calling either of them.
    assert.equal((await call('POST', '/calls', { token: cat.token, body: { to: ann.id, kind: 'audio', device: DEV.cat } })).status, 403);
    assert.equal((await call('POST', '/calls', { token: ann.token, body: { to: ben.id, kind: 'audio', device: DEV.ann } })).status, 409);

    // Signals aren't accepted before it's answered, and only the person called can answer.
    assert.equal((await call('POST', `/calls/${id}/signal`, { token: ben.token, body: { device: DEV.ben, data: { iv: 'a', ciphertext: 'b' } } })).status, 409);
    assert.equal((await call('POST', `/calls/${id}/answer`, { token: ben.token, body: { device: DEV.ben } })).status, 403);
    assert.equal((await call('POST', `/calls/${id}/answer`, { token: cat.token, body: { device: DEV.cat } })).status, 404);

    // Ann answers on her phone: the laptop stops ringing, ben hears it was answered.
    const answered = await call('POST', `/calls/${id}/answer`, { token: ann.token, body: { device: DEV.ann } });
    assert.equal(answered.body.call.state, 'active');
    assert.equal((await call('POST', `/calls/${id}/answer`, { token: ann.token, body: { device: DEV.ann2 } })).status, 409);
    const laptop = await events(ann, DEV.ann2, annLaptopAt);
    assert.deepEqual(laptop.events.map((e) => [e.type, e.reason]), [['incoming', undefined], ['ended', 'answered-elsewhere']]);
    const phone = await events(ann, DEV.ann, annAt);
    assert.deepEqual(phone.events.map((e) => e.type), ['incoming'], "the phone that answered doesn't get 'ended'");
    const benEvents = await events(ben, DEV.ben, benAt);
    assert.deepEqual(benEvents.events.map((e) => e.type), ['answered']);

    // Encrypted setup messages go to the other phone only.
    const sig = { device: DEV.ben, data: { iv: 'aXZpdml2aXZpdml2', ciphertext: 'Y2lwaGVy' } };
    assert.equal((await call('POST', `/calls/${id}/signal`, { token: ben.token, body: sig })).status, 200);
    assert.equal((await call('POST', `/calls/${id}/signal`, { token: ben.token, body: { ...sig, device: 'ben-tablet-1' } })).status, 409);
    assert.equal((await call('POST', `/calls/${id}/signal`, { token: ann.token, body: { ...sig, device: DEV.ann2 } })).status, 409, 'not the device that answered');
    const got = await events(ann, DEV.ann, phone.seq);
    assert.equal(got.events[0].type, 'signal');
    assert.deepEqual(got.events[0].data, sig.data);
    assert.equal(got.events[0].device, undefined, 'routing details are not sent');
    assert.deepEqual((await events(ann, DEV.ann2, laptop.seq)).events, [], 'the laptop never sees it');

    // Hang up.
    await call('POST', `/calls/${id}/end`, { token: ann.token });
    const end = await events(ben, DEV.ben, benEvents.seq);
    assert.equal(end.events.at(-1).type, 'ended');
    assert.equal(end.events.at(-1).reason, 'ended');
    assert.equal((await call('GET', '/calls/active', { token: ann.token })).body.call, null);
    assert.equal((await call('POST', `/calls/${id}/signal`, { token: ben.token, body: sig })).status, 404);
  });

  test('declined, cancelled and missed calls', async () => {
    // Declined
    let annAt = await cursor(ann, DEV.ann);
    let id = (await call('POST', '/calls', { token: ann.token, body: { to: ben.id, kind: 'audio', device: DEV.ann } })).body.call.id;
    assert.equal((await call('POST', `/calls/${id}/decline`, { token: ann.token })).status, 409, "the caller can't decline");
    await call('POST', `/calls/${id}/decline`, { token: ben.token });
    assert.equal((await events(ann, DEV.ann, annAt)).events.at(-1).reason, 'declined');
    assert.equal((await call('GET', '/calls/active', { token: ann.token })).body.call, null);

    // Cancelled by the caller: the person called gets a missed-call notification.
    pushes.length = 0;
    const benAt = await cursor(ben, DEV.ben);
    id = (await call('POST', '/calls', { token: ann.token, body: { to: ben.id, kind: 'audio', device: DEV.ann } })).body.call.id;
    await call('POST', `/calls/${id}/end`, { token: ann.token });
    assert.equal((await events(ben, DEV.ben, benAt)).events.at(-1).reason, 'cancelled');
    assert.deepEqual(pushes.map((p) => p.kind), ['call', 'missed-call']);
    assert.match(pushes[1].body, /Missed call from ann/);
  });

  test('nobody answers: it rings out as missed', async () => {
    const quick = createApp({ db, admins: ['boss'], pusher, callRingTimeout: 150 });
    const srv = quick.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const at = (path, user, body) =>
      fetch(`http://127.0.0.1:${srv.address().port}/api${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => r.json());
    pushes.length = 0;
    const start = (await at(`/calls/events?device=${DEV.ann}`, ann)).seq;
    await at('/calls', ann, { to: ben.id, kind: 'video', device: DEV.ann });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await at('/calls/active', ann)).call, null);
    const ev = await at(`/calls/events?device=${DEV.ann}&after=${start}`, ann);
    assert.equal(ev.events.at(-1).reason, 'missed');
    assert.deepEqual(pushes.map((p) => p.kind), ['call', 'missed-call']);
    assert.match(pushes[1].body, /Missed FaceTime from ann/);
    srv.close();
  });

  test("an answered call ends if one phone disappears", async () => {
    const id = (await call('POST', '/calls', { token: ann.token, body: { to: ben.id, kind: 'audio', device: DEV.ann } })).body.call.id;
    await call('POST', `/calls/${id}/answer`, { token: ben.token, body: { device: DEV.ben } });
    const annAt = await cursor(ann, DEV.ann);
    await cursor(ben, DEV.ben);
    now += 60_000;
    await cursor(ann, DEV.ann); // ann's app keeps checking in, ben's doesn't
    app.locals.sweepCalls();
    assert.ok((await call('GET', '/calls/active', { token: ann.token })).body.call, 'still within the grace period');
    now += 40_000;
    await cursor(ann, DEV.ann);
    app.locals.sweepCalls();
    assert.equal((await call('GET', '/calls/active', { token: ann.token })).body.call, null);
    const ev = await events(ann, DEV.ann, annAt);
    assert.equal(ev.events.at(-1).reason, 'lost');
  });

  test('event requests wait for something to happen', async () => {
    const at = await cursor(ben, DEV.ben);
    const waiting = events(ben, DEV.ben, at);
    await new Promise((r) => setTimeout(r, 100));
    const id = (await call('POST', '/calls', { token: ann.token, body: { to: ben.id, kind: 'audio', device: DEV.ann } })).body.call.id;
    const got = await waiting;
    assert.equal(got.events[0].type, 'incoming');
    await call('POST', `/calls/${id}/end`, { token: ann.token });
    // A cursor from before a server restart starts again from now.
    const reset = await events(ben, DEV.ben, 999_999);
    assert.equal(reset.reset, true);
  });

  test('STUN always, TURN when configured', () => {
    assert.equal(iceServersFor(1, 0, {}).length, 1);
    const fixed = iceServersFor(1, 0, { TURN_URLS: 'turn:turn.example.com:3478, turns:turn.example.com:443', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
    assert.deepEqual(fixed[1], { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:443'], username: 'u', credential: 'p' });
    const timed = iceServersFor(7, 1_000_000, { TURN_URLS: 'turn:t.example.com', TURN_SECRET: 's' });
    assert.match(timed[1].username, /^\d+:7$/);
    assert.ok(timed[1].credential);
    assert.equal(iceServersFor(1, 0, { TURN_URLS: 'https://nope' }).length, 1, 'only turn: urls');
  });

  test('call setup messages are end-to-end encrypted between the two friends', async () => {
    const person = async (name) => {
      const { vaultKey } = await deriveKeysFromPassword(name, 'pw', 1000);
      const id = await createIdentity(vaultKey);
      const privateKey = await unlockIdentity(vaultKey, id.encryptedPrivateKey, id.privateKeyIv);
      return { publicKey: id.publicKey, privateKey };
    };
    const [a, b, eve] = [await person('a'), await person('b'), await person('eve')];
    const ka = await callKey(a.privateKey, b.publicKey, 'call1', 1, 2);
    const kb = await callKey(b.privateKey, a.publicKey, 'call1', 1, 2);
    const offer = { type: 'sdp', sdp: { type: 'offer', sdp: 'v=0...' } };
    const sealed = await sealSignal(ka, offer, 1);
    assert.doesNotMatch(sealed.ciphertext, /offer/);
    assert.deepEqual(await openSignal(kb, sealed, 1), offer, 'the friend can read it');
    await assert.rejects(openSignal(kb, sealed, 2), 'bounced back as if from the other side');
    const keve = await callKey(eve.privateKey, a.publicKey, 'call1', 1, 2);
    await assert.rejects(openSignal(keve, sealed, 1), 'someone else (or the server) cannot');
    const other = await callKey(b.privateKey, a.publicKey, 'call2', 1, 2);
    await assert.rejects(openSignal(other, sealed, 1), 'a different call has a different key');
    const tampered = { ...sealed, ciphertext: sealed.ciphertext.slice(0, -4) + 'AAAA' };
    await assert.rejects(openSignal(kb, tampered, 1));
  });
});

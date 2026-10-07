// Calls (voice) and FaceTime (video) with friends, using WebRTC.
//
// Audio and video go directly between the two phones and are encrypted by
// WebRTC. The setup messages (offer, answer, network candidates) go through
// the KoolKat server, encrypted with a key only the two friends share
// (callKey in crypto.js), so the server can't read them or join the call.
import { API_BASE, api } from './api.js';
import { callKey, openSignal, sealSignal } from './crypto.js';
import { startRinging, stopRinging } from './sounds.js';

const $ = (id) => document.getElementById(id);

/** Identifies this tab/phone, so a call answered here doesn't ring on to your other devices. */
const DEVICE = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

const CONNECT_TIMEOUT = 30 * 1000;
const RECONNECT_GRACE = 15 * 1000;

let hooks = {
  me: () => null, // { userId, privateKey }
  findFriend: () => null, // id -> friend (with publicKey)
  toast: () => {},
  beforeMedia: async () => {}, // e.g. turn off the KoolKat camera so FaceTime can use it
  afterCall: () => {},
  beforeShow: () => {}, // e.g. close dialogs so the call screen is on top
};

let current = null;
const events = { run: 0 };

const kindLabel = (kind) => (kind === 'video' ? 'FaceTime' : 'Call');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function inCall() {
  return Boolean(current);
}

/** Whether a FaceTime is using the camera right now. */
export function usingCamera() {
  return current?.kind === 'video';
}

export function initCalls(options) {
  hooks = { ...hooks, ...options };
  $('btn-call-accept').addEventListener('click', accept);
  $('btn-call-decline').addEventListener('click', decline);
  $('btn-call-end').addEventListener('click', () => hangUp());
  $('btn-call-mute').addEventListener('click', toggleMute);
  $('btn-call-camera').addEventListener('click', toggleCamera);
  $('btn-call-flip').addEventListener('click', flipCamera);
  // Closing KoolKat mid-call hangs up instead of leaving the friend waiting.
  window.addEventListener('pagehide', () => {
    if (current?.call) api('POST', `/calls/${current.call.id}/end`, undefined, { keepalive: true }).catch(() => {});
  });
}

// ---------- listening for calls ----------
/** Start listening for incoming calls (after signing in). */
export function startCallEvents() {
  const run = ++events.run;
  listen(run);
}

/** Stop listening (signing out), hanging up any call. */
export function stopCallEvents() {
  events.run++;
  if (current) hangUp(null);
}

async function listen(run) {
  let after = null;
  while (run === events.run) {
    try {
      const query = after == null ? '' : `&after=${after}`;
      const res = await api('GET', `/calls/events?device=${DEVICE}${query}`, undefined, { timeout: 40000 });
      if (run !== events.run) return;
      // First check, or the server restarted: look for a call that's already ringing.
      if (res.reset) checkActive();
      after = res.seq;
      for (const event of res.events) await handleEvent(event);
    } catch (err) {
      if (err.status === 401 || run !== events.run) return;
      await sleep(3000);
    }
  }
}

/** A call ringing for us right now (e.g. KoolKat was opened from the call notification). */
export async function checkActive() {
  try {
    const { call } = await api('GET', '/calls/active');
    if (call && call.state === 'ringing' && !call.outgoing && !current) onIncoming(call);
  } catch {
    // Offline: the next event check will find it.
  }
}

async function handleEvent(event) {
  if (event.type === 'incoming') return onIncoming(event.call);
  if (!current?.call || event.callId !== current.call.id) return;
  if (event.type === 'answered' && current.outgoing) return onAnswered();
  if (event.type === 'signal') {
    current.chain = current.chain.then(() => onSignal(event.data)).catch((err) => console.warn('Call signal', err));
    return;
  }
  if (event.type === 'ended') {
    const name = current.peer.displayName;
    const messages = {
      declined: current.outgoing ? `${name} declined` : null,
      missed: current.outgoing ? 'No answer' : `Missed ${kindLabel(current.kind)} from ${name}`,
      cancelled: current.outgoing ? null : `Missed ${kindLabel(current.kind)} from ${name}`,
      ended: `${kindLabel(current.kind)} ended`,
      lost: 'The call dropped',
      'answered-elsewhere': null,
    };
    finish(messages[event.reason] ?? `${kindLabel(current.kind)} ended`);
  }
}

// ---------- starting, answering, ending ----------
export async function startCall(friend, kind) {
  if (current) return hooks.toast("You're already in a call", { error: true });
  const me = hooks.me();
  current = newCall({ kind, outgoing: true, peer: friend });
  const mine = current;
  showScreen();
  setStatus(kind === 'video' ? 'Starting FaceTime…' : 'Calling…');
  try {
    await hooks.beforeMedia(kind);
    mine.local = await getMedia(kind, 'user');
    if (current !== mine) return stopTracks(mine.local);
    attachLocal();
    const [{ call }, iceServers] = await Promise.all([
      api('POST', '/calls', { to: friend.id, kind, device: DEVICE }),
      loadIce(),
    ]);
    if (current !== mine) {
      // Hung up while it was starting.
      api('POST', `/calls/${call.id}/end`).catch(() => {});
      return;
    }
    mine.call = call;
    mine.iceServers = iceServers;
    mine.key = await keyFor(call, me);
    setStatus(kind === 'video' ? 'FaceTiming…' : 'Ringing…');
    startRinging();
  } catch (err) {
    if (current === mine) finish(mediaError(err) || err.message);
  }
}

function onIncoming(call) {
  if (current) return; // the server already turns away calls while you're on one
  current = newCall({ kind: call.kind, outgoing: false, peer: call.peer });
  current.call = call;
  showScreen();
  setStatus(call.kind === 'video' ? 'wants to FaceTime…' : 'is calling you…');
  startRinging();
}

async function accept() {
  const mine = current;
  if (!mine || mine.outgoing || mine.answered) return;
  mine.answered = true;
  stopRinging();
  renderControls();
  setStatus('Connecting…');
  try {
    await hooks.beforeMedia(mine.kind);
    mine.local = await getMedia(mine.kind, 'user');
    if (current !== mine) return stopTracks(mine.local);
    attachLocal();
    mine.iceServers = await loadIce();
    mine.key = await keyFor(mine.call, hooks.me());
    createPeer();
    await api('POST', `/calls/${mine.call.id}/answer`, { device: DEVICE });
    watchConnecting();
  } catch (err) {
    if (current === mine) hangUp(mediaError(err) || err.message);
  }
}

async function decline() {
  if (!current?.call) return finish(null);
  const id = current.call.id;
  finish(null);
  api('POST', `/calls/${id}/decline`).catch(() => {});
}

/** Hang up (or cancel a call that's still ringing). */
export function hangUp(message = `${kindLabel(current?.kind)} ended`) {
  if (!current) return;
  const id = current.call?.id;
  finish(message);
  if (id) api('POST', `/calls/${id}/end`, undefined, { keepalive: true }).catch(() => {});
}

async function onAnswered() {
  stopRinging();
  current.answered = true;
  renderControls();
  setStatus('Connecting…');
  try {
    const pc = createPeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await send({ type: 'sdp', sdp: pc.localDescription.toJSON() });
    watchConnecting();
  } catch (err) {
    hangUp(`Couldn't start the call (${err.message})`);
  }
}

function finish(message) {
  const mine = current;
  if (!mine) return;
  current = null;
  stopRinging();
  clearInterval(mine.clock);
  clearTimeout(mine.connectTimer);
  clearTimeout(mine.reconnectTimer);
  stopTracks(mine.local);
  try {
    mine.pc?.close();
  } catch {
    // Already closed.
  }
  for (const id of ['call-remote-video', 'call-local-video', 'call-remote-audio']) $(id).srcObject = null;
  $('call-screen').hidden = true;
  document.body.classList.remove('in-call');
  if (message) hooks.toast(message);
  hooks.afterCall(mine.kind);
}

// ---------- WebRTC ----------
function newCall({ kind, outgoing, peer }) {
  return { kind, outgoing, peer, call: null, pending: [], chain: Promise.resolve(), muted: false, cameraOff: false, facing: 'user' };
}

async function keyFor(call, me) {
  // Use the key from your own friends list (the one your safety code checks).
  const peerId = call.callerId === me.userId ? call.calleeId : call.callerId;
  const publicKey = hooks.findFriend(peerId)?.publicKey ?? call.peer.publicKey;
  return callKey(me.privateKey, publicKey, call.id, call.callerId, call.calleeId);
}

async function loadIce() {
  try {
    return (await api('GET', '/calls/ice')).iceServers;
  } catch {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

async function getMedia(kind, facing) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't make calls");
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: kind === 'video' ? { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });
}

function mediaError(err) {
  if (err?.name === 'NotAllowedError') return 'KoolKat needs your microphone (and camera for FaceTime). Allow them in your browser settings.';
  if (err?.name === 'NotFoundError') return 'No microphone or camera was found';
  if (err?.name === 'NotReadableError') return 'Your microphone or camera is being used by another app';
  return null;
}

const stopTracks = (stream) => stream?.getTracks().forEach((t) => t.stop());

function createPeer() {
  const pc = new RTCPeerConnection({ iceServers: current.iceServers });
  current.pc = pc;
  current.remote = new MediaStream();
  for (const track of current.local.getTracks()) pc.addTrack(track, current.local);
  pc.ontrack = (e) => {
    if (!current || current.pc !== pc) return;
    current.remote.addTrack(e.track);
    attachRemote();
  };
  pc.onicecandidate = (e) => {
    if (e.candidate && current?.pc === pc) send({ type: 'candidate', candidate: e.candidate.toJSON() }).catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (!current || current.pc !== pc) return;
    const state = pc.connectionState;
    if (state === 'connected') {
      clearTimeout(current.connectTimer);
      clearTimeout(current.reconnectTimer);
      if (!current.startedAt) startClock();
      else setStatus(clockText());
    } else if (state === 'disconnected') {
      setStatus('Reconnecting…');
      clearTimeout(current.reconnectTimer);
      current.reconnectTimer = setTimeout(() => hangUp('The call dropped'), RECONNECT_GRACE);
    } else if (state === 'failed') {
      hangUp("Couldn't connect the call. Check your connection and try again.");
    }
  };
  return pc;
}

function watchConnecting() {
  clearTimeout(current.connectTimer);
  current.connectTimer = setTimeout(() => {
    if (current && !current.startedAt) {
      hangUp("Couldn't connect the call. One of you may be on a network that blocks calls; try Wi-Fi.");
    }
  }, CONNECT_TIMEOUT);
}

async function send(message) {
  const me = hooks.me();
  const data = await sealSignal(current.key, message, me.userId);
  await api('POST', `/calls/${current.call.id}/signal`, { device: DEVICE, data });
}

async function onSignal(data) {
  const mine = current;
  if (!mine?.key) return;
  const peerId = mine.outgoing ? mine.call.calleeId : mine.call.callerId;
  let message;
  try {
    message = await openSignal(mine.key, data, peerId);
  } catch {
    // Not from your friend (or tampered with): ignore it.
    return;
  }
  const pc = mine.pc;
  if (!pc) return;
  if (message.type === 'sdp') {
    await pc.setRemoteDescription(message.sdp);
    for (const candidate of mine.pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    if (message.sdp.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      await send({ type: 'sdp', sdp: pc.localDescription.toJSON() });
    }
  } else if (message.type === 'candidate') {
    if (pc.remoteDescription) await pc.addIceCandidate(message.candidate).catch(() => {});
    else mine.pending.push(message.candidate);
  } else if (message.type === 'camera') {
    mine.peerCameraOff = !message.on;
    renderVideo();
  }
}

// ---------- controls ----------
function toggleMute() {
  if (!current?.local) return;
  current.muted = !current.muted;
  for (const t of current.local.getAudioTracks()) t.enabled = !current.muted;
  renderControls();
}

function toggleCamera() {
  if (!current?.local || current.kind !== 'video') return;
  current.cameraOff = !current.cameraOff;
  for (const t of current.local.getVideoTracks()) t.enabled = !current.cameraOff;
  if (current.pc) send({ type: 'camera', on: !current.cameraOff }).catch(() => {});
  renderControls();
  renderVideo();
}

async function flipCamera() {
  const mine = current;
  if (!mine?.local || mine.kind !== 'video') return;
  const facing = mine.facing === 'user' ? 'environment' : 'user';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing } } });
    const [track] = stream.getVideoTracks();
    if (current !== mine) return track.stop();
    track.enabled = !mine.cameraOff;
    const sender = mine.pc?.getSenders().find((s) => s.track?.kind === 'video');
    await sender?.replaceTrack(track);
    for (const old of mine.local.getVideoTracks()) {
      mine.local.removeTrack(old);
      old.stop();
    }
    mine.local.addTrack(track);
    mine.facing = facing;
    attachLocal();
  } catch {
    hooks.toast("Couldn't switch camera", { error: true });
  }
}

// ---------- screen ----------
function showScreen() {
  hooks.beforeShow();
  const peer = current.peer;
  const avatar = $('call-avatar');
  if (peer.avatarUrl) {
    const img = document.createElement('img');
    img.src = `${API_BASE}/api/${peer.avatarUrl}`;
    img.alt = '';
    avatar.replaceChildren(img);
  } else {
    avatar.textContent = (peer.displayName || peer.username || '?')[0];
  }
  $('call-name').textContent = peer.displayName || peer.username;
  $('call-kind').textContent = current.kind === 'video' ? '📹 FaceTime' : '📞 Call';
  $('call-screen').hidden = false;
  $('call-screen').dataset.kind = current.kind;
  document.body.classList.add('in-call');
  renderControls();
  renderVideo();
}

function setStatus(text) {
  $('call-status').textContent = text;
}

function renderControls() {
  const incoming = current && !current.outgoing && !current.answered;
  $('call-incoming-controls').hidden = !incoming;
  $('call-active-controls').hidden = incoming;
  $('btn-call-accept').setAttribute('aria-label', current?.kind === 'video' ? 'Answer FaceTime' : 'Answer call');
  $('btn-call-mute').setAttribute('aria-pressed', String(Boolean(current?.muted)));
  $('btn-call-camera').setAttribute('aria-pressed', String(Boolean(current?.cameraOff)));
  $('btn-call-camera').hidden = current?.kind !== 'video';
  $('btn-call-flip').hidden = current?.kind !== 'video';
}

function renderVideo() {
  const video = current?.kind === 'video';
  const remoteShowing = video && current.startedAt && !current.peerCameraOff;
  $('call-remote-video').hidden = !remoteShowing;
  $('call-local-video').hidden = !video || current.cameraOff;
  $('call-screen').classList.toggle('has-video', Boolean(remoteShowing));
  $('call-peer-camera-off').hidden = !(video && current.startedAt && current.peerCameraOff);
}

function attachLocal() {
  const local = $('call-local-video');
  local.srcObject = current.kind === 'video' ? current.local : null;
  local.classList.toggle('mirrored', current.facing === 'user');
  local.play?.().catch(() => {});
  renderVideo();
}

function attachRemote() {
  // Sound always plays through the audio element; the video element only shows the picture.
  const audio = $('call-remote-audio');
  if (audio.srcObject !== current.remote) audio.srcObject = current.remote;
  audio.play().catch(() => {});
  if (current.kind === 'video') {
    const video = $('call-remote-video');
    if (video.srcObject !== current.remote) video.srcObject = current.remote;
    video.play().catch(() => {});
  }
  renderVideo();
}

function startClock() {
  current.startedAt = Date.now();
  setStatus(clockText());
  renderVideo();
  current.clock = setInterval(() => current && setStatus(clockText()), 1000);
}

function clockText() {
  const s = Math.floor((Date.now() - current.startedAt) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

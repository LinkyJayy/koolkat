import { API_BASE, api, getToken, setToken, setUnauthorizedHandler } from './api.js';
import {
  disablePush,
  enablePush,
  needsHomeScreenInstall,
  pushPreferenceOff,
  pushState,
  pushSupported,
  registerServiceWorker,
  resyncPush,
  setPushPreference,
} from './push.js';
import { clearIdentity, loadIdentity, saveIdentity } from './keystore.js';
import {
  createIdentity,
  decryptMessage,
  decryptSnap,
  encryptMessage,
  deriveKeysFromPassword,
  encryptSnap,
  fingerprint,
  unlockIdentity,
} from './crypto.js';
import { drawQr, friendLink, parseFriendCode, scanVideo } from './qr.js';
import { compose, grabFrame, openCamera, stopStream, waitForPicture } from './katcam.js';
import { checkActive, initCalls, startCall, startCallEvents, stopCallEvents, usingCamera } from './calls.js';
import { playNotification, setSoundsOn, soundsOn } from './sounds.js';

const $ = (id) => document.getElementById(id);

// Show unexpected errors on screen instead of failing silently.
window.addEventListener('error', (e) => toast(`Something went wrong: ${e.message}`, { error: true }));
window.addEventListener('unhandledrejection', (e) =>
  toast(`Something went wrong: ${e.reason?.message || e.reason}`, { error: true })
);

const state = {
  me: null, // { userId, username, displayName, publicKey, privateKey }
  friends: [],
  incoming: [],
  outgoing: [],
  inbox: [],
  facing: 'user',
  stream: null,
  // KatCam: both cameras in one Klick. insetStream is the second camera when the
  // phone can run both at once; otherwise the selfie is taken right after.
  katcam: false,
  insetStream: null,
  katcamOneAtATime: false,
  capturing: false,
  capture: null, // { blob, url, width, height }
  caption: { y: 0.5 },
  selected: new Set(),
  inboxTab: 'received',
  screen: null,
  pollTimer: null,
};

// ---------- small DOM helpers ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

/** Show someone's profile picture in an avatar circle, or their first letter if they have none. */
function fillAvatar(node, user) {
  const letter = (user?.displayName || user?.username || '?').trim()[0] || '?';
  if (user?.avatarUrl) {
    node.replaceChildren(el('img', { src: `${API_BASE}/api/${user.avatarUrl}`, alt: '', loading: 'lazy' }));
  } else {
    node.textContent = letter;
  }
  return node;
}
const avatar = (user, cls = '') => fillAvatar(el('span', { class: `avatar ${cls}` }), user);

/** A user's display name, with the Kool badge if they have KoolKat Unlimited. */
// The default Kool badge, or the custom badge picture someone uploaded.
const badgeSrc = (user) => (user?.badgeUrl ? `${API_BASE}/api/${user.badgeUrl}` : 'icons/kool-badge.png');
/** The verified tick, the Kool badge (Unlimited) and, on their birthday, a 🎉, to go after someone's name. */
const badgeImg = (user) => {
  const parts = nodes(
    user?.verified && el('img', { src: 'icons/social/verified.png', alt: 'Verified', title: 'Verified', class: 'verified-badge' }),
    user?.badge && el('img', { src: badgeSrc(user), alt: 'KoolKat Unlimited', title: 'KoolKat Unlimited', class: 'kool-badge' }),
    user?.birthday && el('span', { class: 'birthday-pop', title: "It's their birthday!", 'aria-label': "It's their birthday", text: '🎉' })
  );
  if (parts.length < 2) return parts[0] ?? null;
  return el('span', { class: 'name-marks' }, ...parts);
};
const bffImg = (user) => (user?.bff ? el('img', { src: 'icons/bff-heart.png', alt: 'BFF', title: 'BFF', class: 'bff-heart' }) : null);
/** Drop empty parts, so replaceChildren() doesn't print "null". */
const nodes = (...parts) => parts.filter((p) => p != null && p !== false);
const nameEl = (user, cls = 'item-title') => el('div', { class: cls }, user.displayName, badgeImg(user));

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

let toastTimer;
function toast(message, { error = false } = {}) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function streakBadge(streak) {
  if (!streak || streak.count < 1) return null;
  return el('span', {
    class: `streak${streak.expiring ? ' expiring' : ''}`,
    title: streak.expiring ? 'Send each other a Klick today to keep your streak!' : `${streak.count} day streak`,
    text: `🔥 ${streak.count}`,
  });
}

// ---------- screens ----------
function show(name) {
  if (state.screen === 'camera' && name !== 'camera') stopCamera();
  if (state.screen === 'chat' && name !== 'chat') stopChatPolling();
  if (state.screen === 'scan' && name !== 'scan') stopScanner();
  if (state.screen === 'nearby' && name !== 'nearby') stopNearby();
  if (state.screen === 'katmap' && name !== 'katmap') stopKatMap();
  // Don't leave News videos playing in the background.
  if (state.screen === 'news' && name !== 'news') {
    for (const video of document.querySelectorAll('#screen-news video')) video.pause();
  }
  if (state.screen === 'reels' && name !== 'reels') pauseReels();
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== `screen-${name}`;
  state.screen = name;
  // The tab bar (Home, Reels, Camera, Klicks, Chats) shows on the main screens.
  const tabbed = TAB_SCREENS.has(name);
  $('tabbar').hidden = !tabbed;
  $('tabbar').classList.toggle('dark', name === 'reels');
  document.body.classList.toggle('has-tabbar', tabbed);
  for (const tab of document.querySelectorAll('[data-tab-screen]')) {
    const on = tab.dataset.tabScreen === name;
    tab.classList.toggle('active', on);
    if (on) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (name === 'camera') startCamera();
}
const TAB_SCREENS = new Set(['home', 'reels', 'inbox', 'chats']);

document.addEventListener('click', (e) => {
  const back = e.target.closest('[data-back]');
  if (!back) return;
  // Going back to the chat list reloads it (new messages, order, BFF pins).
  if (back.dataset.back === 'chats') openChats();
  else if (back.dataset.back === 'friends') openFriends();
  else if (back.dataset.back === 'home') openHome();
  else show(back.dataset.back);
});

// ---------- auth ----------
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  for (const tab of document.querySelectorAll('[data-auth-tab]')) {
    tab.classList.toggle('active', tab.dataset.authTab === mode);
  }
  for (const node of document.querySelectorAll('.register-only')) node.hidden = mode !== 'register';
  const form = $('auth-form');
  form.displayName.required = mode === 'register';
  form.confirm.required = mode === 'register';
  form.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('auth-submit').textContent = mode === 'register' ? 'Create account' : 'Sign in';
  $('auth-error').textContent = '';
}

for (const tab of document.querySelectorAll('[data-auth-tab]')) {
  tab.addEventListener('click', () => setAuthMode(tab.dataset.authTab));
}

// Usernames can't contain spaces. Phone keyboards often add one after a word
// suggestion, so strip them as you type instead of silently refusing the form.
$('auth-form').username.addEventListener('input', (e) => {
  const cleaned = e.target.value.replace(/\s+/g, '');
  if (cleaned !== e.target.value) e.target.value = cleaned;
});

function authFormError(form, username, password) {
  if (!username) return 'Enter your username';
  if (!password) return 'Enter your password';
  if (authMode !== 'register') return null;
  if (!/^[A-Za-z0-9_.]{3,20}$/.test(username)) return 'Username must be 3-20 characters: letters, numbers, _ or .';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password !== form.confirm.value) return "Passwords don't match";
  return null;
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const username = form.username.value.replace(/\s+/g, '');
  form.username.value = username;
  const password = form.password.value;
  const submit = $('auth-submit');
  const errorBox = $('auth-error');
  errorBox.textContent = '';

  const problem = authFormError(form, username, password);
  if (problem) {
    errorBox.textContent = problem;
    return;
  }

  const label = submit.textContent;
  submit.disabled = true;
  submit.textContent = authMode === 'register' ? 'Creating your keys…' : 'Unlocking…';
  try {
    const { authSecret, vaultKey } = await deriveKeysFromPassword(username, password);
    let me;
    if (authMode === 'register') {
      const identity = await createIdentity(vaultKey);
      const res = await api('POST', '/auth/register', {
        username,
        displayName: form.displayName.value.trim() || username,
        authSecret,
        publicKey: identity.publicKey,
        encryptedPrivateKey: identity.encryptedPrivateKey,
        privateKeyIv: identity.privateKeyIv,
      });
      setToken(res.token);
      me = { ...res.user, publicKey: identity.publicKey, privateKey: identity.privateKey };
    } else {
      const res = await api('POST', '/auth/login', { username, authSecret });
      setToken(res.token);
      const privateKey = await unlockIdentity(vaultKey, res.encryptedPrivateKey, res.privateKeyIv);
      me = { ...res.user, publicKey: res.publicKey, privateKey };
    }
    state.me = { userId: me.id, username: me.username, displayName: me.displayName, publicKey: me.publicKey, privateKey: me.privateKey };
    await saveIdentity(state.me);
    form.reset();
    enterApp();
  } catch (err) {
    setToken(null);
    errorBox.textContent =
      err.name === 'OperationError' ? "Couldn't unlock your encryption key." : err.message;
  } finally {
    submit.disabled = false;
    submit.textContent = label;
  }
});

async function logout() {
  // Stop notifications for this account on this device before the token goes away.
  await disablePush().catch(() => {});
  try {
    await api('POST', '/auth/logout');
  } catch {
    /* already signed out */
  }
  signedOut();
}

function signedOut() {
  window.koolkatTheme.setAccent(null);
  applyAppIcon({ icon: 'default' });
  stopMapSharing();
  stopCallEvents();
  alertCounts = null;
  applyAppIcon(null);
  setToken(null);
  clearIdentity();
  clearInterval(state.pollTimer);
  stopChatPolling();
  chat.current = null;
  chat.decrypted.clear();
  state.chats = [];
  state.me = null;
  state.friends = [];
  state.inbox = [];
  discardCapture();
  setAuthMode('login');
  show('auth');
}
setUnauthorizedHandler(() => {
  if (state.me) {
    toast('Your session ended. Please sign in again.', { error: true });
    signedOut();
  }
});

function enterApp() {
  fillAvatar($('my-avatar'), state.me);
  openHome();
  refresh();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 10000);
  resyncPush();
  startCallEvents();
  refreshMe()
    .then(() => {
      maybeAskBirthday();
      return resumeMapSharing();
    })
    .catch(() => {});
  // Opened from a notification: jump to what it was about.
  const view = location.hash.slice(1);
  if (view) {
    history.replaceState(null, '', location.pathname + location.search);
    openView(view);
  }
}

function openView(view) {
  if (!state.me) return;
  // A friend's QR code opened with the phone's own camera app.
  if (view.startsWith('add/')) {
    const code = parseFriendCode(`#${view}`);
    if (code) addByCode(code).catch((err) => toast(err.message, { error: true }));
    else toast("That friend link isn't valid", { error: true });
    return;
  }
  // A Call or FaceTime notification: show the call that's ringing.
  if (view === 'call') {
    checkActive();
    return;
  }
  if (view === 'inbox') openInbox();
  else if (view === 'friends') openFriends();
  else if (view === 'chats') openChats();
  else if (view === 'news') openNews();
  else if (view === 'reels') openReels();
  else if (view === 'camera') show('camera');
  else if (state.screen !== 'home') openHome();
}

// ---------- data ----------
async function refreshFriends() {
  const data = await api('GET', '/friends');
  state.friends = data.friends;
  state.incoming = data.incoming;
  state.outgoing = data.outgoing;
  const badge = $('badge-friends');
  badge.hidden = data.incoming.length === 0;
  badge.textContent = data.incoming.length;
}

async function refreshInbox() {
  const { snaps, hasMore } = await api('GET', '/snaps/inbox');
  // Keep any older pages already loaded with "Show older Klicks".
  const oldest = snaps.at(-1)?.createdAt ?? 0;
  const older = hasMore ? state.inbox.filter((s) => s.createdAt < oldest) : [];
  state.inbox = [...snaps, ...older];
  if (!older.length) state.inboxHasMore = hasMore;
  const unopened = state.inbox.filter((s) => !s.opened).length;
  const badge = $('badge-inbox');
  badge.hidden = unopened === 0;
  badge.textContent = unopened;
}

// New friend requests, Klicks and messages since the last check play the
// notification sound (not on the first check after opening KoolKat).
let alertCounts = null;

function playSoundForNewThings() {
  const counts = {
    requests: state.incoming.length,
    klicks: state.inbox.filter((s) => !s.opened).length,
    messages: state.unreadMessages ?? 0,
  };
  const before = alertCounts;
  alertCounts = counts;
  if (before && Object.keys(counts).some((k) => counts[k] > before[k])) playNotification();
}

async function refresh() {
  try {
    await Promise.all([refreshFriends(), refreshInbox(), refreshChats(), refreshNewsBadge()]);
    playSoundForNewThings();
    if (state.screen === 'chats') renderChats();
    if (state.screen === 'friends') {
      renderFriends();
      if ($('search-input').value.trim()) runSearch();
    }
    if (state.screen === 'inbox' && state.inboxTab === 'received') renderInbox();
    if (state.screen === 'home') {
      renderHomeKlicks();
      renderHomeFriends();
      if (home.chip === 'all') $('home-friends-shelf').hidden = !state.friends.length;
    }
  } catch {
    /* offline; try again on the next tick */
  }
}

// ---------- camera ----------
// Each start gets a number; anything that finishes for an older start is thrown
// away, so overlapping starts (flip, retry, leaving the screen) never leave a
// stale stream holding the camera.
let cameraRun = 0;
let cameraRetryAction = null;

function showCameraMessage(text, { button = 'Try again', action = startCamera } = {}) {
  $('camera-message-text').textContent = text;
  const retry = $('camera-retry');
  retry.hidden = !button;
  retry.textContent = button || '';
  cameraRetryAction = action;
  $('camera-message').hidden = false;
}

function hideCameraMessage() {
  $('camera-message').hidden = true;
}

const CAMERA_ERRORS = {
  NotAllowedError: 'KoolKat needs camera access. Tap the lock icon next to the address, allow Camera, then try again.',
  SecurityError: 'Camera access is blocked on this page.',
  NotFoundError: 'No camera was found on this device.',
  NotReadableError: 'Your camera is being used by another app. Close it and try again.',
  AbortError: 'The camera could not be started. Close other apps using it and try again.',
};

async function startCamera() {
  // FaceTime is using the camera; it comes back when the call ends.
  if (usingCamera()) return;
  const run = ++cameraRun;
  releaseCamera();
  hideCameraMessage();
  const video = $('camera-video');
  if (!window.isSecureContext) {
    showCameraMessage('The camera only works over HTTPS (or on localhost). Open KoolKat from a secure address.', { button: null });
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraMessage(
      "This browser doesn't allow camera access. If you opened KoolKat from inside another app, open it in Chrome or Safari instead.",
      { button: null }
    );
    return;
  }

  // If nothing happens for a moment, the browser is probably asking for permission.
  const waiting = setTimeout(() => {
    if (run === cameraRun && !state.stream) {
      showCameraMessage('Starting the camera… If your browser asks for permission, tap Allow.', { button: null });
    }
  }, 1500);

  const facing = state.facing;
  // Try the best quality first, then simpler requests for cameras that refuse it.
  const attempts = [
    { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    { facingMode: { ideal: facing } },
    true,
  ];
  let stream = null;
  let error = null;
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
      break;
    } catch (err) {
      error = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') break;
    }
  }
  clearTimeout(waiting);

  if (run !== cameraRun || state.screen !== 'camera') {
    stream?.getTracks().forEach((t) => t.stop());
    return;
  }
  if (!stream) {
    const reason = CAMERA_ERRORS[error?.name] || "Couldn't start the camera.";
    showCameraMessage(`${reason} (${error?.name || 'unknown error'})`);
    return;
  }

  state.stream = stream;
  hideCameraMessage();
  const [track] = stream.getVideoTracks();
  const actualFacing = track?.getSettings?.().facingMode;
  video.classList.toggle('mirrored', (actualFacing || facing) === 'user');
  track?.addEventListener('ended', () => {
    if (state.stream === stream && state.screen === 'camera') showCameraMessage('The camera stopped.');
  });

  video.srcObject = stream;
  // Safety net: the stream is "on" but no picture ever arrives. (Set up before
  // play(), which never settles in that case.)
  setTimeout(() => {
    if (run === cameraRun && state.stream === stream && state.screen === 'camera' && !video.videoWidth) {
      const details = `track ${track?.readyState}${track?.muted ? ', muted' : ''}, video ${video.readyState}`;
      showCameraMessage(`The camera isn't showing a picture. Try again, or flip to the other camera. (${details})`);
    }
  }, 4000);
  try {
    await video.play();
  } catch {
    // Some browsers only start video after a tap.
    if (run === cameraRun) {
      showCameraMessage('Tap to turn on the camera.', {
        button: 'Start camera',
        action: () => video.play().then(hideCameraMessage, startCamera),
      });
    }
    return;
  }
  if (state.katcam) startInset(run);
}

function releaseCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  $('camera-video').srcObject = null;
  stopStream(state.insetStream);
  state.insetStream = null;
  $('katcam-video').srcObject = null;
}

// ---------- KatCam ----------
const otherFacing = () => (state.facing === 'user' ? 'environment' : 'user');

function renderKatcam() {
  const on = state.katcam;
  $('btn-katcam').setAttribute('aria-pressed', String(on));
  $('katcam-inset').hidden = !on;
  const live = on && Boolean(state.insetStream);
  $('katcam-video').hidden = !live;
  $('katcam-later').hidden = !on || live;
  $('katcam-later').replaceChildren(otherFacing() === 'user' ? '🤳' : '📷', el('br'), otherFacing() === 'user' ? 'Selfie after' : 'Back camera after');
}

function setKatcamStatus(text) {
  $('katcam-status').textContent = text || '';
  $('katcam-status').hidden = !text;
}

/** Try to run the second camera alongside the first. Many phones can't; then KatCam takes them one after the other. */
async function startInset(run) {
  renderKatcam();
  if (state.katcamOneAtATime) return;
  const main = state.stream?.getVideoTracks()[0];
  let stream;
  try {
    stream = await openCamera(otherFacing(), { exact: true });
  } catch {
    state.katcamOneAtATime = true;
    renderKatcam();
    return;
  }
  if (run !== cameraRun || state.screen !== 'camera' || !state.katcam) {
    stopStream(stream);
    return;
  }
  const video = $('katcam-video');
  video.srcObject = stream;
  video.classList.toggle('mirrored', otherFacing() === 'user');
  video.play().catch(() => {});
  const showing = await waitForPicture(video, 2500);
  // Opening a second camera often silently stops the first one.
  await new Promise((r) => setTimeout(r, 300));
  const sameCamera = stream.getVideoTracks()[0]?.getSettings().deviceId === main?.getSettings().deviceId;
  const mainAlive = main?.readyState === 'live' && !main.muted && state.stream?.getVideoTracks()[0] === main;
  if (run !== cameraRun || !state.katcam) {
    stopStream(stream);
    return;
  }
  if (!showing || !mainAlive || sameCamera) {
    stopStream(stream);
    video.srcObject = null;
    state.katcamOneAtATime = true;
    renderKatcam();
    if (!mainAlive) startCamera();
    return;
  }
  state.insetStream = stream;
  renderKatcam();
}

$('btn-katcam').addEventListener('click', () => {
  state.katcam = !state.katcam;
  try {
    localStorage.setItem('koolkat-katcam', state.katcam ? '1' : '');
  } catch {
    // Remembering it is only a convenience.
  }
  if (state.katcam) {
    // The back camera fills the Klick, with your selfie in the corner (flip swaps them).
    state.facing = 'environment';
    toast('😺 KatCam on: both cameras in one Klick');
  }
  setKatcamStatus('');
  startCamera();
  renderKatcam();
});
try {
  state.katcam = localStorage.getItem('koolkat-katcam') === '1';
  if (state.katcam) state.facing = 'environment';
} catch {
  // Private mode: start with KatCam off.
}
renderKatcam();

/** Take the second picture straight after the first, for phones that only run one camera at a time. */
async function takeOtherPicture() {
  const facing = otherFacing();
  stopCamera();
  const video = $('katcam-video');
  $('katcam-later').hidden = true;
  video.hidden = false;
  setKatcamStatus(facing === 'user' ? 'Now smile! 📸' : 'Now the back camera… 📸');
  let stream;
  try {
    stream = await openCamera(facing, { exact: true });
    video.srcObject = stream;
    video.classList.toggle('mirrored', facing === 'user');
    await video.play().catch(() => {});
    if (!(await waitForPicture(video, 3000))) return null;
    // Give the camera a moment to adjust to the light.
    await new Promise((r) => setTimeout(r, 600));
    return grabFrame(video, { mirror: facing === 'user', max: 960 });
  } catch {
    return null;
  } finally {
    stopStream(stream);
    video.srcObject = null;
    setKatcamStatus('');
  }
}

function stopCamera() {
  cameraRun++; // cancel any start still waiting on the browser
  releaseCamera();
}

$('camera-retry').addEventListener('click', () => (cameraRetryAction || startCamera)());
$('btn-flip').addEventListener('click', () => {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  startCamera();
});

// Phones turn the camera off when you switch apps; turn it back on when you return.
document.addEventListener('visibilitychange', () => {
  if (state.screen !== 'camera') return;
  if (document.visibilityState === 'hidden') stopCamera();
  else startCamera();
});

$('btn-shutter').addEventListener('click', async () => {
  const video = $('camera-video');
  if (state.capturing) return;
  if (!state.stream || !video.videoWidth) {
    toast('The camera is not ready yet', { error: true });
    return;
  }
  // Save selfies the way they looked in the preview.
  let canvas = grabFrame(video, { mirror: video.classList.contains('mirrored') });
  if (state.katcam) {
    state.capturing = true;
    try {
      const insetVideo = $('katcam-video');
      let inset = null;
      if (state.insetStream && insetVideo.videoWidth) {
        inset = grabFrame(insetVideo, { mirror: insetVideo.classList.contains('mirrored'), max: 960 });
      } else {
        inset = await takeOtherPicture();
      }
      if (inset) canvas = compose(canvas, inset);
      else toast("Couldn't use your other camera, so this Klick only has one picture", { error: true });
    } finally {
      state.capturing = false;
    }
  }
  const { width, height } = canvas;
  canvas.toBlob(
    (blob) => {
      if (!blob) {
        if (state.screen === 'camera' && !state.stream) startCamera();
        return toast('Could not take the photo', { error: true });
      }
      discardCapture();
      state.capture = { blob, url: URL.createObjectURL(blob), width, height };
      openPreview();
    },
    'image/jpeg',
    0.85
  );
});

// ---------- preview & caption ----------
function fitFrame(frame, width, height) {
  const stage = frame.parentElement;
  const scale = Math.min(stage.clientWidth / width, stage.clientHeight / height);
  frame.style.width = `${Math.floor(width * scale)}px`;
  frame.style.height = `${Math.floor(height * scale)}px`;
}

function placeCaption(bar, y) {
  bar.style.top = `${(y * 100).toFixed(2)}%`;
}

function openPreview() {
  $('preview-img').src = state.capture.url;
  $('caption-input').value = '';
  $('caption-bar').hidden = true;
  $('caption-hint').hidden = false;
  state.caption.y = 0.5;
  show('preview');
  fitFrame($('preview-frame'), state.capture.width, state.capture.height);
}

function discardCapture() {
  if (state.capture) URL.revokeObjectURL(state.capture.url);
  state.capture = null;
  state.selected.clear();
}

function editCaption(y) {
  if (y != null) state.caption.y = Math.min(Math.max(y, 0.05), 0.95);
  const bar = $('caption-bar');
  placeCaption(bar, state.caption.y);
  bar.hidden = false;
  $('caption-hint').hidden = true;
  fitCaptionInput();
  $('caption-input').focus();
}

$('preview-frame').addEventListener('click', (e) => {
  if (e.target.closest('#caption-bar')) return;
  const rect = e.currentTarget.getBoundingClientRect();
  editCaption((e.clientY - rect.top) / rect.height);
});
$('btn-caption').addEventListener('click', () => editCaption());
$('caption-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
});
// Grow the caption box onto more lines as it fills the width.
function fitCaptionInput() {
  const input = $('caption-input');
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}
$('caption-input').addEventListener('input', (e) => {
  // Pasted line breaks become spaces: the caption wraps by itself.
  if (/\n/.test(e.target.value)) e.target.value = e.target.value.replace(/\s*\n\s*/g, ' ');
  fitCaptionInput();
});
$('caption-input').addEventListener('blur', (e) => {
  if (!e.target.value.trim()) $('caption-bar').hidden = true;
});
$('btn-discard').addEventListener('click', () => {
  discardCapture();
  show('camera');
});
$('btn-to-send').addEventListener('click', () => {
  show('send');
  renderSendList();
  refreshFriends().then(renderSendList).catch(() => {});
});

// ---------- choose recipients & send ----------
function renderSendList() {
  const list = $('send-list');
  list.replaceChildren(
    ...state.friends.map((f) =>
      el(
        'li',
        {},
        el(
          'label',
          { class: 'item' },
          avatar(f),
          el(
            'span',
            { class: 'item-main' },
            nameEl(f),
            el('div', { class: 'item-sub', text: `@${f.username}` })
          ),
          streakBadge(f.streak),
          el('input', {
            type: 'checkbox',
            checked: state.selected.has(f.id),
            'aria-label': `Send to ${f.displayName}`,
            onchange: (e) => {
              if (e.target.checked) state.selected.add(f.id);
              else state.selected.delete(f.id);
              updateSendBar();
            },
          })
        )
      )
    )
  );
  // Drop selections for anyone who is no longer a friend.
  for (const id of state.selected) if (!state.friends.some((f) => f.id === id)) state.selected.delete(id);
  $('send-empty').hidden = state.friends.length > 0;
  updateSendBar();
}

function updateSendBar() {
  const chosen = state.friends.filter((f) => state.selected.has(f.id));
  $('send-bar').hidden = chosen.length === 0;
  $('send-summary').textContent = chosen.map((f) => f.displayName).join(', ');
}

$('btn-send').addEventListener('click', async () => {
  const button = $('btn-send');
  const recipients = state.friends
    .filter((f) => state.selected.has(f.id))
    .map((f) => ({ userId: f.id, publicKey: f.publicKey }));
  if (!recipients.length || !state.capture) return;
  button.disabled = true;
  button.textContent = 'Encrypting…';
  try {
    const image = new Uint8Array(await state.capture.blob.arrayBuffer());
    const caption = $('caption-input').value.trim();
    // Also encrypt the snap for yourself, so you can view it later from Sent.
    const payload = await encryptSnap(image, { caption, captionY: state.caption.y, mime: 'image/jpeg' }, recipients, {
      userId: state.me.userId,
      publicKey: state.me.publicKey,
    });
    button.textContent = 'Sending…';
    await api('POST', '/snaps', payload);
    toast(recipients.length === 1 ? 'Klick sent!' : `Klick sent to ${recipients.length} friends!`);
    discardCapture();
    show('camera');
    refreshFriends().catch(() => {});
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    button.disabled = false;
    button.textContent = 'Send';
  }
});

// ---------- inbox ----------
for (const tab of document.querySelectorAll('[data-inbox-tab]')) {
  tab.addEventListener('click', () => {
    state.inboxTab = tab.dataset.inboxTab;
    for (const t of document.querySelectorAll('[data-inbox-tab]')) t.classList.toggle('active', t === tab);
    loadInbox();
  });
}
function openInbox() {
  show('inbox');
  loadInbox();
  renderNotifyBanner();
}
$('btn-inbox').addEventListener('click', openInbox);
$('btn-inbox-refresh').addEventListener('click', loadInbox);

async function loadInbox() {
  try {
    if (state.inboxTab === 'received') {
      renderInbox();
      await refreshInbox();
      renderInbox();
    } else {
      renderSent((await api('GET', '/snaps/sent')).snaps);
    }
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function inboxStatus(s) {
  if (!s.available) return 'No longer available';
  if (!s.opened) return `New Klick · ${timeAgo(s.createdAt)}`;
  return `Sent ${timeAgo(s.createdAt)} · tap to view again`;
}

function renderInbox() {
  const empty = $('inbox-empty');
  $('inbox-empty-text').textContent = 'No Klicks yet. When friends send you Klicks, they show up here.';
  empty.hidden = state.inbox.length > 0;
  const rows = state.inbox.map((s) =>
    el(
      'li',
      {},
      el(
        'button',
        { type: 'button', class: 'item', disabled: !s.available, onclick: () => openSnap(s) },
        avatar(s.from),
        el(
          'span',
          { class: 'item-main' },
          nameEl(s.from),
          el(
            'div',
            { class: `item-sub${s.opened ? '' : ' new'}` },
            el('span', { class: `snap-icon${s.opened ? '' : ' new'}` }),
            inboxStatus(s)
          )
        ),
        streakBadge(state.friends.find((f) => f.id === s.from.id)?.streak)
      )
    )
  );
  if (state.inboxHasMore) {
    rows.push(
      el(
        'li',
        { class: 'load-more' },
        el('button', { type: 'button', class: 'btn', text: 'Show older Klicks', onclick: (e) => withBusy(e.currentTarget, loadOlderSnaps) })
      )
    );
  }
  $('inbox-list').replaceChildren(...rows);
}

async function loadOlderSnaps() {
  const before = state.inbox.at(-1)?.createdAt;
  if (!before) return;
  const { snaps, hasMore } = await api('GET', `/snaps/inbox?before=${before}`);
  const known = new Set(state.inbox.map((s) => s.id));
  state.inbox.push(...snaps.filter((s) => !known.has(s.id)));
  state.inboxHasMore = hasMore;
  renderInbox();
}

function renderSent(snaps) {
  const empty = $('inbox-empty');
  $('inbox-empty-text').textContent = "You haven't sent any Klicks yet.";
  empty.hidden = snaps.length > 0;
  $('inbox-list').replaceChildren(
    ...snaps.map((s) => {
      const opened = s.recipients.filter((r) => r.opened).length;
      const status =
        opened === s.recipients.length ? 'Opened' : opened > 0 ? `Opened by ${opened} of ${s.recipients.length}` : 'Delivered';
      return el(
        'li',
        {},
        el(
          s.viewable ? 'button' : 'div',
          {
            type: s.viewable ? 'button' : null,
            class: 'item',
            onclick: s.viewable ? () => openSnap({ ...s, own: true, available: true }) : null,
          },
          el('span', { class: `snap-icon sent${opened === s.recipients.length ? ' opened' : ''}` }),
          el(
            'span',
            { class: 'item-main' },
            el('div', { class: 'item-title', text: `To ${s.recipients.map((r) => r.displayName).join(', ')}` }),
            el('div', { class: 'item-sub', text: `${status} · ${timeAgo(s.createdAt)}${s.viewable ? ' · tap to view' : ''}` })
          )
        )
      );
    })
  );
}

// ---------- viewer ----------
let viewer = null;

async function openSnap(summary) {
  const returnTo = state.screen;
  try {
    const snap = await api('GET', `/snaps/${encodeURIComponent(summary.id)}`);
    const opened = await decryptSnap(snap, state.me.privateKey, state.me.userId);
    const url = URL.createObjectURL(new Blob([opened.imageBytes], { type: opened.mime }));
    const img = $('viewer-img');
    img.src = url;
    await img.decode();

    $('viewer-from').replaceChildren(
      ...nodes(...(snap.own ? [`You → ${snap.to.map((u) => u.displayName).join(', ')}`] : [snap.from.displayName, badgeImg(snap.from)]))
    );
    $('viewer-time').textContent = timeAgo(snap.createdAt);
    const cap = $('viewer-caption');
    cap.textContent = opened.caption;
    cap.hidden = !opened.caption;
    placeCaption(cap, opened.captionY);
    // Keep the hint away from the caption, and let it fade out.
    const hint = $('viewer-hint');
    hint.classList.toggle('top', Boolean(opened.caption) && opened.captionY > 0.6);
    hint.classList.remove('faded');
    clearTimeout(hint.fadeTimer);
    hint.fadeTimer = setTimeout(() => hint.classList.add('faded'), 3000);

    show('viewer');
    fitFrame($('viewer-frame'), img.naturalWidth, img.naturalHeight);
    viewer = { url, summary, own: Boolean(snap.own), returnTo, size: [img.naturalWidth, img.naturalHeight] };
    setFavoriteButton(Boolean(snap.favorite));

    if (!snap.own && !summary.opened) {
      summary.opened = true;
      summary.openedAt = Date.now();
      api('POST', `/snaps/${encodeURIComponent(summary.id)}/viewed`).catch(() => {});
    }
  } catch (err) {
    if (err.status === 410 || err.status === 404) summary.available = false;
    toast(err.name === 'OperationError' ? "This Klick couldn't be decrypted." : err.message, { error: true });
    if (returnTo === 'favorites') loadFavorites();
    else if (summary.own) loadInbox();
    else renderInbox();
  }
}

function closeSnap() {
  if (!viewer) return;
  const { returnTo } = viewer;
  URL.revokeObjectURL(viewer.url);
  $('viewer-img').removeAttribute('src');
  viewer = null;
  if (returnTo === 'favorites') {
    openFavorites();
  } else {
    show('inbox');
    loadInbox();
  }
}
$('screen-viewer').addEventListener('click', (e) => {
  if (!e.target.closest('.viewer-actions')) closeSnap();
});

// ---------- news ----------
async function refreshNewsBadge() {
  const { unread } = await api('GET', '/news/unread');
  $('badge-news').hidden = unread === 0;
  $('badge-news').textContent = unread;
}

// News has two styles (remembered on this device): Formal, like reading a
// newspaper, and TikTok, a full-screen feed you swipe through.
const news = { posts: [], canPost: false, mode: 'formal', edit: null, observer: null };
try {
  news.mode = localStorage.getItem('koolkat.newsMode') === 'tiktok' ? 'tiktok' : 'formal';
} catch {
  // Private mode: start in Formal.
}

function openNews(focus = null) {
  show('news');
  news.focus = typeof focus === 'number' ? focus : null;
  renderNewsMode();
  loadNews();
}
$('btn-news').addEventListener('click', () => openNews());

async function loadNews() {
  try {
    const { posts, canPost } = await api('GET', '/news');
    news.posts = posts;
    news.canPost = canPost;
    renderNews();
    if (news.focus != null) {
      const i = posts.findIndex((p) => p.id === news.focus);
      const target = news.mode === 'tiktok' ? $('news-feed').children[i] : document.querySelector(`#news-list [data-post="${news.focus}"]`);
      target?.scrollIntoView({ block: 'start' });
      news.focus = null;
    }
    await api('POST', '/news/seen');
    $('badge-news').hidden = true;
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function setNewsMode(mode) {
  news.mode = mode;
  try {
    localStorage.setItem('koolkat.newsMode', mode);
  } catch {
    // Remembering it is only a convenience.
  }
  renderNewsMode();
  renderNews();
}

function renderNewsMode() {
  const tiktok = news.mode === 'tiktok';
  for (const tab of document.querySelectorAll('#news-modes .tab')) {
    const on = tab.dataset.mode === news.mode;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-checked', String(on));
  }
  $('screen-news').classList.toggle('news-tiktok', tiktok);
}
$('news-modes').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) setNewsMode(tab.dataset.mode);
});

const longDate = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

function renderNews() {
  const tiktok = news.mode === 'tiktok';
  // In TikTok style, admins write and edit posts by switching back to Formal.
  $('news-form').hidden = !news.canPost || tiktok;
  $('news-list').hidden = tiktok;
  $('news-feed').hidden = !tiktok;
  $('news-empty').hidden = news.posts.length > 0;
  $('news-list').className = 'news-list news-formal';
  if (tiktok) renderTikTok();
  else $('news-list').replaceChildren(...news.posts.map((p) => formalArticle(p)));
}

// ---------- shared pieces ----------
function authorButton(author, cls) {
  if (!author) return el('span', { class: cls, text: 'KoolKat' });
  return el(
    'button',
    { type: 'button', class: `${cls} author-link`, onclick: () => openUserProfile(author.id) },
    avatar(author, 'small'),
    el('span', { text: `@${author.username}` }),
    badgeImg(author)
  );
}

function codeBox(p) {
  if (!p.code) return null;
  return el(
    'div',
    { class: 'news-code' },
    el('code', { text: p.code }),
    actionButton('Redeem', async () => {
      const res = await api('POST', '/codes/redeem', { code: p.code });
      await refreshMe().catch(() => {});
      toast(res.forever ? '🎉 KoolKat Unlimited is yours forever!' : `🎉 KoolKat Unlimited until ${formatDate(res.unlimitedUntil)}!`);
    }),
    actionButton('Copy', () => copyText(p.code), '')
  );
}

/** ❤️ and ⭐ buttons for a post. `onChange` redraws whatever shows it. */
function reactionButtons(p, { onChange, cls = 'reaction' } = {}) {
  const heart = el(
    'button',
    {
      type: 'button',
      class: `${cls} heart`,
      'aria-pressed': String(p.liked),
      'aria-label': p.liked ? 'Unlike' : 'Like',
      onclick: () =>
        toggleReaction(p, 'like', 'liked').then(onChange, (err) => toast(err.message, { error: true })),
    },
    el('span', { class: 'reaction-icon', text: p.liked ? '❤️' : '🤍' }),
    el('span', { class: 'reaction-count', text: String(p.likes) })
  );
  const star = el(
    'button',
    {
      type: 'button',
      class: `${cls} star`,
      'aria-pressed': String(p.saved),
      'aria-label': p.saved ? 'Remove from Favorite Articles' : 'Save to Favorite Articles',
      onclick: () =>
        toggleReaction(p, 'save', 'saved')
          .then(() => {
            toast(p.saved ? '⭐ Saved to Favorite Articles' : 'Removed from Favorite Articles');
            onChange?.();
          })
          .catch((err) => toast(err.message, { error: true })),
    },
    el('span', { class: 'reaction-icon', text: p.saved ? '⭐' : '☆' }),
    el('span', { class: 'reaction-count', text: p.saved ? 'Saved' : 'Save' })
  );
  return [heart, star];
}

async function toggleReaction(p, kind, field) {
  const on = !p[field];
  const res = await api(on ? 'POST' : 'DELETE', `/news/${p.id}/${kind}`);
  p[field] = res[field];
  p.likes = res.likes;
  // Keep the same post in the other lists in step.
  for (const other of news.posts) {
    if (other.id === p.id && other !== p) Object.assign(other, { [field]: p[field], likes: p.likes });
  }
}

function adminButtons(p) {
  if (!news.canPost) return [];
  return [
    actionButton('Edit', () => startEditingNews(p), ''),
    actionButton(
      'Delete',
      async () => {
        if (!confirm(`Delete “${p.title}”?`)) return;
        await api('DELETE', `/news/${p.id}`);
        if (news.edit?.id === p.id) stopEditingNews();
        await loadNews();
      },
      'danger'
    ),
  ];
}

// ---------- Formal: like a newspaper article ----------
function formalArticle(p, { saved = false } = {}) {
  const node = el('li', { class: 'news-post article', 'data-post': String(p.id) });
  const draw = () =>
    node.replaceChildren(
      ...nodes(
        el('p', { class: 'article-kicker', text: 'KoolKat News' }),
        el('h3', { class: 'article-headline', text: p.title }),
        el(
          'div',
          { class: 'article-byline' },
          el('span', { text: 'By ' }),
          authorButton(p.author, 'byline-author'),
          el('span', { class: 'article-date', text: ` · ${longDate(p.createdAt)}${p.editedAt ? ' · Updated' : ''}` })
        ),
        newsMedia(p.media),
        p.body
          ? el(
              'div',
              // A big first letter, newspaper style, for proper articles (not one-liners).
              { class: `article-body${p.body.length > 140 ? ' drop-cap' : ''}` },
              ...p.body.split(/\n{2,}/).map((para) => el('p', { text: para }))
            )
          : null,
        pollBox(p, draw),
        codeBox(p),
        el(
          'div',
          { class: 'article-actions' },
          ...reactionButtons(p, {
            onChange: () => (saved && !p.saved ? node.remove() : draw()),
          }),
          commentsButton(p, 'reaction', draw),
          ...(saved ? [] : adminButtons(p))
        )
      )
    );
  draw();
  return node;
}

// ---------- TikTok: one post per screen, swipe up for the next ----------
function renderTikTok() {
  news.observer?.disconnect();
  const feed = $('news-feed');
  feed.replaceChildren(...news.posts.map((p) => tiktokPost(p)));
  if (!news.posts.length) {
    feed.replaceChildren(el('div', { class: 'tt-empty', text: 'No news yet. Check back soon!' }));
    return;
  }
  // Videos play (muted) while they're on screen and pause when you swipe away.
  news.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const video = entry.target.querySelector('video');
        if (!video) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0.6) video.play().catch(() => {});
        else video.pause();
      }
    },
    { root: feed, threshold: [0, 0.6, 1] }
  );
  for (const post of feed.querySelectorAll('.tt-post')) news.observer.observe(post);
}

function tiktokPost(p) {
  const node = el('article', { class: 'tt-post' });
  let media = null;
  if (p.media?.kind === 'video') {
    media = el('video', {
      class: 'tt-media',
      src: `${API_BASE}/api/${p.media.url}`,
      muted: true,
      loop: true,
      playsinline: true,
      preload: 'metadata',
    });
    media.muted = true;
    // Tap the video for sound.
    media.addEventListener('click', () => {
      media.muted = !media.muted;
      toast(media.muted ? '🔇 Sound off' : '🔊 Sound on');
    });
  } else if (p.media?.kind === 'image') {
    media = el('img', { class: 'tt-media', src: `${API_BASE}/api/${p.media.url}`, alt: '' });
  }
  const drawRail = () =>
    rail.replaceChildren(
      ...reactionButtons(p, { cls: 'tt-action', onChange: drawRail }),
      commentsButton(p, 'tt-action', drawRail),
      ...(news.canPost
        ? [
            el('button', { type: 'button', class: 'tt-action', 'aria-label': 'Edit post', onclick: () => {
              setNewsMode('formal');
              startEditingNews(p);
            } }, el('span', { class: 'reaction-icon', text: '✏️' }), el('span', { class: 'reaction-count', text: 'Edit' })),
          ]
        : [])
    );
  const rail = el('div', { class: 'tt-rail' });
  drawRail();
  const text = el(
    'div',
    { class: 'tt-text' },
    el('h3', { class: 'tt-title', text: p.title }),
    p.body ? el('p', { class: 'tt-body', text: p.body }) : null
  );
  const more = el('button', {
    type: 'button',
    class: 'tt-more',
    text: '...more',
    onclick: () => {
      const open = node.classList.toggle('expanded');
      more.textContent = open ? 'less' : '...more';
    },
  });
  node.append(
    ...nodes(
      media ?? el('div', { class: 'tt-media tt-plain' }),
      el('div', { class: 'tt-shade' }),
      rail,
      el(
        'div',
        { class: 'tt-info' },
        authorButton(p.author, 'tt-author'),
        text,
        more,
        pollBox(p, () => node.querySelector('.poll')?.replaceWith(pollBox(p, null))),
        codeBox(p),
        el('span', { class: 'tt-date', text: `${timeAgo(p.createdAt)}${p.editedAt ? ' · edited' : ''}` })
      )
    )
  );
  // Only offer "...more" when there's more to show.
  requestAnimationFrame(() => {
    if (text.scrollHeight <= text.clientHeight + 2) more.hidden = true;
  });
  return node;
}

// ---------- polls ----------
function pollBox(p, redraw) {
  const poll = p.poll;
  if (!poll) return null;
  const box = el('div', { class: `poll${poll.myVote == null ? '' : ' voted'}` });
  const vote = async (choice) => {
    try {
      const res =
        choice === poll.myVote ? await api('DELETE', `/news/${p.id}/vote`) : await api('POST', `/news/${p.id}/vote`, { choice });
      p.poll = res.poll;
      if (redraw) redraw();
      else box.replaceWith(pollBox(p, null));
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  const showResults = poll.myVote != null;
  box.append(
    el('p', { class: 'poll-question', text: `📊 ${poll.question || p.title}` }),
    ...poll.options.map((o, i) => {
      const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
      const mine = poll.myVote === i;
      const button = el(
        'button',
        { type: 'button', class: `poll-option${mine ? ' mine' : ''}`, 'aria-pressed': String(mine), onclick: () => vote(i) },
        el('span', { class: 'poll-label', text: `${mine ? '✓ ' : ''}${o.text}` }),
        showResults ? el('span', { class: 'poll-pct', text: `${pct}%` }) : null
      );
      if (showResults) button.style.setProperty('--pct', `${pct}%`);
      return button;
    }),
    el('p', {
      class: 'poll-total',
      text: `${poll.total} ${poll.total === 1 ? 'vote' : 'votes'}${showResults ? ' · tap your choice again to undo' : ''}`,
    })
  );
  return box;
}

// ---------- comments ----------
const comments = { post: null, onChange: null, kind: 'news' };

function commentsButton(p, cls, onChange) {
  return el(
    'button',
    { type: 'button', class: `${cls} comments-btn`, 'aria-label': 'Comments', onclick: () => openComments(p, onChange) },
    el('span', { class: 'reaction-icon', text: '💬' }),
    el('span', { class: 'reaction-count', text: String(p.comments ?? 0) })
  );
}

async function openComments(p, onChange, kind = 'news') {
  comments.post = p;
  comments.onChange = onChange;
  comments.kind = kind;
  $('comments-title').textContent = kind === 'reels' ? 'Comments' : `Comments on “${p.title}”`;
  $('comment-list').replaceChildren();
  $('comments-empty').hidden = true;
  $('dialog-comments').showModal();
  await loadComments();
}

async function loadComments() {
  const p = comments.post;
  try {
    const { comments: list } = await api('GET', `/${comments.kind}/${p.id}/comments`);
    if (comments.post !== p) return;
    p.comments = list.length;
    comments.onChange?.();
    $('comments-empty').hidden = list.length > 0;
    $('comment-list').replaceChildren(
      ...list.map((c) =>
        el(
          'li',
          { class: 'comment' },
          el('button', { type: 'button', class: 'comment-avatar', 'aria-label': `@${c.author.username}`, onclick: () => openUserProfile(c.author.id) }, avatar(c.author)),
          el(
            'div',
            { class: 'comment-main' },
            el(
              'div',
              { class: 'comment-head' },
              el('button', { type: 'button', class: 'author-link', onclick: () => openUserProfile(c.author.id) }, el('span', { text: c.author.displayName }), badgeImg(c.author)),
              el('span', { class: 'comment-time', text: timeAgo(c.createdAt) })
            ),
            el('p', { class: 'comment-body', text: c.body }),
            c.canDelete
              ? el('button', {
                  type: 'button',
                  class: 'link-btn comment-delete',
                  text: c.mine || comments.kind === 'reels' ? 'Delete' : 'Delete (admin)',
                  onclick: async () => {
                    if (!confirm('Delete this comment?')) return;
                    try {
                      await api('DELETE', `/${comments.kind}/comments/${c.id}`);
                      await loadComments();
                    } catch (err) {
                      toast(err.message, { error: true });
                    }
                  },
                })
              : null
          )
        )
      )
    );
    const listEl = $('comment-list');
    listEl.scrollTop = listEl.scrollHeight;
  } catch (err) {
    toast(err.message, { error: true });
  }
}

$('btn-comments-close').addEventListener('click', () => $('dialog-comments').close());
$('comment-input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
});
$('comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('comment-input');
  const body = input.value.trim();
  if (!body || !comments.post) return;
  await withBusy($('btn-comment-send'), async () => {
    await api('POST', `/${comments.kind}/${comments.post.id}/comments`, { body });
    input.value = '';
    input.style.height = 'auto';
    await loadComments();
  });
});

// ---------- poll editor (admins) ----------
function setPollEditor(poll) {
  const form = $('news-form');
  const on = Boolean(poll);
  $('news-poll-fields').hidden = !on;
  $('btn-news-poll').hidden = on;
  form.pollQuestion.value = poll?.question ?? '';
  [...form.querySelectorAll('[name=pollOption]')].forEach((input, i) => {
    input.value = poll?.options?.[i]?.text ?? poll?.options?.[i] ?? '';
  });
  $('news-poll-note').textContent =
    news.edit && news.edit.poll
      ? 'Changing the choices starts the vote again.'
      : 'Anyone can vote once and change their vote.';
}
$('btn-news-poll').addEventListener('click', () => setPollEditor({ question: '', options: [] }));
$('btn-news-poll-remove').addEventListener('click', () => setPollEditor(null));

/** The poll in the form: undefined (unchanged/none), null (removed) or { question, options }. */
function readPollEditor() {
  const form = $('news-form');
  if ($('news-poll-fields').hidden) return news.edit?.poll ? null : undefined;
  const options = [...form.querySelectorAll('[name=pollOption]')].map((i) => i.value.trim()).filter(Boolean);
  if (options.length < 2) throw new Error('A poll needs at least 2 choices');
  return { question: form.pollQuestion.value.trim(), options };
}

// ---------- editing ----------
function startEditingNews(p) {
  news.edit = { id: p.id, media: p.media, removeMedia: false, poll: p.poll };
  const form = $('news-form');
  form.title.value = p.title;
  form.body.value = p.body;
  form.code.value = p.code ?? '';
  form.notify.checked = false;
  form.notify.closest('label').hidden = true;
  $('news-form-title').textContent = 'Edit post';
  $('btn-news-submit').textContent = 'Save changes';
  $('btn-news-cancel-edit').hidden = false;
  setNewsFile(null);
  showExistingNewsMedia();
  setPollEditor(p.poll);
  form.hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  form.title.focus({ preventScroll: true });
}

function stopEditingNews() {
  news.edit = null;
  const form = $('news-form');
  form.reset();
  form.notify.closest('label').hidden = false;
  $('news-form-title').textContent = 'New post (admins only)';
  $('btn-news-submit').textContent = 'Post';
  $('btn-news-cancel-edit').hidden = true;
  setNewsFile(null);
  setPollEditor(null);
}
$('btn-news-cancel-edit').addEventListener('click', stopEditingNews);

/** While editing: the post's current photo/video, until it's removed or replaced. */
function showExistingNewsMedia() {
  const current = news.edit && !news.edit.removeMedia ? news.edit.media : null;
  if (!current || newsUpload.file) return;
  $('news-media-preview').hidden = false;
  $('btn-news-media').hidden = true;
  $('news-media-preview-item').replaceChildren(newsMedia(current));
}

// ---------- News photos and videos ----------
function newsMedia(media) {
  if (!media) return null;
  const src = `${API_BASE}/api/${media.url}`;
  if (media.kind === 'video') {
    return el('video', { class: 'news-media', src, controls: true, playsinline: true, preload: 'metadata' });
  }
  return el('img', { class: 'news-media', src, alt: '', loading: 'lazy' });
}

const newsUpload = { file: null, previewUrl: null };
const MAX_NEWS_PHOTO = 15 * 1024 * 1024;
const MAX_NEWS_VIDEO = 100 * 1024 * 1024;

function setNewsFile(file) {
  if (newsUpload.previewUrl) URL.revokeObjectURL(newsUpload.previewUrl);
  newsUpload.file = file;
  newsUpload.previewUrl = file ? URL.createObjectURL(file) : null;
  $('news-media-preview').hidden = !file;
  $('btn-news-media').hidden = Boolean(file);
  $('news-media-preview-item').replaceChildren(
    ...nodes(
      file &&
        (file.type.startsWith('video/')
          ? el('video', { src: newsUpload.previewUrl, controls: true, playsinline: true, muted: true, class: 'news-media' })
          : el('img', { src: newsUpload.previewUrl, alt: '', class: 'news-media' }))
    )
  );
}

$('btn-news-media').addEventListener('click', () => $('news-media-file').click());
$('btn-news-media-remove').addEventListener('click', () => {
  if (news.edit && !newsUpload.file) news.edit.removeMedia = true;
  setNewsFile(null);
  showExistingNewsMedia();
});
$('news-media-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const video = file.type.startsWith('video/');
  if (!video && !file.type.startsWith('image/')) return toast('Pick a photo or a video', { error: true });
  if (video && file.size > MAX_NEWS_VIDEO) return toast('Videos can be up to 100 MB', { error: true });
  if (!video && file.size > MAX_NEWS_PHOTO) return toast('Photos can be up to 15 MB', { error: true });
  setNewsFile(file);
});

/** Upload the photo or video, showing progress (videos can take a while). */
function uploadNewsMedia(file) {
  const bar = $('news-upload-bar');
  $('news-upload-progress').hidden = false;
  bar.style.width = '0%';
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/news/media`);
    xhr.setRequestHeader('authorization', `Bearer ${getToken()}`);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: use the status below.
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Couldn't upload. Check your connection."));
    xhr.send(file);
  }).finally(() => {
    $('news-upload-progress').hidden = true;
  });
}

$('news-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  await withBusy($('btn-news-submit'), async () => {
    const title = form.title.value.trim();
    if (!title) throw new Error('Give the post a title');
    const poll = readPollEditor();
    const mediaId = newsUpload.file ? (await uploadNewsMedia(newsUpload.file)).mediaId : null;
    const body = { title, body: form.body.value, code: form.code.value.trim() || null, mediaId, poll };
    if (news.edit) {
      await api('POST', `/news/${news.edit.id}`, { ...body, removeMedia: news.edit.removeMedia });
      stopEditingNews();
      toast('✏️ Post updated');
    } else {
      await api('POST', '/news', { ...body, notify: form.notify.checked });
      form.reset();
      setNewsFile(null);
      setPollEditor(null);
      toast('📣 Posted to News');
    }
    await loadNews();
  });
});

// ---------- favorites ----------
function setFavoriteButton(on) {
  const button = $('btn-snap-favorite');
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
}

$('btn-snap-favorite').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    if (!viewer) return;
    const on = $('btn-snap-favorite').getAttribute('aria-pressed') !== 'true';
    await api(on ? 'POST' : 'DELETE', `/snaps/${encodeURIComponent(viewer.summary.id)}/favorite`);
    viewer.summary.favorite = on;
    setFavoriteButton(on);
    toast(on ? '⭐ Added to favorites' : 'Removed from favorites');
  })
);

let favoritesTab = 'klicks';

function openFavorites() {
  show('favorites');
  setFavoritesTab(favoritesTab);
}

function setFavoritesTab(tab) {
  favoritesTab = tab;
  for (const t of document.querySelectorAll('#favorites-tabs .tab')) {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  const articles = tab === 'articles';
  $('favorites-list').hidden = articles;
  $('saved-articles').hidden = !articles;
  if (articles) {
    $('favorites-empty').hidden = true;
    loadSavedArticles();
  } else {
    $('saved-articles-empty').hidden = true;
    loadFavorites();
  }
}
$('favorites-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) setFavoritesTab(tab.dataset.tab);
});

// Favorite Articles: News posts saved with the ⭐ (separate from favorite Klicks).
async function loadSavedArticles() {
  try {
    const { posts } = await api('GET', '/news/saved');
    if (favoritesTab !== 'articles') return;
    $('saved-articles-empty').hidden = posts.length > 0;
    $('saved-articles').replaceChildren(...posts.map((p) => formalArticle(p, { saved: true })));
  } catch (err) {
    toast(err.message, { error: true });
  }
}
$('btn-favorites').addEventListener('click', openFavorites);

async function loadFavorites() {
  try {
    const { favorites } = await api('GET', '/favorites');
    renderFavorites(favorites);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderFavorites(favorites) {
  $('favorites-empty').hidden = favorites.length > 0;
  $('favorites-list').replaceChildren(
    ...favorites.map((f) =>
      el(
        'li',
        {},
        el(
          'button',
          { type: 'button', class: 'item', disabled: !f.available, onclick: () => openSnap(f) },
          avatar(f.own ? state.me : f.from),
          el(
            'span',
            { class: 'item-main' },
            f.own ? el('div', { class: 'item-title', text: `You → ${f.to.map((u) => u.displayName).join(', ')}` }) : nameEl(f.from),
            el('div', { class: 'item-sub', text: f.available ? `Klick from ${timeAgo(f.createdAt)}` : 'No longer available' })
          ),
          el('span', { class: 'fav-star', 'aria-hidden': 'true', text: '★' })
        )
      )
    )
  );
}

// ---------- chats ----------
const chat = { current: null, messages: [], decrypted: new Map(), hasMore: false, timer: null, picker: null };

async function refreshChats() {
  const { chats, unread } = await api('GET', '/chats');
  state.chats = chats;
  state.unreadMessages = unread;
  const badge = $('badge-chats');
  badge.hidden = unread === 0;
  badge.textContent = unread;
}

function openChats() {
  show('chats');
  renderChats();
  refreshChats().then(renderChats).catch((err) => toast(err.message, { error: true }));
}
$('btn-chats').addEventListener('click', openChats);

const chatAvatar = (c) =>
  c.kind === 'group'
    ? el('span', { class: 'avatar group-avatar', text: '👥' })
    : avatar(c.members.find((m) => m.id !== state.me.userId) ?? { displayName: c.name });

function chatTitle(c, cls = 'item-title') {
  if (c.kind === 'direct') {
    const other = c.members.find((m) => m.id !== state.me.userId);
    if (other) return nameEl(other, cls);
  }
  return el('div', { class: cls, text: c.name });
}

function renderChats() {
  const chats = state.chats ?? [];
  $('chats-empty').hidden = chats.length > 0;
  $('chats-list').replaceChildren(
    ...chats.map((c) => {
      let sub = c.kind === 'group' ? `${c.members.length} people` : 'Tap to chat';
      if (c.lastMessageAt) sub = c.unread ? `${c.unread} new message${c.unread === 1 ? '' : 's'} · ${timeAgo(c.lastMessageAt)}` : `Last message ${timeAgo(c.lastMessageAt)}`;
      return el(
        'li',
        {},
        el(
          'button',
          { type: 'button', class: 'item', onclick: () => openChat(c) },
          chatAvatar(c),
          el('span', { class: 'item-main' }, chatTitle(c), el('div', { class: `item-sub${c.unread ? ' unread' : ''}`, text: sub })),
          bffImg(c),
          c.unread ? el('span', { class: 'unread-dot', text: c.unread }) : null
        )
      );
    })
  );
}

// Picking friends for a new chat, a new group, or adding to a group.
function openPicker(mode) {
  chat.picker = { mode, selected: new Set() };
  $('chat-new-title').textContent = { direct: 'New chat', group: 'New group', add: 'Add friends' }[mode];
  $('chat-new-hint').textContent =
    mode === 'direct' ? 'Pick a friend to message.' : mode === 'group' ? 'Pick at least 2 friends for your group.' : 'Pick friends to add to the group.';
  $('group-name-row').hidden = mode !== 'group';
  $('group-name').value = '';
  $('btn-create-group').textContent = mode === 'add' ? 'Add to group' : 'Create group';
  show('chat-new');
  renderPicker();
  refreshFriends().then(renderPicker).catch(() => {});
}
$('btn-new-chat').addEventListener('click', () => openPicker('direct'));
$('btn-new-group').addEventListener('click', () => openPicker('group'));

function renderPicker() {
  const { mode, selected } = chat.picker;
  const inGroup = new Set(mode === 'add' ? chat.current?.members.map((m) => m.id) : []);
  const friends = state.friends.filter((f) => !inGroup.has(f.id));
  $('chat-new-empty').hidden = friends.length > 0;
  $('chat-new-list').replaceChildren(
    ...friends.map((f) => {
      const row = [avatar(f), el('span', { class: 'item-main' }, nameEl(f), el('div', { class: 'item-sub', text: `@${f.username}` }))];
      if (mode === 'direct') {
        return el('li', {}, el('button', { type: 'button', class: 'item', onclick: (e) => withBusy(e.currentTarget, () => startDirectChat(f.id)) }, ...row));
      }
      return el(
        'li',
        {},
        el(
          'label',
          { class: 'item' },
          ...row,
          el('input', {
            type: 'checkbox',
            checked: selected.has(f.id),
            'aria-label': `Add ${f.displayName}`,
            onchange: (e) => {
              if (e.target.checked) selected.add(f.id);
              else selected.delete(f.id);
              updateGroupBar();
            },
          })
        )
      );
    })
  );
  updateGroupBar();
}

function updateGroupBar() {
  const { mode, selected } = chat.picker;
  const needed = mode === 'group' ? 2 : 1;
  $('group-bar').hidden = mode === 'direct' || selected.size === 0;
  $('group-summary').textContent =
    selected.size < needed ? `Pick ${needed - selected.size} more` : `${selected.size} friend${selected.size === 1 ? '' : 's'} picked`;
  $('btn-create-group').disabled = selected.size < needed;
}

$('btn-create-group').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const { mode, selected } = chat.picker;
    if (mode === 'add') {
      const res = await api('POST', `/chats/${chat.current.id}/members`, { userIds: [...selected] });
      toast('Added to the group');
      openChat(res.chat);
    } else {
      const res = await api('POST', '/chats/group', { name: $('group-name').value.trim() || null, memberIds: [...selected] });
      openChat(res.chat);
    }
  })
);

async function startDirectChat(userId) {
  const { chat: c } = await api('POST', '/chats/direct', { userId });
  openChat(c);
}

function openChat(c) {
  chat.current = c;
  chat.messages = [];
  chat.hasMore = false;
  renderChatHeader();
  applyChatTheme($('messages'), state.plan?.chatTheme);
  $('message-list').replaceChildren();
  $('btn-older-messages').hidden = true;
  show('chat');
  loadMessages({ scroll: true }).catch((err) => toast(err.message, { error: true }));
  stopChatPolling();
  chat.timer = setInterval(() => {
    if (document.visibilityState === 'visible') loadMessages().catch(() => {});
  }, 3000);
}

function stopChatPolling() {
  clearInterval(chat.timer);
  chat.timer = null;
}

function renderChatHeader() {
  const c = chat.current;
  $('chat-name').replaceChildren(chatTitle(c, 'chat-name-inner'));
  const others = c.members.filter((m) => m.id !== state.me.userId);
  $('chat-members').textContent =
    c.kind === 'group' ? `You, ${others.map((m) => m.displayName).join(', ')}` : others[0]?.flair || `@${others[0]?.username ?? ''}`;
  $('btn-chat-menu').hidden = c.kind !== 'group';
  // Calls and FaceTime are one-to-one, with friends.
  const callable = c.kind !== 'group' && state.friends.some((f) => f.id === others[0]?.id);
  $('btn-chat-call').hidden = !callable;
  $('btn-chat-facetime').hidden = !callable;
  const friend = c.kind === 'group' ? null : state.friends.find((f) => f.id === others[0]?.id);
  showActivity($('chat-activity'), friend?.activity);
}

async function decryptAll(messages) {
  return Promise.all(
    messages.map(async (m) => {
      if (!chat.decrypted.has(m.id)) {
        try {
          chat.decrypted.set(m.id, { text: await decryptMessage(m, state.me.privateKey, state.me.userId) });
        } catch {
          chat.decrypted.set(m.id, { text: "This message couldn't be decrypted.", failed: true });
        }
      }
      return m;
    })
  );
}

async function loadMessages({ scroll = false, older = false } = {}) {
  const c = chat.current;
  if (!c) return;
  const before = older ? chat.messages[0]?.createdAt : null;
  const res = await api('GET', `/chats/${c.id}/messages${before ? `?before=${before}` : ''}`);
  if (chat.current?.id !== c.id) return; // switched chats meanwhile
  chat.current = res.chat;
  renderChatHeader();
  await decryptAll(res.messages);
  const known = new Set(chat.messages.map((m) => m.id));
  const fresh = res.messages.filter((m) => !known.has(m.id));
  if (older) {
    chat.messages = [...fresh, ...chat.messages];
    chat.hasMore = res.hasMore;
  } else {
    if (!chat.messages.length) chat.hasMore = res.hasMore;
    chat.messages = [...chat.messages, ...fresh].sort((a, b) => a.createdAt - b.createdAt);
  }
  if (!fresh.length && !scroll) return;
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const prevHeight = box.scrollHeight;
  renderMessages();
  if (older) box.scrollTop = box.scrollHeight - prevHeight;
  else if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
  if (fresh.some((m) => m.sender?.id !== state.me.userId)) {
    api('POST', `/chats/${c.id}/read`).then(refreshChats).catch(() => {});
  }
}

function renderMessages() {
  const group = chat.current.kind === 'group';
  let previousSender = null;
  $('btn-older-messages').hidden = !chat.hasMore;
  $('message-list').replaceChildren(
    ...chat.messages.map((m) => {
      const mine = m.sender?.id === state.me.userId;
      const { text, failed } = chat.decrypted.get(m.id) ?? { text: '' };
      const showSender = group && !mine && previousSender !== m.sender?.id;
      previousSender = m.sender?.id;
      return el(
        'li',
        { class: `message${mine ? ' mine' : ''}${failed ? ' failed' : ''}` },
        showSender ? el('span', { class: 'sender' }, m.sender ? m.sender.displayName : 'Someone', badgeImg(m.sender)) : null,
        el('div', { class: 'bubble', text }),
        el('span', { class: 'time', text: timeAgo(m.createdAt) })
      );
    })
  );
}

$('btn-older-messages').addEventListener('click', (e) => withBusy(e.currentTarget, () => loadMessages({ older: true })));

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('composer-input');
  const text = input.value.trim();
  if (!text || !chat.current) return;
  const button = $('btn-send-message');
  await withBusy(button, async () => {
    const send = async () => {
      const members = chat.current.members.map((m) => ({ userId: m.id, publicKey: m.publicKey }));
      return api('POST', `/chats/${chat.current.id}/messages`, await encryptMessage(text, members));
    };
    try {
      await send();
    } catch (err) {
      if (err.status !== 409) throw err;
      // Someone joined or left: refresh the member list and encrypt again.
      await loadMessages();
      await send();
    }
    input.value = '';
    await loadMessages({ scroll: true });
  });
  input.focus();
});

// Group options
$('btn-chat-menu').addEventListener('click', () => {
  const c = chat.current;
  $('group-rename').value = c.customName ?? '';
  $('group-members').replaceChildren(
    ...c.members.map((m) =>
      el(
        'li',
        {},
        el('div', { class: 'item' }, avatar(m), el('span', { class: 'item-main' }, nameEl(m), el('div', { class: 'item-sub', text: m.id === state.me.userId ? 'You' : `@${m.username}` })))
      )
    )
  );
  $('dialog-group').showModal();
});
$('btn-group-rename').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const res = await api('POST', `/chats/${chat.current.id}/name`, { name: $('group-rename').value.trim() || null });
    chat.current = res.chat;
    renderChatHeader();
    toast('Group name saved');
  })
);
$('btn-group-add').addEventListener('click', () => {
  $('dialog-group').close();
  openPicker('add');
});
$('btn-group-leave').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    if (!confirm('Leave this group? You will stop getting its messages.')) return;
    await api('POST', `/chats/${chat.current.id}/leave`);
    $('dialog-group').close();
    chat.current = null;
    toast('You left the group');
    openChats();
  })
);
$('group-rename').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('btn-group-rename').click();
  }
});

$('btn-snap-delete').addEventListener('click', async (e) => {
  if (!viewer) return;
  const { summary, own } = viewer;
  const question = own
    ? 'Delete this Klick for everyone? Nobody will be able to see it again, and it stops counting toward your storage.'
    : `Delete this Klick from ${summary.from.displayName}? You won't be able to see it again.`;
  if (!confirm(question)) return;
  await withBusy(e.currentTarget, async () => {
    await api('DELETE', `/snaps/${encodeURIComponent(summary.id)}`);
    state.inbox = state.inbox.filter((s) => s.id !== summary.id);
    toast(own ? 'Klick deleted for everyone' : 'Klick deleted');
    closeSnap();
  });
});

window.addEventListener('resize', () => {
  if (state.screen === 'preview' && state.capture) fitFrame($('preview-frame'), state.capture.width, state.capture.height);
  if (state.screen === 'viewer' && viewer) fitFrame($('viewer-frame'), ...viewer.size);
});

// ---------- friends ----------
function openFriends() {
  $('search-input').value = '';
  $('search-results').replaceChildren();
  show('friends');
  renderFriends();
  refreshFriends().then(renderFriends).catch((err) => toast(err.message, { error: true }));
}
$('btn-friends').addEventListener('click', openFriends);

function userRow(user, sub, ...actions) {
  return el(
    'li',
    {},
    el(
      'div',
      { class: 'item' },
      avatar(user),
      el(
        'span',
        { class: 'item-main' },
        nameEl(user),
        el('div', { class: 'item-sub', text: sub ?? `@${user.username}` })
      ),
      el('span', { class: 'item-actions' }, ...actions)
    )
  );
}

const actionButton = (text, onclick, cls = 'primary') =>
  el('button', { type: 'button', class: `btn small ${cls}`, text, onclick: (e) => withBusy(e.currentTarget, onclick) });

async function withBusy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    button.disabled = false;
  }
}

async function friendAction(fn, message) {
  await fn();
  if (message) toast(message);
  await refreshFriends();
  renderFriends();
  if ($('search-input').value.trim()) runSearch();
}

const acceptFriend = (user) =>
  friendAction(() => api('POST', `/friends/${user.id}/accept`), `You and ${user.displayName} are now friends!`);
const removeFriend = (user, message) => friendAction(() => api('DELETE', `/friends/${user.id}`), message);
const addFriend = (user) =>
  friendAction(async () => {
    const res = await api('POST', '/friends/request', { username: user.username });
    toast(res.status === 'accepted' ? `You and ${user.displayName} are now friends!` : 'Friend request sent');
  });

function renderFriends() {
  $('incoming-title').hidden = state.incoming.length === 0;
  $('incoming-list').replaceChildren(
    ...state.incoming.map((u) =>
      userRow(u, `@${u.username} wants to be friends`, actionButton('Accept', () => acceptFriend(u)), actionButton('Ignore', () => removeFriend(u), ''))
    )
  );

  $('friends-empty').hidden = state.friends.length > 0;
  const bffs = state.friends.filter((f) => f.bff);
  $('bff-title').hidden = bffs.length === 0;
  $('friends-title').hidden = bffs.length > 0 && bffs.length === state.friends.length;
  $('bff-list').replaceChildren(...bffs.map(friendRow));
  $('friends-list').replaceChildren(...state.friends.filter((f) => !f.bff).map(friendRow));

  $('outgoing-title').hidden = state.outgoing.length === 0;
  $('outgoing-list').replaceChildren(
    ...state.outgoing.map((u) => userRow(u, `@${u.username} · pending`, actionButton('Cancel', () => removeFriend(u), '')))
  );
}

function friendRow(f) {
  let sub = f.flair ? `@${f.username} · ${f.flair}` : `@${f.username}`;
  if (f.streak.count > 0 && f.streak.youNeedToSnap) sub = 'Send them a Klick today to keep your streak!';
  else if (f.streak.count > 0 && f.streak.theyNeedToSnap) sub = `Waiting for ${f.displayName} to send a Klick back`;
  return el(
    'li',
    {},
    el(
      'button',
      { type: 'button', class: 'item', onclick: () => openFriend(f) },
      avatar(f),
      el(
        'span',
        { class: 'item-main' },
        nameEl(f),
        el('div', { class: 'item-sub', text: sub }),
        f.activity ? el('div', { class: 'activity-bubble small', text: activityLabel(f.activity) }) : null
      ),
      bffImg(f),
      streakBadge(f.streak)
    )
  );
}

let searchTimer;
let searchSeq = 0;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch();
});

async function runSearch() {
  const term = $('search-input').value.trim();
  const seq = ++searchSeq;
  if (!term) {
    $('search-results').replaceChildren();
    return;
  }
  try {
    const { users } = await api('GET', `/users/search?q=${encodeURIComponent(term)}`);
    if (seq !== searchSeq) return;
    const results = users.map((u) => {
      const action = {
        none: actionButton('Add', () => addFriend(u)),
        incoming: actionButton('Accept', () => acceptFriend(u)),
        outgoing: el('button', { type: 'button', class: 'btn small', disabled: true, text: 'Requested' }),
        friends: el('button', { type: 'button', class: 'btn small', disabled: true, text: 'Friends' }),
      }[u.relationship];
      return userRow(u, null, action);
    });
    if (!results.length) results.push(el('li', { class: 'empty', text: `No one called “${term}”` }));
    $('search-results').replaceChildren(...results);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function openFriend(friend) {
  const dialog = $('dialog-friend');
  fillAvatar($('friend-avatar'), friend);
  $('friend-name').replaceChildren(...nodes(friend.displayName, badgeImg(friend)));
  $('friend-username').textContent = `@${friend.username}`;
  $('friend-flair').textContent = friend.flair || '';
  $('friend-flair').hidden = !friend.flair;
  showActivity($('friend-activity'), friend.activity);
  $('friend-streak').textContent =
    friend.streak.count > 0 ? `🔥 ${friend.streak.count} day streak${friend.streak.expiring ? ' ⌛' : ''}` : 'No streak yet. Send each other Klicks every day to start one!';
  $('friend-fingerprint').textContent = await fingerprint(friend.publicKey);
  renderBffButton(friend);
  renderSocials($('friend-socials'), null);
  api('GET', `/users/${friend.id}`)
    .then(({ user }) => renderSocials($('friend-socials'), user.socials))
    .catch(() => {});
  dialog.returnValue = '';
  dialog.onclose = () => {
    if (dialog.returnValue === 'profile') {
      openUserProfile(friend.id);
      return;
    }
    if (dialog.returnValue === 'message') {
      startDirectChat(friend.id).catch((err) => toast(err.message, { error: true }));
      return;
    }
    if (dialog.returnValue === 'call' || dialog.returnValue === 'facetime') {
      startCall(friend, dialog.returnValue === 'facetime' ? 'video' : 'audio');
      return;
    }
    if (dialog.returnValue === 'remove' && confirm(`Remove ${friend.displayName} as a friend? Your streak will be lost.`)) {
      removeFriend(friend, `Removed ${friend.displayName}`).catch((err) => toast(err.message, { error: true }));
    }
  };
  dialog.showModal();
}

// ---------- profile ----------
// ---------- profile picture ----------
function renderMyAvatar() {
  fillAvatar($('my-avatar'), state.me);
  fillAvatar($('profile-avatar'), state.me);
  $('btn-avatar-remove').hidden = !state.me.avatarUrl;
}

$('btn-avatar').addEventListener('click', () => $('avatar-file').click());
$('avatar-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const img = await loadImageFile(file);
    // A centred square, small enough to load quickly everywhere it's shown.
    const size = 320;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    canvas
      .getContext('2d')
      .drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    const image = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    const { avatarUrl } = await api('POST', '/me/avatar', { image });
    state.me.avatarUrl = avatarUrl;
    renderMyAvatar();
    toast('📸 Profile picture updated');
  } catch (err) {
    toast(err.message, { error: true });
  }
});
$('btn-avatar-remove').addEventListener('click', async () => {
  try {
    await api('DELETE', '/me/avatar');
    state.me.avatarUrl = null;
    renderMyAvatar();
    toast('Profile picture removed');
  } catch (err) {
    toast(err.message, { error: true });
  }
});

// Your settings (plan, perks, notifications…), from "Edit profile" on your profile page.
async function openProfileSettings() {
  const dialog = $('dialog-profile');
  renderMyAvatar();
  $('profile-username').textContent = `@${state.me.username}`;
  renderPlan();
  refreshMe()
    .then(() => {
      renderPlan();
      if (state.plan?.isAdmin) return api('GET', '/admin/requests').then((r) => renderRequests(r.requests));
    })
    .catch(() => {});
  $('profile-fingerprint').textContent = await fingerprint(state.me.publicKey);
  renderNotifyRow();
  renderSoundsRow();
  renderInstallRow();
  renderCameraInfo();
  api('GET', '/health')
    .then((h) => ($('app-version').textContent = `· version ${h.version}`))
    .catch(() => {});
  dialog.returnValue = '';
  dialog.onclose = () => {
    if (dialog.returnValue === 'logout') logout();
    else if (state.screen === 'user' && userPage.user?.relationship === 'you') openUserProfile(state.me.userId);
  };
  dialog.showModal();
}
$('btn-profile').addEventListener('click', () => openUserProfile(state.me.userId));

// ---------- KoolKat Unlimited ----------
async function refreshMe() {
  const me = await api('GET', '/me');
  state.plan = me.plan;
  Object.assign(state.me, {
    displayName: me.user.displayName,
    badge: me.user.badge,
    badgeUrl: me.user.badgeUrl,
    flair: me.user.flair,
    avatarUrl: me.user.avatarUrl,
    birthday: me.user.birthday,
    verified: me.user.verified,
  });
  renderMyAvatar();
  window.koolkatTheme.setAccent(me.plan.accentColor);
  applyAppIcon(me.plan.appIcon);
  return me;
}

const formatDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function renderPlan() {
  const plan = state.plan;
  $('profile-name').replaceChildren(...nodes(state.me.displayName, badgeImg(state.me)));
  $('profile-flair').textContent = plan?.flair || '';
  $('profile-flair').hidden = !plan?.flair;
  showActivity($('profile-activity'), plan?.activity);
  if (!plan) return;
  const unlimited = plan.plan === 'unlimited';
  $('plan-name').replaceChildren(...nodes(unlimited ? 'KoolKat Unlimited' : 'KoolKat Free', unlimited && badgeImg({ badge: true })));
  $('plan-detail').textContent = unlimited
    ? plan.forever
      ? 'Yours forever'
      : `Until ${formatDate(plan.unlimitedUntil)}`
    : '512 MB storage';
  const pct = Math.min(100, (plan.storageUsed / plan.storageLimit) * 100);
  $('storage-fill').style.width = `${pct}%`;
  $('storage-fill').classList.toggle('full', pct >= 95);
  $('storage-text').textContent = `${formatBytes(plan.storageUsed)} of ${formatBytes(plan.storageLimit)} used by Klicks you've sent`;
  $('plan-upsell').hidden = unlimited;
  renderRequest(plan);
  $('flair-editor').hidden = !unlimited;
  $('unlimited-extras').hidden = !unlimited;
  if (unlimited) renderPersonalisation(plan);
  if (unlimited && document.activeElement !== $('flair-input')) $('flair-input').value = plan.flair;
  $('btn-admin').hidden = !plan.isAdmin;
  renderSocials($('profile-socials'), plan.socials);
  $('storage-warning').hidden = !plan.storageWarning;
  $('storage-warning').textContent = plan.storageWarning
    ? `⚠️ Admin: accounts will be lost on the next update (${plan.storageWarning}). In Railway, attach a volume at /data to this service.`
    : '';
}

// Asking an admin for KoolKat Unlimited.
function renderRequest(plan) {
  const r = plan.request;
  const status = $('request-status');
  const pending = r?.status === 'pending';
  const declinedRecently = r?.status === 'declined' && Date.now() - (r.handledAt ?? 0) < 24 * 60 * 60 * 1000;
  $('btn-request-open').hidden = pending || declinedRecently || !$('request-form').hidden;
  if (pending || declinedRecently) $('request-form').hidden = true;
  status.hidden = !(pending || declinedRecently);
  status.textContent = pending
    ? `🎁 Request sent ${timeAgo(r.createdAt)}. An admin will look at it soon!`
    : "Your last request wasn't approved. You can ask again tomorrow, or look for codes in News.";
}

$('btn-request-open').addEventListener('click', () => {
  $('btn-request-open').hidden = true;
  $('request-form').hidden = false;
  $('request-message').focus();
});

$('btn-request-send').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    await api('POST', '/unlimited/request', { message: $('request-message').value.trim() });
    $('request-message').value = '';
    $('request-form').hidden = true;
    await refreshMe();
    renderPlan();
    toast('🎁 Request sent to the admins');
  })
);

$('btn-flair-save').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const { flair } = await api('POST', '/me/flair', { flair: $('flair-input').value });
    $('flair-input').value = flair;
    await refreshMe();
    renderPlan();
    toast('Kool flair saved ✨');
  })
);

$('btn-redeem').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const code = $('redeem-input').value.trim();
    if (!code) throw new Error('Type a code first');
    const res = await api('POST', '/codes/redeem', { code });
    $('redeem-input').value = '';
    await refreshMe();
    renderPlan();
    toast(res.forever ? '🎉 KoolKat Unlimited is yours forever!' : `🎉 KoolKat Unlimited until ${formatDate(res.unlimitedUntil)}!`);
  })
);

// In the profile dialog, Enter would submit (and close) the dialog's form.
for (const [input, button] of [
  ['flair-input', 'btn-flair-save'],
  ['redeem-input', 'btn-redeem'],
]) {
  $(input).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $(button).click();
    }
  });
}

// ---------- admin ----------
$('btn-admin').addEventListener('click', () => {
  $('dialog-profile').close();
  show('admin');
  loadCodes();
  loadRequests();
  $('admins-section').hidden = !state.plan?.isOwner;
  $('verified-section').hidden = !state.plan?.isOwner;
  if (state.plan?.isOwner) {
    loadAdmins();
    loadVerified();
  }
});

// Only the owner can give out (and take back) the verified badge.
async function loadVerified() {
  try {
    const { users } = await api('GET', '/admin/verified');
    $('verified-empty').hidden = users.length > 0;
    $('verified-list').replaceChildren(
      ...users.map((u) =>
        userRow(
          u,
          `@${u.username} · Verified ${formatDate(u.verifiedAt)}`,
          actionButton(
            'Remove',
            async () => {
              if (!confirm(`Take the verified badge away from ${u.displayName}?`)) return;
              await api('DELETE', `/admin/verified/${encodeURIComponent(u.username)}`);
              toast(`${u.displayName} is no longer verified`);
              await loadVerified();
            },
            'danger'
          )
        )
      )
    );
  } catch (err) {
    toast(err.message, { error: true });
  }
}

$('verified-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  await withBusy(form.querySelector('button[type=submit]'), async () => {
    const username = form.username.value.trim();
    if (!username) throw new Error('Type a username');
    const { user } = await api('POST', '/admin/verified', { username });
    form.reset();
    toast(`✔ ${user.displayName} is now verified`);
    await loadVerified();
    if (user.id === state.me.userId) await refreshMe();
  });
});

// Only the owner (zalith9) can add or remove admins.
async function loadAdmins() {
  try {
    const { admins } = await api('GET', '/admin/admins');
    $('admins-list').replaceChildren(
      ...admins.map((a) =>
        userRow(
          a,
          a.owner ? `@${a.username} · Owner` : `@${a.username} · Admin since ${formatDate(a.grantedAt)}`,
          a.owner
            ? null
            : actionButton(
                'Remove',
                async () => {
                  if (!confirm(`Remove ${a.displayName} as an admin?`)) return;
                  await api('DELETE', `/admin/admins/${encodeURIComponent(a.username)}`);
                  toast(`${a.displayName} is no longer an admin`);
                  await loadAdmins();
                },
                'danger'
              )
        )
      )
    );
  } catch (err) {
    toast(err.message, { error: true });
  }
}

$('admins-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  await withBusy(form.querySelector('button[type=submit]'), async () => {
    const username = form.username.value.trim();
    if (!username) throw new Error('Type a username');
    if (!confirm(`Make ${username} an admin? They'll be able to use Admin tools and post News.`)) return;
    const { admin } = await api('POST', '/admin/admins', { username });
    form.reset();
    toast(`🛠 ${admin.displayName} is now an admin`);
    await loadAdmins();
  });
});

async function loadRequests() {
  try {
    renderRequests((await api('GET', '/admin/requests')).requests);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderRequests(requests) {
  $('request-empty').hidden = requests.length > 0;
  $('request-list').replaceChildren(
    ...requests.map((r) =>
      el(
        'li',
        {},
        el(
          'div',
          { class: 'item' },
          avatar(r.user),
          el(
            'span',
            { class: 'item-main' },
            nameEl(r.user),
            el('div', { class: 'item-sub', text: `@${r.user.username} · ${timeAgo(r.createdAt)}` }),
            r.message ? el('div', { class: 'item-sub request-msg', text: `“${r.message}”` }) : null
          ),
          el(
            'span',
            { class: 'item-actions' },
            actionButton('Approve', async () => {
              const days = $('request-days').value || null;
              await api('POST', `/admin/requests/${r.id}/approve`, { days });
              toast(`🎉 ${r.user.displayName} got KoolKat Unlimited ${days ? `for ${days} days` : 'forever'}`);
              await loadRequests();
            }),
            actionButton('Decline', async () => {
              await api('POST', `/admin/requests/${r.id}/decline`);
              await loadRequests();
            }, 'danger')
          )
        )
      )
    )
  );
  $('btn-admin').textContent = requests.length ? `🛠 Admin tools (${requests.length} request${requests.length === 1 ? '' : 's'})` : '🛠 Admin tools';
}

async function loadCodes() {
  try {
    renderCodes((await api('GET', '/admin/codes')).codes);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function describeCodeRow(c) {
  const parts = [`${c.uses}/${c.maxUses ?? '∞'} used`];
  parts.push(c.grantDays ? `${c.grantDays} day${c.grantDays === 1 ? '' : 's'} of Unlimited` : 'Unlimited forever');
  if (c.expiresAt) parts.push(c.expiresAt <= Date.now() ? 'expired' : `expires ${formatDate(c.expiresAt)}`);
  else parts.push('never expires');
  if (c.maxUses != null && c.uses >= c.maxUses) parts.push('used up');
  return parts.join(' · ');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${text}`);
  } catch {
    toast(text);
  }
}

function renderCodes(codes) {
  $('code-empty').hidden = codes.length > 0;
  $('code-list').replaceChildren(
    ...codes.map((c) =>
      el(
        'li',
        {},
        el(
          'div',
          { class: 'item' },
          el(
            'span',
            { class: 'item-main' },
            el('div', { class: 'item-title code-text', text: c.code }),
            el('div', { class: 'item-sub', text: describeCodeRow(c) })
          ),
          el(
            'span',
            { class: 'item-actions' },
            actionButton('Copy', () => copyText(c.code), ''),
            actionButton('Delete', async () => {
              if (!confirm(`Delete the code ${c.code}? Nobody will be able to redeem it.`)) return;
              await api('DELETE', `/admin/codes/${encodeURIComponent(c.code)}`);
              await loadCodes();
            }, 'danger')
          )
        )
      )
    )
  );
}

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector('button[type=submit]');
  await withBusy(button, async () => {
    const expires = form.expiresAt.value ? new Date(form.expiresAt.value).getTime() : null;
    const { code } = await api('POST', '/admin/codes', {
      code: form.code.value.trim() || null,
      maxUses: form.maxUses.value || null,
      expiresAt: expires,
      grantDays: form.grantDays.value || null,
    });
    form.code.value = '';
    await loadCodes();
    copyText(code.code);
  });
});

$('grant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector('button[type=submit]');
  await withBusy(button, async () => {
    const username = form.username.value.trim();
    if (!username) throw new Error('Type a username');
    const res = await api('POST', '/admin/grant', { username, days: form.days.value || null });
    toast(
      res.forever
        ? `🎁 ${res.user.displayName} has KoolKat Unlimited forever`
        : `🎁 ${res.user.displayName} has KoolKat Unlimited until ${formatDate(res.unlimitedUntil)}`
    );
    if (res.user.id === state.me.userId) refreshMe().catch(() => {});
  });
});

// Reset someone's custom badge / app icon.
$('reset-form').addEventListener('submit', (e) => e.preventDefault());
for (const button of document.querySelectorAll('#reset-form [data-reset]')) {
  button.addEventListener('click', () =>
    withBusy(button, async () => {
      const username = $('reset-form').username.value.trim();
      if (!username) throw new Error('Type a username');
      const which = button.dataset.reset;
      const label = {
        badge: 'custom badge',
        icon: 'custom app icon',
        activity: 'Activity Bubble',
        avatar: 'profile picture',
        all: 'custom badge, app icon, Activity Bubble and profile picture',
      }[which];
      if (!confirm(`Reset ${username}'s ${label}?`)) return;
      const res = await api('POST', '/admin/reset-customization', {
        username,
        badge: which === 'badge' || which === 'all',
        icon: which === 'icon' || which === 'all',
        activity: which === 'activity' || which === 'all',
        avatar: which === 'avatar' || which === 'all',
      });
      const names = { badge: 'badge', icon: 'app icon', activity: 'Activity Bubble', avatar: 'profile picture' };
      const done = res.reset.map((r) => names[r]);
      toast(
        done.length === 0
          ? `${res.user.displayName} had nothing to reset`
          : `Reset ${res.user.displayName}'s ${done.join(', ')}`
      );
      if (res.user.id === state.me.userId) refreshMe().catch(() => {});
    })
  );
}

$('btn-revoke').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const username = $('grant-form').username.value.trim();
    if (!username) throw new Error('Type a username');
    if (!confirm(`Take away gifted KoolKat Unlimited from ${username}? (A paid subscription isn't affected.)`)) return;
    const res = await api('POST', '/admin/revoke', { username });
    toast(`Removed gifted Unlimited from ${res.user.displayName}`);
  })
);

// ---------- KoolKat Unlimited personalisation ----------
const APP_ICON_KEY = 'koolkat.appIcon';

/** Point the tab icon, home-screen icon and install manifest at the chosen app icon. */
function applyAppIcon(appIcon) {
  const choice = appIcon?.icon || 'default';
  let small = 'icons/icon-32.png';
  let large = 'icons/icon-192.png';
  let touch = 'icons/icon-180.png';
  let manifest = 'manifest.webmanifest';
  // KoolKat Unlimited accent colour: the normal icon is drawn in that colour.
  const accent = window.koolkatTheme.getAccent()?.slice(1);
  if (choice === 'default' && accent) {
    const url = (name) => `${API_BASE}/api/accent-icons/${accent}/${name}.png`;
    small = url('icon-32');
    large = url('icon-192');
    touch = url('icon-180');
    manifest = `manifest.webmanifest?accent=${accent}`;
  } else if (choice === 'crown' || choice === 'glow') {
    small = `icons/alt-${choice}-32.png`;
    large = `icons/alt-${choice}-192.png`;
    touch = `icons/alt-${choice}-180.png`;
    manifest = `manifest.webmanifest?icon=${choice}`;
  } else if (choice === 'custom' && appIcon.customId) {
    large = `${API_BASE}/api/app-icons/${appIcon.customId}/192.png`;
    small = large;
    touch = large;
    manifest = `manifest.webmanifest?icon=custom-${appIcon.customId}`;
  }
  const [icon32, icon192] = document.querySelectorAll('link[rel="icon"]');
  if (icon32) icon32.href = small;
  if (icon192) icon192.href = large;
  const apple = document.querySelector('link[rel="apple-touch-icon"]');
  if (apple) apple.href = touch;
  const link = document.querySelector('link[rel="manifest"]');
  if (link && !API_BASE) link.href = manifest; // a separately hosted frontend has a static manifest
  for (const img of document.querySelectorAll('img[data-logo]')) img.src = logoSrc();
  try {
    if (choice === 'default') localStorage.removeItem(APP_ICON_KEY);
    else localStorage.setItem(APP_ICON_KEY, JSON.stringify(appIcon));
  } catch {
    /* storage blocked */
  }
}

/** The KoolKat logo, in your accent colour if you have one. */
function logoSrc() {
  const accent = window.koolkatTheme.getAccent()?.slice(1);
  return accent ? `${API_BASE}/api/accent-icons/${accent}/logo.png` : 'icons/logo.png';
}
for (const img of document.querySelectorAll('img[src="icons/logo.png"]')) img.dataset.logo = '';

// Use the last chosen icon (and accent colour) straight away, before the server answers.
let savedAppIcon = null;
try {
  savedAppIcon = JSON.parse(localStorage.getItem(APP_ICON_KEY) || 'null');
} catch {
  /* nothing saved */
}
applyAppIcon(savedAppIcon ?? { icon: 'default' });

function renderPersonalisation(plan) {
  renderAccentEditor(plan);
  const current = plan.appIcon?.icon || 'default';
  for (const button of document.querySelectorAll('.icon-choice')) {
    button.setAttribute('aria-checked', String(button.dataset.icon === current));
  }
  const id = plan.appIcon?.customId;
  $('custom-icon-preview').hidden = !id;
  $('custom-icon-plus').hidden = Boolean(id);
  if (id) $('custom-icon-preview').src = `${API_BASE}/api/app-icons/${id}/192.png`;
  $('badge-preview').src = badgeSrc(state.me);
  $('btn-badge-reset').disabled = !plan.customBadge;
  renderActivityEditor(plan);
  renderChatThemeEditor(plan);
}

async function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Pick a picture');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error("That picture couldn't be opened. Try a JPG or PNG.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The picture, cropped to a centred square of `size` pixels, as base64 PNG. */
function squarePng(img, size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/png').split(',')[1];
}

/** The picture scaled to fit in `max`×`max` (keeping its shape), as base64 PNG. */
function fittedPng(img, max) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(16, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(16, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').split(',')[1];
}

async function saveAppIcon(body) {
  const { appIcon } = await api('POST', '/me/app-icon', body);
  await refreshMe();
  renderPlan();
  applyAppIcon(appIcon);
  toast('🎨 App icon updated');
}

$('icon-picker').addEventListener('click', (e) => {
  const button = e.target.closest('.icon-choice');
  if (!button) return;
  const icon = button.dataset.icon;
  if (icon === 'custom' && !state.plan?.appIcon?.customId) {
    $('icon-file').click();
    return;
  }
  withBusy(button, () => saveAppIcon({ icon }));
});
$('btn-icon-upload').addEventListener('click', () => $('icon-file').click());

$('icon-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  withBusy($('icon-picker').querySelector('[data-icon="custom"]'), async () => {
    const img = await loadImageFile(file);
    await saveAppIcon({ icon: 'custom', icon512: squarePng(img, 512), icon192: squarePng(img, 192) });
  });
});

$('btn-badge-upload').addEventListener('click', () => $('badge-file').click());
$('badge-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  withBusy($('btn-badge-upload'), async () => {
    const img = await loadImageFile(file);
    await api('POST', '/me/badge', { image: fittedPng(img, 128) });
    await refreshMe();
    renderPlan();
    toast('✨ Badge updated');
  });
});
$('btn-badge-reset').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    await api('DELETE', '/me/badge');
    await refreshMe();
    renderPlan();
    toast('Badge reset to the default');
  })
);

// BFF button on a friend's card.
function renderBffButton(friend) {
  const button = $('btn-friend-bff');
  const unlimited = state.plan?.plan === 'unlimited';
  button.setAttribute('aria-pressed', String(Boolean(friend.bff)));
  button.replaceChildren(
    el('img', { src: 'icons/bff-heart.png', alt: '', class: 'bff-heart' }),
    friend.bff ? ' BFF' : unlimited ? ' Make BFF' : ' BFF (Unlimited)'
  );
  button.onclick = () =>
    withBusy(button, async () => {
      if (!unlimited) throw new Error('BFFs are part of KoolKat Unlimited. Ask an admin for it in your profile!');
      await api(friend.bff ? 'DELETE' : 'POST', `/bffs/${friend.id}`);
      friend.bff = !friend.bff;
      toast(friend.bff ? `💙 ${friend.displayName} is now your BFF` : `${friend.displayName} is no longer a BFF`);
      renderBffButton(friend);
      await refreshFriends();
      renderFriends();
      refreshChats().catch(() => {});
    });
}

// ---------- troubleshooting ----------
async function renderCameraInfo() {
  const video = $('camera-video');
  const track = state.stream?.getVideoTracks()[0];
  const settings = track?.getSettings?.() ?? {};
  const lines = [
    `secure: ${window.isSecureContext}, getUserMedia: ${Boolean(navigator.mediaDevices?.getUserMedia)}`,
    `asked for: ${state.facing}`,
    track
      ? `track: ${track.label || '(no label)'} | ${track.readyState}${track.muted ? ', muted' : ''}${track.enabled ? '' : ', disabled'}`
      : 'track: none',
    `settings: ${settings.width ?? '?'}x${settings.height ?? '?'} facing=${settings.facingMode ?? '?'}`,
    `video: ${video.videoWidth}x${video.videoHeight}, readyState ${video.readyState}, paused ${video.paused}`,
    `message: ${$('camera-message').hidden ? '(none)' : $('camera-message-text').textContent}`,
  ];
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    lines.push(`cameras: ${cams.length} ${cams.map((c) => c.label || '?').join(' / ')}`);
  } catch (err) {
    lines.push(`cameras: ${err.name}`);
  }
  try {
    const perm = await navigator.permissions?.query({ name: 'camera' });
    if (perm) lines.push(`permission: ${perm.state}`);
  } catch {
    /* not supported */
  }
  if (window.__koolkatErrors?.length) lines.push(`errors: ${window.__koolkatErrors.slice(-5).join(' | ')}`);
  lines.push(navigator.userAgent);
  $('camera-info').textContent = lines.join('\n');
}

// ---------- installing the app ----------
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', (e) => {
  // Show our own Install button (in the profile) instead of the browser's mini bar.
  e.preventDefault();
  installPrompt = e;
  renderInstallRow();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  renderInstallRow();
  toast('🎉 KoolKat is installed');
});

function renderInstallRow() {
  const row = $('install-row');
  if (isStandalone()) {
    row.hidden = true;
    return;
  }
  if (installPrompt) {
    row.hidden = false;
    $('btn-install').hidden = false;
    $('install-status').textContent = 'Add it to your home screen like an app';
  } else if (isIos()) {
    row.hidden = false;
    $('btn-install').hidden = true;
    $('install-status').textContent = 'In Safari, tap Share ⬆️ then “Add to Home Screen”';
  } else {
    row.hidden = true;
  }
}

$('btn-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  renderInstallRow();
});

// Offline notice
function renderOnline() {
  $('offline-bar').hidden = navigator.onLine;
}
window.addEventListener('online', () => {
  renderOnline();
  if (state.me) refresh();
});
window.addEventListener('offline', renderOnline);
renderOnline();

// ---------- notifications ----------
const BANNER_KEY = 'koolkat.pushBanner';

async function renderNotifyRow() {
  const status = $('notify-status');
  const button = $('btn-notify');
  const current = await pushState();
  button.hidden = false;
  button.disabled = false;
  if (current === 'on') {
    status.textContent = 'On for this device';
    button.textContent = 'Turn off';
  } else if (current === 'blocked') {
    status.textContent = 'Blocked in your browser settings';
    button.hidden = true;
  } else if (current === 'unsupported') {
    status.textContent = needsHomeScreenInstall()
      ? 'Add KoolKat to your Home Screen (Share → Add to Home Screen) to get notifications'
      : 'Not supported in this browser';
    button.hidden = true;
  } else {
    status.textContent = 'Klicks, messages, friend requests and streak reminders';
    button.textContent = 'Turn on';
  }
}

async function turnOnNotifications() {
  await enablePush();
  setPushPreference(true);
  toast('Notifications are on 🔔');
}

$('btn-notify').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    if ((await pushState()) === 'on') {
      await disablePush();
      setPushPreference(false);
      toast('Notifications are off');
    } else {
      await turnOnNotifications();
    }
    await renderNotifyRow();
  })
);

async function renderNotifyBanner() {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(BANNER_KEY) === 'dismissed';
  } catch {
    /* storage blocked */
  }
  $('notify-banner').hidden = dismissed || pushPreferenceOff() || !pushSupported() || (await pushState()) !== 'off';
}

$('btn-notify-banner').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    await turnOnNotifications();
    await renderNotifyBanner();
  })
);
$('btn-notify-dismiss').addEventListener('click', () => {
  try {
    localStorage.setItem(BANNER_KEY, 'dismissed');
  } catch {
    /* storage blocked */
  }
  $('notify-banner').hidden = true;
});

// ---------- appearance ----------
const THEMES = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

function renderThemePickers() {
  const current = window.koolkatTheme.get();
  for (const picker of document.querySelectorAll('[data-theme-picker]')) {
    picker.replaceChildren(
      ...THEMES.map(([value, label]) =>
        el('button', {
          type: 'button',
          role: 'radio',
          class: `tab${value === current ? ' active' : ''}`,
          'aria-checked': String(value === current),
          text: label,
          onclick: () => {
            window.koolkatTheme.set(value);
            renderThemePickers();
          },
        })
      )
    );
  }
}
renderThemePickers();

const TEXT_STYLES = [
  ['regular', 'Regular text', 'SemiBold headings'],
  ['semibold', 'Semibold text', 'Bold headings'],
];

function renderTextStylePicker() {
  const current = window.koolkatTheme.getText();
  $('text-style-picker').replaceChildren(
    ...TEXT_STYLES.map(([value, text, headings]) =>
      el(
        'button',
        {
          type: 'button',
          role: 'radio',
          class: `tab text-style-${value}${value === current ? ' active' : ''}`,
          'aria-checked': String(value === current),
          onclick: () => {
            window.koolkatTheme.setText(value);
            renderTextStylePicker();
          },
        },
        el('span', { class: 'text-style-text', text }),
        el('span', { class: 'text-style-headings', text: headings })
      )
    )
  );
}
renderTextStylePicker();

// ---------- boot ----------

// ---------- adding friends in person: QR codes ----------
let qrTimer = null;

async function addByCode(code) {
  const res = await api('POST', '/friends/qr', { code });
  toast(res.status === 'already' ? `You and ${res.user.displayName} are already friends` : `🎉 You and ${res.user.displayName} are now friends!`);
  openFriends();
  return res;
}

async function openMyQr() {
  const dialog = $('dialog-qr');
  const canvas = $('qr-canvas');
  $('qr-username').textContent = `@${state.me.username}`;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  let current = null;
  const draw = async () => {
    try {
      const { code } = await api('GET', '/friend-code');
      if (code !== current) {
        current = code;
        drawQr(canvas, friendLink(code));
      }
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  clearInterval(qrTimer);
  // The server swaps the code before it runs out; check every minute while it's on screen.
  qrTimer = setInterval(() => document.visibilityState === 'visible' && draw(), 60_000);
  dialog.onclose = () => clearInterval(qrTimer);
  $('btn-qr-share').onclick = async () => {
    if (!current) return;
    const url = friendLink(current);
    try {
      if (navigator.share) await navigator.share({ title: 'Add me on KoolKat', text: `Add me on KoolKat: @${state.me.username}`, url });
      else await copyText(url);
    } catch {
      // Sharing was cancelled.
    }
  };
  $('btn-qr-scan').onclick = () => {
    dialog.close();
    openScanner();
  };
  if (!dialog.open) dialog.showModal();
  await draw();
}

$('btn-my-qr').addEventListener('click', openMyQr);
$('btn-profile-qr').addEventListener('click', () => {
  $('dialog-profile').close();
  openMyQr();
});

const scanner = { run: 0, stream: null, stop: null, lastBad: '' };

function setScanStatus(text) {
  $('scan-status').textContent = text;
}

async function openScanner() {
  show('scan');
  const run = ++scanner.run;
  scanner.lastBad = '';
  setScanStatus('Starting the camera…');
  let stream;
  try {
    stream = await openCamera('environment');
  } catch (err) {
    if (run === scanner.run) setScanStatus(CAMERA_ERRORS[err?.name] || "Couldn't start the camera.");
    return;
  }
  if (run !== scanner.run || state.screen !== 'scan') {
    stopStream(stream);
    return;
  }
  scanner.stream = stream;
  const video = $('scan-video');
  video.srcObject = stream;
  video.play().catch(() => {});
  setScanStatus("Point your camera at a friend's KoolKat QR code");
  try {
    const stop = await scanVideo(video, handleScanned);
    if (run === scanner.run) scanner.stop = stop;
    else stop();
  } catch (err) {
    if (run === scanner.run) setScanStatus(err.message);
  }
}

async function handleScanned(text) {
  if (text === scanner.lastBad) return false;
  const code = parseFriendCode(text);
  if (!code) {
    scanner.lastBad = text;
    setScanStatus("That QR code isn't a KoolKat friend code");
    return false;
  }
  setScanStatus('Adding friend…');
  try {
    await addByCode(code);
    return true;
  } catch (err) {
    scanner.lastBad = text;
    setScanStatus(err.message);
    return false;
  }
}

function stopScanner() {
  scanner.run++;
  scanner.stop?.();
  scanner.stop = null;
  stopStream(scanner.stream);
  scanner.stream = null;
  $('scan-video').srcObject = null;
}

$('btn-scan-qr').addEventListener('click', openScanner);
$('btn-scan-my-qr').addEventListener('click', () => {
  openFriends();
  openMyQr();
});
window.addEventListener('hashchange', () => {
  if (state.me && location.hash.startsWith('#add/')) {
    const view = location.hash.slice(1);
    history.replaceState(null, '', location.pathname + location.search);
    openView(view);
  }
});

// ---------- adding friends in person: Nearby ----------
const near = { run: 0, watch: null, timer: null, position: null, busy: false };

function setNearbyStatus(text) {
  $('nearby-status').textContent = text;
}

function openNearby() {
  show('nearby');
  $('nearby-list').replaceChildren();
  const run = ++near.run;
  if (!navigator.geolocation) {
    setNearbyStatus("This browser can't share your location, so Nearby doesn't work here. Try a QR code instead.");
    return;
  }
  setNearbyStatus('Finding where you are… If your browser asks, tap Allow.');
  near.watch = navigator.geolocation.watchPosition(
    (pos) => {
      if (run !== near.run) return;
      const first = !near.position;
      near.position = pos.coords;
      if (first) nearbyCheckIn(run);
    },
    (err) => {
      if (run !== near.run) return;
      setNearbyStatus(
        err.code === err.PERMISSION_DENIED
          ? 'Nearby needs your location. Allow location for KoolKat in your browser settings, then open Nearby again.'
          : "Couldn't find your location. Try turning on Wi-Fi or going outside."
      );
    },
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 }
  );
  near.timer = setInterval(() => nearbyCheckIn(run), 5000);
}

async function nearbyCheckIn(run) {
  if (run !== near.run || !near.position || near.busy || document.visibilityState !== 'visible') return;
  near.busy = true;
  try {
    const { latitude: lat, longitude: lng, accuracy } = near.position;
    const { people } = await api('POST', '/nearby', { lat, lng, accuracy: Math.round(accuracy || 0) });
    if (run === near.run) renderNearby(people, run);
  } catch (err) {
    if (run === near.run) setNearbyStatus(err.message);
  } finally {
    near.busy = false;
  }
}

function renderNearby(people, run) {
  setNearbyStatus(
    people.length
      ? `${people.length === 1 ? '1 person' : `${people.length} people`} near you`
      : 'Looking for people near you… Ask them to open Friends → Nearby too.'
  );
  const after = () => nearbyCheckIn(run);
  $('nearby-list').replaceChildren(
    ...people.map((u) => {
      const action = {
        none: actionButton('Add', () => addFriend(u).then(after)),
        incoming: actionButton('Accept', () => acceptFriend(u).then(after)),
        outgoing: el('button', { type: 'button', class: 'btn small', disabled: true, text: 'Requested' }),
        friends: el('button', { type: 'button', class: 'btn small', disabled: true, text: 'Friends' }),
      }[u.relationship];
      return userRow(u, null, action);
    })
  );
}

function stopNearby() {
  near.run++;
  if (near.watch != null) navigator.geolocation?.clearWatch(near.watch);
  clearInterval(near.timer);
  near.watch = null;
  near.position = null;
  // Disappear from everyone else's Nearby list straight away.
  api('DELETE', '/nearby').catch(() => {});
}

$('btn-nearby').addEventListener('click', openNearby);

// ---------- KoolKat Unlimited: Activity Bubbles ----------
const ACTIVITY_EMOJIS = ['🎮', '📚', '🎧', '🍕', '💤', '🏃', '🎬', '✈️', '💼', '🎉'];
const activityLabel = (a) => `${a.emoji} ${a.text}`.trim();

function showActivity(node, activity) {
  node.textContent = activity ? activityLabel(activity) : '';
  node.hidden = !activity;
}

function renderActivityEditor(plan, { fill = true } = {}) {
  const a = plan.activity;
  const emojiInput = $('activity-emoji');
  const textInput = $('activity-text');
  if (fill && document.activeElement !== emojiInput && document.activeElement !== textInput) {
    emojiInput.value = a?.emoji ?? '';
    textInput.value = a?.text ?? '';
  }
  $('btn-activity-clear').disabled = !a;
  $('activity-emojis').replaceChildren(
    ...ACTIVITY_EMOJIS.map((emoji) =>
      el('button', {
        type: 'button',
        class: 'emoji-chip',
        role: 'radio',
        'aria-checked': String(emojiInput.value === emoji),
        text: emoji,
        onclick: () => {
          emojiInput.value = emoji;
          renderActivityEditor(state.plan, { fill: false });
          textInput.focus();
        },
      })
    )
  );
}

$('activity-emoji').addEventListener('input', () => renderActivityEditor(state.plan, { fill: false }));
$('btn-activity-save').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const hours = $('activity-hours').value;
    const { activity } = await api('POST', '/me/activity', {
      emoji: $('activity-emoji').value.trim(),
      text: $('activity-text').value,
      hours: hours ? Number(hours) : null,
    });
    state.plan.activity = activity;
    renderPlan();
    toast('🫧 Your friends can see what you are up to');
  })
);
$('activity-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('btn-activity-save').click();
  }
});
$('btn-activity-clear').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    await api('DELETE', '/me/activity');
    state.plan.activity = null;
    $('activity-emoji').value = '';
    $('activity-text').value = '';
    renderPlan();
    toast('Activity cleared');
  })
);

// ---------- KoolKat Unlimited: chat themes ----------
// The background picture is private, so it's fetched with your login and kept as a blob URL.
const chatPicture = { version: null, url: null, loading: null };

async function chatPictureUrl(version) {
  if (chatPicture.version === version && chatPicture.url) return chatPicture.url;
  if (chatPicture.version === version && chatPicture.loading) return chatPicture.loading;
  chatPicture.version = version;
  chatPicture.loading = (async () => {
    const res = await fetch(`${API_BASE}/api/me/chat-background`, { headers: { authorization: `Bearer ${getToken()}` } });
    if (!res.ok) return null;
    if (chatPicture.url) URL.revokeObjectURL(chatPicture.url);
    chatPicture.url = URL.createObjectURL(await res.blob());
    return chatPicture.url;
  })().catch(() => null);
  return chatPicture.loading;
}

/** Black or white text, whichever reads better on `hex`. */
function textOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.4 ? '#0f172a' : '#ffffff';
}

async function applyChatTheme(node, theme) {
  node.dataset.bg = theme?.background ?? 'default';
  node.style.removeProperty('--chat-custom-bg');
  node.style.removeProperty('--chat-image');
  if (theme?.bubble) {
    node.style.setProperty('--bubble-mine', theme.bubble);
    node.style.setProperty('--bubble-mine-text', textOn(theme.bubble));
  } else {
    node.style.removeProperty('--bubble-mine');
    node.style.removeProperty('--bubble-mine-text');
  }
  if (theme?.background === 'color') node.style.setProperty('--chat-custom-bg', theme.color);
  if (theme?.background === 'image') {
    const url = await chatPictureUrl(theme.imageVersion);
    if (url && node.dataset.bg === 'image') node.style.setProperty('--chat-image', `url("${url}")`);
  }
}

function renderChatThemeEditor(plan) {
  const theme = plan.chatTheme;
  const current = theme?.background ?? 'default';
  for (const button of document.querySelectorAll('#chat-backgrounds .swatch')) {
    button.setAttribute('aria-checked', String(button.dataset.bg === current));
  }
  if (theme?.color) {
    $('chat-bg-color').value = theme.color;
    $('swatch-color').style.setProperty('--chat-custom-bg', theme.color);
  }
  if (theme?.background === 'image') {
    chatPictureUrl(theme.imageVersion).then((url) => {
      if (url) $('swatch-image').style.setProperty('--chat-image', `url("${url}")`);
      $('swatch-image').textContent = url ? '' : '＋';
    });
  } else {
    $('swatch-image').style.removeProperty('--chat-image');
    $('swatch-image').textContent = '＋';
  }
  // No bubble colour of your own: your bubbles match your accent colour.
  $('chat-bubble-color').value = theme?.bubble ?? plan.accentColor ?? '#002eff';
  $('btn-bubble-reset').disabled = !theme?.bubble;
  applyChatTheme($('chat-preview'), theme);
}

async function saveChatTheme(changes) {
  const theme = state.plan?.chatTheme ?? {};
  const body = { background: theme.background ?? 'default', color: theme.color, bubble: theme.bubble ?? null, ...changes };
  if (body.background !== 'color') delete body.color;
  const { chatTheme } = await api('POST', '/me/chat-theme', body);
  state.plan.chatTheme = chatTheme;
  renderChatThemeEditor(state.plan);
  toast('💬 Chat theme saved');
}

const reportError = (err) => toast(err.message, { error: true });

$('chat-backgrounds').addEventListener('click', (e) => {
  const button = e.target.closest('.swatch');
  if (!button) return;
  const bg = button.dataset.bg;
  if (bg === 'color') $('chat-bg-color').click();
  else if (bg === 'image') $('chat-bg-file').click();
  else saveChatTheme({ background: bg }).catch(reportError);
});
$('chat-bg-color').addEventListener('change', (e) =>
  saveChatTheme({ background: 'color', color: e.target.value }).catch(reportError)
);
$('chat-bg-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const img = await loadImageFile(file);
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    let quality = 0.8;
    let data = canvas.toDataURL('image/jpeg', quality);
    while (data.length > 900_000 && quality > 0.4) {
      quality -= 0.15;
      data = canvas.toDataURL('image/jpeg', quality);
    }
    await saveChatTheme({ background: 'image', image: data.split(',')[1] });
  } catch (err) {
    reportError(err);
  }
});
$('chat-bubble-color').addEventListener('change', (e) => saveChatTheme({ bubble: e.target.value }).catch(reportError));
$('btn-bubble-reset').addEventListener('click', () => saveChatTheme({ bubble: null }).catch(reportError));

// ---------- KoolKat Unlimited: accent colour ----------
const DEFAULT_ACCENT = '#002eff';
for (const swatch of document.querySelectorAll('.accent-swatch')) {
  swatch.style.setProperty('--swatch', swatch.dataset.accent || DEFAULT_ACCENT);
}

function renderAccentEditor(plan) {
  const current = plan?.accentColor ?? '';
  for (const swatch of document.querySelectorAll('.accent-swatch')) {
    swatch.setAttribute('aria-checked', String(swatch.dataset.accent === current));
  }
  $('accent-picker').value = current || DEFAULT_ACCENT;
  if (document.activeElement !== $('accent-hex')) $('accent-hex').value = (current || '').toUpperCase();
}

async function saveAccent(value) {
  const color = value ? window.koolkatTheme.normaliseHex(value) : null;
  if (value && !color) throw new Error("That isn't a hex colour. Try something like #FF0000.");
  const { accentColor } = await api('POST', '/me/accent', { color });
  state.plan.accentColor = accentColor;
  window.koolkatTheme.setAccent(accentColor);
  applyAppIcon(state.plan.appIcon);
  $('accent-hex').value = (accentColor || '').toUpperCase();
  renderAccentEditor(state.plan);
  renderChatThemeEditor(state.plan);
  toast(accentColor ? `🎨 Accent colour set to ${accentColor.toUpperCase()}` : '🎨 Back to KoolKat blue');
}

$('accent-swatches').addEventListener('click', (e) => {
  const swatch = e.target.closest('.accent-swatch');
  if (swatch) saveAccent(swatch.dataset.accent || null).catch(reportError);
});
// Dragging the picker previews the colour; letting go saves it.
$('accent-picker').addEventListener('input', (e) => {
  window.koolkatTheme.setAccent(e.target.value);
  $('accent-hex').value = e.target.value.toUpperCase();
});
$('accent-picker').addEventListener('change', (e) => saveAccent(e.target.value).catch(reportError));
// A pasted or typed hex code ("#FF0000", "ff0000" or "#f00").
$('accent-hex').addEventListener('input', (e) => {
  const hex = window.koolkatTheme.normaliseHex(e.target.value);
  if (hex) $('accent-picker').value = hex;
});
const applyAccentHex = () => withBusy($('btn-accent-apply'), () => saveAccent($('accent-hex').value.trim()));
$('btn-accent-apply').addEventListener('click', applyAccentHex);
$('accent-hex').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); // don't close the profile dialog
  applyAccentHex();
});

// ---------- KoolKat Unlimited: Kat Map ----------
let leafletLoading = null;
/** Leaflet (the map library) is only downloaded when Kat Map is opened. */
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletLoading ??= new Promise((resolve, reject) => {
    document.head.append(el('link', { rel: 'stylesheet', href: 'vendor/leaflet/leaflet.css' }));
    const script = el('script', { src: 'vendor/leaflet/leaflet.js' });
    script.onload = () => resolve(window.L);
    script.onerror = () => {
      leafletLoading = null;
      reject(new Error("The map couldn't be loaded. Check your connection."));
    };
    document.head.append(script);
  });
  return leafletLoading;
}

const katmap = { map: null, markers: new Map(), timer: null, data: null, fitted: 0, run: 0 };

// Sending your location while KoolKat is open (browsers pause this when it's in the background).
const mapShare = { watch: null, last: null, sentAt: 0, sending: false };

function shareDistance(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const x = rad(b.longitude - a.longitude) * Math.cos(rad((a.latitude + b.latitude) / 2));
  const y = rad(b.latitude - a.latitude);
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

function startMapSharing() {
  if (mapShare.watch != null || !navigator.geolocation) return;
  mapShare.watch = navigator.geolocation.watchPosition(
    (pos) => sendMapLocation(pos.coords),
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        stopMapSharing();
        if (state.screen === 'katmap') $('katmap-status').textContent = 'Allow location for KoolKat in your browser settings to share where you are.';
      }
    },
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 }
  );
}

function stopMapSharing() {
  if (mapShare.watch != null) navigator.geolocation.clearWatch(mapShare.watch);
  mapShare.watch = null;
  mapShare.last = null;
}

async function sendMapLocation(coords, { force = false } = {}) {
  const now = Date.now();
  const moved = mapShare.last ? shareDistance(mapShare.last, coords) : Infinity;
  // Send when you've moved a bit, or at least every 30 seconds.
  if (!force && moved < 25 && now - mapShare.sentAt < 30_000) return;
  if (mapShare.sending || document.visibilityState !== 'visible') return;
  mapShare.sending = true;
  try {
    await api('POST', '/map/location', { lat: coords.latitude, lng: coords.longitude, accuracy: Math.round(coords.accuracy || 0) });
    mapShare.last = { latitude: coords.latitude, longitude: coords.longitude };
    mapShare.sentAt = now;
    if (state.screen === 'katmap') loadKatMap().catch(() => {});
  } catch (err) {
    if (err.status === 409 || err.status === 403) stopMapSharing();
  } finally {
    mapShare.sending = false;
  }
}

/** After signing in: keep sharing if it was on and location is already allowed (never asks by itself). */
async function resumeMapSharing() {
  if (!state.plan || state.plan.mapMode === 'off' || state.plan.plan !== 'unlimited') return;
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    if (status?.state === 'granted') startMapSharing();
  } catch {
    // No Permissions API: wait until Kat Map is opened.
  }
}

async function openKatMap() {
  show('katmap');
  const run = ++katmap.run;
  const unlimited = state.plan?.plan === 'unlimited';
  $('katmap').hidden = !unlimited;
  $('katmap-sheet').hidden = !unlimited;
  $('katmap-locked').hidden = unlimited;
  $('btn-katmap-me').hidden = !unlimited;
  if (!unlimited) return;
  renderMapModes(state.plan.mapMode);
  $('katmap-status').textContent = 'Loading the map…';
  try {
    const L = await loadLeaflet();
    if (run !== katmap.run) return;
    if (!katmap.map) {
      katmap.map = L.map('katmap', { zoomControl: false, worldCopyJump: true }).setView([20, 0], 2);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        // OpenStreetMap asks apps to say where tile requests come from.
        referrerPolicy: 'strict-origin-when-cross-origin',
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      }).addTo(katmap.map);
    }
    katmap.fitted = 0;
    // The map was hidden while its size changed.
    setTimeout(() => katmap.map?.invalidateSize(), 50);
    await loadKatMap();
    if (state.plan.mapMode !== 'off') startMapSharing();
  } catch (err) {
    if (run === katmap.run) $('katmap-status').textContent = err.message;
  }
  clearInterval(katmap.timer);
  katmap.timer = setInterval(() => document.visibilityState === 'visible' && loadKatMap().catch(() => {}), 10_000);
}

function stopKatMap() {
  katmap.run++;
  clearInterval(katmap.timer);
}

function renderMapModes(mode) {
  for (const tab of document.querySelectorAll('#katmap-modes .tab')) {
    const on = tab.dataset.mode === mode;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-checked', String(on));
  }
}

function pinIcon(me = false) {
  return window.L.divIcon({
    className: `kat-pin${me ? ' me' : ''}`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    html: '',
  });
}

function placeMarker(key, user, location, me) {
  const L = window.L;
  let marker = katmap.markers.get(key);
  if (!marker) {
    marker = L.marker([location.lat, location.lng], { icon: pinIcon(me), keyboard: false }).addTo(katmap.map);
    katmap.markers.set(key, marker);
  } else {
    marker.setLatLng([location.lat, location.lng]);
  }
  // Built with DOM nodes so names are never treated as HTML.
  const node = marker.getElement();
  if (node) {
    node.replaceChildren(
      el('span', { class: 'pin-avatar', text: me ? '😺' : (user.displayName || user.username)[0] }),
      el('span', { class: 'pin-name', text: me ? 'You' : user.displayName })
    );
  }
  return marker;
}

async function loadKatMap() {
  const run = katmap.run;
  const data = await api('GET', '/map');
  if (run !== katmap.run || !katmap.map) return;
  katmap.data = data;
  state.plan.mapMode = data.mode;
  renderMapModes(data.mode);
  const seen = new Set();
  const points = [];
  if (data.location) {
    placeMarker('me', state.me, data.location, true);
    seen.add('me');
    points.push([data.location.lat, data.location.lng]);
  }
  for (const f of data.friends) {
    placeMarker(f.id, f, f.location, false).off('click').on('click', () => openFriendFromMap(f));
    seen.add(f.id);
    points.push([f.location.lat, f.location.lng]);
  }
  for (const [key, marker] of katmap.markers) {
    if (!seen.has(key)) {
      marker.remove();
      katmap.markers.delete(key);
    }
  }
  // Zoom to fit everyone, again whenever someone new (or you) appears.
  if (points.length > katmap.fitted) {
    katmap.fitted = points.length;
    if (points.length === 1) katmap.map.setView(points[0], 15);
    else katmap.map.fitBounds(points, { padding: [48, 48], maxZoom: 16 });
  }
  const sharing = {
    off: "👻 Ghost mode: nobody can see where you are.",
    bffs: '💙 Your BFFs can see where you are while KoolKat is open.',
    friends: '👥 Your friends can see where you are while KoolKat is open.',
  }[data.mode];
  $('katmap-status').textContent = sharing;
  $('katmap-list').replaceChildren(
    ...(data.friends.length
      ? data.friends.map((f) =>
          el(
            'li',
            {},
            el(
              'button',
              { type: 'button', class: 'item', onclick: () => katmap.map.flyTo([f.location.lat, f.location.lng], 16) },
              avatar(f),
              el(
                'span',
                { class: 'item-main' },
                nameEl(f),
                el('div', { class: 'item-sub', text: `${timeAgo(f.location.at)}${f.activity ? ` · ${activityLabel(f.activity)}` : ''}` })
              )
            )
          )
        )
      : [el('li', { class: 'empty', text: 'None of your friends are sharing their location right now.' })])
  );
}

function openFriendFromMap(f) {
  const friend = state.friends.find((x) => x.id === f.id);
  if (friend) openFriend(friend);
}

$('btn-katmap').addEventListener('click', openKatMap);
$('btn-katmap-me').addEventListener('click', () => {
  const loc = katmap.data?.location;
  if (loc) katmap.map?.flyTo([loc.lat, loc.lng], 16);
  else toast('Turn on BFFs or Friends sharing to put yourself on the map');
});
$('katmap-modes').addEventListener('click', async (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const mode = tab.dataset.mode;
  try {
    await api('POST', '/map/settings', { mode });
    state.plan.mapMode = mode;
    renderMapModes(mode);
    if (mode === 'off') {
      stopMapSharing();
      toast('👻 Ghost mode on. Your location was deleted.');
    } else {
      startMapSharing();
      // Send straight away instead of waiting for the next move.
      navigator.geolocation?.getCurrentPosition(
        (pos) => sendMapLocation(pos.coords, { force: true }),
        () => {},
        { enableHighAccuracy: true, timeout: 20_000 }
      );
      toast(mode === 'bffs' ? '💙 Sharing your location with your BFFs' : '👥 Sharing your location with your friends');
    }
    await loadKatMap();
  } catch (err) {
    toast(err.message, { error: true });
  }
});


// ---------- Calls and FaceTime ----------
initCalls({
  me: () => state.me,
  findFriend: (id) => state.friends.find((f) => f.id === id),
  toast,
  beforeShow: () => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  },
  beforeMedia: async (kind) => {
    // Phones can't use the camera twice: FaceTime takes it from the KoolKat camera.
    if (kind === 'video' && state.screen === 'camera') stopCamera();
  },
  afterCall: (kind) => {
    if (kind === 'video' && state.screen === 'camera') startCamera();
  },
});

function chatPeer() {
  const other = chat.current?.members.find((m) => m.id !== state.me.userId);
  return other && state.friends.find((f) => f.id === other.id);
}
$('btn-chat-call').addEventListener('click', () => {
  const friend = chatPeer();
  if (friend) startCall(friend, 'audio');
});
$('btn-chat-facetime').addEventListener('click', () => {
  const friend = chatPeer();
  if (friend) startCall(friend, 'video');
});

// ---------- sounds ----------
function renderSoundsRow() {
  const on = soundsOn();
  $('sounds-status').textContent = on
    ? 'A sound plays for new Klicks, messages and requests while KoolKat is open'
    : 'Off (calls still ring)';
  $('btn-sounds').textContent = on ? 'Turn off' : 'Turn on';
}
$('btn-sounds').addEventListener('click', () => {
  setSoundsOn(!soundsOn());
  renderSoundsRow();
  if (soundsOn()) playNotification();
});

// ---------- profile pages (yours and everyone else's) ----------
const userPage = { user: null, reels: [], from: 'home' };

/** 1234 → "1,234"; 15300 → "15.3K"; 1100000 → "1.1M". */
function compactNumber(n) {
  if (n < 10000) return n.toLocaleString();
  const [value, unit] = n >= 1e6 ? [n / 1e6, 'M'] : [n / 1e3, 'K'];
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
}

async function openUserProfile(userId) {
  const from = state.screen === 'user' ? userPage.from : state.screen || 'home';
  let user;
  try {
    ({ user } = await api('GET', `/users/${userId}`));
  } catch (err) {
    toast(err.message, { error: true });
    return;
  }
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  userPage.user = user;
  userPage.from = from;
  renderUserPage();
  show('user');
  $('screen-user').scrollTop = 0;
  try {
    const { reels: list } = await api('GET', `/reels?user=${user.id}&limit=50`);
    if (userPage.user !== user) return;
    userPage.reels = list;
    renderReelGrid($('up-grid'), list, { source: 'user' });
    $('up-empty').hidden = list.length > 0;
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderUserPage() {
  const user = userPage.user;
  const you = user.relationship === 'you';
  if (you) Object.assign(user, { displayName: state.me.displayName, avatarUrl: state.me.avatarUrl });
  $('up-title').replaceChildren(...nodes(user.displayName, badgeImg(user)));
  fillAvatar($('up-avatar'), user);
  $('up-username').textContent = `@${user.username}`;
  $('up-marks').replaceChildren();
  $('up-admin').hidden = !user.isAdmin;
  $('up-flair').textContent = user.flair || '';
  $('up-flair').hidden = !user.flair;
  showActivity($('up-activity'), user.activity);
  $('up-friends').textContent = compactNumber(user.stats?.friends ?? 0);
  $('up-reels').textContent = compactNumber(user.stats?.reels ?? 0);
  $('up-likes').textContent = compactNumber(user.stats?.likes ?? 0);
  renderSocials($('up-socials'), user.socials);
  $('up-joined').textContent = `On KoolKat since ${formatDate(user.joinedAt)}`;
  $('up-grid').replaceChildren();
  $('up-empty').hidden = true;
  $('up-more').hidden = true;

  const friend = state.friends.find((f) => f.id === user.id);
  const more = (items) =>
    el('button', {
      type: 'button',
      class: 'btn up-btn up-btn-more',
      'aria-label': 'More',
      'aria-expanded': 'false',
      onclick: (e) => {
        const menu = $('up-more');
        menu.hidden = !menu.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!menu.hidden));
        menu.replaceChildren(...nodes(...items));
      },
      text: '▾',
    });
  const big = (text, onclick, cls = '') => el('button', { type: 'button', class: `btn up-btn ${cls}`, text, onclick: (e) => withBusy(e.currentTarget, onclick) });
  const reload = () => openUserProfile(user.id);
  const actions = {
    you: [
      big('Edit profile', openProfileSettings, 'primary'),
      big('Share profile', async () => openMyQr()),
      more([el('button', { type: 'button', class: 'btn small', text: '🔗 Social links', onclick: openSocials }), el('button', { type: 'button', class: 'btn small', text: '🎂 Birthday', onclick: openBirthday })]),
    ],
    friends: [
      big('Message', () => startDirectChat(user.id), 'primary'),
      big('📞 Call', async () => friend && startCall(friend, 'audio')),
      more(
        friend
          ? [
              el('button', { type: 'button', class: 'btn small', text: '📹 FaceTime', onclick: () => startCall(friend, 'video') }),
              el('button', { type: 'button', class: 'btn small', text: '🔒 Friend details', onclick: () => openFriend(friend) }),
            ]
          : []
      ),
    ],
    none: [big('Add friend', () => addFriend(user).then(reload), 'primary snap')],
    incoming: [big('Accept friend request', () => acceptFriend(user).then(reload), 'primary snap')],
    outgoing: [el('button', { type: 'button', class: 'btn up-btn', disabled: true, text: 'Request sent' })],
  }[user.relationship] ?? [];
  $('up-actions').replaceChildren(...actions);
}

$('btn-up-back').addEventListener('click', () => {
  const to = userPage.from;
  if (to === 'chats') openChats();
  else if (to === 'friends') openFriends();
  else if (to === 'home' || !to || to === 'user') openHome();
  else show(to);
});
$('btn-up-share').addEventListener('click', async () => {
  const user = userPage.user;
  if (!user) return;
  if (user.relationship === 'you') return openMyQr();
  const text = `${user.displayName} (@${user.username}) is on KoolKat`;
  try {
    if (navigator.share) await navigator.share({ title: 'KoolKat', text, url: location.origin });
    else {
      await navigator.clipboard.writeText(`${text}: ${location.origin}`);
      toast('Copied');
    }
  } catch {
    // Share sheet closed.
  }
});

/** A grid of Reel thumbnails (profiles, and Reels on Home). */
function renderReelGrid(grid, list, { source }) {
  grid.replaceChildren(
    ...list.map((r, i) =>
      el(
        'button',
        { type: 'button', class: 'reel-thumb', 'aria-label': r.caption || `Reel by @${r.author.username}`, onclick: () => openReels({ list, start: i, source }) },
        reelPoster(r),
        el('span', { class: 'reel-thumb-views', text: `▶ ${compactNumber(r.views)}` })
      )
    )
  );
}

function reelPoster(r) {
  if (r.poster) return el('img', { src: `${API_BASE}/api/${r.poster}`, alt: '', loading: 'lazy' });
  return el('video', { src: `${API_BASE}/api/${r.video.url}#t=0.5`, muted: true, playsinline: true, preload: 'metadata' });
}

// ---------- Home ----------
const home = { chip: 'all', reels: [], posts: [] };

function openHome() {
  show('home');
  renderHomeFriends();
  loadHome();
}
$('tab-home').addEventListener('click', () => {
  if (state.screen === 'home') $('home-feed').scrollTo({ top: 0, behavior: 'smooth' });
  openHome();
});
$('tab-camera').addEventListener('click', () => show('camera'));
$('btn-camera-close').addEventListener('click', openHome);
$('chip-favorites').addEventListener('click', openFavorites);
$('home-klicks').addEventListener('click', openInbox);

$('home-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-chip]');
  if (!chip) return;
  home.chip = chip.dataset.chip;
  renderHome();
  $('home-feed').scrollTo({ top: 0 });
});

async function loadHome() {
  const [reelsRes, newsRes] = await Promise.allSettled([api('GET', '/reels?limit=24'), api('GET', '/news')]);
  if (reelsRes.status === 'fulfilled') home.reels = reelsRes.value.reels;
  if (newsRes.status === 'fulfilled') home.posts = newsRes.value.posts;
  renderHome();
}

function renderHome() {
  const chip = home.chip;
  for (const c of document.querySelectorAll('#home-chips [data-chip]')) {
    const on = c.dataset.chip === chip;
    c.classList.toggle('active', on);
    c.setAttribute('aria-selected', String(on));
  }
  const showSection = (id, kinds) => ($(id).hidden = !kinds.includes(chip));
  showSection('home-reels-shelf', ['all', 'reels']);
  showSection('home-news-section', ['all', 'news']);
  showSection('home-friends-shelf', ['all', 'friends']);
  if (chip === 'all' && !state.friends.length) $('home-friends-shelf').hidden = true;

  renderHomeKlicks();

  // Reels: a shelf you swipe sideways on All, a grid on Reels.
  const grid = chip === 'reels';
  $('home-reels').hidden = grid;
  $('home-reels-grid').hidden = !grid;
  $('home-reels-empty').hidden = home.reels.length > 0;
  if (grid) renderReelGrid($('home-reels-grid'), home.reels, { source: 'home' });
  else {
    $('home-reels').replaceChildren(
      ...home.reels.map((r, i) =>
        el(
          'button',
          { type: 'button', class: 'shelf-reel', onclick: () => openReels({ list: home.reels, start: i, source: 'home' }) },
          el('span', { class: 'shelf-reel-poster' }, reelPoster(r)),
          el('span', { class: 'shelf-reel-caption', text: r.caption || `@${r.author.username}` }),
          el('span', { class: 'shelf-reel-meta', text: `${compactNumber(r.views)} view${r.views === 1 ? '' : 's'}` })
        )
      )
    );
  }

  // News, as video-style cards.
  $('home-news-empty').hidden = home.posts.length > 0;
  $('home-news').replaceChildren(...home.posts.map(homeNewsCard));
  if (chip === 'friends') renderHomeFriends();
}

/** "You have 3 new Klicks", when there are some. */
function renderHomeKlicks() {
  const unopened = state.inbox.filter((s) => !s.opened).length;
  $('home-klicks').hidden = !unopened || !['all', 'friends'].includes(home.chip);
  $('home-klicks').replaceChildren(
    el('span', { class: 'home-klicks-dot' }),
    el('span', { text: unopened === 1 ? '📬 You have a new Klick' : `📬 You have ${unopened} new Klicks` }),
    el('span', { class: 'home-klicks-go', text: 'Open ›' })
  );
}

function homeNewsCard(p) {
  const open = () => openNews(p.id);
  let thumb;
  if (p.media?.kind === 'image') thumb = el('img', { src: `${API_BASE}/api/${p.media.url}`, alt: '', loading: 'lazy' });
  else if (p.media?.kind === 'video') {
    thumb = el('video', { src: `${API_BASE}/api/${p.media.url}#t=0.5`, muted: true, playsinline: true, preload: 'metadata' });
  } else thumb = el('span', { class: 'home-card-title-art' }, el('img', { src: logoSrc(), alt: '', 'data-logo': true }), el('span', { text: p.title }));
  const details = [p.author ? `@${p.author.username}` : 'KoolKat', `${compactNumber(p.likes)} ♥`, timeAgo(p.createdAt)];
  return el(
    'article',
    { class: 'home-card' },
    el(
      'button',
      { type: 'button', class: 'home-card-thumb', 'aria-label': p.title, onclick: open },
      thumb,
      p.media?.kind === 'video' ? el('span', { class: 'home-card-play', text: '▶' }) : null,
      p.poll ? el('span', { class: 'home-card-tag', text: '📊 Poll' }) : p.code ? el('span', { class: 'home-card-tag', text: '🎁 Code' }) : null
    ),
    el(
      'div',
      { class: 'home-card-info' },
      p.author
        ? el('button', { type: 'button', class: 'home-card-avatar', 'aria-label': `@${p.author.username}`, onclick: () => openUserProfile(p.author.id) }, avatar(p.author))
        : el('span', { class: 'home-card-avatar' }, el('img', { src: logoSrc(), alt: '', class: 'avatar', 'data-logo': true })),
      el(
        'button',
        { type: 'button', class: 'home-card-text', onclick: open },
        el('span', { class: 'home-card-headline', text: p.title }),
        el('span', { class: 'home-card-meta' }, ...nodes(details.join(' · '), p.author && badgeImg(p.author)))
      )
    )
  );
}

function renderHomeFriends() {
  $('home-friends').replaceChildren(
    ...state.friends.map((f) =>
      el(
        'button',
        { type: 'button', class: 'home-friend', onclick: () => openUserProfile(f.id) },
        el('span', { class: `home-friend-ring${f.streak?.count ? ' streak' : ''}` }, avatar(f)),
        el('span', { class: 'home-friend-name', text: f.displayName }),
        f.streak?.count ? el('span', { class: 'home-friend-streak', text: `🔥 ${f.streak.count}` }) : null
      )
    ),
    el(
      'button',
      { type: 'button', class: 'home-friend', onclick: openFriends },
      el('span', { class: 'home-friend-ring add' }, el('span', { class: 'avatar', text: '＋' })),
      el('span', { class: 'home-friend-name', text: 'Add friends' })
    )
  );
}

// ---------- KoolKat Reels ----------
// A full-screen feed you swipe up through, like TikTok. Everyone can watch,
// heart and comment; posting is part of KoolKat Unlimited.
const reels = { list: [], more: false, canPost: false, source: 'feed', observer: null, muted: false, loading: false, viewTimer: null };

async function openReels({ list = null, start = 0, source = 'feed' } = {}) {
  show('reels');
  reels.source = source;
  $('btn-reels-back').hidden = source === 'feed';
  $('reels-title').textContent = source === 'user' ? `@${userPage.user?.username ?? ''}` : 'KoolKat Reels';
  if (list) {
    reels.list = list.slice();
    reels.more = source === 'home';
    renderReels(start);
  } else {
    $('reels-feed').replaceChildren();
    await loadReels();
  }
  if (!list || source === 'home') {
    api('GET', '/reels?limit=1')
      .then((r) => (reels.canPost = r.canPost))
      .catch(() => {});
  }
}
$('tab-reels').addEventListener('click', () => {
  if (state.screen === 'reels' && reels.source === 'feed') {
    $('reels-feed').scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  openReels();
});
$('btn-reels-back').addEventListener('click', () => {
  if (reels.source === 'user' && userPage.user) show('user');
  else openHome();
});

async function loadReels({ append = false } = {}) {
  if (reels.loading) return;
  reels.loading = true;
  try {
    const before = append ? reels.list.at(-1)?.id : null;
    const data = await api('GET', `/reels?limit=10${before ? `&before=${before}` : ''}`);
    reels.canPost = data.canPost;
    reels.more = data.more;
    if (append) {
      const known = new Set(reels.list.map((r) => r.id));
      const fresh = data.reels.filter((r) => !known.has(r.id));
      reels.list.push(...fresh);
      for (const r of fresh) {
        const node = reelItem(r);
        $('reels-feed').append(node);
        reels.observer?.observe(node);
      }
    } else {
      reels.list = data.reels;
      renderReels(0);
    }
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    reels.loading = false;
  }
}

function renderReels(start) {
  reels.observer?.disconnect();
  const feed = $('reels-feed');
  feed.replaceChildren(...reels.list.map(reelItem));
  $('reels-empty').hidden = reels.list.length > 0;
  reels.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const video = entry.target.querySelector('video');
        if (entry.isIntersecting && entry.intersectionRatio > 0.6) playReel(entry.target, video);
        else {
          video.pause();
          if (reels.viewing === entry.target) clearTimeout(reels.viewTimer);
        }
      }
    },
    { root: feed, threshold: [0, 0.6, 1] }
  );
  for (const item of feed.children) reels.observer.observe(item);
  feed.children[start]?.scrollIntoView({ block: 'start' });
}

function playReel(item, video) {
  video.muted = reels.muted;
  video.play().catch(() => {
    // The browser wants a tap before playing sound: play muted until then.
    reels.muted = true;
    video.muted = true;
    updateMuteButtons();
    video.play().catch(() => {});
  });
  // Count a view after a couple of seconds of watching.
  reels.viewing = item;
  clearTimeout(reels.viewTimer);
  const reel = reels.list.find((r) => String(r.id) === item.dataset.reel);
  reels.viewTimer = setTimeout(() => {
    if (!reel || reel.viewed) return;
    reel.viewed = true;
    api('POST', `/reels/${reel.id}/view`)
      .then(({ views }) => (reel.views = views))
      .catch(() => {});
  }, 2000);
  // Nearly at the end: load more.
  if (reels.more && reels.source !== 'user' && item === $('reels-feed').lastElementChild?.previousElementSibling) loadReels({ append: true });
  if (reels.more && reels.source !== 'user' && item === $('reels-feed').lastElementChild) loadReels({ append: true });
}

function pauseReels() {
  clearTimeout(reels.viewTimer);
  for (const video of document.querySelectorAll('#reels-feed video')) video.pause();
}

function updateMuteButtons() {
  for (const b of document.querySelectorAll('.reel-mute')) {
    b.textContent = reels.muted ? '🔇' : '🔊';
    b.setAttribute('aria-label', reels.muted ? 'Turn sound on' : 'Mute');
  }
}

function heartIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'reel-heart');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 21.4 10.6 20C5.4 15.4 2 12.3 2 8.5 2 5.4 4.4 3 7.5 3c1.7 0 3.4.8 4.5 2.1C13.1 3.8 14.8 3 16.5 3 19.6 3 22 5.4 22 8.5c0 3.8-3.4 6.9-8.6 11.5L12 21.4Z');
  svg.append(path);
  return svg;
}

function reelItem(r) {
  const video = el('video', {
    class: 'reel-video',
    src: `${API_BASE}/api/${r.video.url}`,
    poster: r.poster ? `${API_BASE}/api/${r.poster}` : null,
    loop: true,
    playsinline: true,
    preload: 'metadata',
  });
  const paused = el('span', { class: 'reel-paused', text: '▶', hidden: true });
  video.addEventListener('pause', () => (paused.hidden = false));
  video.addEventListener('play', () => (paused.hidden = true));
  const likeCount = el('span', { class: 'reel-count', text: compactNumber(r.likes) });
  const like = el(
    'button',
    { type: 'button', class: `reel-action reel-like${r.liked ? ' on' : ''}`, 'aria-label': 'Heart', 'aria-pressed': String(r.liked) },
    heartIcon(),
    likeCount
  );
  const toggleLike = async (force) => {
    const on = force ?? !r.liked;
    if (on === r.liked) return;
    try {
      const res = await api(on ? 'POST' : 'DELETE', `/reels/${r.id}/like`);
      r.liked = res.liked;
      r.likes = res.likes;
      like.classList.toggle('on', r.liked);
      like.setAttribute('aria-pressed', String(r.liked));
      likeCount.textContent = compactNumber(r.likes);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  like.addEventListener('click', () => toggleLike());
  const commentCount = el('span', { class: 'reel-count', text: compactNumber(r.comments) });
  const mute = el('button', { type: 'button', class: 'reel-action reel-mute', text: reels.muted ? '🔇' : '🔊' });
  mute.addEventListener('click', () => {
    reels.muted = !reels.muted;
    for (const v of document.querySelectorAll('#reels-feed video')) v.muted = reels.muted;
    updateMuteButtons();
  });
  const stage = el('div', { class: 'reel-stage' }, video, paused);
  // Tap to pause; double-tap to heart.
  let lastTap = 0;
  let tapTimer = null;
  stage.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 300) {
      clearTimeout(tapTimer);
      lastTap = 0;
      toggleLike(true);
      const heart = el('span', { class: 'reel-burst', text: '♥' });
      stage.append(heart);
      setTimeout(() => heart.remove(), 800);
      return;
    }
    lastTap = now;
    tapTimer = setTimeout(() => {
      if (reels.muted && !video.paused) {
        reels.muted = false;
        video.muted = false;
        updateMuteButtons();
      } else if (video.paused) video.play().catch(() => {});
      else video.pause();
    }, 300);
  });
  const caption = el('p', { class: 'reel-caption', text: r.caption });
  caption.hidden = !r.caption;
  caption.addEventListener('click', () => caption.classList.toggle('open'));
  return el(
    'article',
    { class: 'reel', 'data-reel': String(r.id) },
    stage,
    el(
      'div',
      { class: 'reel-rail' },
      el('button', { type: 'button', class: 'reel-author-pic', 'aria-label': `@${r.author.username}`, onclick: () => openUserProfile(r.author.id) }, avatar(r.author)),
      like,
      el(
        'button',
        {
          type: 'button',
          class: 'reel-action',
          'aria-label': 'Comments',
          onclick: () => openComments(r, () => (commentCount.textContent = compactNumber(r.comments)), 'reels'),
        },
        el('span', { class: 'reel-icon', text: '💬' }),
        commentCount
      ),
      el(
        'button',
        { type: 'button', class: 'reel-action', 'aria-label': 'Share', onclick: () => shareReel(r) },
        el('span', { class: 'reel-icon', text: '↗' }),
        el('span', { class: 'reel-count', text: 'Share' })
      ),
      mute,
      r.canDelete
        ? el('button', { type: 'button', class: 'reel-action', 'aria-label': 'Delete Reel', onclick: () => deleteReel(r) }, el('span', { class: 'reel-icon', text: '🗑' }))
        : null
    ),
    el(
      'div',
      { class: 'reel-info' },
      el(
        'button',
        { type: 'button', class: 'reel-author', onclick: () => openUserProfile(r.author.id) },
        el('span', { text: `@${r.author.username}` }),
        badgeImg(r.author),
        el('span', { class: 'reel-time', text: ` · ${timeAgo(r.createdAt)}` })
      ),
      caption
    )
  );
}

async function shareReel(r) {
  const text = r.caption ? `${r.caption} (a Reel by @${r.author.username} on KoolKat)` : `A Reel by @${r.author.username} on KoolKat`;
  try {
    if (navigator.share) await navigator.share({ title: 'KoolKat Reels', text, url: `${location.origin}/#reels` });
    else {
      await navigator.clipboard.writeText(`${text}: ${location.origin}/#reels`);
      toast('Link copied');
    }
  } catch {
    // Share sheet closed.
  }
}

async function deleteReel(r) {
  if (!confirm(r.mine ? 'Delete your Reel?' : `Delete this Reel by @${r.author.username}? (admin)`)) return;
  try {
    await api('DELETE', `/reels/${r.id}`);
    reels.list = reels.list.filter((x) => x.id !== r.id);
    home.reels = home.reels.filter((x) => x.id !== r.id);
    userPage.reels = userPage.reels.filter((x) => x.id !== r.id);
    document.querySelector(`#reels-feed [data-reel="${r.id}"]`)?.remove();
    $('reels-empty').hidden = reels.list.length > 0;
    toast('Reel deleted');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------- posting a Reel ----------
const MAX_REEL_VIDEO = 100 * 1024 * 1024;
const MAX_REEL_SECONDS = 3 * 60;
const reelDraft = { file: null, url: null, duration: 0 };

$('btn-reel-new').addEventListener('click', () => {
  if (!reels.canPost) {
    toast('🎬 Posting Reels is part of KoolKat Unlimited. Get it free in your profile!', { error: true });
    return;
  }
  $('reel-file').click();
});

$('reel-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('video/')) return toast('Choose a video', { error: true });
  if (file.size > MAX_REEL_VIDEO) return toast('Reels can be up to 100 MB', { error: true });
  if (reelDraft.url) URL.revokeObjectURL(reelDraft.url);
  reelDraft.file = file;
  reelDraft.url = URL.createObjectURL(file);
  const preview = $('reel-preview');
  preview.src = reelDraft.url;
  $('reel-caption').value = '';
  $('dialog-reel-new').showModal();
});

function closeReelDraft() {
  $('reel-preview').pause();
  $('reel-preview').removeAttribute('src');
  if (reelDraft.url) URL.revokeObjectURL(reelDraft.url);
  reelDraft.file = null;
  reelDraft.url = null;
  $('dialog-reel-new').close();
}
$('btn-reel-cancel').addEventListener('click', closeReelDraft);

/** A still from the video (JPEG), shown as the thumbnail on Home and profiles. */
function reelThumbnail(url) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const done = (blob) => {
      video.removeAttribute('src');
      resolve(blob);
    };
    const timer = setTimeout(() => done(null), 8000);
    video.addEventListener('loadedmetadata', () => {
      reelDraft.duration = video.duration;
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
    });
    video.addEventListener('seeked', () => {
      const scale = Math.min(1, 540 / Math.max(video.videoWidth, 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      if (!canvas.width || !canvas.height) return done(null);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        clearTimeout(timer);
        done(blob);
      }, 'image/jpeg', 0.8);
    });
    video.addEventListener('error', () => {
      clearTimeout(timer);
      done(null);
    });
    video.src = url;
  });
}

/** Upload a file as raw bytes, with progress. */
function uploadReelFile(blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/reels/upload`);
    xhr.setRequestHeader('authorization', `Bearer ${getToken()}`);
    xhr.setRequestHeader('content-type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: use the status below.
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Couldn't upload. Check your connection."));
    xhr.send(blob);
  });
}

$('reel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!reelDraft.file) return;
  await withBusy($('btn-reel-post'), async () => {
    const poster = await reelThumbnail(reelDraft.url);
    if (reelDraft.duration > MAX_REEL_SECONDS + 1) throw new Error('Reels can be up to 3 minutes long');
    const bar = $('reel-upload-bar');
    $('reel-upload-progress').hidden = false;
    bar.style.width = '0%';
    try {
      const video = await uploadReelFile(reelDraft.file, (f) => (bar.style.width = `${Math.round(f * 100)}%`));
      const thumb = poster ? await uploadReelFile(poster).catch(() => null) : null;
      const { reel } = await api('POST', '/reels', { videoId: video.uploadId, posterId: thumb?.uploadId ?? null, caption: $('reel-caption').value });
      closeReelDraft();
      toast('🎬 Your Reel is up!');
      reels.list = [reel, ...reels.list.filter((r) => r.id !== reel.id)];
      home.reels = [reel, ...home.reels];
      reels.source = 'feed';
      $('btn-reels-back').hidden = true;
      $('reels-title').textContent = 'KoolKat Reels';
      renderReels(0);
    } finally {
      $('reel-upload-progress').hidden = true;
    }
  });
});

// ---------- social media links ----------
const SOCIAL_SITES = [
  ['youtube', 'YouTube'],
  ['instagram', 'Instagram'],
  ['tiktok', 'TikTok'],
  ['facebook', 'Facebook'],
  ['x', 'X'],
  ['linktree', 'Linktree'],
];

/** A row of round social media buttons that open someone's pages. */
function renderSocials(row, socials) {
  const links = SOCIAL_SITES.filter(([site]) => typeof socials?.[site] === 'string' && socials[site].startsWith('https://')).map(
    ([site, name]) =>
      el(
        'a',
        { class: 'social-link', href: socials[site], target: '_blank', rel: 'noopener noreferrer', title: name, 'aria-label': name },
        el('img', { src: `icons/social/${site}.png`, alt: '' })
      )
  );
  row.replaceChildren(...links);
  row.hidden = links.length === 0;
}

function openSocials() {
  const saved = state.plan?.socials ?? {};
  for (const [site] of SOCIAL_SITES) $(`social-${site}`).value = saved[site] ?? '';
  $('dialog-socials').showModal();
}
$('btn-profile-socials').addEventListener('click', openSocials);
$('btn-socials-cancel').addEventListener('click', () => $('dialog-socials').close());
$('socials-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withBusy($('btn-socials-save'), async () => {
    const body = Object.fromEntries(SOCIAL_SITES.map(([site]) => [site, $(`social-${site}`).value.trim()]));
    const { socials } = await api('POST', '/me/socials', body);
    if (state.plan) state.plan.socials = socials;
    renderSocials($('profile-socials'), socials);
    $('dialog-socials').close();
    toast('🔗 Social links saved');
  });
});

// ---------- birthdays ----------
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'long' }));
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function fillBirthdayDays() {
  const month = Number($('birthday-month').value) || 1;
  const keep = Number($('birthday-day').value) || 1;
  $('birthday-day').replaceChildren(
    ...Array.from({ length: DAYS_IN[month - 1] }, (_, i) => el('option', { value: String(i + 1), text: String(i + 1) }))
  );
  $('birthday-day').value = String(Math.min(keep, DAYS_IN[month - 1]));
}
$('birthday-month').replaceChildren(...MONTHS.map((name, i) => el('option', { value: String(i + 1), text: name })));
$('birthday-month').addEventListener('change', fillBirthdayDays);

function openBirthday() {
  const current = state.plan?.birthday;
  $('birthday-month').value = String(current?.month ?? new Date().getMonth() + 1);
  fillBirthdayDays();
  $('birthday-day').value = String(current?.day ?? 1);
  $('btn-birthday-remove').hidden = !current;
  $('btn-birthday-skip').textContent = current ? 'Cancel' : 'Not now';
  $('dialog-birthday').showModal();
}

/** Ask once, after signing up or the first sign-in with this version. */
function maybeAskBirthday() {
  if (state.plan && !state.plan.birthdayAsked && !document.querySelector('dialog[open]')) openBirthday();
}

$('birthday-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withBusy($('btn-birthday-save'), async () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { birthday } = await api('POST', '/me/birthday', {
      month: Number($('birthday-month').value),
      day: Number($('birthday-day').value),
      timeZone,
    });
    Object.assign(state.plan, { birthday, birthdayAsked: true });
    $('dialog-birthday').close();
    toast(`🎂 Saved! You'll get a 🎉 on ${MONTHS[birthday.month - 1]} ${birthday.day}`);
    refreshMe().catch(() => {});
  });
});
$('btn-birthday-skip').addEventListener('click', () => {
  $('dialog-birthday').close();
  if (state.plan && !state.plan.birthdayAsked) {
    state.plan.birthdayAsked = true;
    api('POST', '/me/birthday', { skip: true }).catch(() => {});
    toast('No problem. You can add it any time in your profile.');
  }
});
$('btn-birthday-remove').addEventListener('click', async () => {
  try {
    await api('DELETE', '/me/birthday');
    Object.assign(state.plan, { birthday: null, birthdayAsked: true });
    $('dialog-birthday').close();
    toast('Birthday removed');
    refreshMe().catch(() => {});
  } catch (err) {
    toast(err.message, { error: true });
  }
});
$('btn-profile-birthday').addEventListener('click', () => {
  $('dialog-profile').close();
  openBirthday();
});

async function boot() {
  setAuthMode('login');
  $('auth-config-warning').hidden = Boolean(API_BASE) || !location.hostname.endsWith('.github.io');
  window.__koolkatBootStep = 'service worker';
  await registerServiceWorker(
    (msg) => {
      if (msg.type === 'refresh' && state.me) refresh();
      if (msg.type === 'open') openView(msg.view);
    },
    (apply) => {
      $('update-bar').hidden = false;
      $('btn-update').onclick = apply;
    }
  );
  window.__koolkatBootStep = 'loading your keys';
  const identity = await loadIdentity();
  if (getToken() && identity) {
    try {
      window.__koolkatBootStep = 'contacting the server';
      const me = await api('GET', '/me');
      if (me.user.id === identity.userId && me.publicKey === identity.publicKey) {
        state.me = { ...identity, displayName: me.user.displayName, username: me.user.username };
        enterApp();
        return;
      }
    } catch (err) {
      if (err.status !== 401) {
        // Server unreachable: keep the session and let the user retry by reloading.
        state.me = identity;
        enterApp();
        return;
      }
    }
  }
  setToken(null);
  await clearIdentity();
  show('auth');
}

boot()
  .then(() => (window.__koolkatBooted = true))
  .catch((err) => {
    window.__koolkatErrors?.push(`boot: ${err?.name}: ${err?.message}`);
    toast(`KoolKat couldn't start: ${err?.message}`, { error: true });
  });

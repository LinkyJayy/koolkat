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
import { createKatWordle } from './wordle.js';
import { focusFirst, initInput } from './input.js';
import { createKatEscape } from './escape.js';
import { teamEdge } from './teams.js';
import { BUG_CATEGORIES, SUGGESTION_CATEGORIES, categoryLabel } from './feedback-categories.js';
import { BOLTS_PER_GEM, chaseGems, escapeGems, invaderGems, placeGems, wordleGems } from './rewards.js';
import { DIFFICULTIES as KI_DIFFICULTIES, LIVES as KI_LIVES, createKatInvaders } from './invaders.js';
import { createKatSurvival } from './survival.js';
import { createBooks } from './books.js';
import { choicesFor as ccChoicesFor, choose as ccChoose, deckCounts as ccDeckCounts, draw as ccDraw, newDeck as ccNewDeck, ranked as ccRanked } from './circle-rules.js';
import { BASE_TEAMS, TEAMS as CC_TEAMS, TEAM_NAMES as CC_TEAM_NAMES, TURNS as CC_TURNS, circleIcon as ccCircleIcon, createCircleTable, describeEvent as ccDescribe, teamIcon as ccTeamIcon } from './circles.js';
import { KART_MAPS, RACE_SONGS, RACERS as KART_RACERS, createKatKart, createRaceMusic, formatRaceTime, showNowPlaying } from './kart.js';

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
// The Kool crown is drawn in its owner's accent colour, if they've picked one.
const badgeSrc = (user) => {
  if (user?.badgeUrl) return `${API_BASE}/api/${user.badgeUrl}`;
  if (/^#[0-9a-f]{6}$/.test(user?.accent ?? '')) return `${API_BASE}/api/accent-icons/${user.accent.slice(1)}/kool-badge.png`;
  return 'icons/kool-badge.png';
};
/** Show someone's Kool flair, in their accent colour. */
function showFlair(node, user) {
  node.textContent = user?.flair || '';
  node.hidden = !user?.flair;
  if (/^#[0-9a-f]{6}$/.test(user?.accent ?? '')) node.style.setProperty('--flair', user.accent);
  else node.style.removeProperty('--flair');
}
/** The verified tick, the Kool badge (Unlimited) and, on their birthday, a 🎉, to go after someone's name. */
const badgeImg = (user) => {
  const parts = nodes(
    user?.verified && el('img', { src: 'icons/social/verified.png', alt: 'Verified', title: 'Verified', class: 'verified-badge' }),
    user?.badge && el('img', { src: badgeSrc(user), alt: 'KoolKat Unlimited', title: 'KoolKat Unlimited', class: 'kool-badge' }),
    user?.boltBadge && el('img', { src: 'icons/bolt-badge.png', alt: 'Bolt Badge', title: 'Bolt Badge', class: 'bolt-badge' }),
    user?.gemBadge && el('img', { src: 'icons/gem.png', alt: 'Gem Badge', title: 'Gem Badge', class: 'bolt-badge gem-badge' }),
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

// ---------- "Are you sure?" ----------
// KoolKat's own confirm box (instead of the browser's), so it matches the app
// and works with a keyboard or game controller: A / Enter = yes, B / Esc = no.
function askConfirm(message, { ok = 'OK', cancel = 'Cancel', danger = /delete|remove|leave|quit|take|reset/i.test(message) } = {}) {
  const dialog = $('dialog-confirm');
  $('confirm-text').textContent = message;
  const yes = $('btn-confirm-ok');
  yes.textContent = ok;
  yes.className = `btn ${danger ? 'danger-solid' : 'primary'}`;
  $('btn-confirm-cancel').textContent = cancel;
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.onclose = () => resolve(dialog.returnValue === 'ok');
    dialog.showModal();
    yes.focus();
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
  if (state.screen === 'escape' && name !== 'escape') {
    katEscape.stop();
    leaveEscapeRoom();
  }
  if (state.screen === 'book' && name !== 'book') books.stop();
  if (state.screen === 'survival' && name !== 'survival') {
    katSurvival.stop();
    leaveSurvivalRoom();
  }
  if (state.screen === 'invaders' && name !== 'invaders') {
    katInvaders.stop();
    leaveInvadersRoom();
  }
  if (state.screen === 'circles' && name !== 'circles') {
    ccTable.stop();
    leaveCirclesRoom();
  }
  if (state.screen === 'kart' && name !== 'kart') {
    katKart.stop();
    leaveKartRoom();
    if (kartSideways) kartLandscape(false);
  }
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
  try {
    updateMiniPlayer();
  } catch {
    // Starting up: the music player isn't ready yet.
  }
  if (name === 'camera') startCamera();
  focusFirst();
}
const TAB_SCREENS = new Set(['home', 'reels', 'music', 'inbox', 'chats']);

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
  try {
    audioEl.pause();
    player.song = null;
  } catch {
    // Never started.
  }
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
  else if (view === 'music') openMusic();
  else if (view === 'books') books.open();
  else if (view === 'playables') openPlayables();
  // A new suggestion or bug report (the owner's notifications).
  else if (view === 'feedback') openFeedback();
  // A reply to your suggestion or bug report.
  else if (view === 'feedback-mine/suggestion') $('btn-suggest').click();
  else if (view === 'feedback-mine/bug') $('btn-report-bug').click();
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
  // On a PC, a webcam you picked (built-in or plugged in) is asked for by name.
  const attempts = [
    ...(state.cameraId ? [{ deviceId: { exact: state.cameraId }, width: { ideal: 1920 }, height: { ideal: 1080 } }, { deviceId: { exact: state.cameraId } }] : []),
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
  updateCameraSwitch();
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
// Switching cameras. Phones flip between front and back. PCs (where webcams
// don't say which way they face) go through every camera plugged in.
const CAMERA_KEY = 'koolkat.cameraId';
try {
  state.cameraId = localStorage.getItem(CAMERA_KEY) || null;
} catch {
  state.cameraId = null;
}
const videoInputs = async () => (await navigator.mediaDevices?.enumerateDevices?.() ?? []).filter((d) => d.kind === 'videoinput');

async function updateCameraSwitch() {
  const cams = await videoInputs().catch(() => []);
  // One camera: nothing to switch to.
  $('btn-flip').hidden = cams.length < 2;
}

$('btn-flip').addEventListener('click', async () => {
  const track = state.stream?.getVideoTracks()[0];
  const settings = track?.getSettings?.() ?? {};
  const cams = await videoInputs().catch(() => []);
  if (cams.length > 1 && !settings.facingMode) {
    const i = cams.findIndex((c) => c.deviceId === settings.deviceId);
    const next = cams[(i + 1) % cams.length];
    state.cameraId = next.deviceId;
    try {
      localStorage.setItem(CAMERA_KEY, next.deviceId);
    } catch {
      // Remembering it is only a convenience.
    }
    toast(`📷 ${next.label || `Camera ${((i + 1) % cams.length) + 1}`}`);
  } else {
    state.cameraId = null;
    state.facing = state.facing === 'user' ? 'environment' : 'user';
  }
  startCamera();
});

// A webcam plugged in or unplugged.
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  const cams = await videoInputs().catch(() => []);
  if (state.cameraId && !cams.some((c) => c.deviceId === state.cameraId)) {
    state.cameraId = null;
    if (state.screen === 'camera') startCamera();
  }
  if (state.screen === 'camera') updateCameraSwitch();
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
        if (!await askConfirm(`Delete “${p.title}”?`)) return;
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
                  text: c.mine || comments.kind !== 'news' ? 'Delete' : 'Delete (admin)',
                  onclick: async () => {
                    if (!await askConfirm('Delete this comment?')) return;
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
    if (!await askConfirm('Leave this group? You will stop getting its messages.')) return;
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
  if (!await askConfirm(question)) return;
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
  showFlair($('friend-flair'), friend);
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
  dialog.onclose = async () => {
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
    if (dialog.returnValue === 'remove' && await askConfirm(`Remove ${friend.displayName} as a friend? Your streak will be lost.`)) {
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
    boltBadge: me.user.boltBadge,
    gemBadge: me.user.gemBadge,
    badgeUrl: me.user.badgeUrl,
    flair: me.user.flair,
    accent: me.user.accent,
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
  showFlair($('profile-flair'), { flair: plan?.flair, accent: plan?.accentColor });
  showActivity($('profile-activity'), plan?.activity);
  if (!plan) return;
  const unlimited = plan.plan === 'unlimited';
  $('plan-name').replaceChildren(...nodes(unlimited ? 'KoolKat Unlimited' : 'KoolKat Free', unlimited && badgeImg({ badge: true, accent: plan.accentColor })));
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

// ---------- Suggestions & Bug reports ----------
// KoolKat Unlimited users send them from their profile. The owner goes
// through suggestions (search, sort, filter, approve); every admin can verify
// bug reports, and the owner can search, sort and filter them too.
const fillCategories = (select, list, first) =>
  select.replaceChildren(...(first ? [el('option', { value: '', text: first })] : []), ...list.map(([id, label]) => el('option', { value: id, text: label })));
fillCategories($('suggest-category'), SUGGESTION_CATEGORIES, 'Pick a category…');
fillCategories($('bug-category'), BUG_CATEGORIES, 'Pick a category…');
const feedbackDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Admins' replies to a suggestion or bug report. */
function feedbackReplies(replies = []) {
  if (!replies.length) return null;
  return el(
    'ul',
    { class: 'feedback-replies' },
    ...replies.map((r) =>
      el(
        'li',
        {},
        el('span', { class: 'feedback-reply-by' }, '💬 ', r.from.displayName, badgeImg(r.from), el('span', { class: 'fineprint', text: ` · ${feedbackDate(r.createdAt)}` })),
        el('span', { class: 'feedback-reply-body', text: r.body })
      )
    )
  );
}

/** Your own suggestions or bug reports, with how they're doing. */
function myFeedbackItem(item, kind) {
  const done = kind === 'suggestions' ? item.approved : item.verified;
  return el(
    'li',
    { class: 'feedback-item' },
    el('div', { class: 'feedback-body' },
      el('span', { class: 'feedback-chip', text: categoryLabel(kind === 'suggestions' ? SUGGESTION_CATEGORIES : BUG_CATEGORIES, item.category) }),
      el('strong', { text: kind === 'suggestions' ? item.idea : item.description }),
      el('span', { class: 'fineprint', text: `${feedbackDate(item.createdAt)} · ${done ? (kind === 'suggestions' ? '✅ Approved' : '☑️ Verified: a real bug') : kind === 'suggestions' ? 'Waiting for the owner' : 'Waiting for an admin'}` }),
      feedbackReplies(item.replies)
    )
  );
}
async function loadMine(kind) {
  const list = kind === 'suggestions' ? $('my-suggestions') : $('my-bugs');
  try {
    const data = await api('GET', kind === 'suggestions' ? '/suggestions/mine' : '/bugs/mine');
    const items = data[kind];
    list.replaceChildren(...(items.length ? items.map((i) => myFeedbackItem(i, kind)) : [el('li', { class: 'fineprint', text: 'Nothing yet.' })]));
  } catch {
    list.replaceChildren();
  }
}
$('btn-suggest').addEventListener('click', () => {
  $('dialog-profile').close();
  $('dialog-suggest').showModal();
  loadMine('suggestions');
});
$('btn-report-bug').addEventListener('click', () => {
  $('dialog-profile').close();
  $('dialog-bug').showModal();
  loadMine('bugs');
});
$('btn-suggest-close').addEventListener('click', () => $('dialog-suggest').close());
$('btn-bug-close').addEventListener('click', () => $('dialog-bug').close());
$('suggest-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('btn-suggest-send'), async () => {
    if (!$('suggest-category').value) throw new Error('Pick a category');
    if (!$('suggest-idea').value.trim()) throw new Error("What's your suggestion?");
    if (!$('suggest-does').value.trim()) throw new Error('Say what it could do');
    await api('POST', '/suggestions', { category: $('suggest-category').value, idea: $('suggest-idea').value, does: $('suggest-does').value });
    $('suggest-form').reset();
    toast('💡 Thanks! Your suggestion was sent');
    loadMine('suggestions');
  });
});
$('bug-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('btn-bug-send'), async () => {
    if (!$('bug-category').value) throw new Error('Pick a category');
    if (!$('bug-description').value.trim()) throw new Error("Describe what's going wrong");
    await api('POST', '/bugs', { category: $('bug-category').value, description: $('bug-description').value });
    $('bug-form').reset();
    toast('🐞 Thanks! Your bug report was sent');
    loadMine('bugs');
  });
});

// The owner's (and admins') screen.
const feedback = { kind: 'suggestions', timer: null };
function openFeedback(kind) {
  if (!state.plan?.isAdmin) return;
  feedback.kind = kind ?? feedback.kind;
  show('feedback');
  setFeedbackKind(feedback.kind);
}
function setFeedbackKind(kind) {
  feedback.kind = kind;
  // A fresh start on each tab (the categories are different anyway).
  $('feedback-search').value = '';
  for (const tab of document.querySelectorAll('.feedback-tab')) tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
  const suggestions = kind === 'suggestions';
  fillCategories($('feedback-category'), suggestions ? SUGGESTION_CATEGORIES : BUG_CATEGORIES, 'All categories');
  $('feedback-status').replaceChildren(
    el('option', { value: '', text: 'All' }),
    el('option', { value: 'open', text: suggestions ? 'Not approved yet' : 'Not verified yet' }),
    el('option', { value: 'done', text: suggestions ? '✅ Approved' : '☑️ Verified' })
  );
  loadFeedback();
}
for (const tab of document.querySelectorAll('.feedback-tab')) tab.addEventListener('click', () => setFeedbackKind(tab.dataset.kind));
$('btn-open-feedback').addEventListener('click', () => openFeedback('suggestions'));
$('btn-feedback-back').addEventListener('click', () => $('btn-admin').click());
for (const id of ['feedback-category', 'feedback-status', 'feedback-sort']) $(id).addEventListener('change', () => loadFeedback());
$('feedback-search').addEventListener('input', () => {
  clearTimeout(feedback.timer);
  feedback.timer = setTimeout(loadFeedback, 250);
});

async function loadFeedback() {
  const kind = feedback.kind;
  const params = new URLSearchParams();
  for (const [key, id] of [['q', 'feedback-search'], ['category', 'feedback-category'], ['status', 'feedback-status'], ['sort', 'feedback-sort']]) {
    if ($(id).value) params.set(key, $(id).value);
  }
  try {
    const data = await api('GET', `/admin/${kind === 'suggestions' ? 'suggestions' : 'bugs'}?${params}`);
    if (feedback.kind !== kind) return;
    const items = data[kind];
    // Only the owner can search, sort and filter.
    const canSearch = data.canSearch;
    feedback.canApprove = kind === 'bugs' || data.canApprove;
    $('feedback-filters').hidden = !canSearch;
    const counts = data.counts ? Object.values(data.counts).reduce((a, c) => ({ total: a.total + c.total, done: a.done + c.done }), { total: 0, done: 0 }) : null;
    $('feedback-note').textContent = counts
      ? `${counts.total} in all · ${counts.done} ${kind === 'suggestions' ? 'approved' : 'verified'}`
      : kind === 'suggestions'
        ? 'Reply to any of them. Only the owner can search, sort and approve suggestions.'
        : 'Verify the ones that are real bugs, and reply. Only the owner can search and sort them.';
    $('feedback-list').replaceChildren(...items.map((item) => feedbackItem(item, kind)));
    $('feedback-empty').hidden = items.length > 0;
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/** Admins: write a reply (the person who sent it gets told). */
function replyBox(item, kind) {
  const input = el('textarea', { class: 'feedback-reply-input', rows: '2', maxlength: '1000', placeholder: 'Write a reply…', 'aria-label': 'Reply' });
  const send = el('button', {
    type: 'button',
    class: 'btn small',
    text: '💬 Reply',
    onclick: (e) =>
      withBusy(e.currentTarget, async () => {
        if (!input.value.trim()) throw new Error('Write a reply');
        await api('POST', `/admin/${kind === 'suggestions' ? 'suggestions' : 'bugs'}/${item.id}/replies`, { body: input.value });
        toast('💬 Reply sent');
        await loadFeedback();
      }),
  });
  return el('div', { class: 'feedback-reply-form' }, input, send);
}

function feedbackItem(item, kind) {
  const suggestions = kind === 'suggestions';
  const done = suggestions ? item.approved : item.verified;
  const li = el(
    'li',
    { class: `feedback-item${done ? ' done' : ''}` },
    el('div', { class: 'feedback-body' },
      el('span', { class: 'feedback-chip', text: categoryLabel(suggestions ? SUGGESTION_CATEGORIES : BUG_CATEGORIES, item.category) }),
      el('strong', {}, suggestions ? item.idea : item.description, done && !suggestions ? el('img', { src: 'icons/social/verified.png', alt: 'Verified', title: 'Verified: a real bug', class: 'verified-badge' }) : null),
      suggestions ? el('p', { class: 'feedback-does', text: item.does }) : null,
      el('span', { class: 'fineprint feedback-by' }, `${feedbackDate(item.createdAt)} · `, item.author ? el('span', {}, item.author.displayName, badgeImg(item.author), ` @${item.author.username}`) : null),
      feedbackReplies(item.replies),
      replyBox(item, kind)
    ),
    (!suggestions || feedback.canApprove) && el('button', {
      type: 'button',
      class: `btn small${done ? '' : ' primary'}`,
      text: suggestions ? (done ? '✅ Approved' : 'Approve') : done ? '☑️ Verified' : 'Verify',
      title: done ? 'Tap to undo' : null,
      onclick: (e) =>
        withBusy(e.currentTarget, async () => {
          const path = suggestions ? `/admin/suggestions/${item.id}/approve` : `/admin/bugs/${item.id}/verify`;
          const body = suggestions ? { approved: !done } : { verified: !done };
          await api('POST', path, body);
          await loadFeedback(); // and the counts
        }),
    })
  );
  return li;
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
              if (!await askConfirm(`Take the verified badge away from ${u.displayName}?`)) return;
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
                  if (!await askConfirm(`Remove ${a.displayName} as an admin?`)) return;
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
    if (!await askConfirm(`Make ${username} an admin? They'll be able to use Admin tools and post News.`)) return;
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
              if (!await askConfirm(`Delete the code ${c.code}? Nobody will be able to redeem it.`)) return;
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
      if (!await askConfirm(`Reset ${username}'s ${label}?`)) return;
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
    if (!await askConfirm(`Take away gifted KoolKat Unlimited from ${username}? (A paid subscription isn't affected.)`)) return;
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
  // The Classic choice in the app icon picker shows it in your accent colour.
  const classic = document.querySelector('.icon-choice[data-icon="default"] img');
  if (classic) classic.src = accent ? `${API_BASE}/api/accent-icons/${accent}/icon-192.png` : 'icons/icon-192.png';
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
  state.me.accent = accentColor;
  renderPlan();
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
const userPage = { user: null, reels: [], songs: [], from: 'home', tab: 'reels' };

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
    const [{ reels: list }, { songs }] = await Promise.all([
      api('GET', `/reels?user=${user.id}&limit=50`),
      api('GET', `/music?user=${user.id}&limit=100`),
    ]);
    if (userPage.user !== user) return;
    userPage.reels = list;
    userPage.songs = songs;
    // Artists open on their music.
    setUserTab(songs.length && !list.length ? 'music' : 'reels');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function setUserTab(tab) {
  userPage.tab = tab;
  for (const t of document.querySelectorAll('[data-up-tab]')) {
    const on = t.dataset.upTab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  const musicTab = tab === 'music';
  $('up-grid').hidden = musicTab;
  $('up-songs').hidden = !musicTab;
  if (musicTab) {
    $('up-songs').replaceChildren(...userPage.songs.map((s, i) => songRow(s, userPage.songs, i)));
    $('up-empty').textContent = 'No songs yet.';
    $('up-empty').hidden = userPage.songs.length > 0;
  } else {
    renderReelGrid($('up-grid'), userPage.reels, { source: 'user' });
    $('up-empty').textContent = 'No Reels yet.';
    $('up-empty').hidden = userPage.reels.length > 0;
  }
}
$('up-tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-up-tab]');
  if (t) setUserTab(t.dataset.upTab);
});

function renderUserPage() {
  const user = userPage.user;
  const you = user.relationship === 'you';
  if (you) Object.assign(user, { displayName: state.me.displayName, avatarUrl: state.me.avatarUrl });
  $('up-title').replaceChildren(...nodes(user.displayName, badgeImg(user)));
  fillAvatar($('up-avatar'), user);
  $('up-username').textContent = `@${user.username}`;
  $('up-marks').replaceChildren();
  $('up-admin').hidden = !user.isAdmin;
  showFlair($('up-flair'), user);
  showActivity($('up-activity'), user.activity);
  $('up-friends').textContent = compactNumber(user.stats?.friends ?? 0);
  $('up-reels').textContent = compactNumber(user.stats?.reels ?? 0);
  $('up-likes').textContent = compactNumber(user.stats?.likes ?? 0);
  renderSocials($('up-socials'), user.socials);
  $('up-joined').textContent = `On KoolKat since ${formatDate(user.joinedAt)}`;
  $('up-grid').replaceChildren();
  $('up-songs').replaceChildren();
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
const home = { chip: 'all', reels: [], posts: [], songs: [] };

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
  const [reelsRes, newsRes, musicRes] = await Promise.allSettled([api('GET', '/reels?limit=24'), api('GET', '/news'), api('GET', '/music?limit=20')]);
  if (reelsRes.status === 'fulfilled') home.reels = reelsRes.value.reels;
  if (musicRes.status === 'fulfilled') home.songs = musicRes.value.songs;
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
  showSection('home-music-shelf', ['all', 'music']);
  showSection('home-playables-shelf', ['all']);
  // Songs: square covers to swipe through on All, a list on Music.
  const songList = chip === 'music';
  $('home-music').hidden = songList;
  $('home-music-list').hidden = !songList;
  $('home-music-empty').hidden = home.songs.length > 0;
  if (songList) $('home-music-list').replaceChildren(...home.songs.map((s, i) => songRow(s, home.songs, i)));
  else $('home-music').replaceChildren(...home.songs.map((s, i) => songCard(s, home.songs, i)));
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
  // One thing at a time: a Reel pauses KoolKat Music.
  if (!audioEl.paused) audioEl.pause();
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
  if (!await askConfirm(r.mine ? 'Delete your Reel?' : `Delete this Reel by @${r.author.username}? (admin)`)) return;
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

// ---------- KoolKat Music ----------
// Like Spotify: songs from KoolKat artists, a player that keeps going while
// you use the rest of the app, Liked Songs, search, and music videos.
// Everyone can listen, heart and comment; posting is part of KoolKat Unlimited.
const music = { view: 'home', top: [], newest: [], liked: [], list: [], canPost: false, searchTimer: null, listTitle: '' };
const player = { queue: [], index: -1, song: null, mode: 'song', listened: 0, lastTime: null, counted: false };
const audioEl = new Audio();
audioEl.preload = 'auto';
const SVG_NS = 'http://www.w3.org/2000/svg';

function noteIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'note-icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6Z');
  svg.append(path);
  return svg;
}

/** An album cover, or a coloured square with a note if there isn't one. */
function fillCover(node, song) {
  node.classList.add('song-cover');
  if (song?.cover) node.replaceChildren(el('img', { src: `${API_BASE}/api/${song.cover}`, alt: '', loading: 'lazy' }));
  else node.replaceChildren(noteIcon());
  return node;
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const artistLine = (song) => [song.artist.displayName, song.album].filter(Boolean).join(' · ');

/** Every copy of a song (they come from different lists) gets the same change. */
function updateSong(id, changes) {
  const lists = [music.top, music.newest, music.liked, music.list, player.queue, home.songs ?? [], userPage.songs ?? []];
  for (const list of lists) for (const s of list) if (s.id === id) Object.assign(s, changes);
  if (player.song?.id === id) Object.assign(player.song, changes);
  for (const b of document.querySelectorAll(`[data-song-like="${id}"]`)) {
    b.classList.toggle('on', Boolean(changes.liked ?? b.classList.contains('on')));
    b.setAttribute('aria-pressed', String(b.classList.contains('on')));
  }
  if (player.song?.id === id) renderPlayer();
}

async function toggleSongLike(song) {
  try {
    const res = await api(song.liked ? 'DELETE' : 'POST', `/music/${song.id}/like`);
    updateSong(song.id, { liked: res.liked, likes: res.likes });
    if (res.liked && !music.liked.some((s) => s.id === song.id)) music.liked.unshift({ ...song, liked: true });
    if (!res.liked) music.liked = music.liked.filter((s) => s.id !== song.id);
    $('liked-songs-count').textContent = `${music.liked.length} song${music.liked.length === 1 ? '' : 's'}`;
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function songHeart() {
  const svg = heartIcon();
  svg.setAttribute('class', 'song-heart');
  return svg;
}
for (const id of ['mini-like', 'player-like']) $(id).replaceChildren(songHeart());
document.querySelector('.liked-songs-art').replaceChildren(songHeart());

function likeButton(song, cls = 'song-like') {
  const b = el(
    'button',
    {
      type: 'button',
      class: `${cls}${song.liked ? ' on' : ''}`,
      'aria-label': 'Heart',
      'aria-pressed': String(Boolean(song.liked)),
      'data-song-like': String(song.id),
    },
    songHeart()
  );
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSongLike(song);
  });
  return b;
}

/** A song in a list: cover, title, artist; tap to play from this list. */
function songRow(song, list, i) {
  const playing = player.song?.id === song.id;
  return el(
    'li',
    { class: `song-row${playing ? ' playing' : ''}`, 'data-song': String(song.id) },
    el(
      'button',
      { type: 'button', class: 'song-main', onclick: () => playSong(list, i) },
      fillCover(el('span', { class: 'song-thumb' }), song),
      el(
        'span',
        { class: 'song-text' },
        el('span', { class: 'song-title', text: song.title }),
        el('span', { class: 'song-sub' }, song.explicit ? el('span', { class: 'explicit-tag', title: 'Explicit', text: 'E' }) : null, song.video ? el('span', { class: 'song-tag', text: 'VIDEO' }) : null, ...nodes(artistLine(song), badgeImg(song.artist)))
      )
    ),
    likeButton(song)
  );
}

/** A song as a square card (Top songs, Home). */
function songCard(song, list, i) {
  return el(
    'button',
    { type: 'button', class: 'song-card', onclick: () => playSong(list, i) },
    fillCover(el('span', { class: 'song-card-cover' }), song),
    el('span', { class: 'song-card-title', text: song.title }),
    el('span', { class: 'song-card-sub', text: song.artist.displayName })
  );
}

function markPlaying() {
  for (const row of document.querySelectorAll('.song-row')) row.classList.toggle('playing', row.dataset.song === String(player.song?.id));
}

// ---------- the Music tab ----------
async function openMusic() {
  show('music');
  if (music.view !== 'home' && !$('music-search').value.trim()) setMusicView('home');
  await loadMusicHome();
}
$('tab-music').addEventListener('click', () => {
  if (state.screen === 'music') {
    $('music-search').value = '';
    setMusicView('home');
    $('music-body').scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  openMusic();
});

async function loadMusicHome() {
  try {
    const [homeData, newest] = await Promise.all([api('GET', '/music/home'), api('GET', '/music?limit=50')]);
    music.top = homeData.top;
    music.liked = homeData.liked;
    music.newest = newest.songs;
    music.canPost = homeData.canPost;
    renderMusicHome();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderMusicHome() {
  $('liked-songs-count').textContent = `${music.liked.length} song${music.liked.length === 1 ? '' : 's'}`;
  const top = music.top.filter((s) => s.plays > 0 || s.likes > 0);
  $('music-top-heading').hidden = top.length === 0;
  $('music-top').hidden = top.length === 0;
  $('music-top').replaceChildren(...top.map((s, i) => songCard(s, top, i)));
  $('music-new').replaceChildren(...music.newest.map((s, i) => songRow(s, music.newest, i)));
  $('music-empty').hidden = music.newest.length > 0;
}

function setMusicView(view, { title = '', songs = [], empty = '' } = {}) {
  music.view = view;
  $('music-main').hidden = view !== 'home';
  $('music-list-view').hidden = view === 'home';
  $('btn-music-back').hidden = view !== 'liked';
  $('music-title').textContent = view === 'liked' ? title : 'KoolKat Music';
  if (view === 'home') return;
  music.list = songs;
  $('music-list').replaceChildren(...songs.map((s, i) => songRow(s, songs, i)));
  $('music-list-empty').hidden = songs.length > 0;
  $('music-list-empty').textContent = empty;
}

$('btn-liked-songs').addEventListener('click', () =>
  setMusicView('liked', { title: 'Liked Songs', songs: music.liked, empty: 'Songs you heart ♥ show up here.' })
);
$('btn-music-back').addEventListener('click', () => setMusicView('home'));

$('music-search').addEventListener('input', (e) => {
  clearTimeout(music.searchTimer);
  const text = e.target.value.trim();
  if (!text) return setMusicView('home');
  music.searchTimer = setTimeout(async () => {
    try {
      const { songs } = await api('GET', `/music?q=${encodeURIComponent(text)}`);
      if ($('music-search').value.trim() !== text) return;
      setMusicView('search', { songs, empty: `No songs, albums or artists match “${text}”.` });
    } catch (err) {
      toast(err.message, { error: true });
    }
  }, 250);
});

// ---------- playing ----------
function playSong(list, i) {
  player.queue = list.slice();
  startSong(i);
}

function startSong(i) {
  const song = player.queue[i];
  if (!song) return;
  stopVideoMode();
  player.index = i;
  player.song = song;
  player.listened = 0;
  player.lastTime = null;
  player.counted = false;
  audioEl.src = `${API_BASE}/api/${song.audio.url}`;
  audioEl.play().catch(() => {});
  pauseReels();
  renderPlayer();
  markPlaying();
  updateMiniPlayer();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist.displayName,
      album: song.album ?? 'KoolKat Music',
      artwork: song.cover ? [{ src: `${location.origin}${API_BASE}/api/${song.cover}`, sizes: '512x512' }] : [],
    });
  }
}

const media = () => (player.mode === 'video' ? $('player-video') : audioEl);

function togglePlay() {
  const m = media();
  if (m.paused) m.play().catch(() => {});
  else m.pause();
}
function nextSong() {
  if (player.index < player.queue.length - 1) startSong(player.index + 1);
  else {
    media().pause();
    media().currentTime = 0;
  }
}
function prevSong() {
  if (media().currentTime > 3 || player.index === 0) media().currentTime = 0;
  else startSong(player.index - 1);
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => media().play().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause', () => media().pause());
  navigator.mediaSession.setActionHandler('nexttrack', nextSong);
  navigator.mediaSession.setActionHandler('previoustrack', prevSong);
}

// A play counts after 30 seconds of listening (or the whole song, if it's shorter).
function countListening(m) {
  if (player.counted || !player.song || m.paused) return;
  if (player.lastTime != null) {
    const step = m.currentTime - player.lastTime;
    if (step > 0 && step < 2) player.listened += step;
  }
  player.lastTime = m.currentTime;
  const needed = Math.min(30, (m.duration || 30) * 0.9);
  if (player.listened >= needed) {
    player.counted = true;
    const song = player.song;
    api('POST', `/music/${song.id}/play`)
      .then(({ plays }) => updateSong(song.id, { plays }))
      .catch(() => {});
  }
}

for (const m of [audioEl, $('player-video')]) {
  m.addEventListener('timeupdate', () => {
    if (m !== media()) return;
    countListening(m);
    renderProgress();
  });
  m.addEventListener('play', renderPlayState);
  m.addEventListener('pause', renderPlayState);
  m.addEventListener('loadedmetadata', renderProgress);
}
audioEl.addEventListener('ended', nextSong);
// The music video finished: back to the song.
$('player-video').addEventListener('ended', () => setPlayerMode('song'));

function renderPlayState() {
  const playing = !media().paused;
  for (const b of [$('mini-play'), $('player-play')]) {
    b.classList.toggle('is-playing', playing);
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
}

function renderProgress() {
  const m = media();
  const duration = m.duration || player.song?.duration || 0;
  const pct = duration ? (m.currentTime / duration) * 100 : 0;
  $('mini-progress-bar').style.width = `${pct}%`;
  if (!player.seeking) $('player-seek').value = String(Math.round(pct * 10));
  $('player-time').textContent = formatTime(m.currentTime);
  $('player-duration').textContent = formatTime(duration);
}

// ---------- mini player ----------
function updateMiniPlayer() {
  const show_ = Boolean(player.song) && (TAB_SCREENS.has(state.screen) || state.screen === 'user') && state.screen !== 'reels';
  $('mini-player').hidden = !show_;
  document.body.classList.toggle('has-mini', show_);
}

function renderPlayer() {
  const song = player.song;
  if (!song) return;
  fillCover($('mini-cover'), song);
  $('mini-title').textContent = song.title;
  $('mini-artist').textContent = song.artist.displayName;
  for (const b of [$('mini-like'), $('player-like')]) {
    b.dataset.songLike = String(song.id);
    b.classList.toggle('on', Boolean(song.liked));
    b.setAttribute('aria-pressed', String(Boolean(song.liked)));
  }
  fillCover($('player-cover'), song);
  $('player-title').textContent = song.title;
  $('player-explicit').hidden = !song.explicit;
  $('player-artist').replaceChildren(...nodes(song.artist.displayName, badgeImg(song.artist)));
  $('player-album').textContent = song.album || song.artist.displayName;
  $('player-switch').hidden = !song.video;
  $('btn-player-delete').hidden = !song.canDelete;
  $('player-comment-count').textContent = compactNumber(song.comments);
  $('player-plays').textContent = `${compactNumber(song.plays)} play${song.plays === 1 ? '' : 's'} · ${compactNumber(song.likes)} ♥`;
  renderPlayState();
  renderProgress();
}

$('mini-open').addEventListener('click', () => $('dialog-player').showModal());
$('mini-play').addEventListener('click', togglePlay);
$('mini-like').addEventListener('click', () => player.song && toggleSongLike(player.song));

// ---------- Now Playing ----------
$('btn-player-close').addEventListener('click', () => $('dialog-player').close());
$('dialog-player').addEventListener('close', () => {
  // The music video only plays here: carry on with the song.
  if (player.mode === 'video') setPlayerMode('song');
});
$('player-play').addEventListener('click', togglePlay);
$('player-next').addEventListener('click', nextSong);
$('player-prev').addEventListener('click', prevSong);
$('player-like').addEventListener('click', () => player.song && toggleSongLike(player.song));
$('player-artist').addEventListener('click', () => {
  if (!player.song) return;
  $('dialog-player').close();
  openUserProfile(player.song.artist.id);
});
$('player-seek').addEventListener('input', () => {
  player.seeking = true;
  const m = media();
  const duration = m.duration || 0;
  $('player-time').textContent = formatTime((Number($('player-seek').value) / 1000) * duration);
});
$('player-seek').addEventListener('change', () => {
  const m = media();
  if (m.duration) m.currentTime = (Number($('player-seek').value) / 1000) * m.duration;
  player.lastTime = null;
  player.seeking = false;
});
$('player-comments').addEventListener('click', () => {
  const song = player.song;
  if (song) openComments(song, () => updateSong(song.id, { comments: song.comments }), 'music');
});
$('player-share').addEventListener('click', async () => {
  const song = player.song;
  if (!song) return;
  const text = `“${song.title}” by ${song.artist.displayName} on KoolKat Music`;
  try {
    if (navigator.share) await navigator.share({ title: 'KoolKat Music', text, url: `${location.origin}/#music` });
    else {
      await navigator.clipboard.writeText(`${text}: ${location.origin}/#music`);
      toast('Link copied');
    }
  } catch {
    // Share sheet closed.
  }
});
$('btn-player-delete').addEventListener('click', async () => {
  const song = player.song;
  if (!song || !await askConfirm(song.mine ? `Delete “${song.title}”?` : `Delete “${song.title}” by ${song.artist.displayName}? (admin)`)) return;
  try {
    await api('DELETE', `/music/${song.id}`);
    toast('Song deleted');
    stopVideoMode();
    audioEl.pause();
    audioEl.removeAttribute('src');
    for (const key of ['top', 'newest', 'liked', 'list']) music[key] = music[key].filter((s) => s.id !== song.id);
    player.queue = player.queue.filter((s) => s.id !== song.id);
    player.song = null;
    $('dialog-player').close();
    updateMiniPlayer();
    if (state.screen === 'music') renderMusicHome();
  } catch (err) {
    toast(err.message, { error: true });
  }
});

// Song or music video. The video plays from the start; switching back
// carries on with the song where you left it.
$('player-switch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-player-mode]');
  if (b) setPlayerMode(b.dataset.playerMode);
});
function setPlayerMode(mode) {
  const song = player.song;
  if (mode === 'video' && !song?.video) return;
  if (mode === player.mode) return;
  const video = $('player-video');
  for (const b of document.querySelectorAll('[data-player-mode]')) b.classList.toggle('active', b.dataset.playerMode === mode);
  if (mode === 'video') {
    player.songWasPlaying = !audioEl.paused;
    audioEl.pause();
    player.mode = 'video';
    video.hidden = false;
    $('player-cover').hidden = true;
    video.src = `${API_BASE}/api/${song.video.url}`;
    video.play().catch(() => {});
  } else {
    stopVideoMode();
    if (player.songWasPlaying) audioEl.play().catch(() => {});
  }
  player.lastTime = null;
  renderPlayState();
}
function stopVideoMode() {
  const video = $('player-video');
  video.pause();
  video.removeAttribute('src');
  video.hidden = true;
  $('player-cover').hidden = false;
  player.mode = 'song';
  for (const b of document.querySelectorAll('[data-player-mode]')) b.classList.toggle('active', b.dataset.playerMode === 'song');
}

// ---------- posting a song (KoolKat Unlimited) ----------
const songDraft = { audio: null, video: null, cover: null, coverUrl: null, duration: null };

$('btn-song-new').addEventListener('click', () => {
  if (!music.canPost) {
    toast('🎵 Posting songs is part of KoolKat Unlimited. Get it free in your profile!', { error: true });
    return;
  }
  resetSongDraft();
  $('dialog-song-new').showModal();
});

function resetSongDraft() {
  if (songDraft.coverUrl) URL.revokeObjectURL(songDraft.coverUrl);
  Object.assign(songDraft, { audio: null, video: null, cover: null, coverUrl: null, duration: null });
  $('song-form').reset();
  $('btn-song-cover').replaceChildren(el('span', {}, '＋', el('br'), 'Album cover'));
  $('song-audio-name').textContent = '';
  $('song-video-name').textContent = '';
  $('btn-song-audio').textContent = '🎵 Choose the song';
  $('btn-song-video').textContent = '🎬 Add a music video (optional)';
}

$('btn-song-cancel').addEventListener('click', () => $('dialog-song-new').close());
$('btn-song-cover').addEventListener('click', () => $('song-cover-file').click());
$('btn-song-audio').addEventListener('click', () => $('song-audio-file').click());
$('btn-song-video').addEventListener('click', () => $('song-video-file').click());

$('song-cover-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    // A square cover, at most 1000×1000, as a JPEG.
    const img = await loadImageFile(file);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const size = Math.min(1000, side);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    songDraft.cover = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (songDraft.coverUrl) URL.revokeObjectURL(songDraft.coverUrl);
    songDraft.coverUrl = URL.createObjectURL(songDraft.cover);
    $('btn-song-cover').replaceChildren(el('img', { src: songDraft.coverUrl, alt: 'Album cover' }));
  } catch (err) {
    toast(err.message, { error: true });
  }
});

$('song-audio-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) return toast('Songs can be up to 50 MB', { error: true });
  songDraft.audio = file;
  songDraft.duration = null;
  $('btn-song-audio').textContent = '🎵 Change the song';
  $('song-audio-name').textContent = file.name;
  const probe = new Audio();
  probe.preload = 'metadata';
  const url = URL.createObjectURL(file);
  probe.addEventListener('loadedmetadata', () => {
    songDraft.duration = Number.isFinite(probe.duration) ? probe.duration : null;
    if (songDraft.duration) $('song-audio-name').textContent = `${file.name} · ${formatTime(songDraft.duration)}`;
    URL.revokeObjectURL(url);
  });
  probe.addEventListener('error', () => URL.revokeObjectURL(url));
  probe.src = url;
  // Use the file name as the title if there isn't one yet.
  const form = $('song-form');
  if (!form.title.value.trim()) form.title.value = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').slice(0, 80);
});

$('song-video-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 200 * 1024 * 1024) return toast('Music videos can be up to 200 MB', { error: true });
  songDraft.video = file;
  $('btn-song-video').textContent = '🎬 Change the music video';
  $('song-video-name').textContent = file.name;
});

function uploadMusicFile(kind, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/music/upload?kind=${kind}`);
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

$('song-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  await withBusy($('btn-song-post'), async () => {
    const title = form.title.value.trim();
    if (!title) throw new Error('Give your song a title');
    if (!songDraft.audio) throw new Error('Choose the song first');
    const bar = $('song-upload-bar');
    const step = $('song-upload-step');
    $('song-upload-progress').hidden = false;
    step.hidden = false;
    try {
      const files = [['audio', songDraft.audio, 'Uploading the song…'], ['cover', songDraft.cover, 'Uploading the album cover…'], ['video', songDraft.video, 'Uploading the music video…']];
      const ids = {};
      for (const [kind, blob, label] of files) {
        if (!blob) continue;
        step.textContent = label;
        bar.style.width = '0%';
        ids[kind] = (await uploadMusicFile(kind, blob, (f) => (bar.style.width = `${Math.round(f * 100)}%`))).uploadId;
      }
      step.textContent = 'Posting…';
      const { song } = await api('POST', '/music', {
        title,
        album: form.album.value.trim() || null,
        audioId: ids.audio,
        coverId: ids.cover ?? null,
        videoId: ids.video ?? null,
        duration: songDraft.duration,
        explicit: form.explicit.checked,
      });
      $('dialog-song-new').close();
      toast(`🎵 “${song.title}” is out!`);
      music.newest.unshift(song);
      if (state.screen === 'music') renderMusicHome();
    } finally {
      $('song-upload-progress').hidden = true;
      step.hidden = true;
    }
  });
});

// ---------- KoolKat Playables (for everyone) ----------
const WORDLE_STATS = 'koolkat.katWordle';
const KART_BEST = 'koolkat.katKart.best';
const readJson = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
};

// ---------- Bolts ⚡ and gems 💎: the Playables currencies ----------
// Win any game: +100 bolts. KatEscape: keep every bolt you collect. Every
// game you finish: 1 to 10 gems, the better you did. 1 gem = 100 bolts.
// Online games pay out on the server; Solo and Practice games tell it here.
const wallet = { bolts: null, gems: null };
function showWallet({ bolts, gems }) {
  if (bolts != null) {
    wallet.bolts = bolts;
    $('bolts-balance').textContent = bolts.toLocaleString();
  }
  if (gems != null) {
    wallet.gems = gems;
    $('gems-balance').textContent = gems.toLocaleString();
  }
}
/** Fresh balances; returns how much each went up by. */
async function refreshWallet() {
  try {
    const before = { ...wallet };
    const now = await api('GET', '/bolts');
    showWallet(now);
    if (shopState) Object.assign(shopState, now);
    return { bolts: before.bolts == null ? 0 : now.bolts - before.bolts, gems: before.gems == null ? 0 : now.gems - before.gems };
  } catch {
    return { bolts: 0, gems: 0 };
  }
}
function toastRewards({ bolts = 0, gems = 0 }, why = '') {
  const parts = [bolts > 0 && `+${bolts.toLocaleString()} ⚡ bolts`, gems > 0 && `+${gems} 💎 ${gems === 1 ? 'gem' : 'gems'}`].filter(Boolean);
  if (parts.length) toast(`${parts.join(' · ')}${why}`);
}
/**
 * A Solo or Practice game finished: { win } (+100 bolts), { runBolts } (KatEscape's
 * collected bolts), { gems } (1 to 10, from how well you did).
 */
async function earnRewards(game, { win = false, runBolts = 0, gems = 0 } = {}) {
  const got = { bolts: 0, gems: 0 };
  const calls = [];
  if (win) calls.push(api('POST', '/bolts/earn', { game, reason: 'win' }).then((r) => (got.bolts += r.earned)));
  if (runBolts > 0) calls.push(api('POST', '/bolts/earn', { game, reason: 'run', bolts: runBolts }).then((r) => (got.bolts += r.earned)));
  if (gems > 0) calls.push(api('POST', '/gems/earn', { game, gems }).then((r) => (got.gems += r.earned)));
  await Promise.allSettled(calls); // rewards are a bonus; the game still counts
  await refreshWallet();
  toastRewards(got, win ? ' for winning!' : '');
}

// ---------- The Bolt Shop: team colours, Unlimited and the Bolt Badge ----------
const SHOP_ART = { 'bolt-badge': 'icons/bolt-badge.png', 'gem-badge': 'icons/gem.png', unlimited: 'icons/kool-badge.png', 'unlimited-trial': 'icons/kool-badge.png' };
const SHOP_INFO = {
  'bolt-badge': 'A ⚡ next to your name, for everyone to see.',
  'gem-badge': 'A 💎 next to your name, for everyone to see.',
  'unlimited-trial': 'Try everything in KoolKat Unlimited for 30 days (all the team colours too).',
  unlimited: 'Everything in KoolKat Unlimited, for as long as you keep it (all the team colours too).',
};
let shopState = null;
// Which shop: the Bolt Shop (prices in bolts) or the Gem Shop (in gems; 1 gem = 100 bolts).
let shopCurrency = 'bolts';
const money = (n, currency) => `${n.toLocaleString()} ${currency === 'gems' ? '💎' : '⚡'}`;
for (const tab of document.querySelectorAll('.shop-tab')) {
  tab.addEventListener('click', () => {
    shopCurrency = tab.dataset.currency;
    renderShop();
  });
}
function applyShop(shop) {
  shopState = shop;
  usableTeams = new Set(shop.teams);
  showWallet({ bolts: shop.bolts, gems: shop.gems });
}
/** What you have (bolts and team colours). Quietly keeps the old if it can't. */
async function loadShop() {
  try {
    applyShop((await api('GET', '/shop')).shop);
  } catch {
    // Offline: keep what we had.
  }
  return shopState;
}
async function openShop() {
  const shop = await loadShop();
  if (!shop) return toast("Couldn't open the Bolt Shop", { error: true });
  renderShop();
  if (!$('dialog-shop').open) $('dialog-shop').showModal();
  focusFirst();
}
$('btn-shop').addEventListener('click', openShop);
$('btn-shop-close').addEventListener('click', () => $('dialog-shop').close());

function shopCard(item) {
  const team = item.kind === 'team' ? item.team : null;
  const price = shopCurrency === 'gems' ? item.gemPrice : item.price;
  const have = shopCurrency === 'gems' ? shopState.gems ?? 0 : shopState.bolts;
  const card = el(
    'div',
    { class: `shop-item${item.owned || item.included ? ' owned' : ''}` },
    el('img', { src: team ? ccTeamIcon(team) : SHOP_ART[item.id], alt: '' })
  );
  if (team) card.style.setProperty('--shop-color', teamEdge(team));
  const ends = item.kind === 'trial' && item.owned && shopState.trialUntil ? ` Ends ${new Date(shopState.trialUntil).toLocaleDateString()}.` : '';
  const text = el('div', {}, el('strong', { text: item.name }), el('span', { class: 'fineprint', text: item.kind === 'team' ? money(price, shopCurrency) : `${SHOP_INFO[item.id]}${ends} ${money(price, shopCurrency)}` }));
  let action;
  // Selling gives back what you paid, in what you paid with (whichever shop you're in).
  if (item.owned) action = el('button', { type: 'button', class: 'btn small', text: `Sell · +${money(item.paid, item.paidIn)}`, onclick: () => shopTrade('sell', item) });
  else if (item.included) action = el('button', { type: 'button', class: 'btn small', text: item.kind === 'team' ? '✓ With Unlimited' : '✓ You have Unlimited', disabled: true });
  else {
    const short = price - have;
    action = el('button', { type: 'button', class: `btn small${short > 0 ? '' : ' primary'}`, text: short > 0 ? `Need ${short.toLocaleString()} more` : `Buy · ${money(price, shopCurrency)}`, onclick: () => shopTrade('buy', item) });
  }
  if (team) card.append(el('strong', { text: CC_TEAM_NAMES[team] }), el('span', { class: 'fineprint', text: item.owned ? 'Yours' : item.included ? 'With Unlimited' : money(price, shopCurrency) }), action);
  else card.append(text, action);
  return card;
}
function renderShop() {
  $('shop-balance').textContent = shopState.bolts.toLocaleString();
  $('shop-gems').textContent = (shopState.gems ?? 0).toLocaleString();
  updateSwap();
  const gemShop = shopCurrency === 'gems';
  $('shop-title').textContent = gemShop ? '💎 Gem Shop' : '⚡ Bolt Shop';
  for (const tab of document.querySelectorAll('.shop-tab')) tab.setAttribute('aria-selected', String(tab.dataset.currency === shopCurrency));
  // Each shop has what's priced in its currency (the Bolt Badge is bolts only; the Gem Badge gems only).
  const here = shopState.items.filter((i) => (gemShop ? i.gemPrice : i.price) != null);
  $('shop-teams').replaceChildren(...here.filter((i) => i.kind === 'team').map(shopCard));
  $('shop-extras').replaceChildren(...here.filter((i) => i.kind !== 'team').map(shopCard));
}
async function shopTrade(action, item) {
  const currency = shopCurrency;
  const price = currency === 'gems' ? item.gemPrice : item.price;
  const unit = (c) => (c === 'gems' ? 'gems' : 'bolts');
  const ask =
    action === 'buy'
      ? `Buy ${item.name} for ${price.toLocaleString()} ${unit(currency)}?`
      : `Sell ${item.name}? You'll get all ${item.paid.toLocaleString()} ${unit(item.paidIn)} back${['unlimited', 'trial'].includes(item.kind) ? ', and lose that KoolKat Unlimited' : ''}.`;
  if (!(await askConfirm(ask, { ok: action === 'buy' ? 'Buy' : 'Sell', danger: action === 'sell' }))) return;
  try {
    const { shop } = await api('POST', `/shop/${action}`, { item: item.id, currency });
    applyShop(shop);
    renderShop();
    toast(action === 'buy' ? `${item.name} is yours! ${currency === 'gems' ? '💎' : '⚡'}` : `Sold. +${money(item.paid, item.paidIn)}`);
    // Unlimited and the badge change what you (and everyone else) see.
    if (item.kind !== 'team') refreshMe().catch(() => {});
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// Swap gems and bolts: 1 gem = 100 bolts, either way.
const swapCount = () => Math.max(1, Math.floor(Number($('swap-gems').value) || 1));
function updateSwap() {
  const n = swapCount();
  $('swap-worth').textContent = `= ${(n * BOLTS_PER_GEM).toLocaleString()} bolts`;
  $('btn-swap-to-gems').disabled = (shopState?.bolts ?? 0) < n * BOLTS_PER_GEM;
  $('btn-swap-to-bolts').disabled = (shopState?.gems ?? 0) < n;
}
$('swap-gems').addEventListener('input', updateSwap);
async function swap(to) {
  const n = swapCount();
  const ask = to === 'gems' ? `Swap ${(n * BOLTS_PER_GEM).toLocaleString()} bolts for ${n} 💎?` : `Swap ${n} 💎 for ${(n * BOLTS_PER_GEM).toLocaleString()} bolts?`;
  if (!(await askConfirm(ask, { ok: 'Swap' }))) return;
  try {
    const now = await api('POST', '/gems/convert', { to, gems: n });
    Object.assign(shopState, now);
    showWallet(now);
    renderShop();
    toast(to === 'gems' ? `+${n} 💎` : `+${(n * BOLTS_PER_GEM).toLocaleString()} ⚡`);
  } catch (err) {
    toast(err.message, { error: true });
  }
}
$('btn-swap-to-gems').addEventListener('click', () => swap('gems'));
$('btn-swap-to-bolts').addEventListener('click', () => swap('bolts'));

/** An online game ended: the server paid out (bolts for winning, gems for everyone), so check. */
async function checkBolts() {
  toastRewards(await refreshWallet());
}

function openPlayables() {
  show('playables');
  loadShop(); // your bolts and team colours
  const best = readJson(KART_BEST);
  $('kart-best').textContent = [best && `🏆 Best: ${ordinalPlace(best.place)} in ${formatRaceTime(best.time)}`, `🤖 Bots: level ${kartLevel()}`].filter(Boolean).join(' · ');
  const stats = readJson(WORDLE_STATS);
  const escapeBest = katEscape.best();
  $('escape-best').textContent = escapeBest ? `🏃 Best: ${escapeBest.toLocaleString()} points` : '';
  const circles = readJson(CC_STATS);
  $('circles-best').textContent = circles?.played ? `🏆 ${circles.wins} won of ${circles.played}` : '';
  const survivalStats = readJson('koolkat.katSurvival.stats');
  $('survival-best').textContent = survivalStats?.played ? `🏕️ Survived ${survivalStats.survived} of ${survivalStats.played} nights` : '';
  const invadersBest = katInvaders.best();
  $('invaders-best').textContent = invadersBest ? `🐭 Best: ${invadersBest.toLocaleString()} points` : '';
  $('wordle-best').textContent = stats?.played ? `🔥 Streak ${stats.streak} · ${stats.wins}/${stats.played} won` : '';
}
$('chip-playables').addEventListener('click', openPlayables);
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-play]');
  if (!card) return;
  if (card.dataset.play === 'kart') openKartMenu();
  else if (card.dataset.play === 'escape') openEscape();
  else if (card.dataset.play === 'circles') openCirclesMenu();
  else if (card.dataset.play === 'invaders') openInvadersMenu();
  else if (card.dataset.play === 'survival') openSurvivalMenu();
  else openWordle();
});

const ordinalPlace = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

// KatEscape: you pick the music on the start screen (remembered); online the host picks.
const ESCAPE_SONG_KEY = 'koolkat.katEscape.song';
for (const select of [$('escape-song'), $('escape-song-online')]) {
  select.replaceChildren(
    el('option', { value: 'random', text: '🔀 Random' }),
    el('option', { value: 'none', text: '🔇 No song' }),
    ...RACE_SONGS.map((song) => el('option', { value: song.id, text: `${song.title} · ${song.artist}` }))
  );
}
try {
  $('escape-song').value = localStorage.getItem(ESCAPE_SONG_KEY) || 'random';
} catch {
  // Random it is.
}
if (!$('escape-song').value) $('escape-song').value = 'random';
$('escape-song').addEventListener('change', (e) => {
  try {
    localStorage.setItem(ESCAPE_SONG_KEY, e.target.value);
  } catch {
    // Remembering it is only a convenience.
  }
});

// KatEscape: solo, Practice (All Chasers vs bots), or online with a code:
// All Chasers, or Chaser vs Cop.
const escapeOnline = { code: null, room: null, timer: null, playing: false, downTimer: null, mode: 'solo' };

function showEscapeOver({ title, final = '', detail = '', results = null, down = false, img = 'icons/escape-cop.png' }) {
  clearInterval(escapeOnline.downTimer);
  $('escape-spectate').hidden = true;
  $('escape-over-title').textContent = title;
  $('escape-final').textContent = final;
  $('escape-over-detail').textContent = detail;
  $('escape-over').querySelector('img').src = img;
  const list = $('escape-results');
  list.hidden = !results;
  if (results) {
    list.replaceChildren(
      ...results.map((p) =>
        el(
          'li',
          { class: p.me ? 'me' : null },
          el('span', { class: 'place', text: ordinalPlace(p.place) }),
          el('span', { class: 'name', text: p.me ? `${p.name} (you)` : p.name }),
          el('span', { class: 'pts', text: `${p.score.toLocaleString()} pts` })
        )
      )
    );
  }
  $('escape-down-actions').hidden = !down;
  $('escape-over-actions').hidden = down;
  $('btn-escape-again').textContent = escapeOnline.mode === 'solo' ? 'Run again' : escapeOnline.mode === 'practice' ? 'Practice again' : 'Play again';
  $('escape-over').hidden = false;
  focusFirst();
}

const katEscape = createKatEscape({
  mute: $('btn-escape-mute'),
  canvas: $('escape-canvas'),
  score: $('escape-score'),
  bolts: $('escape-bolts'),
  boost: $('escape-boost'),
  alert: $('escape-alert'),
  hint: $('escape-hint'),
  nowPlaying: $('escape-now-playing'),
  song: $('escape-song'),
  over: $('escape-over'),
  item: $('escape-item'),
  chase: $('escape-chase'),
  countdown: $('escape-countdown'),
  spectate: $('escape-spectate'),
  onOver: ({ score, bolts, distance, best, newBest, reason }) => {
    showEscapeOver({
      title: reason === 'caught' ? '🚓 The cop caught you!' : '💥 Crashed into a train!',
      final: `${score.toLocaleString()} points`,
      detail: `${distance.toLocaleString()} m · ⚡ ${bolts.toLocaleString()} bolts · ${newBest ? '🏆 New best!' : `Best: ${best.toLocaleString()}`}`,
    });
    // Every bolt you collected is yours, and gems for how far you ran.
    earnRewards('escape', { runBolts: bolts, gems: escapeGems(distance) });
  },
  // Caught: one revive a game.
  onDown: ({ reason, score, online, mode }) => {
    showEscapeOver({
      title: reason === 'caught' ? '🚓 The cop caught you!' : '💥 Crashed into a train!',
      final: `${score.toLocaleString()} points`,
      detail: 'You get one revive a game. Use it now?',
      down: true,
    });
    $('btn-escape-giveup').textContent = mode === 'all' || mode === 'practice' ? '👀 Spectate' : 'Give up';
    if (!online) return;
    // The others are waiting: 10 seconds to decide.
    let left = 10;
    const tick = () => {
      $('escape-over-detail').textContent = `You get one revive a game. Use it now? (${left}s)`;
      if (left-- <= 0) {
        clearInterval(escapeOnline.downTimer);
        katEscape.giveUp();
      }
    };
    tick();
    escapeOnline.downTimer = setInterval(tick, 1000);
  },
  onSpectate: ({ name, count }) => {
    clearInterval(escapeOnline.downTimer);
    $('escape-over').hidden = true;
    $('escape-spec-name').textContent = name;
    $('escape-spec-count').textContent = count > 1 ? `${count} still running` : 'the last one running';
    $('escape-spectate').hidden = false;
    focusFirst();
  },
  onWaiting: () => showEscapeOver({ title: "🚓 You're out!", detail: 'Waiting for the results…' }),
  onResults: (r) => {
    // Your bolts and gems (online, the server pays the winner's bolts).
    const gems = r.mode === 'chase' ? chaseGems(r.winner === r.role) : escapeGems(r.distance);
    const practiceWin = r.mode === 'practice' && r.players.find((p) => p.me)?.place === 1;
    earnRewards('escape', { runBolts: r.bolts ?? 0, gems, win: practiceWin }).then(() => r.mode !== 'practice' && setTimeout(checkBolts, 1200));
    if (r.mode === 'chase') {
      const won = r.winner === r.role;
      const cop = r.role === 'cop';
      const seconds = Math.round(r.time);
      // [title, detail] for how it ended.
      const [title, detail] = {
        'cop-train': [cop ? '💥 You crashed into a train!' : '💥 The cop crashed into a train!', 'The cop had used up their revive'],
        left: [won ? '🏆 They left the game' : '👋 You left', ''],
        escaped: [cop ? '🏃 They got away!' : '🏃 You got away!', `The chaser lasted all ${seconds} seconds`],
        train: [cop ? '💥 They crashed into a train!' : '💥 Crashed into a train!', `The cop wins after ${seconds} seconds`],
      }[r.reason] ?? [cop ? '🚓 You caught them!' : '🚓 The cop caught you!', `Caught after ${seconds} seconds`];
      showEscapeOver({ title, detail, final: won ? 'You win!' : 'You lose', img: r.winner === 'chaser' ? 'icons/escape-cat.png' : 'icons/escape-cop.png' });
      return;
    }
    const me = r.players.find((p) => p.me);
    showEscapeOver({
      title: me?.place === 1 ? '🏆 You won!' : `You came ${ordinalPlace(me?.place ?? r.players.length)}`,
      final: `${(me?.score ?? 0).toLocaleString()} points`,
      detail: r.mode === 'practice' ? 'Practice: All Chasers vs bots' : 'All Chasers',
      results: r.players,
      img: me?.place === 1 ? 'icons/escape-cat.png' : 'icons/escape-cop.png',
    });
  },
});

function startEscape(opts) {
  if (!audioEl.paused) audioEl.pause();
  escapeOnline.mode = opts.mode;
  katEscape.unlockAudio(); // this tap lets the music play
  show('escape');
  katEscape.start(opts).catch((err) => toast(err.message, { error: true }));
}
function openEscape() {
  openEscapeMenu();
}
const leaveEscape = () => {
  leaveEscapeRoom();
  openPlayables();
};
$('btn-escape-quit').addEventListener('click', async () => {
  const inGame = katEscape.running || (escapeOnline.playing && $('escape-over').hidden);
  if (!inGame || (await askConfirm(escapeOnline.playing ? 'Leave the game?' : 'Stop running?', { ok: escapeOnline.playing ? 'Leave' : 'Stop' }))) leaveEscape();
});
$('btn-escape-exit').addEventListener('click', leaveEscape);
$('btn-escape-spec-leave').addEventListener('click', async () => {
  if (await askConfirm('Stop watching and leave the game?', { ok: 'Leave' })) leaveEscape();
});
$('btn-escape-spec-prev').addEventListener('click', () => katEscape.spectateNext(-1));
$('btn-escape-spec-next').addEventListener('click', () => katEscape.spectateNext(1));
$('btn-escape-revive').addEventListener('click', () => {
  clearInterval(escapeOnline.downTimer);
  katEscape.unlockAudio();
  katEscape.revive();
});
$('btn-escape-giveup').addEventListener('click', () => {
  clearInterval(escapeOnline.downTimer);
  katEscape.giveUp();
});
$('btn-escape-again').addEventListener('click', () => {
  katEscape.unlockAudio();
  if (escapeOnline.mode === 'solo' || escapeOnline.mode === 'practice') startEscape({ mode: escapeOnline.mode });
  else {
    leaveEscape();
    openEscapeMenu();
  }
});

// ---------- the KatEscape menu and lobby ----------
function openEscapeMenu() {
  katEscape.unlockAudio();
  $('escape-menu-main').hidden = false;
  $('escape-lobby').hidden = true;
  $('escape-code').value = '';
  $('dialog-escape').showModal();
}
$('btn-escape-close').addEventListener('click', () => $('dialog-escape').close());
$('btn-escape-solo').addEventListener('click', () => {
  $('dialog-escape').close();
  startEscape({ mode: 'solo' });
});
$('btn-escape-practice').addEventListener('click', () => {
  $('dialog-escape').close();
  startEscape({ mode: 'practice' });
});
$('btn-escape-create').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const { room } = await api('POST', '/escape/rooms');
    enterEscapeLobby(room);
  })
);
const joinEscape = () =>
  withBusy($('btn-escape-join'), async () => {
    const code = $('escape-code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) throw new Error('Game codes are 4 letters');
    const { room } = await api('POST', `/escape/rooms/${code}/join`);
    enterEscapeLobby(room);
  });
$('btn-escape-join').addEventListener('click', joinEscape);
$('escape-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    joinEscape();
  }
});

function enterEscapeLobby(room) {
  escapeOnline.code = room.code;
  $('escape-menu-main').hidden = true;
  $('escape-lobby').hidden = false;
  renderEscapeLobby(room);
  focusFirst();
  clearInterval(escapeOnline.timer);
  escapeOnline.timer = setInterval(async () => {
    try {
      const { room: r } = await api('GET', `/escape/rooms/${escapeOnline.code}`);
      renderEscapeLobby(r);
    } catch (err) {
      clearInterval(escapeOnline.timer);
      toast(err.message, { error: true });
      $('dialog-escape').close();
    }
  }, 1000);
}

function renderEscapeLobby(room) {
  escapeOnline.room = room;
  $('escape-lobby-code').textContent = room.code;
  const players = room.players.filter((p) => !p.gone);
  const host = room.hostId === state.me.userId;
  const chase = room.mode === 'chase';
  $('escape-lobby-players').replaceChildren(
    ...players.map((p) =>
      el(
        'li',
        {},
        avatar(p.user, 'small'),
        el('span', { text: p.id === state.me.userId ? `${p.name} (you)` : p.name }),
        p.id === room.hostId ? el('span', { class: 'fineprint', text: ' · host' }) : null,
        el('span', { class: 'escape-role', text: chase && p.id === room.copId ? '🚓 Cop' : '🐱 Chaser' })
      )
    )
  );
  for (const button of [$('btn-escape-mode-all'), $('btn-escape-mode-chase')]) {
    button.setAttribute('aria-checked', String(button.dataset.mode === room.mode));
    button.disabled = !host;
  }
  // Chaser vs Cop: the host picks who's who.
  $('btn-escape-swap').hidden = !(host && chase && players.length === 2);
  const songSelect = $('escape-song-online');
  songSelect.disabled = !host;
  if (document.activeElement !== songSelect) songSelect.value = room.song ?? 'random';
  $('escape-song-note').textContent = host ? '(you pick)' : '(the host picks)';
  $('btn-escape-start').hidden = !host;
  $('btn-escape-start').disabled = chase ? players.length !== 2 : players.length < 2;
  const ready = chase ? players.length === 2 : players.length >= 2;
  $('escape-lobby-status').textContent = !ready
    ? chase
      ? 'Chaser vs Cop is for 2 people. Waiting for a friend to join with the code…'
      : 'Waiting for friends to join with the code… (up to 8 runners)'
    : host
      ? chase
        ? 'Ready! Swap who is the cop if you like, then start.'
        : `${players.length} runners ready. Start when everyone's in!`
      : 'Waiting for the host to start…';
  if (room.state === 'running') startOnlineEscape(room);
}

const escapeLobbyPost = (path, body) =>
  api('POST', `/escape/rooms/${escapeOnline.code}/${path}`, body)
    .then(({ room }) => renderEscapeLobby(room))
    .catch((err) => toast(err.message, { error: true }));
for (const button of [$('btn-escape-mode-all'), $('btn-escape-mode-chase')]) {
  button.addEventListener('click', () => escapeLobbyPost('mode', { mode: button.dataset.mode }));
}
$('btn-escape-swap').addEventListener('click', () => {
  const room = escapeOnline.room;
  const other = room?.players.find((p) => !p.gone && p.id !== room.copId);
  if (other) escapeLobbyPost('cop', { copId: other.id });
});
$('escape-song-online').addEventListener('change', (e) => escapeLobbyPost('song', { song: e.target.value }));

function startOnlineEscape(room) {
  clearInterval(escapeOnline.timer);
  escapeOnline.playing = true;
  $('dialog-escape').close();
  const me = room.players.find((p) => p.id === state.me.userId);
  const code = room.code;
  startEscape({
    mode: room.mode,
    role: room.mode === 'chase' && room.copId === me.id ? 'cop' : 'chaser',
    seed: room.seed,
    song: room.song,
    mySlot: me.slot,
    players: room.players.filter((p) => !p.gone).map((p) => ({ slot: p.slot, name: p.name })),
    startAt: performance.now() + (room.startAt - room.serverNow),
    sync: (st) => api('POST', `/escape/rooms/${code}/state`, st, { timeout: 4000 }).then((r) => r.room),
  });
}

$('btn-escape-start').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const { room } = await api('POST', `/escape/rooms/${escapeOnline.code}/start`);
    renderEscapeLobby(room);
  })
);
$('btn-escape-leave').addEventListener('click', () => {
  leaveEscapeRoom();
  $('dialog-escape').close();
});
$('btn-escape-share').addEventListener('click', async () => {
  const text = `Run from the cop with me in KatEscape on KoolKat! Open Playables → KatEscape and join with code ${escapeOnline.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'KatEscape', text, url: `${location.origin}/#playables` });
    else {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    }
  } catch {
    // Share sheet closed.
  }
});
$('dialog-escape').addEventListener('close', () => {
  // Closed the lobby without starting: leave the game.
  if (!escapeOnline.playing) leaveEscapeRoom();
});

function leaveEscapeRoom() {
  clearInterval(escapeOnline.timer);
  clearInterval(escapeOnline.downTimer);
  escapeOnline.playing = false;
  if (!escapeOnline.code) return;
  api('POST', `/escape/rooms/${escapeOnline.code}/leave`).catch(() => {});
  escapeOnline.code = null;
}

// ---------- Team colours (Circle Chaos and Kat Invaders) ----------
// The first five are free; the rest come from the Bolt Shop (or Unlimited).
let usableTeams = new Set(BASE_TEAMS);
const canUseTeam = (team) => usableTeams.has(team);
/** Team buttons: yours to pick, taken by someone else (their name), or 🔒 in the Bolt Shop. */
function teamPicker(box, { chosen, taken = new Map(), onPick, icon = ccTeamIcon }) {
  box.replaceChildren(
    ...CC_TEAMS.map((team) => {
      const who = taken.get(team);
      const locked = !canUseTeam(team);
      const b = el(
        'button',
        {
          type: 'button',
          class: `cc-team-btn${locked ? ' locked' : ''}`,
          role: 'radio',
          'aria-checked': String(chosen === team),
          'aria-label': locked ? `${CC_TEAM_NAMES[team]}: in the Bolt Shop` : who ? `${CC_TEAM_NAMES[team]} (${who})` : CC_TEAM_NAMES[team],
          onclick: () => (locked ? openShop() : onPick(team)),
        },
        el('img', { src: icon(team), alt: '', class: 'pixel' }),
        el('span', { text: locked ? '🔒' : who ?? CC_TEAM_NAMES[team] })
      );
      b.style.setProperty('--cc-team', teamEdge(team));
      b.disabled = Boolean(who);
      return b;
    })
  );
}

// ---------- Circle Chaos: 2 to 5 teams, online with a code ----------
const CC_STATS = 'koolkat.circleChaos';
const ccTable = createCircleTable($('cc-canvas'));
const cc = { code: null, room: null, timer: null, playing: false, seen: 0, sent: 0, applied: 0, myTurn: false };
// Music from the Kat Kart OST: you pick it in Practice; online the host does.
const ccMusic = createRaceMusic();
ccMusic.bindMute($('btn-cc-mute'));
const CC_SONG = 'koolkat.circleChaos.song';
const songOptions = () => [el('option', { value: 'random', text: '🔀 Random' }), el('option', { value: 'none', text: '🔇 No song' }), ...RACE_SONGS.map((song) => el('option', { value: song.id, text: `${song.title} · ${song.artist}` }))];
$('cc-song').replaceChildren(...songOptions());
$('cc-song-online').replaceChildren(...songOptions());
try {
  $('cc-song').value = localStorage.getItem(CC_SONG) || 'random';
} catch {
  // Random it is.
}
if (!$('cc-song').value) $('cc-song').value = 'random';
$('cc-song').addEventListener('change', (e) => {
  try {
    localStorage.setItem(CC_SONG, e.target.value);
  } catch {
    // Remembering it is only a convenience.
  }
});
$('cc-song-online').addEventListener('change', async (e) => {
  try {
    const { room } = await api('POST', `/circles/rooms/${cc.code}/song`, { song: e.target.value });
    ccApply(room);
  } catch (err) {
    toast(err.message, { error: true });
  }
});

function openCirclesMenu() {
  ccMusic.unlock(); // this tap lets the music play later
  renderPracticePicks();
  loadShop().then(() => renderPracticePicks());
  $('cc-menu-main').hidden = false;
  $('cc-lobby').hidden = true;
  $('cc-code').value = '';
  $('dialog-circles').showModal();
}
$('btn-cc-close').addEventListener('click', () => $('dialog-circles').close());
$('btn-cc-create').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const { room } = await api('POST', '/circles/rooms');
    enterCirclesLobby(room);
  })
);
const joinCircles = () =>
  withBusy($('btn-cc-join'), async () => {
    const code = $('cc-code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) throw new Error('Game codes are 4 letters');
    const { room } = await api('POST', `/circles/rooms/${code}/join`);
    enterCirclesLobby(room);
  });
$('btn-cc-join').addEventListener('click', joinCircles);
$('cc-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    joinCircles();
  }
});

/** Check in with the server every so often (lobby and game). Late answers to old requests are ignored. */
function pollCircles(ms, apply) {
  clearInterval(cc.timer);
  cc.timer = setInterval(async () => {
    if (!cc.code) return;
    const n = ++cc.sent;
    try {
      const { room } = await api('GET', `/circles/rooms/${cc.code}`, undefined, { timeout: 5000 });
      if (n > cc.applied) {
        cc.applied = n;
        apply(room);
      }
    } catch (err) {
      if (err.status === 404 || err.status === 403) {
        clearInterval(cc.timer);
        toast(err.message, { error: true });
        $('dialog-circles').close();
      }
    }
  }, ms);
}
const ccApply = (room) => {
  cc.applied = ++cc.sent;
  if (cc.playing) renderCircles(room);
  else renderCirclesLobby(room);
};

function enterCirclesLobby(room) {
  cc.code = room.code;
  $('cc-menu-main').hidden = true;
  $('cc-lobby').hidden = false;
  renderCirclesLobby(room);
  focusFirst();
  pollCircles(1000, renderCirclesLobby);
}

function renderCirclesLobby(room) {
  if (cc.playing) return renderCircles(room);
  cc.room = room;
  $('cc-lobby-code').textContent = room.code;
  const players = room.players.filter((p) => !p.gone);
  const me = players.find((p) => p.id === state.me.userId);
  const host = room.hostId === state.me.userId;
  // Pick your team: the ones other people have are taken.
  teamPicker($('cc-team-pick'), { chosen: me?.team, taken: new Map(players.filter((p) => p.id !== me?.id).map((p) => [p.team, p.name])), onPick: pickCircleTeam });
  $('cc-lobby-players').replaceChildren(
    ...players.map((p) =>
      el(
        'li',
        {},
        el('img', { src: ccTeamIcon(p.team), alt: CC_TEAM_NAMES[p.team], class: 'cc-mini' }),
        avatar(p.user, 'small'),
        el('span', { text: p.id === state.me.userId ? `${p.name} (you)` : p.name }),
        p.id === room.hostId ? el('span', { class: 'fineprint', text: ' · host' }) : null
      )
    )
  );
  // The host picks the music; everyone else sees what it'll be.
  const songSelect = $('cc-song-online');
  songSelect.disabled = !host;
  if (document.activeElement !== songSelect) songSelect.value = room.song ?? 'random';
  $('cc-song-note').textContent = host ? '(you pick)' : '(the host picks)';
  $('btn-cc-start').hidden = !host;
  $('btn-cc-start').disabled = players.length < 2;
  $('cc-lobby-status').textContent =
    players.length < 2 ? 'Waiting for friends to join with the code… (2 to 5 people)' : host ? `${players.length} teams ready. Start when everyone's in!` : 'Waiting for the host to start…';
  if (room.state !== 'lobby') startCircles(room);
}

async function pickCircleTeam(team) {
  try {
    const { room } = await api('POST', `/circles/rooms/${cc.code}/team`, { team });
    ccApply(room);
  } catch (err) {
    toast(err.message, { error: true });
  }
}
$('btn-cc-start').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const { room } = await api('POST', `/circles/rooms/${cc.code}/start`);
    ccApply(room);
  })
);
$('btn-cc-leave').addEventListener('click', () => {
  leaveCirclesRoom();
  $('dialog-circles').close();
});
$('btn-cc-share').addEventListener('click', async () => {
  const text = `Play Circle Chaos with me on KoolKat! Open Playables → Circle Chaos and join with code ${cc.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Circle Chaos', text, url: `${location.origin}/#playables` });
    else {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    }
  } catch {
    // Share sheet closed.
  }
});
$('dialog-circles').addEventListener('close', () => {
  if (!cc.playing) leaveCirclesRoom();
});

function leaveCirclesRoom() {
  clearInterval(cc.timer);
  clearInterval(ccPractice.timer);
  ccMusic.pause();
  ccPractice.game = null;
  cc.practice = false;
  cc.playing = false;
  if (!cc.code) return;
  api('POST', `/circles/rooms/${cc.code}/leave`).catch(() => {});
  cc.code = null;
}

// ---------- Practice: the same rules, here on your phone, against bots ----------
const CC_PRACTICE = 'koolkat.circleChaos.practice';
const CC_BOT_NAMES = ['Whiskers', 'Mittens', 'Nala', 'Tigger'];
const ccPractice = { game: null, timer: null, last: 0, team: 'red', bots: 3 };
try {
  Object.assign(ccPractice, JSON.parse(localStorage.getItem(CC_PRACTICE) || '{}'));
} catch {
  // Red against 3 bots it is.
}
if (!CC_TEAMS.includes(ccPractice.team)) ccPractice.team = 'red';
ccPractice.bots = Math.max(1, Math.min(4, Number(ccPractice.bots) || 3));

function renderPracticePicks() {
  if (!canUseTeam(ccPractice.team)) ccPractice.team = 'red'; // sold it
  teamPicker($('cc-practice-team'), { chosen: ccPractice.team, onPick: (team) => setPractice({ team }) });
  for (const b of document.querySelectorAll('#dialog-circles .cc-bot-btn')) b.setAttribute('aria-checked', String(Number(b.dataset.bots) === ccPractice.bots));
}
function setPractice(change) {
  Object.assign(ccPractice, change);
  try {
    localStorage.setItem(CC_PRACTICE, JSON.stringify({ team: ccPractice.team, bots: ccPractice.bots }));
  } catch {
    // Remembering it is only a convenience.
  }
  renderPracticePicks();
}
for (const b of document.querySelectorAll('#dialog-circles .cc-bot-btn')) b.addEventListener('click', () => setPractice({ bots: Number(b.dataset.bots) }));
$('btn-cc-practice').addEventListener('click', () => {
  $('dialog-circles').close();
  startCirclesPractice();
});

/** What the screen needs, shaped like an online game from the server. */
const practiceView = (g) => ({
  code: null,
  practice: true,
  state: g.state,
  hostId: state.me.userId,
  serverNow: Date.now(),
  startAt: g.startAt,
  turnId: g.turnId,
  turnEndsAt: null,
  dir: g.dir,
  deck: g.deck.length,
  counts: ccDeckCounts(g.deck),
  pending: g.pending,
  players: g.players.map((p) => ({ ...p })),
  events: g.events,
  results: g.results ?? null,
});

function startCirclesPractice() {
  leaveCirclesRoom();
  if (!canUseTeam(ccPractice.team)) ccPractice.team = 'red';
  const teams = [ccPractice.team, ...BASE_TEAMS.filter((t) => t !== ccPractice.team).slice(0, ccPractice.bots)];
  const players = teams
    .map((team, i) => (i === 0 ? { id: state.me.userId, name: state.me.displayName } : { id: `bot-${i}`, name: `🤖 ${CC_BOT_NAMES[i - 1]}`, bot: true }))
    .map((p, i) => ({ ...p, team: teams[i], circles: 0, turns: 0, gone: false }))
    .sort((a, b) => CC_TEAMS.indexOf(a.team) - CC_TEAMS.indexOf(b.team));
  const g = { state: 'dealing', startAt: Date.now() + 3200, players, deck: ccNewDeck(teams), dir: 1, prevId: null, pending: null, turnId: players[0].id, events: [], seq: 0 };
  ccPractice.game = g;
  practiceEvent(g, { type: 'deal', count: g.deck.length });
  cc.practice = true;
  startCircles(practiceView(g));
  ccPractice.last = Date.now();
  ccPractice.timer = setInterval(practiceTick, 250);
}

function practiceEvent(g, event) {
  g.seq += 1;
  g.events = [...g.events, { ...event, id: g.seq, at: Date.now() }].slice(-30);
}

/** One move (yours or a bot's) in Practice. */
function practiceMove(g, { target, circle } = {}) {
  let event;
  if (g.pending) {
    event = ccChoose(g, target);
    if (!event) return;
  } else {
    event = ccDraw(g, undefined, circle ?? null);
    if (!event) return;
  }
  practiceEvent(g, event);
  if (!g.turnId) {
    g.state = 'done';
    g.results = ccRanked(g.players);
    practiceEvent(g, { type: 'done' });
  }
  ccPractice.last = Date.now();
  renderCircles(practiceView(g));
}

function practiceTick() {
  const g = ccPractice.game;
  if (!g || !cc.practice) return;
  if (g.state === 'dealing' && Date.now() >= g.startAt) {
    g.state = 'playing';
    ccPractice.last = Date.now();
    renderCircles(practiceView(g));
    return;
  }
  if (g.state !== 'playing') return;
  const current = g.players.find((p) => p.id === g.turnId);
  // Bots take a moment, so you can see what they did.
  if (!current?.bot || Date.now() - ccPractice.last < 1100) return;
  // Bots make whoever has the most circles lose them.
  const target = g.pending ? g.players.filter((p) => p.id !== current.id).sort((a, b) => b.circles - a.circles || Math.random() - 0.5)[0].id : undefined;
  practiceMove(g, { target });
}

// ---------- the game ----------
function startCircles(room) {
  cc.playing = true;
  cc.seen = 0;
  cc.myTurn = false;
  $('dialog-circles').close();
  if (!audioEl.paused) audioEl.pause();
  show('circles');
  $('cc-results').hidden = true;
  $('cc-reveal').hidden = true;
  $('cc-log').replaceChildren();
  ccTable.start(room.players.map((p) => p.team)).catch(() => {});
  const song = ccMusic.pick(room.practice ? $('cc-song').value : room.song);
  ccMusic.play(song);
  showNowPlaying($('cc-now-playing'), song);
  renderCircles(room);
  if (!room.practice) pollCircles(700, renderCircles);
}

/** Make a team's circle count bounce (got some) or shake (lost some). */
function ccFlash(id, cls) {
  const li = document.querySelector(`#cc-teams [data-id="${CSS.escape(String(id))}"]`);
  if (!li) return;
  li.classList.remove('bump', 'hit');
  void li.offsetWidth;
  li.classList.add(cls);
}

function renderCircles(room) {
  if (!cc.playing) return;
  cc.room = room;
  const meId = state.me.userId;
  const current = room.players.find((p) => p.id === room.turnId);
  // Teams
  const teams = $('cc-teams');
  teams.style.setProperty('--cc-cols', String(room.players.length));
  teams.replaceChildren(
    ...room.players.map((p) => {
      const li = el(
        'li',
        { class: `cc-team${p.id === room.turnId ? ' turn' : ''}${p.id === meId ? ' me' : ''}${p.gone ? ' gone' : ''}`, 'data-id': String(p.id) },
        el('img', { src: ccTeamIcon(p.team), alt: '' }),
        // (A column next to the cat on small phones; otherwise the same as before.)
        el(
          'span',
          { class: 'cc-team-text' },
          el('span', { class: 'cc-name', text: p.name }),
          el('span', { class: 'cc-count', 'aria-label': `${p.circles} circles` }, el('img', { src: ccCircleIcon(p.team), alt: '' }), String(p.circles)),
          el('span', { class: 'cc-left', text: p.gone ? 'left' : `${Math.max(0, CC_TURNS - p.turns)} turns left` })
        )
      );
      li.style.setProperty('--cc-team', teamEdge(p.team));
      return li;
    })
  );
  // What's new: animate it and add it to the log.
  const fresh = room.events.filter((e) => e.id > cc.seen);
  cc.seen = Math.max(cc.seen, ...room.events.map((e) => e.id));
  for (const e of fresh) {
    if (e.type === 'deal') ccTable.deal();
    if (e.type === 'draw') ccTable.take(e.circle);
    if (e.type === 'draw' || e.type === 'penalty') {
      const img = $('cc-reveal').querySelector('img');
      img.src = ccCircleIcon(e.circle);
      img.style.animation = 'none';
      void img.offsetWidth;
      img.style.animation = '';
      $('cc-reveal').querySelector('p').textContent = ccDescribe(room, e);
      $('cc-reveal').hidden = false;
      if (e.to) setTimeout(() => ccFlash(e.to, 'bump'), 50);
      if (e.target && e.lost) setTimeout(() => ccFlash(e.target, 'hit'), 50);
      if (e.outcome === 'everyone-4') for (const p of room.players) setTimeout(() => ccFlash(p.id, 'bump'), 50);
    }
  }
  if (fresh.length) {
    const log = $('cc-log');
    for (const e of fresh) {
      const text = ccDescribe(room, e);
      if (text) log.prepend(el('li', { text }));
    }
    while (log.children.length > 8) log.lastChild.remove();
  }
  // Whose turn
  const mine = room.state === 'playing' && room.turnId === meId;
  $('cc-turn').textContent =
    room.state === 'dealing' ? '🤖 The bot is spilling the bag…' : room.state === 'done' ? '🏁 Game over' : mine ? '⭐ Your turn!' : current ? `${CC_TEAM_NAMES[current.team]}'s turn (${current.name})` : '';
  $('cc-turn-sub').textContent = room.state === 'playing' && current ? `Turn ${Math.min(CC_TURNS, current.turns + 1)} of ${CC_TURNS}` : '';
  $('cc-dir').classList.toggle('flipped', room.dir === -1);
  $('cc-dir').title = room.dir === -1 ? 'Turn order: flipped' : 'Turn order';
  $('cc-deck-count').textContent = room.state === 'lobby' ? '' : `${room.deck} in the Deck`;
  ccTable.setCount(room.deck);
  // What you can do
  const choosing = mine && room.pending;
  const picking = mine && !room.pending;
  $('cc-picks').hidden = !picking;
  if (picking) renderCirclePicks(room);
  else $('cc-pick-list').dataset.key = '';
  $('cc-targets').hidden = !choosing;
  if (choosing) {
    $('cc-targets-title').textContent = `Who loses ${room.pending.circle === 'lose4' ? 4 : 2}?`;
    const list = $('cc-target-list');
    const ids = room.players.filter((p) => p.id !== meId && !p.gone).map((p) => p.id).join();
    if (list.dataset.ids !== ids) {
      list.dataset.ids = ids;
      list.replaceChildren(
        ...room.players
          .filter((p) => p.id !== meId && !p.gone)
          .map((p) => {
            const b = el(
              'button',
              { type: 'button', class: 'cc-target', onclick: () => ccPlay({ target: p.id }) },
              el('img', { src: ccTeamIcon(p.team), alt: '' }),
              `${CC_TEAM_NAMES[p.team]} · ${p.name} (${p.circles})`
            );
            b.style.setProperty('--cc-team', teamEdge(p.team));
            return b;
          })
      );
      focusFirst();
    }
  } else $('cc-target-list').dataset.ids = '';
  const left = room.turnEndsAt ? Math.max(0, Math.ceil((room.turnEndsAt - room.serverNow) / 1000)) : 0;
  $('cc-wait').textContent =
    room.state !== 'playing' ? '' : !room.turnEndsAt ? (mine ? '' : current?.bot ? `${current.name} is thinking…` : '') : mine ? `${left}s, or the bot takes your turn for you` : current ? `Waiting for ${CC_TEAM_NAMES[current.team]}… (${left}s)` : '';
  if (mine && !cc.myTurn) {
    navigator.vibrate?.(40);
    focusFirst();
  }
  cc.myTurn = mine;
  if (room.state === 'done' && room.results && $('cc-results').hidden) showCirclesResults(room);
}

async function ccPlay(body = {}) {
  if (cc.practice) {
    const g = ccPractice.game;
    if (g?.state === 'playing' && g.turnId === state.me.userId) practiceMove(g, body);
    return;
  }
  try {
    const { room } = await api('POST', `/circles/rooms/${cc.code}/play`, body);
    ccApply(room);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/**
 * Your turn: pick the circle to take, your own colour or a rainbow one (the
 * other teams' colours aren't yours to take). Each shows how many are left;
 * if none of them are, the bot spills the bag again whichever you pick.
 */
const CC_PICK_NAMES = { lose2: 'Lose 2', lose4: 'Lose 4', lucky: 'Lucky' };
function renderCirclePicks(room) {
  const me = room.players.find((p) => p.id === state.me.userId);
  const kinds = ccChoicesFor(me.team);
  const counts = room.counts ?? {};
  const empty = kinds.every((k) => !counts[k]);
  const list = $('cc-pick-list');
  const key = `${room.events.at(-1)?.id}:${kinds.map((k) => counts[k] ?? 0).join()}`;
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(
    ...kinds.map((kind, i) => {
      const n = counts[kind] ?? 0;
      const name = CC_PICK_NAMES[kind] ?? CC_TEAM_NAMES[kind];
      const b = el(
        'button',
        { type: 'button', class: 'cc-pick', 'data-circle': kind, 'aria-label': `${name}: ${n} left (key ${i + 1})`, title: `${name} (${i + 1})` },
        el('img', { src: ccCircleIcon(kind), alt: '', class: 'pixel' }),
        el('span', { class: 'cc-pick-name', text: name }),
        el('span', { class: 'cc-pick-count', text: empty ? '🤖 refill' : `×${n}` })
      );
      b.disabled = !empty && !n;
      b.addEventListener('click', () => withBusy(b, () => ccPlay({ circle: kind })));
      if (kind === me.team) b.style.setProperty('--cc-team', teamEdge(kind));
      return b;
    })
  );
}

function showCirclesResults(room) {
  clearInterval(cc.timer);
  const meId = state.me.userId;
  const me = room.results.find((r) => r.id === meId);
  const winners = room.results.filter((r) => r.place === 1);
  $('cc-results-title').textContent = me?.place === 1 ? (winners.length > 1 ? '🤝 You tied for 1st!' : '🏆 You won!') : `${CC_TEAM_NAMES[winners[0].team]} wins!`;
  $('cc-results-list').replaceChildren(
    ...room.results.map((r) =>
      el(
        'li',
        { class: r.id === meId ? 'me' : null },
        el('span', { class: 'place', text: ordinalPlace(r.place) }),
        el('img', { src: ccTeamIcon(r.team), alt: '' }),
        el('span', { class: 'name', text: `${CC_TEAM_NAMES[r.team]} · ${r.id === meId ? `${r.name} (you)` : r.name}${r.gone ? ' (left)' : ''}` }),
        el('span', { class: 'cc-pts' }, String(r.circles), el('img', { src: ccCircleIcon(r.team), alt: ' circles', class: 'cc-mini-circle' }))
      )
    )
  );
  $('cc-results').hidden = false;
  $('btn-cc-again').textContent = room.practice ? 'Practice again' : 'Play again';
  focusFirst();
  ccMusic.pause();
  if (room.practice) {
    earnRewards('circles', { win: me?.place === 1, gems: placeGems(me?.place ?? room.results.length, room.results.length) });
    return; // only real games count towards your record
  }
  checkBolts();
  const stats = readJson(CC_STATS) ?? { played: 0, wins: 0 };
  stats.played += 1;
  if (me?.place === 1) stats.wins += 1;
  try {
    localStorage.setItem(CC_STATS, JSON.stringify(stats));
  } catch {
    // Just for fun.
  }
  focusFirst();
}

const leaveCircles = () => {
  leaveCirclesRoom();
  openPlayables();
};
$('btn-cc-quit').addEventListener('click', async () => {
  if (cc.room?.state !== 'done' && !(await askConfirm(cc.practice ? 'Stop practising?' : 'Leave the game? The others keep playing without you.', { ok: cc.practice ? 'Stop' : 'Leave' }))) return;
  leaveCircles();
});
$('btn-cc-exit').addEventListener('click', leaveCircles);
$('btn-cc-again').addEventListener('click', () => {
  if (cc.practice) return startCirclesPractice();
  leaveCircles();
  openCirclesMenu();
});

// ---------- Kat Invaders: Solo, Practice vs bots, or online with a code ----------
const KI_SETTINGS = 'koolkat.katInvaders';
const ki = { code: null, room: null, timer: null, playing: false, sent: 0, applied: 0, mode: 'solo', team: 'red', difficulty: 'medium', bots: 3, song: 'random' };
try {
  Object.assign(ki, JSON.parse(localStorage.getItem(KI_SETTINGS) || '{}'), { code: null, room: null, timer: null, playing: false });
} catch {
  // The defaults it is.
}
if (!CC_TEAMS.includes(ki.team)) ki.team = 'red';
if (!(ki.difficulty in KI_LIVES)) ki.difficulty = 'medium';
ki.bots = Math.max(1, Math.min(4, Number(ki.bots) || 3));
const saveKi = () => {
  try {
    localStorage.setItem(KI_SETTINGS, JSON.stringify({ team: ki.team, difficulty: ki.difficulty, bots: ki.bots, song: ki.song }));
  } catch {
    // Remembering it is only a convenience.
  }
};
const kiTeamIcon = (team) => `icons/invaders/team-${team}.png`;
$('ki-song').replaceChildren(...songOptions());
$('ki-song-online').replaceChildren(...songOptions());
$('ki-song').value = ki.song === 'none' || RACE_SONGS.some((s) => s.id === ki.song) ? ki.song : 'random';
$('ki-song').addEventListener('change', (e) => {
  ki.song = e.target.value;
  saveKi();
});

/** Team buttons (shared with Circle Chaos), with Kat Invaders' cats. */
const kiTeamButtons = (box, chosen, taken, onPick) => teamPicker(box, { chosen, taken, onPick, icon: kiTeamIcon });
function kiDifficultyButtons(box, chosen, enabled, onPick) {
  box.replaceChildren(
    ...KI_DIFFICULTIES.map(([id, name, lives]) => {
      const b = el('button', { type: 'button', class: 'ki-diff', role: 'radio', 'aria-checked': String(chosen === id), onclick: () => onPick(id) }, name, el('span', { text: lives }));
      b.disabled = !enabled;
      return b;
    })
  );
}
function renderKiMenu() {
  if (!canUseTeam(ki.team)) ki.team = 'red'; // sold it
  kiTeamButtons($('ki-team-pick'), ki.team, new Map(), (team) => {
    ki.team = team;
    saveKi();
    renderKiMenu();
  });
  $('ki-menu-art').src = kiTeamIcon(ki.team);
  kiDifficultyButtons($('ki-difficulty'), ki.difficulty, true, (difficulty) => {
    ki.difficulty = difficulty;
    saveKi();
    renderKiMenu();
  });
  for (const b of document.querySelectorAll('.ki-bot-btn')) b.setAttribute('aria-checked', String(Number(b.dataset.bots) === ki.bots));
}
for (const b of document.querySelectorAll('.ki-bot-btn')) {
  b.addEventListener('click', () => {
    ki.bots = Number(b.dataset.bots);
    saveKi();
    renderKiMenu();
  });
}

function openInvadersMenu() {
  katInvaders.unlockAudio(); // this tap lets the music play later
  renderKiMenu();
  loadShop().then(() => renderKiMenu());
  $('ki-menu-main').hidden = false;
  $('ki-lobby').hidden = true;
  $('ki-code').value = '';
  $('dialog-invaders').showModal();
}
$('btn-ki-close').addEventListener('click', () => $('dialog-invaders').close());

const katInvaders = createKatInvaders({
  mute: $('btn-ki-mute'),
  canvas: $('ki-canvas'),
  score: $('ki-score'),
  lives: $('ki-lives'),
  time: $('ki-time'),
  board: $('ki-board'),
  alert: $('ki-alert'),
  countdown: $('ki-countdown'),
  nowPlaying: $('ki-now-playing'),
  hint: $('ki-hint'),
  song: $('ki-song'),
  over: $('ki-over'),
  onWaiting: ({ score, why }) => showKiOver({ title: why === 'out' ? '🐭 Out of lives!' : "⏱ Time's up!", final: `${score.toLocaleString()} points`, detail: 'Waiting for everyone else to finish…', waiting: true }),
  onOver: (r) => {
    const meId = r.mode === 'online' ? state.me.userId : 'me';
    const players = r.players.map((p) => ({ ...p, me: p.id === meId }));
    const me = players.find((p) => p.me);
    if (r.mode === 'solo') {
      showKiOver({
        title: r.survived ? '🏆 You survived the 2 minutes!' : '🐭 Out of lives!',
        final: `${r.score.toLocaleString()} points`,
        detail: r.newBest ? '🏆 New best!' : `Best: ${r.best.toLocaleString()}`,
        img: r.survived ? kiTeamIcon(ki.team) : 'icons/invaders/mouse.png',
      });
      earnRewards('invaders', { win: r.survived, gems: invaderGems(r.score) });
      return;
    }
    const winners = players.filter((p) => p.place === 1);
    showKiOver({
      title: me?.place === 1 ? (winners.length > 1 ? '🤝 You tied for 1st!' : '🏆 You won!') : `${CC_TEAM_NAMES[winners[0]?.team] ?? ''} wins!`,
      final: `${r.score.toLocaleString()} points`,
      detail: r.mode === 'practice' ? 'Practice vs bots' : `Kat Invaders · ${KI_DIFFICULTIES.find(([id]) => id === ki.difficulty)?.[1] ?? ''}`,
      results: players,
      img: kiTeamIcon(winners[0]?.team ?? ki.team),
    });
    if (r.mode === 'practice') {
      earnRewards('invaders', { win: me?.place === 1 && r.score > 0, gems: placeGems(me?.place ?? players.length, players.length) });
    } else {
      clearInterval(ki.timer);
      checkBolts();
    }
  },
});

function showKiOver({ title, final = '', detail = '', results = null, img = 'icons/invaders/mouse.png', waiting = false }) {
  $('ki-over-title').textContent = title;
  $('ki-final').textContent = final;
  $('ki-over-detail').textContent = detail;
  $('ki-over-img').src = img;
  const list = $('ki-results');
  list.hidden = !results;
  if (results) {
    list.replaceChildren(
      ...results.map((p) =>
        el(
          'li',
          { class: p.me ? 'me' : null },
          el('span', { class: 'place', text: ordinalPlace(p.place) }),
          el('img', { src: kiTeamIcon(p.team), alt: '', class: 'ki-mini' }),
          el('span', { class: 'name', text: `${p.me ? `${p.name} (you)` : p.name}${p.gone ? ' (left)' : ''}` }),
          el('span', { class: 'pts', text: `${p.score.toLocaleString()} pts` })
        )
      )
    );
  }
  $('btn-ki-again').hidden = waiting;
  $('btn-ki-again').textContent = ki.mode === 'solo' ? 'Play again' : ki.mode === 'practice' ? 'Practice again' : 'Play again';
  $('ki-over').hidden = false;
  focusFirst();
}

function startInvaders(opts) {
  if (!audioEl.paused) audioEl.pause();
  ki.mode = opts.mode;
  katInvaders.unlockAudio();
  show('invaders');
  katInvaders.start({ team: ki.team, name: state.me.displayName, difficulty: ki.difficulty, ...opts }).catch((err) => toast(err.message, { error: true }));
}
$('btn-ki-solo').addEventListener('click', () => {
  $('dialog-invaders').close();
  startInvaders({ mode: 'solo' });
});
$('btn-ki-practice').addEventListener('click', () => {
  $('dialog-invaders').close();
  startInvaders({ mode: 'practice', bots: ki.bots });
});
const leaveInvaders = () => {
  leaveInvadersRoom();
  openPlayables();
};
$('btn-ki-quit').addEventListener('click', async () => {
  const inGame = katInvaders.running || (ki.playing && !$('ki-over').hidden && $('btn-ki-again').hidden);
  if (!inGame || (await askConfirm(ki.playing ? 'Leave the game?' : 'Stop playing?', { ok: ki.playing ? 'Leave' : 'Stop' }))) leaveInvaders();
});
$('btn-ki-exit').addEventListener('click', leaveInvaders);
$('btn-ki-again').addEventListener('click', () => {
  katInvaders.unlockAudio();
  if (ki.mode === 'solo') startInvaders({ mode: 'solo' });
  else if (ki.mode === 'practice') startInvaders({ mode: 'practice', bots: ki.bots });
  else {
    leaveInvaders();
    openInvadersMenu();
  }
});

// Online: lobby, teams, the host's difficulty and music.
$('btn-ki-create').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const { room } = await api('POST', '/invaders/rooms');
    enterKiLobby(room);
    // Your favourite team, if it's free.
    if (canUseTeam(ki.team) && room.players.find((p) => p.id === state.me.userId)?.team !== ki.team) kiLobbyPost('team', { team: ki.team }, true);
  })
);
const joinKi = () =>
  withBusy($('btn-ki-join'), async () => {
    const code = $('ki-code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) throw new Error('Game codes are 4 letters');
    const { room } = await api('POST', `/invaders/rooms/${code}/join`);
    enterKiLobby(room);
  });
$('btn-ki-join').addEventListener('click', joinKi);
$('ki-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    joinKi();
  }
});

function enterKiLobby(room) {
  ki.code = room.code;
  $('ki-menu-main').hidden = true;
  $('ki-lobby').hidden = false;
  renderKiLobby(room);
  focusFirst();
  clearInterval(ki.timer);
  ki.timer = setInterval(async () => {
    if (!ki.code) return;
    const n = ++ki.sent;
    try {
      const { room: r } = await api('GET', `/invaders/rooms/${ki.code}`, undefined, { timeout: 5000 });
      if (n > ki.applied) {
        ki.applied = n;
        renderKiLobby(r);
      }
    } catch (err) {
      if (err.status === 404 || err.status === 403) {
        clearInterval(ki.timer);
        toast(err.message, { error: true });
        $('dialog-invaders').close();
      }
    }
  }, 1000);
}
async function kiLobbyPost(path, body, quiet = false) {
  try {
    const { room } = await api('POST', `/invaders/rooms/${ki.code}/${path}`, body);
    ki.applied = ++ki.sent;
    renderKiLobby(room);
  } catch (err) {
    if (!quiet) toast(err.message, { error: true });
  }
}
function renderKiLobby(room) {
  if (ki.playing) return;
  ki.room = room;
  $('ki-lobby-code').textContent = room.code;
  const players = room.players.filter((p) => !p.gone);
  const me = players.find((p) => p.id === state.me.userId);
  const host = room.hostId === state.me.userId;
  kiTeamButtons($('ki-lobby-team'), me?.team, new Map(players.filter((p) => p.id !== me?.id).map((p) => [p.team, p.name])), (team) => {
    ki.team = team;
    saveKi();
    kiLobbyPost('team', { team });
  });
  $('ki-lobby-players').replaceChildren(
    ...players.map((p) =>
      el(
        'li',
        {},
        el('img', { src: kiTeamIcon(p.team), alt: CC_TEAM_NAMES[p.team], class: 'cc-mini' }),
        avatar(p.user, 'small'),
        el('span', { text: p.id === state.me.userId ? `${p.name} (you)` : p.name }),
        p.id === room.hostId ? el('span', { class: 'fineprint', text: ' · host' }) : null
      )
    )
  );
  kiDifficultyButtons($('ki-lobby-difficulty'), room.difficulty, host, (difficulty) => kiLobbyPost('difficulty', { difficulty }));
  $('ki-lobby-note').textContent = host ? '(you pick)' : '(the host picks)';
  const songSelect = $('ki-song-online');
  songSelect.disabled = !host;
  if (document.activeElement !== songSelect) songSelect.value = room.song ?? 'random';
  $('btn-ki-start').hidden = !host;
  $('btn-ki-start').disabled = players.length < 2;
  $('ki-lobby-status').textContent =
    players.length < 2 ? 'Waiting for friends to join with the code… (2 to 5 people)' : host ? `${players.length} teams ready. Start when everyone's in!` : 'Waiting for the host to start…';
  if (room.state === 'running') startOnlineInvaders(room);
}
$('ki-song-online').addEventListener('change', (e) => kiLobbyPost('song', { song: e.target.value }));
$('btn-ki-start').addEventListener('click', (e) => withBusy(e.currentTarget, () => kiLobbyPost('start')));
$('btn-ki-leave').addEventListener('click', () => {
  leaveInvadersRoom();
  $('dialog-invaders').close();
});
$('btn-ki-share').addEventListener('click', async () => {
  const text = `Shoot mice with me in Kat Invaders on KoolKat! Open Playables → Kat Invaders and join with code ${ki.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Kat Invaders', text, url: `${location.origin}/#playables` });
    else {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    }
  } catch {
    // Share sheet closed.
  }
});
$('dialog-invaders').addEventListener('close', () => {
  if (!ki.playing) leaveInvadersRoom();
});

function startOnlineInvaders(room) {
  clearInterval(ki.timer);
  ki.playing = true;
  $('dialog-invaders').close();
  const me = room.players.find((p) => p.id === state.me.userId);
  const code = room.code;
  ki.difficulty = room.difficulty;
  startInvaders({
    mode: 'online',
    team: me.team,
    difficulty: room.difficulty,
    seed: room.seed,
    song: room.song,
    startAt: performance.now() + (room.startAt - room.serverNow),
    others: room.players.filter((p) => !p.gone && p.id !== me.id).map((p) => ({ id: p.id, name: p.name, team: p.team })),
    sync: (st) => api('POST', `/invaders/rooms/${code}/state`, st, { timeout: 4000 }).then((r) => r.room),
  });
}

function leaveInvadersRoom() {
  clearInterval(ki.timer);
  ki.playing = false;
  if (!ki.code) return;
  api('POST', `/invaders/rooms/${ki.code}/leave`).catch(() => {});
  ki.code = null;
}

// ---------- Kat Survival: Solo, or survive the night with friends ----------
const KS_SETTINGS = 'koolkat.katSurvival';
const KS_STATS = 'koolkat.katSurvival.stats';
const ks = { code: null, room: null, timer: null, playing: false, sent: 0, applied: 0, mode: 'solo', team: 'blue', song: 'random' };
try {
  Object.assign(ks, JSON.parse(localStorage.getItem(KS_SETTINGS) || '{}'), { code: null, room: null, timer: null, playing: false });
} catch {
  // The defaults it is.
}
if (!CC_TEAMS.includes(ks.team)) ks.team = 'blue';
const saveKs = () => {
  try {
    localStorage.setItem(KS_SETTINGS, JSON.stringify({ team: ks.team, song: ks.song }));
  } catch {
    // Remembering it is only a convenience.
  }
};
// The team picker shows each team's Kat (its shirt in the team colour).
const ksTeamIcon = (team) => `icons/circles/team-${team}.png`;
$('ks-song').replaceChildren(...songOptions());
$('ks-song-online').replaceChildren(...songOptions());
$('ks-song').value = ks.song === 'none' || RACE_SONGS.some((s) => s.id === ks.song) ? ks.song : 'random';
$('ks-song').addEventListener('change', (e) => {
  ks.song = e.target.value;
  saveKs();
});
function renderKsMenu() {
  if (!canUseTeam(ks.team)) ks.team = 'blue'; // sold it
  teamPicker($('ks-team-pick'), {
    chosen: ks.team,
    icon: ksTeamIcon,
    onPick: (team) => {
      ks.team = team;
      saveKs();
      renderKsMenu();
    },
  });
}
function openSurvivalMenu() {
  katSurvival.unlockAudio(); // this tap lets the music play later
  renderKsMenu();
  loadShop().then(() => renderKsMenu());
  $('ks-menu-main').hidden = false;
  $('ks-lobby').hidden = true;
  $('ks-code').value = '';
  $('dialog-survival').showModal();
}
$('btn-ks-close').addEventListener('click', () => $('dialog-survival').close());

const katSurvival = createKatSurvival({
  mute: $('btn-ks-mute'),
  canvas: $('ks-canvas'),
  minimap: $('ks-minimap'),
  clock: $('ks-clock'),
  hp: $('ks-hp'),
  hpText: $('ks-hp-text'),
  hunger: $('ks-hunger'),
  hungerText: $('ks-hunger-text'),
  food: $('ks-food'),
  wood: $('ks-wood'),
  stone: $('ks-stone'),
  campfires: $('ks-campfires'),
  swing: $('btn-ks-swing'),
  eat: $('btn-ks-eat'),
  fuel: $('btn-ks-fuel'),
  place: $('btn-ks-place'),
  craft: $('btn-ks-craft'),
  ready: $('btn-ks-ready'),
  cold: $('ks-cold'),
  alert: $('ks-alert'),
  countdown: $('ks-countdown'),
  nowPlaying: $('ks-now-playing'),
  over: $('ks-over'),
  onOver: ({ mode, results, me, gems }) => {
    const survived = Boolean(me?.survived);
    const lasted = formatRaceTime(me?.time ?? 0).replace(/\.\d+$/, '');
    $('ks-over-title').textContent = survived ? '🏕️ You survived the night!' : '💀 You didn’t make it to morning';
    $('ks-final').textContent = survived ? '☀️ The sun is up!' : `Lasted ${lasted}`;
    $('ks-over-detail').textContent = `${me?.kills ?? 0} animal${me?.kills === 1 ? '' : 's'} hunted`;
    $('ks-over-img').src = survived ? 'icons/survival/card.png' : 'icons/survival/bear.png';
    const list = $('ks-results');
    list.hidden = mode !== 'online';
    if (mode === 'online') {
      list.replaceChildren(
        ...results.map((r) =>
          el(
            'li',
            { class: r.id === state.me.userId ? 'me' : null },
            el('span', { class: 'place', text: r.survived ? '🏕️' : '💀' }),
            el('img', { src: ksTeamIcon(r.team), alt: '', class: 'ki-mini' }),
            el('span', { class: 'name', text: `${r.id === state.me.userId ? `${r.name} (you)` : r.name}${r.gone ? ' (left)' : ''}` }),
            el('span', { class: 'pts', text: r.survived ? 'Survived' : formatRaceTime(r.time).replace(/\.\d+$/, '') })
          )
        )
      );
    }
    $('btn-ks-again').textContent = 'Play again';
    $('ks-over').hidden = false;
    const stats = readJson(KS_STATS) ?? { played: 0, survived: 0 };
    stats.played += 1;
    if (survived) stats.survived += 1;
    try {
      localStorage.setItem(KS_STATS, JSON.stringify(stats));
    } catch {
      // Just for fun.
    }
    // Online, the server hands out the bolts and gems.
    if (mode === 'solo') earnRewards('survival', { win: survived, gems });
    else {
      clearInterval(ks.timer);
      checkBolts();
    }
    focusFirst();
  },
});

function startSurvival(opts) {
  if (!audioEl.paused) audioEl.pause();
  ks.mode = opts.mode;
  katSurvival.unlockAudio();
  show('survival');
  katSurvival.start({ team: ks.team, name: state.me.displayName, song: ks.song, ...opts }).catch((err) => toast(err.message, { error: true }));
}
$('btn-ks-solo').addEventListener('click', () => {
  $('dialog-survival').close();
  startSurvival({ mode: 'solo' });
});
const leaveSurvival = () => {
  leaveSurvivalRoom();
  openPlayables();
};
$('btn-ks-quit').addEventListener('click', async () => {
  if (!katSurvival.running || (await askConfirm(ks.playing ? 'Leave the game? The others keep going without you.' : 'Stop playing?', { ok: ks.playing ? 'Leave' : 'Stop' }))) leaveSurvival();
});
$('btn-ks-exit').addEventListener('click', leaveSurvival);
$('btn-ks-again').addEventListener('click', () => {
  katSurvival.unlockAudio();
  if (ks.mode === 'solo') startSurvival({ mode: 'solo' });
  else {
    leaveSurvival();
    openSurvivalMenu();
  }
});

// Online: lobby, teams and the host's music.
$('btn-ks-create').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const { room } = await api('POST', '/survival/rooms');
    enterKsLobby(room);
    if (canUseTeam(ks.team) && room.players.find((p) => p.id === state.me.userId)?.team !== ks.team) ksLobbyPost('team', { team: ks.team }, true);
  })
);
const joinKs = () =>
  withBusy($('btn-ks-join'), async () => {
    const code = $('ks-code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) throw new Error('Game codes are 4 letters');
    const { room } = await api('POST', `/survival/rooms/${code}/join`);
    enterKsLobby(room);
  });
$('btn-ks-join').addEventListener('click', joinKs);
$('ks-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    joinKs();
  }
});

function enterKsLobby(room) {
  ks.code = room.code;
  $('ks-menu-main').hidden = true;
  $('ks-lobby').hidden = false;
  renderKsLobby(room);
  focusFirst();
  clearInterval(ks.timer);
  ks.timer = setInterval(async () => {
    if (!ks.code) return;
    const n = ++ks.sent;
    try {
      const { room: r } = await api('GET', `/survival/rooms/${ks.code}`, undefined, { timeout: 5000 });
      if (n > ks.applied) {
        ks.applied = n;
        renderKsLobby(r);
      }
    } catch (err) {
      if (err.status === 404 || err.status === 403) {
        clearInterval(ks.timer);
        toast(err.message, { error: true });
        $('dialog-survival').close();
      }
    }
  }, 1000);
}
async function ksLobbyPost(path, body, quiet = false) {
  try {
    const { room } = await api('POST', `/survival/rooms/${ks.code}/${path}`, body);
    ks.applied = ++ks.sent;
    renderKsLobby(room);
  } catch (err) {
    if (!quiet) toast(err.message, { error: true });
  }
}
function renderKsLobby(room) {
  if (ks.playing) return;
  ks.room = room;
  $('ks-lobby-code').textContent = room.code;
  const players = room.players.filter((p) => !p.gone);
  const me = players.find((p) => p.id === state.me.userId);
  const host = room.hostId === state.me.userId;
  teamPicker($('ks-lobby-team'), {
    chosen: me?.team,
    icon: ksTeamIcon,
    taken: new Map(players.filter((p) => p.id !== me?.id).map((p) => [p.team, p.name])),
    onPick: (team) => {
      ks.team = team;
      saveKs();
      ksLobbyPost('team', { team });
    },
  });
  $('ks-lobby-players').replaceChildren(
    ...players.map((p) =>
      el(
        'li',
        {},
        el('img', { src: ksTeamIcon(p.team), alt: CC_TEAM_NAMES[p.team], class: 'cc-mini' }),
        avatar(p.user, 'small'),
        el('span', { text: p.id === state.me.userId ? `${p.name} (you)` : p.name }),
        p.id === room.hostId ? el('span', { class: 'fineprint', text: ' · host' }) : null
      )
    )
  );
  const songSelect = $('ks-song-online');
  songSelect.disabled = !host;
  if (document.activeElement !== songSelect) songSelect.value = room.song ?? 'random';
  $('ks-song-note').textContent = host ? '(you pick)' : '(the host picks)';
  $('btn-ks-start').hidden = !host;
  $('btn-ks-start').disabled = players.length < 2;
  $('ks-lobby-status').textContent =
    players.length < 2 ? 'Waiting for friends to join with the code… (2 to 5 Kats)' : host ? `${players.length} Kats ready. Start when everyone's in!` : 'Waiting for the host to start…';
  if (room.state === 'running') startOnlineSurvival(room);
}
$('ks-song-online').addEventListener('change', (e) => ksLobbyPost('song', { song: e.target.value }));
$('btn-ks-start').addEventListener('click', (e) => withBusy(e.currentTarget, () => ksLobbyPost('start')));
$('btn-ks-leave').addEventListener('click', () => {
  leaveSurvivalRoom();
  $('dialog-survival').close();
});
$('btn-ks-share').addEventListener('click', async () => {
  const text = `Survive the night with me in Kat Survival on KoolKat! Open Playables → Kat Survival and join with code ${ks.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Kat Survival', text, url: `${location.origin}/#playables` });
    else {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    }
  } catch {
    // Share sheet closed.
  }
});
$('dialog-survival').addEventListener('close', () => {
  if (!ks.playing) leaveSurvivalRoom();
});

function startOnlineSurvival(room) {
  clearInterval(ks.timer);
  ks.playing = true;
  $('dialog-survival').close();
  const code = room.code;
  startSurvival({
    mode: 'online',
    me: state.me.userId,
    seed: room.seed,
    song: room.song,
    startAt: performance.now() + (room.startAt - room.serverNow),
    players: room.players.filter((p) => !p.gone).map((p) => ({ id: p.id, name: p.name, team: p.team })),
    sync: (st) => api('POST', `/survival/rooms/${code}/state`, st, { timeout: 4000 }),
  });
}

function leaveSurvivalRoom() {
  clearInterval(ks.timer);
  ks.playing = false;
  if (!ks.code) return;
  api('POST', `/survival/rooms/${ks.code}/leave`).catch(() => {});
  ks.code = null;
}

// ---------- KoolKat Books ----------
const books = createBooks({ $, el, api, toast, withBusy, avatar, badgeImg, openUserProfile, openComments, show, askConfirm, timeAgo, formatTime, API_BASE, getToken, goHome: () => openHome() });
$('chip-books').addEventListener('click', () => books.open());

// Kat Wordle
const katWordle = createKatWordle({ board: $('kw-board'), keyboard: $('kw-keyboard'), message: $('kw-message'), result: $('kw-result'), hints: $('kw-hints'), onFinish: ({ won, guesses }) => earnRewards('wordle', { win: won, gems: wordleGems(won, guesses) }) });
function openWordle() {
  show('wordle');
  katWordle.start();
}
$('btn-wordle-back').addEventListener('click', openPlayables);
$('btn-kw-exit').addEventListener('click', openPlayables);
$('btn-kw-again').addEventListener('click', () => katWordle.start());
$('btn-wordle-new').addEventListener('click', async () => {
  if (await askConfirm('Start again with a new word?')) katWordle.start();
});

// Kat Kart
const katKart = createKatKart({
  mute: $('btn-kart-mute'),
  canvas: $('kart-canvas'),
  minimap: $('kart-minimap'),
  place: $('kart-place'),
  lap: $('kart-lap'),
  time: $('kart-time'),
  board: $('kart-board'),
  countdown: $('kart-countdown'),
  finish: $('kart-finish'),
  podium: $('kart-podium'),
  nowPlaying: $('kart-now-playing'),
  item: $('kart-item'),
  alert: $('kart-alert'),
  onFinish: showPodium,
});
const KART_LEVEL = 'koolkat.katKart.level';
const KART_COLORS = KART_RACERS.map((r) => r.color);
const kartLevel = () => Math.max(1, Number(readJson(KART_LEVEL)) || 1);
const kartOnline = { code: null, room: null, timer: null, mode: 'solo' };

/**
 * Racing sideways. The installed app stays upright (portrait), and Android
 * only lets a web app turn the screen when it's full screen, so: full screen,
 * then lock to landscape. This has to start from a tap (Solo, Make a race,
 * Join, Race again or the 🔄 button). Leaving Kat Kart puts everything back.
 */
const KART_LANDSCAPE_KEY = 'koolkat.katKart.landscape';
const kartLandscapeWanted = () => {
  try {
    return localStorage.getItem(KART_LANDSCAPE_KEY) === '1';
  } catch {
    return false;
  }
};
let kartSideways = false;
async function kartLandscape(on) {
  if (on) {
    kartSideways = true;
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    } catch {
      // Some browsers don't do full screen; try the lock anyway.
    }
    try {
      await screen.orientation?.lock?.('landscape');
    } catch {
      if (kartSideways && state.screen === 'kart') toast('📱 Turn your phone sideways to race in landscape');
    }
  } else {
    kartSideways = false;
    try {
      screen.orientation?.unlock?.();
    } catch {
      // Nothing was locked.
    }
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
  $('btn-kart-rotate').classList.toggle('on', kartSideways);
}
$('kart-landscape').checked = kartLandscapeWanted();
$('kart-landscape').addEventListener('change', (e) => {
  try {
    localStorage.setItem(KART_LANDSCAPE_KEY, e.target.checked ? '1' : '0');
  } catch {
    // Remembering it is only a convenience.
  }
});
// Tapping Solo, Make a race, Join or Race again: go sideways first, if that's what you picked.
for (const id of ['btn-kart-solo', 'btn-kart-create', 'btn-kart-join', 'btn-kart-again']) {
  $(id).addEventListener('click', () => kartLandscapeWanted() && !kartSideways && kartLandscape(true));
}
$('btn-kart-rotate').addEventListener('click', () => {
  const on = !kartSideways;
  kartLandscape(on);
  $('kart-landscape').checked = on;
  try {
    localStorage.setItem(KART_LANDSCAPE_KEY, on ? '1' : '0');
  } catch {
    // Remembering it is only a convenience.
  }
});
// Full screen ended some other way (the back gesture): not sideways any more.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && kartSideways) {
    kartSideways = false;
    try {
      screen.orientation?.unlock?.();
    } catch {
      // Nothing was locked.
    }
    $('btn-kart-rotate').classList.remove('on');
  }
});

function openKart(opts) {
  // One thing at a time: the race has its own music.
  if (!audioEl.paused) audioEl.pause();
  kartOnline.mode = opts.mode;
  show('kart');
  $('kart-podium').hidden = true;
  $('btn-kart-again').textContent = opts.mode === 'online' ? 'Race again' : 'Race again';
  katKart.start(opts).catch((err) => toast(err.message, { error: true }));
}
$('btn-kart-quit').addEventListener('click', async () => {
  if (!await askConfirm('Quit the race?')) return;
  leaveKartRoom();
  openPlayables();
});
// B on a controller asks too (A = yes, B = no).
$('btn-kart-quit').addEventListener('gamepad-quit', () => $('btn-kart-quit').click());
$('btn-kart-exit').addEventListener('click', () => {
  leaveKartRoom();
  openPlayables();
});
$('btn-kart-again').addEventListener('click', () => {
  katKart.unlockAudio();
  if (kartOnline.mode === 'online') {
    leaveKartRoom();
    openPlayables();
    openKartMenu();
  } else openKart(soloKartOpts());
});

// ---------- the Kat Kart menu: solo, or race friends with a code ----------
// Race music: the map's own song (the default), Random, or a song from the Kat
// Kart OST. Solo you pick; online the host does. (A new key, so everyone starts
// on the map's song.)
const KART_SONG_KEY = 'koolkat.katKart.music';
for (const select of [$('kart-song-solo'), $('kart-song-online')]) {
  select.replaceChildren(
    el('option', { value: 'map', text: "🗺️ The map's song" }),
    el('option', { value: 'random', text: '🔀 Random' }),
    el('option', { value: 'none', text: '🔇 No song' }),
    ...RACE_SONGS.map((song) => el('option', { value: song.id, text: `${song.title} · ${song.artist}` }))
  );
}
try {
  $('kart-song-solo').value = localStorage.getItem(KART_SONG_KEY) || 'map';
} catch {
  // The map's song it is.
}
if (!$('kart-song-solo').value) $('kart-song-solo').value = 'map';
$('kart-song-solo').addEventListener('change', (e) => {
  try {
    localStorage.setItem(KART_SONG_KEY, e.target.value);
  } catch {
    // Remembering it is only a convenience.
  }
});
// The map: Random, or one of the tracks. Solo you pick; online the host does.
const KART_MAP_KEY = 'koolkat.katKart.map';
for (const select of [$('kart-map-solo'), $('kart-map-online')]) {
  select.replaceChildren(
    el('option', { value: 'random', text: '🔀 Random' }),
    ...KART_MAPS.map((map) => el('option', { value: map.id, text: `${map.emoji} ${map.name}` }))
  );
}
try {
  $('kart-map-solo').value = localStorage.getItem(KART_MAP_KEY) || 'random';
} catch {
  // Random it is.
}
if (!$('kart-map-solo').value) $('kart-map-solo').value = 'random';
$('kart-map-solo').addEventListener('change', (e) => {
  try {
    localStorage.setItem(KART_MAP_KEY, e.target.value);
  } catch {
    // Remembering it is only a convenience.
  }
});
$('kart-map-online').addEventListener('change', async (e) => {
  try {
    const { room } = await api('POST', `/kart/rooms/${kartOnline.code}/map`, { map: e.target.value });
    renderLobby(room);
  } catch (err) {
    toast(err.message, { error: true });
  }
});
/** A solo race with the picked map (Random: any of them) and music. */
function soloKartOpts() {
  const picked = $('kart-map-solo').value;
  const map = KART_MAPS.some((m) => m.id === picked) ? picked : KART_MAPS[Math.floor(Math.random() * KART_MAPS.length)].id;
  return { mode: 'solo', level: kartLevel(), song: $('kart-song-solo').value, map };
}
$('kart-song-online').addEventListener('change', async (e) => {
  try {
    const { room } = await api('POST', `/kart/rooms/${kartOnline.code}/song`, { song: e.target.value });
    renderLobby(room);
  } catch (err) {
    toast(err.message, { error: true });
  }
});

function openKartMenu() {
  katKart.unlockAudio(); // this tap lets the race music play later
  $('kart-level').textContent = `Level ${kartLevel()}`;
  $('kart-menu-main').hidden = false;
  $('kart-lobby').hidden = true;
  $('kart-code').value = '';
  $('dialog-kart').showModal();
}
$('btn-kart-close').addEventListener('click', () => $('dialog-kart').close());
$('btn-kart-solo').addEventListener('click', () => {
  $('dialog-kart').close();
  openKart(soloKartOpts());
});
$('btn-kart-create').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const { room } = await api('POST', '/kart/rooms');
    enterLobby(room);
  })
);
const joinKart = () =>
  withBusy($('btn-kart-join'), async () => {
    const code = $('kart-code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) throw new Error('Race codes are 4 letters');
    const { room } = await api('POST', `/kart/rooms/${code}/join`);
    enterLobby(room);
  });
$('btn-kart-join').addEventListener('click', joinKart);
$('kart-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    joinKart();
  }
});

function enterLobby(room) {
  kartOnline.code = room.code;
  $('kart-menu-main').hidden = true;
  $('kart-lobby').hidden = false;
  renderLobby(room);
  clearInterval(kartOnline.timer);
  kartOnline.timer = setInterval(async () => {
    try {
      const { room: r } = await api('GET', `/kart/rooms/${kartOnline.code}`);
      renderLobby(r);
    } catch (err) {
      clearInterval(kartOnline.timer);
      toast(err.message, { error: true });
      $('dialog-kart').close();
    }
  }, 1000);
}

function renderLobby(room) {
  kartOnline.room = room;
  $('kart-lobby-code').textContent = room.code;
  const players = room.players.filter((p) => !p.gone);
  $('kart-lobby-players').replaceChildren(
    ...players.map((p) => {
      const dot = el('span', { class: 'kk-dot' });
      dot.style.background = KART_COLORS[p.slot];
      return el(
        'li',
        {},
        dot,
        avatar(p.user, 'small'),
        el('span', { text: p.id === state.me.userId ? `${p.name} (you)` : p.name }),
        p.id === room.hostId ? el('span', { class: 'fineprint', text: ' · host' }) : null
      );
    })
  );
  const host = room.hostId === state.me.userId;
  // The host picks the music; everyone else sees what it'll be.
  const songSelect = $('kart-song-online');
  songSelect.disabled = !host;
  if (document.activeElement !== songSelect) songSelect.value = room.song ?? 'map';
  $('kart-song-note').textContent = host ? '(you pick)' : '(the host picks)';
  const mapSelect = $('kart-map-online');
  mapSelect.disabled = !host;
  if (document.activeElement !== mapSelect) mapSelect.value = room.map ?? 'random';
  $('kart-map-note').textContent = host ? '(you pick)' : '(the host picks)';
  $('btn-kart-start').hidden = !host;
  $('btn-kart-start').disabled = players.length < 2;
  $('kart-lobby-status').textContent =
    players.length < 2 ? 'Waiting for friends to join with the code… (up to 8 racers)' : host ? `${players.length} racers ready. Start when everyone's in!` : 'Waiting for the host to start…';
  if (room.state === 'racing') startOnlineRace(room);
}

function startOnlineRace(room) {
  clearInterval(kartOnline.timer);
  kartOnline.racing = true;
  $('dialog-kart').close();
  const me = room.players.find((p) => p.id === state.me.userId);
  const code = room.code;
  openKart({
    mode: 'online',
    mySlot: me.slot,
    players: room.players.filter((p) => !p.gone).map((p) => ({ slot: p.slot, name: p.name })),
    startAt: performance.now() + (room.startAt - room.serverNow),
    song: room.song,
    map: room.map,
    sync: (st) => api('POST', `/kart/rooms/${code}/state`, st, { timeout: 4000 }).then((r) => r.room),
  });
}

$('btn-kart-start').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const { room } = await api('POST', `/kart/rooms/${kartOnline.code}/start`);
    renderLobby(room);
  })
);
$('btn-kart-leave').addEventListener('click', () => {
  leaveKartRoom();
  $('dialog-kart').close();
});
$('btn-kart-share').addEventListener('click', async () => {
  const text = `Race me in Kat Kart on KoolKat! Open Playables → Kat Kart and join with code ${kartOnline.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Kat Kart', text, url: `${location.origin}/#playables` });
    else {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    }
  } catch {
    // Share sheet closed.
  }
});
$('dialog-kart').addEventListener('close', () => {
  // Closed the lobby without starting: leave the race.
  if (!kartOnline.racing) leaveKartRoom();
  // (And if it went sideways for the race that didn't happen, put it back.)
  setTimeout(() => {
    if (kartSideways && state.screen !== 'kart') kartLandscape(false);
  }, 0);
});

function leaveKartRoom() {
  clearInterval(kartOnline.timer);
  kartOnline.racing = false;
  if (!kartOnline.code) return;
  api('POST', `/kart/rooms/${kartOnline.code}/leave`).catch(() => {});
  kartOnline.code = null;
}

/** The podium: 2nd, 1st and 3rd on their steps, then everyone's times. */
function showPodium(results, info = {}) {
  const me = results.find((r) => r.player);
  if (info.mode === 'solo') earnRewards('kart', { win: me?.place === 1, gems: placeGems(me?.place ?? results.length, results.length) });
  else if (info.mode === 'online') checkBolts();
  // Solo: the bots adapt. Win and they get faster; lose and they get easier.
  const levelLine = $('podium-level');
  levelLine.hidden = info.mode !== 'solo';
  if (info.mode === 'solo') {
    const before = info.level;
    const after = me.place === 1 ? before + 1 : Math.max(1, before - 1);
    try {
      localStorage.setItem(KART_LEVEL, JSON.stringify(after));
    } catch {
      // Just for fun.
    }
    levelLine.textContent =
      after > before
        ? `🤖 You beat the bots! They're now level ${after} (faster).`
        : after < before
          ? `🤖 The bots won. They're now level ${after} (easier).`
          : `🤖 The bots won, but they're already on level 1 (easiest).`;
  }
  $('podium-title').textContent = me.place === 1 ? '🏆 You won!' : me.place <= 3 ? `🎉 You came ${ordinalPlace(me.place)}!` : `You came ${ordinalPlace(me.place)}`;
  const step = (r) =>
    el(
      'div',
      { class: `podium-spot p${r.place}${r.player ? ' me' : ''}` },
      el('img', { src: r.sprite, alt: '', class: 'podium-kart' }),
      el('span', { class: 'podium-name', text: r.player ? 'You' : r.name }),
      el('div', { class: 'podium-step' }, el('span', { text: String(r.place) }))
    );
  $('podium').replaceChildren(...[results[1], results[0], results[2]].filter(Boolean).map(step));
  $('podium-list').replaceChildren(
    ...results.map((r) => {
      const dot = el('span', { class: 'kk-dot' });
      dot.style.background = r.color;
      return el(
        'li',
        { class: r.player ? 'me' : '' },
        el('span', { class: 'podium-list-place', text: ordinalPlace(r.place) }),
        dot,
        el('span', { class: 'podium-list-name', text: r.player ? 'You' : r.name }),
        el('span', { class: 'podium-list-time', text: r.time != null ? formatRaceTime(r.time) : '—' })
      );
    })
  );
  $('kart-podium').hidden = false;
  focusFirst();
  const best = readJson(KART_BEST);
  if (info.mode === 'solo' && me.time != null && (!best || me.place < best.place || (me.place === best.place && me.time < best.time))) {
    try {
      localStorage.setItem(KART_BEST, JSON.stringify({ place: me.place, time: me.time }));
    } catch {
      // Just for fun.
    }
  }
}

// Keyboard and controller navigation in every menu (see input.js). While a
// Kat Kart race is on, the arrows / D-pad steer instead.
initInput({ busy: () => !document.querySelector('dialog[open]') && ((state.screen === 'kart' && katKart.running && $('kart-podium').hidden) || (state.screen === 'escape' && katEscape.running) || (state.screen === 'invaders' && katInvaders.running) || (state.screen === 'survival' && katSurvival.running)) });

// Keyboards: typing in Kat Wordle, arrow keys in Kat Kart, Space for a photo.
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || e.target.closest?.('input, textarea')) return;
  if (state.screen === 'camera' && (e.key === ' ' || e.key === 'Enter') && !e.target.closest?.('button')) {
    e.preventDefault();
    $('btn-shutter').click();
    return;
  }
  if (state.screen === 'wordle') katWordle.onKey(e);
  else if (state.screen === 'kart') katKart.keyDown(e);
  else if (state.screen === 'escape' && katEscape.running) katEscape.keyDown(e);
  else if (state.screen === 'invaders' && katInvaders.running) katInvaders.keyDown(e);
  else if (state.screen === 'survival' && katSurvival.running) katSurvival.keyDown(e);
  else if (state.screen === 'book') books.keyDown(e);
  else if (state.screen === 'circles' && !$('cc-picks').hidden && /^[1-4 ]$/.test(e.key) && !e.target.closest?.('button, input, select, textarea')) {
    // 1-4 picks that circle; Space takes the first one you can.
    e.preventDefault();
    const picks = [...$('cc-pick-list').querySelectorAll('.cc-pick')];
    (e.key === ' ' ? picks.find((b) => !b.disabled) : picks[Number(e.key) - 1])?.click();
  }
});
document.addEventListener('keyup', (e) => {
  if (state.screen === 'kart') katKart.keyUp(e);
  if (state.screen === 'invaders') katInvaders.keyUp(e);
  if (state.screen === 'survival') katSurvival.keyUp(e);
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

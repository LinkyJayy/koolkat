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
  decryptSnap,
  deriveKeysFromPassword,
  encryptSnap,
  fingerprint,
  unlockIdentity,
} from './crypto.js';

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

const avatar = (user, cls = '') =>
  el('span', { class: `avatar ${cls}`, text: (user.displayName || user.username || '?').trim()[0] });

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
    title: streak.expiring ? 'Snap each other today to keep your streak!' : `${streak.count} day streak`,
    text: `🔥 ${streak.count}`,
  });
}

// ---------- screens ----------
function show(name) {
  if (state.screen === 'camera' && name !== 'camera') stopCamera();
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== `screen-${name}`;
  state.screen = name;
  if (name === 'camera') startCamera();
}

document.addEventListener('click', (e) => {
  const back = e.target.closest('[data-back]');
  if (back) show(back.dataset.back);
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
  setToken(null);
  clearIdentity();
  clearInterval(state.pollTimer);
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
  $('my-avatar').textContent = (state.me.displayName || state.me.username)[0];
  show('camera');
  refresh();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 10000);
  resyncPush();
  // Opened from a notification: jump to what it was about.
  const view = location.hash.slice(1);
  if (view) {
    history.replaceState(null, '', location.pathname + location.search);
    openView(view);
  }
}

function openView(view) {
  if (!state.me) return;
  if (view === 'inbox') openInbox();
  else if (view === 'friends') openFriends();
  else if (state.screen !== 'camera') show('camera');
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
  state.inbox = (await api('GET', '/snaps/inbox')).snaps;
  const unopened = state.inbox.filter((s) => !s.opened).length;
  const badge = $('badge-inbox');
  badge.hidden = unopened === 0;
  badge.textContent = unopened;
}

async function refresh() {
  try {
    await Promise.all([refreshFriends(), refreshInbox()]);
    if (state.screen === 'friends') {
      renderFriends();
      if ($('search-input').value.trim()) runSearch();
    }
    if (state.screen === 'inbox' && state.inboxTab === 'received') renderInbox();
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

}

function releaseCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  $('camera-video').srcObject = null;
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

$('btn-shutter').addEventListener('click', () => {
  const video = $('camera-video');
  if (!state.stream || !video.videoWidth) {
    toast('The camera is not ready yet', { error: true });
    return;
  }
  const MAX = 1440;
  const scale = Math.min(1, MAX / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (state.facing === 'user') {
    // Save selfies the way they looked in the preview.
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, width, height);
  canvas.toBlob(
    (blob) => {
      if (!blob) return toast('Could not take the photo', { error: true });
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
  $('caption-input').focus();
}

$('preview-frame').addEventListener('click', (e) => {
  if (e.target.closest('#caption-bar')) return;
  const rect = e.currentTarget.getBoundingClientRect();
  editCaption((e.clientY - rect.top) / rect.height);
});
$('btn-caption').addEventListener('click', () => editCaption());
$('caption-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
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
            el('div', { class: 'item-title', text: f.displayName }),
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
    const payload = await encryptSnap(image, { caption, captionY: state.caption.y, mime: 'image/jpeg' }, recipients);
    button.textContent = 'Sending…';
    await api('POST', '/snaps', payload);
    toast(recipients.length === 1 ? 'Snap sent!' : `Snap sent to ${recipients.length} friends!`);
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

function renderInbox() {
  const empty = $('inbox-empty');
  $('inbox-empty-text').textContent = 'No snaps yet. When friends send you snaps, they show up here.';
  empty.hidden = state.inbox.length > 0;
  $('inbox-list').replaceChildren(
    ...state.inbox.map((s) =>
      el(
        'li',
        {},
        el(
          'button',
          { type: 'button', class: 'item', disabled: s.opened, onclick: () => openSnap(s) },
          avatar(s.from),
          el(
            'span',
            { class: 'item-main' },
            el('div', { class: 'item-title', text: s.from.displayName }),
            el(
              'div',
              { class: `item-sub${s.opened ? '' : ' new'}` },
              el('span', { class: `snap-icon${s.opened ? '' : ' new'}` }),
              s.opened ? `Opened · ${timeAgo(s.openedAt)}` : `New Snap · ${timeAgo(s.createdAt)}`
            )
          ),
          streakBadge(state.friends.find((f) => f.id === s.from.id)?.streak)
        )
      )
    )
  );
}

function renderSent(snaps) {
  const empty = $('inbox-empty');
  $('inbox-empty-text').textContent = "You haven't sent any snaps yet.";
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
          'div',
          { class: 'item' },
          el('span', { class: `snap-icon sent${opened === s.recipients.length ? ' opened' : ''}` }),
          el(
            'span',
            { class: 'item-main' },
            el('div', { class: 'item-title', text: `To ${s.recipients.map((r) => r.displayName).join(', ')}` }),
            el('div', { class: 'item-sub', text: `${status} · ${timeAgo(s.createdAt)}` })
          )
        )
      );
    })
  );
}

// ---------- viewer ----------
let viewer = null;

async function openSnap(summary) {
  try {
    const snap = await api('GET', `/snaps/${encodeURIComponent(summary.id)}`);
    const opened = await decryptSnap(snap, state.me.privateKey, state.me.userId);
    const url = URL.createObjectURL(new Blob([opened.imageBytes], { type: opened.mime }));
    const img = $('viewer-img');
    img.src = url;
    await img.decode();

    $('viewer-from').textContent = snap.from.displayName;
    $('viewer-time').textContent = timeAgo(snap.createdAt);
    const cap = $('viewer-caption');
    cap.textContent = opened.caption;
    cap.hidden = !opened.caption;
    placeCaption(cap, opened.captionY);

    show('viewer');
    fitFrame($('viewer-frame'), img.naturalWidth, img.naturalHeight);
    viewer = { url, remaining: 10, timer: null, size: [img.naturalWidth, img.naturalHeight] };
    $('viewer-timer').textContent = viewer.remaining;
    viewer.timer = setInterval(() => {
      viewer.remaining -= 1;
      $('viewer-timer').textContent = viewer.remaining;
      if (viewer.remaining <= 0) closeSnap();
    }, 1000);

    summary.opened = true;
    summary.openedAt = Date.now();
    api('POST', `/snaps/${encodeURIComponent(summary.id)}/viewed`).catch(() => {});
  } catch (err) {
    if (err.status === 410 || err.status === 404) summary.opened = true;
    toast(err.name === 'OperationError' ? "This snap couldn't be decrypted." : err.message, { error: true });
    renderInbox();
  }
}

function closeSnap() {
  if (!viewer) return;
  clearInterval(viewer.timer);
  URL.revokeObjectURL(viewer.url);
  $('viewer-img').removeAttribute('src');
  viewer = null;
  show('inbox');
  loadInbox();
}
$('screen-viewer').addEventListener('click', closeSnap);

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
        el('div', { class: 'item-title', text: user.displayName }),
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
  $('friends-list').replaceChildren(
    ...state.friends.map((f) => {
      let sub = `@${f.username}`;
      if (f.streak.count > 0 && f.streak.youNeedToSnap) sub = 'Snap them today to keep your streak!';
      else if (f.streak.count > 0 && f.streak.theyNeedToSnap) sub = `Waiting for ${f.displayName} to snap back`;
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
            el('div', { class: 'item-title', text: f.displayName }),
            el('div', { class: 'item-sub', text: sub })
          ),
          streakBadge(f.streak)
        )
      );
    })
  );

  $('outgoing-title').hidden = state.outgoing.length === 0;
  $('outgoing-list').replaceChildren(
    ...state.outgoing.map((u) => userRow(u, `@${u.username} · pending`, actionButton('Cancel', () => removeFriend(u), '')))
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
  $('friend-avatar').textContent = friend.displayName[0];
  $('friend-name').textContent = friend.displayName;
  $('friend-username').textContent = `@${friend.username}`;
  $('friend-streak').textContent =
    friend.streak.count > 0 ? `🔥 ${friend.streak.count} day streak${friend.streak.expiring ? ' ⌛' : ''}` : 'No streak yet. Snap each other every day to start one!';
  $('friend-fingerprint').textContent = await fingerprint(friend.publicKey);
  dialog.returnValue = '';
  dialog.onclose = () => {
    if (dialog.returnValue === 'remove' && confirm(`Remove ${friend.displayName} as a friend? Your streak will be lost.`)) {
      removeFriend(friend, `Removed ${friend.displayName}`).catch((err) => toast(err.message, { error: true }));
    }
  };
  dialog.showModal();
}

// ---------- profile ----------
$('btn-profile').addEventListener('click', async () => {
  const dialog = $('dialog-profile');
  $('profile-avatar').textContent = (state.me.displayName || state.me.username)[0];
  $('profile-name').textContent = state.me.displayName;
  $('profile-username').textContent = `@${state.me.username}`;
  $('profile-fingerprint').textContent = await fingerprint(state.me.publicKey);
  renderNotifyRow();
  renderCameraInfo();
  api('GET', '/health')
    .then((h) => ($('app-version').textContent = `· version ${h.version}`))
    .catch(() => {});
  dialog.returnValue = '';
  dialog.onclose = () => {
    if (dialog.returnValue === 'logout') logout();
  };
  dialog.showModal();
});

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
    status.textContent = 'Snaps, friend requests and streak reminders';
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

// ---------- boot ----------
async function boot() {
  setAuthMode('login');
  $('auth-config-warning').hidden = Boolean(API_BASE) || !location.hostname.endsWith('.github.io');
  window.__koolkatBootStep = 'service worker';
  await registerServiceWorker((msg) => {
    if (msg.type === 'refresh' && state.me) refresh();
    if (msg.type === 'open') openView(msg.view);
  });
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

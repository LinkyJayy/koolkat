import { api, getToken, setToken, setUnauthorizedHandler } from './api.js';
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

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const username = form.username.value.trim();
  const password = form.password.value;
  const submit = $('auth-submit');
  const errorBox = $('auth-error');
  errorBox.textContent = '';

  if (authMode === 'register' && password !== form.confirm.value) {
    errorBox.textContent = "Passwords don't match";
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
async function startCamera() {
  const video = $('camera-video');
  const message = $('camera-message');
  message.hidden = true;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('camera-message-text').textContent =
      'The camera only works over HTTPS (or on localhost). Open KoolKat from a secure address.';
    message.hidden = false;
    return;
  }
  stopCamera();
  const facing = state.facing;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1920 } },
    });
    // The user may have left the camera (or flipped again) while we waited.
    if (state.screen !== 'camera' || state.facing !== facing) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    state.stream = stream;
    video.srcObject = stream;
    video.classList.toggle('mirrored', facing === 'user');
  } catch (err) {
    const reasons = {
      NotAllowedError: 'KoolKat needs camera access. Allow it in your browser settings, then try again.',
      NotFoundError: 'No camera was found on this device.',
      NotReadableError: 'Your camera is being used by another app.',
    };
    $('camera-message-text').textContent = reasons[err.name] || `Couldn't start the camera (${err.message}).`;
    message.hidden = false;
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  $('camera-video').srcObject = null;
}

$('camera-retry').addEventListener('click', startCamera);
$('btn-flip').addEventListener('click', () => {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  startCamera();
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
$('btn-inbox').addEventListener('click', () => {
  show('inbox');
  loadInbox();
});
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
$('btn-friends').addEventListener('click', () => {
  $('search-input').value = '';
  $('search-results').replaceChildren();
  show('friends');
  renderFriends();
  refreshFriends().then(renderFriends).catch((err) => toast(err.message, { error: true }));
});

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
  dialog.returnValue = '';
  dialog.onclose = () => {
    if (dialog.returnValue === 'logout') logout();
  };
  dialog.showModal();
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
  const identity = await loadIdentity();
  if (getToken() && identity) {
    try {
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

boot();

import { api } from './api.js';

// Web Push support. Notifications only contain who sent something, never the
// snap itself (that stays end-to-end encrypted).

let registration = null;

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** iPhone/iPad Safari only allows push for apps added to the Home Screen. */
export function needsHomeScreenInstall() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && !navigator.standalone && !pushSupported();
}

export async function registerServiceWorker(onMessage) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    registration = await navigator.serviceWorker.register('sw.js');
    navigator.serviceWorker.addEventListener('message', (e) => onMessage?.(e.data || {}));
  } catch (err) {
    console.warn('Service worker registration failed', err);
    registration = null;
  }
  return registration;
}

async function ready() {
  if (!registration) throw new Error('Notifications are not available in this browser.');
  return navigator.serviceWorker.ready;
}

function keyToBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** 'on' | 'off' | 'blocked' | 'unsupported' */
export async function pushState() {
  if (!pushSupported() || !registration) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await ready();
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

/** Ask for permission (must be called from a tap) and subscribe this device. */
export async function enablePush() {
  if (!pushSupported()) throw new Error('This browser does not support notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? 'Notifications are blocked. Allow them in your browser settings.' : 'Notifications were not turned on.');
  }
  const reg = await ready();
  const { publicKey } = await api('GET', '/push/key');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for a different server key can't be reused.
  if (sub && sub.options?.applicationServerKey) {
    const current = new Uint8Array(sub.options.applicationServerKey);
    const wanted = keyToBytes(publicKey);
    if (current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
    } catch {
      throw new Error(
        "This browser couldn't set up notifications. In Brave, turn on “Use Google services for push messaging” in Settings → Privacy."
      );
    }
  }
  await api('POST', '/push/subscribe', sub.toJSON());
}

export async function disablePush() {
  if (!registration) return;
  const reg = await ready();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// Remembers if the user switched notifications off in KoolKat on this device,
// so they aren't silently turned back on at the next sign-in.
const PREF_KEY = 'koolkat.push';
export function setPushPreference(on) {
  try {
    if (on) localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, 'off');
  } catch {
    /* storage blocked */
  }
}
export function pushPreferenceOff() {
  try {
    return localStorage.getItem(PREF_KEY) === 'off';
  } catch {
    return false;
  }
}

/** After sign-in: if this device already allows notifications, make sure the server has it. */
export async function resyncPush() {
  if (!pushSupported() || !registration || Notification.permission !== 'granted' || pushPreferenceOff()) return;
  try {
    await enablePush();
  } catch {
    /* not fatal */
  }
}

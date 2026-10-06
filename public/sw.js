// KoolKat service worker:
//  - keeps the app's files on the device so KoolKat opens instantly and works
//    offline (the API is never cached; Klicks and messages stay end-to-end
//    encrypted and are only fetched live),
//  - installs new versions in the background and lets the page offer a reload,
//  - shows push notifications and opens the right screen when one is tapped.

// Replaced by the server with a hash of the app's files, so every deploy
// becomes a new version (GitHub Pages builds substitute the commit id).
const VERSION = '__KOOLKAT_VERSION__';
const CACHE = `koolkat-${VERSION}`;

// The app shell. Paths are relative to the service worker's scope.
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js',
  'js/api.js',
  'js/boot-check.js',
  'js/config.js',
  'js/crypto.js',
  'js/keystore.js',
  'js/push.js',
  'js/qr.js',
  'js/katcam.js',
  'js/theme.js',
  'vendor/qrcode.mjs',
  'vendor/jsQR.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'icons/logo.png',
  'icons/kool-badge.png',
  'icons/bff-heart.png',
  'icons/icon-32.png',
  'icons/icon-64.png',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const scoped = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE.map((path) => new Request(scoped(path), { cache: 'reload' })));
      // The very first install takes over right away; later versions wait
      // until the page says it's a good moment to reload.
      if (!self.registration.active) await self.skipWaiting();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('koolkat-') && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  // Live data and the worker itself always come from the network.
  if (path.startsWith('api/') || path === 'sw.js') return;

  // The manifest can change with the chosen app icon, so fetch it fresh when online.
  if (path === 'manifest.webmanifest') {
    event.respondWith(fetch(request).catch(async () => (await caches.open(CACHE)).match(scoped('manifest.webmanifest'))));
    return;
  }

  if (request.mode === 'navigate') {
    // Pages: try the network first (fresh), fall back to the saved app shell offline.
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match(scoped('./'))) || (await cache.match(scoped('index.html'))) || Response.error();
        }
      })()
    );
    return;
  }

  // Files: from the saved copy of this version, otherwise the network (and save it).
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') cache.put(request, response.clone());
      return response;
    })()
  );
});

const VIEWS = ['inbox', 'friends', 'camera', 'chats', 'news'];
const appUrl = (view) => new URL(VIEWS.includes(view) ? `./#${view}` : './', self.registration.scope).href;

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title || 'KoolKat', {
        body: data.body || 'You have something new on KoolKat',
        tag: data.tag,
        renotify: Boolean(data.tag),
        icon: new URL('icons/icon-192.png', self.registration.scope).href,
        badge: new URL('icons/icon-64.png', self.registration.scope).href,
        data: { view: data.view },
      });
      // Let open tabs refresh their inbox and friend list straight away.
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const client of windows) client.postMessage({ type: 'refresh' });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const view = event.notification.data?.view;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((c) => c.url.startsWith(self.registration.scope));
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'open', view });
      } else {
        await self.clients.openWindow(appUrl(view));
      }
    })()
  );
});

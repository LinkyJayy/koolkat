// KoolKat service worker: shows push notifications and opens the app when one
// is tapped. It deliberately does no caching, so updates show up right away.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const VIEWS = ['inbox', 'friends', 'camera'];
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

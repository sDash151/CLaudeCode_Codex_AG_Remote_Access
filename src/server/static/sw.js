/* Service worker.
 *
 * Deliberately does NOT cache application shell or API responses. A stale
 * approval list on a security surface is worse than a slow one, and a cached
 * pending request could invite a tap on something already resolved.
 * Its only jobs are: exist (so Web Push can be registered), show notifications,
 * and focus the app when one is tapped.
 */
'use strict';

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Approval needed', body: 'An agent is waiting for a decision.' };
  }

  const title = data.title || 'Approval needed';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      // Tag by request id so repeated pushes for one request collapse.
      tag: data.tag || 'agw',
      renotify: true,
      requireInteraction: data.risk === 'HIGH',
      data: { url: data.url || '/' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) {
          await c.focus();
          if ('navigate' in c) {
            try {
              await c.navigate(target);
            } catch {
              /* navigation blocked; the focused window is enough */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});

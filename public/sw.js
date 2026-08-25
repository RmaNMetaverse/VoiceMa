/**
 * Offline shell for the PWA.
 *
 * Deliberately conservative: signalling, the API and the certificate download
 * always go to the network. Only the static shell is cached, so a stale cache
 * can never desync a live call.
 */
const VERSION = 'voicema-v1';
const SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/audio.js',
  '/js/net.js',
  '/js/rtc.js',
  '/js/ui.js',
  '/js/store.js',
  '/js/keepalive.js',
  '/js/vad-processor.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // addAll is atomic; one missing file would poison the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api')) return;
  if (url.pathname.endsWith('.crt')) return;

  // Navigations: fresh when possible, shell when the server is unreachable.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((c) => c.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html').then((r) => r ?? Response.error()))
    );
    return;
  }

  // Assets: serve from cache immediately, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((c) => c.put(request, copy));
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/**
 * Tapping a chat notification focuses the app if it is already open rather
 * than launching a second copy — a second copy would mean a second connection
 * and a duplicated voice.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'open-chat' });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

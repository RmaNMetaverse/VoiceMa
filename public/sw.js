/**
 * Offline shell for the PWA.
 *
 * Deliberately conservative: signalling, the API and the certificate download
 * always go to the network. Only the static shell is cached, so a stale cache
 * can never desync a live call.
 */
const VERSION = 'voicema-v3';

// Resolved against the worker's own location, so the same file works whether
// the app is mounted at / or at /VoiceMa/.
const BASE = new URL('./', self.location);
const at = (path) => new URL(path, BASE).toString();

const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/audio.js',
  'js/net.js',
  'js/rtc.js',
  'js/ui.js',
  'js/store.js',
  'js/keepalive.js',
  'js/vad-processor.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png'
].map(at);

const SHELL_DOC = at('index.html');

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
  // Never cache signalling, the API, or the certificate download.
  const rel = url.pathname.startsWith(new URL(BASE).pathname)
    ? url.pathname.slice(new URL(BASE).pathname.length)
    : url.pathname;
  if (rel.startsWith('ws') || rel.startsWith('api')) return;
  if (url.pathname.endsWith('.crt')) return;

  // Navigations: fresh when possible, shell when the server is unreachable.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((c) => c.put(SHELL_DOC, copy));
          return response;
        })
        .catch(() => caches.match(SHELL_DOC).then((r) => r ?? Response.error()))
    );
    return;
  }

  // Assets: network first, cache as the fallback.
  //
  // Cache-first would be the usual choice, but this app is served from a box on
  // the same LAN — the network is never the slow part, and serving a stale
  // script after a deploy is a real cost. The cache exists so the shell still
  // opens when the server is down, not to save milliseconds.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((c) => c.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? Response.error()))
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
  const target = event.notification.data?.url ?? at('./');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(new URL(BASE).href) && 'focus' in client) {
          client.postMessage({ type: 'open-chat' });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

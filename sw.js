/* Klang Service Worker – cached die App-Hülle für 100 % Offline-Start.
   Songs liegen separat in IndexedDB (nicht hier). */
const CACHE = 'klang-shell-v3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './vendor/fflate.js',
  './manifest.webmanifest',
  './icons/icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // nur eigene Dateien

  // Network-first für die App-Dateien, Fallback auf Cache (offline).
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))),
  );
});

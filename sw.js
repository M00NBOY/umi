// Keeps the pages and the engine on the device so the game opens without a
// connection. The game itself is in the page's storage (store-worker.js).
// Pages come from the cache at once and are refreshed behind the reader's
// back, so a new version shows on the visit after it was published.
'use strict';

const CACHE = 'umineko-vb9e4754e5b24';
const FILES = [
  './', 'index.html', 'play.html', 'style.css', 'app.webmanifest', 'icon.png',
  'library.js', 'library.css', 'store.js', 'store-worker.js', 'source.js', 'shell.js',
  'engine/ponscr.js', 'engine/ponscr.wasm',
];

self.addEventListener('install', (event) => {
  // Past the browser's HTTP cache, which may still hold the previous version.
  const requests = FILES.map((file) => new Request(file, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });
    const fresh = fetch(request, { cache: 'no-cache' }).then((response) => {
      if (response.ok) cache.put(request.url.split('?')[0], response.clone());
      return response;
    });
    if (cached) {
      event.waitUntil(fresh.catch(() => {}));
      return cached;
    }
    return fresh;
  })());
});

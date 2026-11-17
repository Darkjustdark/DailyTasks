// Offline cache for DopaminApp. Bump CACHE when you change app files.
const CACHE = 'dopaminapp-v1';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve from cache first (works offline), refresh the cache in the background when online.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const req = e.request.mode === 'navigate' ? './index.html' : e.request;
  e.respondWith(
    caches.open(CACHE).then(cache => cache.match(req).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res && res.ok && new URL(e.request.url).origin === location.origin) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    }))
  );
});

/**
 * LENSAMAS - Progressive Web App Service Worker
 * Memberikan caching cerdas untuk app-shell offline & pemuatan instan pada jaringan lambat.
 */

const CACHE_NAME = 'lensamas-v4';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/assets/favicon.ico',
  '/assets/icon-16.png',
  '/assets/icon-32.png',
  '/assets/icon-48.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/apple-touch-icon.png',
];

// 1. Install & Precache App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.warn('[SW] Precache failed:', err);
      })
  );
});

// 2. Activate & Purge Old Caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.map((name) => {
            if (name !== CACHE_NAME) {
              return caches.delete(name);
            }
            return Promise.resolve();
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

// 3. Fetch Routing Strategy
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Jangan cache WebSocket, API backend, tile cross-origin, stream live go2rtc, atau request non-GET
  if (
    req.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.protocol.startsWith('ws') ||
    /\.(m3u8|m4s|ts|flv)$/i.test(url.pathname) ||
    req.headers.get('range') ||
    req.destination === 'media' ||
    url.hostname.includes('ponorogo.go.id') ||
    url.hostname.includes('google.com')
  ) {
    return;
  }

  // Navigasi HTML: Network-first dengan fallback ke offline cache index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static Assets (CSS, JS, Images, Fonts): Cache-first dengan background revalidation
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch di background untuk update cache secara asinkron
        fetch(req)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, responseClone));
            }
          })
          .catch(() => {});
        return cachedResponse;
      }

      // Jika belum ada di cache, ambil dari network dan simpan
      return fetch(req)
        .then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse;
          }
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, responseClone));
          return networkResponse;
        })
        .catch(() => {
          // Fallback offline bila koneksi terputus total
          if (req.headers.get('accept')?.includes('text/html')) {
            return caches.match('/index.html');
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
    })
  );
});

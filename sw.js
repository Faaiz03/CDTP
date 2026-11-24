const CACHE_NAME = 'ytu-robot-eval-v2.0';

const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './js/state.js',
  './js/homography.js',
  './js/aruco.js',
  './js/vision.js',
  './js/telemetry.js',
  './js/evaluator.js',
  './js/renderer.js',
  './js/app.js'
];

const CDN_ASSETS = [
  'https://cdn.tailwindcss.com/3.4.17',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(LOCAL_ASSETS);
      // Best-effort precache of external CDN scripts for offline lab-day refreshes
      await Promise.allSettled(
        CDN_ASSETS.map(async (url) => {
          try {
            const req = new Request(url, { mode: 'cors' });
            const res = await fetch(req);
            if (res.ok) await cache.put(url, res);
          } catch (_) {
            try {
              const noCorsRes = await fetch(new Request(url, { mode: 'no-cors' }));
              await cache.put(url, noCorsRes);
            } catch (_) {}
          }
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && (response.ok || response.type === 'opaque')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});

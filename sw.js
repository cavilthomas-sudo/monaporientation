// sw.js

// sw.js

const CACHE_VERSION = 'v6'; // <-- NOTEZ LE NOUVEAU NUMÉRO DE VERSION
const CACHE_NAME = `oriantation-cache-${CACHE_VERSION}`;
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/logo.png',
  '/logo_180.png',
  '/logo_badges.png',
  '/manifest.json'
];

self.addEventListener('install', event => {
  console.log(`[SW v${CACHE_VERSION}] Installation...`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log(`[SW v${CACHE_VERSION}] Mise en cache des fichiers de base.`);
        return cache.addAll(URLS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  console.log(`[SW v${CACHE_VERSION}] Activation...`);
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log(`[SW v${CACHE_VERSION}] Ancien cache supprimé :`, cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
        console.log(`[SW v${CACHE_VERSION}] Prêt à prendre le contrôle !`);
        return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', event => {
  const log = msg => console.log(`[SW v${CACHE_VERSION}] Fetch: ${msg}`);
  
  if (event.request.mode === 'navigate') {
    log(`Requête de navigation (Network First) pour ${event.request.url}`);
    event.respondWith(
      fetch(event.request).catch(() => {
        log(`Échec réseau, service depuis le cache : index.html`);
        return caches.match('index.html');
      })
    );
    return;
  }

  log(`Requête d'asset (Cache First) pour ${event.request.url}`);
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request);
      })
  );
});
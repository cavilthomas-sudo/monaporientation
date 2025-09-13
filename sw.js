// 1. LA VARIABLE À CHANGER À CHAQUE MISE À JOUR
const CACHE_VERSION = 'v2';
const CACHE_NAME = `explor-orientation-cache-${CACHE_VERSION}`;
const urlsToCache = [
  '/',
  '/index.html',
  '/logo.png',
  // Assurez-vous d'inclure les bonnes tailles de logo utilisées dans votre index.html et manifest.json
  '/logo_180.png', 
  '/manifest.json'
  // Ajoutez ici tous les autres fichiers importants (CSS, autres scripts, etc.)
];

// Étape d'installation : mise en cache des nouveaux fichiers
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache ouvert et nouveaux fichiers mis en cache');
        return cache.addAll(urlsToCache);
      })
  );
  // Force le nouveau Service Worker à s'activer dès qu'il est installé
  self.skipWaiting();
});

// Étape d'activation : nettoyage des anciens caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // Si le nom d'un cache ne correspond pas au nouveau, on le supprime
          if (cacheName !== CACHE_NAME) {
            console.log('Ancien cache supprimé:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Prend le contrôle de toutes les pages ouvertes immédiatement
      return self.clients.claim();
    })
  );
});

// Étape de fetch : servir le contenu depuis le cache (stratégie "Cache First")
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Si la ressource est dans le cache, on la retourne
        if (response) {
          return response;
        }
        // Sinon, on la récupère sur le réseau
        return fetch(event.request);
      })
  );
});
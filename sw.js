// sw.js

// 1. LA VARIABLE À CHANGER À CHAQUE MISE À JOUR
const CACHE_VERSION = 'v3'; // IMPORTANT : Changez ce numéro de version
const CACHE_NAME = `oriantation-cache-${CACHE_VERSION}`;
const URLS_TO_CACHE = [
  '/',
  'index.html',
  'logo.png',
  'logo_180.png',
  'logo_badges.png', // Ajout du logo manquant
  'manifest.json'
];

// Étape d'installation : mise en cache des fichiers de base
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache ouvert, mise en cache des fichiers de l\'application.');
        return cache.addAll(URLS_TO_CACHE);
      })
      .then(() => self.skipWaiting()) // Force l'activation immédiate du nouveau SW
  );
});

// Étape d'activation : nettoyage des anciens caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Ancien cache supprimé:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim()) // Prend le contrôle de la page immédiatement
  );
});

// Étape de fetch : la nouvelle stratégie hybride
self.addEventListener('fetch', event => {
  // Si la requête est pour une page de navigation (ex: index.html)
  if (event.request.mode === 'navigate') {
    // Stratégie "Network First" : on essaie le réseau d'abord
    event.respondWith(
      fetch(event.request).catch(() => {
        // En cas d'échec (hors ligne), on sert la page depuis le cache
        return caches.match('index.html');
      })
    );
    return;
  }

  // Pour toutes les autres requêtes (images, manifest...), stratégie "Cache First"
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Si la ressource est dans le cache, on la retourne, sinon on la récupère sur le réseau
        return response || fetch(event.request);
      })
  );
});
// sw.js - Version améliorée avec Stale-While-Revalidate

// On incrémente la version pour déclencher la mise à jour
const CACHE_VERSION = 'v96';
const CACHE_NAME = `oriantation-cache-${CACHE_VERSION}`;

// Vos fichiers essentiels restent les mêmes
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/logo.png',
  '/logo_180.png',
  '/logo_badges.png',
  '/manifest.json'
];

// L'étape d'installation ne change pas, elle est déjà très bien
self.addEventListener('install', event => {
  console.log(`[SW ${CACHE_NAME}] Installation...`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log(`[SW ${CACHE_NAME}] Mise en cache de l'App Shell.`);
        return cache.addAll(URLS_TO_CACHE);
      })
      .then(() => self.skipWaiting()) // Force l'activation
  );
});

// L'étape d'activation ne change pas non plus, elle est parfaite
self.addEventListener('activate', event => {
  console.log(`[SW ${CACHE_NAME}] Activation...`);
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log(`[SW ${CACHE_NAME}] Ancien cache supprimé :`, cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim()) // Prend le contrôle
  );
});

// --- C'EST ICI QUE TOUT CHANGE : L'ÉVÉNEMENT FETCH ---
self.addEventListener('fetch', event => {
  const { request } = event;

  // On ignore les requêtes qui ne sont pas des GET (ex: POST vers Firebase)
  // On ignore aussi les requêtes des extensions Chrome, qui peuvent causer des erreurs.
  if (request.method !== 'GET' || request.url.startsWith('chrome-extension://')) {
    return;
  }

  // Stratégie Stale-While-Revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return cache.match(request).then(cachedResponse => {
        
        // 1. On lance la requête réseau en parallèle
        const fetchPromise = fetch(request).then(networkResponse => {
          // Si la requête réussit, on met à jour le cache avec la nouvelle version
          if (networkResponse.ok) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(error => {
          // La requête réseau a échoué, on ne fait rien, l'utilisateur a déjà la version en cache (si elle existe)
          console.warn(`[SW ${CACHE_NAME}] Échec de la requête réseau pour ${request.url}`, error);
        });

        // 2. On retourne la réponse du cache immédiatement si elle existe.
        // Si elle n'existe pas, on attend la réponse du réseau.
        // C'est ce qui rend l'application fonctionnelle hors ligne dès le premier chargement.
        return cachedResponse || fetchPromise;
      });
    })
  );
});

// --- AJOUT POUR LES NOTIFICATIONS PUSH ---
// Le code ci-dessous est ajouté à votre fichier existant.

// Événement 'push' : se déclenche quand le service worker reçoit une notification.
self.addEventListener('push', event => {
  const data = event.data.json();
  const options = {
    body: data.body,
    icon: data.icon || '/logo.png', // Utilise l'icône du payload, ou une par défaut
    badge: '/logo_badges.png',
    data: { // On stocke les données additionnelles ici
        url: data.url || '/' // On récupère l'URL cible
    }
  };
  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Événement 'notificationclick' : se déclenche quand l'utilisateur clique sur la notification.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  // On récupère l'URL stockée et on ouvre la bonne page
  const targetUrl = event.notification.data.url || '/';
  event.waitUntil(
    clients.openWindow(targetUrl)
  );
});

// --- FIN DE L'AJOUT ---
/**
 * @file serviceWorker.js
 *
 * @summary
 * Service Worker de l'application. Intercepte les requêtes GET et les route
 * vers l'une des deux stratégies de cache selon la nature de l'asset.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STRATÉGIES DE CACHE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @strategy Cache First — {@link cacheFirst}
 *   Cible : assets immuables (CSS, JS, fonts, images, SVG).
 *   Pipeline : cache → [miss] → réseau → écriture disque → retour.
 *   Invariant : un asset immuable n'a aucune raison de solliciter le réseau
 *   s'il est déjà présent. Le réseau n'est atteint qu'au premier chargement
 *   ou après invalidation du cache (bump de CACHE_NAME).
 *
 * @strategy Network First — {@link networkFirst}
 *   Cible : navigations et requêtes dynamiques (racine /, HTML).
 *   Pipeline : réseau → écriture disque → retour / [échec] → cache → offline.html.
 *   Invariant : la fraîcheur du contenu prime. Le cache est un fallback dégradé,
 *   pas la source canonique.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARBITRAGES ARCHITECTURAUX NON DÉDUCTIBLES DU CODE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @architectural-decision Cache unique (CACHE_NAME)
 *   Assets statiques et navigations partagent le même cache.
 *   MEDIA_CACHE_NAME est conservé uniquement pour purger les entrées
 *   d'une stratégie Cache First media antérieure (activate → caches.delete).
 *   Il n'est plus alimenté. Supprimer cette constante casserait la purge
 *   sur les navigateurs ayant encore l'ancien cache en mémoire.
 *
 * @architectural-decision Routing via request.destination + fallback regex
 *   request.destination est une propriété native pré-calculée par le moteur
 *   (coût O(1), zéro allocation). Elle couvre les cas canoniques
 *   ('style', 'script', 'font', 'image').
 *   Le fallback regex sur request.url (string native) traite les cas où
 *   destination vaut '' : requêtes fetch() programmatiques, SVG chargés
 *   via <use xlink:href>, workers. Ne pas supprimer ce fallback sans audit
 *   exhaustif des points de chargement SVG dans l'application.
 *   L'alternative new URL(request.url) a été écartée : elle alloue un objet
 *   par requête sur le hot path, augmentant la pression GC.
 *   L'alternative [...].includes() a été écartée pour la même raison
 *   (tableau littéral recréé à chaque appel). Le Set module-level garantit
 *   un lookup O(1) sans allocation par appel.
 *
 * @architectural-decision putInCache fire-and-forget + event.waitUntil()
 *   L'écriture disque est détachée du return response (non bloquante pour
 *   le rendu client), mais attachée au cycle de vie de l'événement fetch
 *   via event.waitUntil(). Sans ce rattachement, le navigateur peut terminer
 *   le processus SW entre la résolution de respondWith() et la fin de
 *   l'écriture, annulant silencieusement la mise en cache.
 *
 * @architectural-decision Debounce de notifyServiceUnavailable (5 000 ms)
 *   En cas de perte réseau, chaque requête en vol échoue simultanément.
 *   Sans garde temporelle, chaque échec déclencherait un postMessage vers
 *   tous les clients, saturant la MessageQueue. Le seuil de 5 s est un
 *   compromis entre réactivité UI et coût CPU ; ajuster selon la densité
 *   de requêtes en vol acceptable dans l'application.
 *
 * @architectural-decision Absence d'exclusion du périmètre /app/
 *   L'exclusion explicite des requêtes '/app/' a été supprimée. L'isolation
 *   est déléguée à la mécanique de scope navigateur : tout enfant de /app/
 *   enregistrant son propre SW (scope /app/enfant/) intercepte ses requêtes
 *   avant que ce SW racine ne soit consulté. Le scope le plus spécifique
 *   gagne, indépendamment de l'ordre d'enregistrement.
 *   Les enfants de /app/ sans SW propre héritent en conséquence des
 *   stratégies de ce fichier, ce qui est le comportement souhaité.
 *   Réintroduire une exclusion URL explicite ne serait justifié que pour
 *   un périmètre devant échapper à toute interception (API, auth token)
 *   indépendamment de la présence d'un SW enfant.
 *
 * @architectural-decision Listener 'message' absent de ce fichier
 *   La manipulation de document.documentElement est interdite dans le scope
 *   SW (pas d'accès au DOM). L'écoute des messages du SW doit être
 *   enregistrée dans le Main Thread via :
 *   navigator.serviceWorker.addEventListener('message', handler)
 */

const CACHE_NAME = 'v110'
const MEDIA_CACHE_NAME = `media-${CACHE_NAME}`
const OFFLINE_URL = '/offline.html'

const resourcesToCache = [
  '/',
  '/styles/main.css',
  '/styles/print.css',
  '/scripts/main.js',
  '/scripts/more.js',
  '/fonts/notoSans-Regular.woff2',
  '/fonts/notoSerif-Regular.woff2',
  '/sprites/util.svg',
  '/sprites/player.svg',
  '/medias/images/logo/logo.svg',
  '/sprites/silos/195v.svg#a',
  '/sprites/various/MonogrammeTULivreDeKellsTEST.svg#a',
  OFFLINE_URL,
]

// Module-level Set : lookup O(1), zéro allocation par appel.
const STATIC_DESTINATIONS = new Set(['style', 'script', 'font', 'image'])

function isStaticAsset(request) {
  // Propriété native pré-calculée — couvre css, js, woff2, images.
  if (STATIC_DESTINATIONS.has(request.destination)) return true
  // Fallback pour destination '' (fetch(), SVG via <use>, etc.) : regex sur string native, sans new URL().
  return /\.(css|js|woff2|svg)$/.test(request.url)
}

// --- Debounce state ---
let lastNotifyTime = 0
const NOTIFY_DEBOUNCE_MS = 5000

// --- I/O helpers ---
async function addResourcesToCache(resources) {
  try {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll(resources)
  } catch (error) {
    console.error(`Erreur cache.addAll: ${error}`)
  }
}

// Retourne sa promesse : permet à event.waitUntil() de contrôler le cycle de vie SW.
function putInCache(request, response) {
  return caches
    .open(CACHE_NAME)
    .then(cache => cache.put(request, response))
    .catch(error => console.error(`Erreur putInCache: ${error}`))
}

async function notifyServiceUnavailable() {
  const now = Date.now()
  if (now - lastNotifyTime < NOTIFY_DEBOUNCE_MS) return
  lastNotifyTime = now
  try {
    const allClients = await clients.matchAll()
    allClients.forEach(client => client.postMessage({ action: 'service-unavailable' }))
  } catch (error) {
    console.error(`Erreur notification: ${error}`)
  }
}

// --- Strategies ---
// Les stratégies reçoivent l'event complet pour attacher l'I/O disque à son cycle de vie.
async function networkFirst(event) {
  const { request } = event

  try {
    const networkResponse = await fetch(request)
    if (networkResponse?.ok) {
      // L'écriture disque est liée au cycle de vie de l'événement : le SW ne sera pas
      // tué avant la résolution de la promesse, sans bloquer le return.
      event.waitUntil(putInCache(request, networkResponse.clone()))
    }
    return networkResponse
  } catch {
    await notifyServiceUnavailable()
    const cache = await caches.open(CACHE_NAME)
    return (await cache.match(request)) ?? cache.match(OFFLINE_URL)
  }
}

async function cacheFirst(event) {
  const { request } = event
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached) return cached

  try {
    const networkResponse = await fetch(request)
    if (networkResponse?.ok) {
      event.waitUntil(putInCache(request, networkResponse.clone()))
    }
    return networkResponse
  } catch {
    return cache.match(OFFLINE_URL)
  }
}

// --- Lifecycle ---
self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(addResourcesToCache(resourcesToCache))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      try {
        const cacheNames = await caches.keys()
        await Promise.all(cacheNames.filter(name => name !== CACHE_NAME && name !== MEDIA_CACHE_NAME).map(name => caches.delete(name)))
        await self.clients.claim()
      } catch (error) {
        console.error(`Erreur activation: ${error}`)
      }
    })(),
  )
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return

  const strategy = isStaticAsset(event.request) ? cacheFirst : networkFirst
  event.respondWith(strategy(event))
})

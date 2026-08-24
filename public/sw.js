const CACHE_NAME = 'tryout-timer-v2'
const OFFLINE_URL = '/offline.html'

const PRECACHE = [
  '/',
  '/dashboard',
  '/collect',
  '/records',
  '/analytics',
  '/login',
  OFFLINE_URL,
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Let the network handle API and Supabase calls without interference
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('supabase')
  ) {
    return
  }

  if (event.request.method !== 'GET') return

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(event.request)
        if (cached) return cached

        // For page navigations with no cache, show the offline fallback
        if (event.request.mode === 'navigate') {
          const offline = await caches.match(OFFLINE_URL)
          if (offline) return offline
        }

        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' })
      })
  )
})

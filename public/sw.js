// The panel's service worker. It makes the panel installable and nothing more:
// it caches nothing and has no fetch handler, so every request, /api/ included,
// goes to the server. A later issue adds `push`.
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

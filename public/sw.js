// The panel's service worker. It makes the panel installable and shows Web Push notifications.
// It caches nothing and has no fetch handler, so every request, /api/ included, goes to the server.
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// A notification per task: the tag makes a second one for the same task replace the first.
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = data.title || 'aifactory'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || 'aifactory',
      icon: '/icon-192.png',
      data: { url: data.url || '/' },
    }),
  )
})

// Focus an open window on the link, or open one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) {
          if ('navigate' in w) w.navigate(url)
          return w.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})

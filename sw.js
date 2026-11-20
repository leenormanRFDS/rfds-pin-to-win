/* Pin to Win offline shell.
   Network first for everything, so a new deploy is picked up on the next load.
   The cache is only a fallback when conference Wi-Fi drops. /api and the admin pages are never cached. */
const CACHE = 'ptw-shell-v130';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/public/app.css?v=130', '/public/tablet.css?v=130',
  '/public/config.js?v=130', '/data/destinations.js?v=130', '/data/rules.js?v=130',
  '/public/app.js?v=130', '/public/conference.js?v=130', '/public/tablet.js?v=130',
  '/public/rfds-logo.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('ptw-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function bypass(url) {
  return url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname.includes('/admin.');
}

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || bypass(url)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(request, copy)); }
      return response;
    } catch {
      const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (cached) return cached;
      if (request.mode === 'navigate') return caches.match('/index.html');
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

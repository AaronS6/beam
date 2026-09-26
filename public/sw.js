/*
 * Beam service worker — app-shell caching only.
 *
 * IMPORTANT: File transfer bytes flow over WebRTC DataChannels directly
 * between peers and NEVER pass through this service worker. This SW only
 * caches the static app shell (HTML navigations + same-origin static assets
 * like JS/CSS/fonts/images) so the app loads fast and survives offline.
 *
 * Signaling traffic (WebSocket upgrade to the Socket.IO server on :3003) is
 * explicitly bypassed below — never cached, never intercepted.
 */

const CACHE = 'beam-shell-v1';

// ---------------------------------------------------------------------------
// Install: take control immediately. Next.js routes are dynamic and chunked,
// so we don't precache a fixed asset list here — assets get populated lazily
// by the fetch handler as users navigate.
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

// ---------------------------------------------------------------------------
// Activate: evict any old cache versions and start serving all clients ASAP.
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// Fetch: route by request type.
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch websocket upgrades — signaling channel must stay live & fresh.
  // Also bail on anything that isn't a GET (POST/PUT/DELETE, etc.).
  if (request.mode === 'websocket' || request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Cross-origin requests (e.g. Google STUN/TURN, external fonts) — let the
  // browser handle them normally. We don't cache opaque responses blindly.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Navigation requests (page loads) — network first, fall back to cache,
  // fall back to the cached root shell for true offline support.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          // Only cache OK, basic/cors navigations (skip errors / redirects / opaque).
          if (fresh && fresh.ok && fresh.type === 'basic') {
            const cache = await caches.open(CACHE);
            cache.put(request, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch (err) {
          const cache = await caches.open(CACHE);
          const cached = await cache.match(request);
          if (cached) return cached;
          // Last resort: the offline shell.
          const shell = await cache.match('/');
          if (shell) return shell;
          throw err;
        }
      })(),
    );
    return;
  }

  // Same-origin static assets (JS, CSS, fonts, images, manifest, etc.) —
  // stale-while-revalidate: serve from cache, refresh in background.
  // Skip caching opaque / error / non-GET responses.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);

      const networkPromise = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        })
        .catch(() => undefined);

      if (cached) {
        // Serve stale immediately, refresh in background.
        event.waitUntil(networkPromise);
        return cached;
      }

      // Not in cache — must hit the network.
      const networkResponse = await networkPromise;
      if (networkResponse) return networkResponse;

      // Nothing we can do — let the browser surface the error.
      return Response.error();
    })(),
  );
});

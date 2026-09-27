/*
 * Beam service worker — app-shell caching + Web Share Target handler.
 *
 * IMPORTANT: File transfer bytes flow over WebRTC DataChannels directly
 * between peers and NEVER pass through this service worker. This SW only:
 *   1. Caches the static app shell (HTML + JS/CSS) for fast/offline loads.
 *   2. Handles Web Share Target POSTs (when a user shares a file TO Beam
 *      from their phone's share sheet) — stores the file in a temporary
 *      cache, redirects to /?shared=1, and the client picks it up.
 *
 * Signaling traffic (WebSocket) is explicitly bypassed — never cached.
 */

const CACHE = 'beam-shell-v2';

// ---------------------------------------------------------------------------
// Install: take control immediately.
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

// ---------------------------------------------------------------------------
// Activate: evict old caches, claim all clients.
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
// Fetch handler: route by request type.
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ---- Web Share Target: POST to "/" with shared files ----
  // When a user shares a file to Beam from their phone's share sheet,
  // Android POSTs multipart/form-data to "/" (the share_target action).
  // We intercept it, store the files in a temporary cache, and redirect
  // to /?shared=1 so the client picks them up.
  if (request.method === 'POST' && url.pathname === '/') {
    event.respondWith(handleShareTarget(event));
    return;
  }

  // Never touch websocket upgrades — signaling channel must stay live & fresh.
  // Also bail on anything that isn't a GET.
  if (request.mode === 'websocket' || request.method !== 'GET') {
    return;
  }

  // Cross-origin requests (Google STUN/TURN, fonts) — let the browser handle.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Navigation requests — network first, fall back to cache, fall back to shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok && fresh.type === 'basic') {
            const cache = await caches.open(CACHE);
            cache.put(request, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch (err) {
          const cache = await caches.open(CACHE);
          const cached = await cache.match(request);
          if (cached) return cached;
          const shell = await cache.match('/');
          if (shell) return shell;
          throw err;
        }
      })(),
    );
    return;
  }

  // Same-origin static assets — stale-while-revalidate.
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
        event.waitUntil(networkPromise);
        return cached;
      }
      const networkResponse = await networkPromise;
      if (networkResponse) return networkResponse;
      return Response.error();
    })(),
  );
});

// ---------------------------------------------------------------------------
// Web Share Target handler — extract shared files, redirect to /?shared=1
// ---------------------------------------------------------------------------
async function handleShareTarget(event) {
  const formData = await event.request.formData();
  const files = formData.getAll('files');

  // Store the shared files in a temporary cache the client can read.
  // We use the Cache API with a special key "shared-files".
  const cache = await caches.open('beam-shared');
  // Store each file as a separate response with a unique URL.
  const sharedUrls = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const sharedUrl = new URL('/__shared__/' + i, self.location.origin);
    const response = new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': file.name || `file-${i + 1}`,
      },
    });
    await cache.put(sharedUrl.toString(), response);
    sharedUrls.push({ url: sharedUrl.toString(), name: file.name || `file-${i + 1}`, type: file.type });
  }

  // Notify all clients about the shared files.
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({ type: 'shared-files', files: sharedUrls });
  }

  // Redirect to the app with ?shared=1 so it knows to look for shared files.
  return Response.redirect('/?shared=1', 303);
}

// ---------------------------------------------------------------------------
// Message handler: client asks for shared files.
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'get-shared-files') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open('beam-shared');
        const keys = await cache.keys();
        const files = [];
        for (const key of keys) {
          const response = await cache.match(key);
          const name = response.headers.get('X-File-Name') || 'shared-file';
          const type = response.headers.get('Content-Type') || 'application/octet-stream';
          const blob = await response.blob();
          files.push({ name, type, blob });
          // Clean up after reading.
          await cache.delete(key);
        }
        event.source.postMessage({ type: 'shared-files-data', files });
      })(),
    );
  }
});

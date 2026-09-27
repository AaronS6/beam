/*
 * Beam service worker — app-shell caching + Web Share Target handler.
 *
 * IMPORTANT: File transfer bytes flow over WebRTC DataChannels directly
 * between peers and NEVER pass through this service worker. This SW only:
 *   1. Caches the static app shell (HTML + JS/CSS) for fast/offline loads.
 *   2. Handles Web Share Target POSTs — stores files in the Cache API
 *      (which persists across SW restarts), redirects to /?shared=1.
 *      The client reads the files from the Cache API via postMessage.
 *
 * Signaling traffic (WebSocket) is explicitly bypassed — never cached.
 */

const CACHE = 'beam-shell-v3';
const SHARED_CACHE = 'beam-shared-files';

// ---------------------------------------------------------------------------
// Install: take control immediately.
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

// ---------------------------------------------------------------------------
// Activate: evict old caches, claim all clients immediately.
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE && k !== SHARED_CACHE).map((k) => caches.delete(k)),
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

  // ---- Web Share Target: POST to "/api/share" or "/" with shared files ----
  if (request.method === 'POST' && (url.pathname === '/api/share' || url.pathname === '/')) {
    event.respondWith(handleShareTarget(event));
    return;
  }

  // Never touch websocket upgrades — signaling channel must stay live & fresh.
  if (request.mode === 'websocket') return;

  // Bail on non-GET requests.
  if (request.method !== 'GET') return;

  // Cross-origin requests — let the browser handle.
  if (url.origin !== self.location.origin) return;

  // Navigation requests — network first, fall back to cache.
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
// Web Share Target handler — extract shared files, store in Cache API
// (persists across SW restarts), redirect to /?shared=1.
// ---------------------------------------------------------------------------
async function handleShareTarget(event) {
  try {
    const formData = await event.request.formData();
    const files = formData.getAll('files');
    const title = formData.get('title');
    const text = formData.get('text');

    const cache = await caches.open(SHARED_CACHE);

    // Clear any previously shared files
    const oldKeys = await cache.keys();
    await Promise.all(oldKeys.map((k) => cache.delete(k)));

    let storedCount = 0;

    // Store each shared file as a Response in the Cache API
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file instanceof Blob) {
        const sharedUrl = new URL('/__shared__/' + i, self.location.origin).toString();
        const response = new Response(file, {
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name || `file-${i + 1}`),
          },
        });
        await cache.put(sharedUrl, response);
        storedCount++;
      }
    }

    // If no files but there's text, create a text file
    if (storedCount === 0 && (text || title)) {
      const content = [title ? String(title) : '', text ? String(text) : ''].filter(Boolean).join('\n\n');
      if (content) {
        const sharedUrl = new URL('/__shared__/0', self.location.origin).toString();
        const response = new Response(content, {
          headers: {
            'Content-Type': 'text/plain',
            'X-File-Name': 'shared-text.txt',
          },
        });
        await cache.put(sharedUrl, response);
        storedCount = 1;
      }
    }

    // Notify all open clients that shared files are ready
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'shared-files-ready', count: storedCount });
    }

    // Redirect to the app
    return Response.redirect('/?shared=1', 303);
  } catch (err) {
    console.error('[sw] share target error:', err);
    return Response.redirect('/?shared=1', 303);
  }
}

// ---------------------------------------------------------------------------
// Message handler: client asks for shared files.
// Reads from the Cache API (persistent across SW restarts).
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'get-shared-files') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(SHARED_CACHE);
        const keys = await cache.keys();
        const files = [];
        for (const key of keys) {
          const response = await cache.match(key);
          if (!response) continue;
          const name = decodeURIComponent(response.headers.get('X-File-Name') || 'shared-file');
          const type = response.headers.get('Content-Type') || 'application/octet-stream';
          const blob = await response.blob();
          files.push({ name, type, blob });
        }
        // Clear the shared cache after reading
        await Promise.all(keys.map((k) => cache.delete(k)));

        event.source.postMessage({ type: 'shared-files-data', files });
      })(),
    );
  }
});

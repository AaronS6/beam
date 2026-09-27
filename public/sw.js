/*
 * Beam service worker — app-shell caching + Web Share Target handler.
 *
 * IMPORTANT: File transfer bytes flow over WebRTC DataChannels directly
 * between peers and NEVER pass through this service worker. This SW only:
 *   1. Caches the static app shell (HTML + JS/CSS) for fast/offline loads.
 *   2. Handles Web Share Target POSTs (when a user shares a file TO Beam
 *      from their phone's share sheet) — stores the file, redirects to
 *      /?shared=1, and the client picks it up via postMessage.
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
// Activate: evict old caches, claim all clients immediately.
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      );
      // Claim all clients immediately so the SW controls the page
      // right after install (needed for share target to work).
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

  // ---- Web Share Target: POST to "/api/share" with shared files ----
  // When a user shares a file to Beam from their phone's share sheet,
  // Android POSTs multipart/form-data to /api/share (the share_target action
  // in the manifest). We intercept it, store the file, and redirect to
  // /?shared=1 so the client picks them up.
  if (request.method === 'POST' && (url.pathname === '/api/share' || url.pathname === '/')) {
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
// Shared files store — uses a simple global variable in the SW scope.
// Files are stored as { name, type, blob } and read back by the client
// via postMessage. Cleared after reading.
// ---------------------------------------------------------------------------
let sharedFilesStore = [];

// ---------------------------------------------------------------------------
// Web Share Target handler — extract shared files, redirect to /?shared=1
// ---------------------------------------------------------------------------
async function handleShareTarget(event) {
  try {
    const formData = await event.request.formData();
    const files = formData.getAll('files');

    // Store the shared files in the SW's memory (not Cache API — that's
    // unreliable for File objects on some browsers).
    sharedFilesStore = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      sharedFilesStore.push({
        name: file.name || `file-${i + 1}`,
        type: file.type || 'application/octet-stream',
        blob: file,
      });
    }

    // Notify all open clients that shared files are ready.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'shared-files-ready' });
    }

    // Redirect to the app with ?shared=1.
    return Response.redirect('/?shared=1', 303);
  } catch (err) {
    console.error('[sw] share target error:', err);
    return Response.redirect('/?shared=1', 303);
  }
}

// ---------------------------------------------------------------------------
// Message handler: client asks for shared files.
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'get-shared-files') {
    // Send the stored files back to the client, then clear them.
    const files = sharedFilesStore.map((f) => ({
      name: f.name,
      type: f.type,
      blob: f.blob,
    }));
    sharedFilesStore = [];
    event.source.postMessage({ type: 'shared-files-data', files });
  }
});

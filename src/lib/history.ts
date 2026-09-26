/**
 * Beam — Persistent transfer history (IndexedDB).
 *
 * Stores metadata + the actual file blobs of the last N completed transfers so
 * the user can re-download files from recent sessions without re-pairing. Lives
 * entirely in the browser — nothing is ever sent to a server.
 *
 * Caps: MAX_SESSIONS (5), MAX_SESSION_BYTES (50MB per session). Older/larger
 * sessions are evicted on insert.
 */

const DB_NAME = "beam-history";
const DB_VERSION = 1;
const STORE_SESSIONS = "sessions";
const STORE_BLOBS = "blobs";
const MAX_SESSIONS = 5;
const MAX_SESSION_BYTES = 50 * 1024 * 1024;

export type HistoryFile = {
  id: string;
  name: string;
  size: number;
  mime?: string;
  text?: string; // for small text files, so we can re-copy without the blob
};

export type HistorySession = {
  id: string; // unique per session (uuid)
  sessionId: string; // the 6-char beam session id
  direction: "sent" | "received";
  peerLabel: string | null;
  createdAt: number; // epoch ms
  totalBytes: number;
  durationMs: number;
  files: HistoryFile[]; // metadata only; blobs stored separately keyed by file id
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("no idb"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Record a completed transfer. `blobs` maps file id → Blob for files we want
 *  re-downloadable (capped; oversized files skip the blob but keep metadata). */
export async function recordSession(
  session: HistorySession,
  blobs: Map<string, Blob>,
): Promise<void> {
  try {
    const db = await openDB();
    // Evict oldest sessions beyond MAX_SESSIONS.
    const all = await listSessions();
    all.sort((a, b) => a.createdAt - b.createdAt);
    while (all.length >= MAX_SESSIONS) {
      const oldest = all.shift()!;
      await tx(STORE_SESSIONS, "readwrite", (s) => s.delete(oldest.id));
      // Delete its blobs too.
      for (const f of oldest.files) {
        await tx(STORE_BLOBS, "readwrite", (s) => s.delete(f.id));
      }
    }
    // Enforce per-session byte cap: keep as many files (largest-first? no —
    // smallest-first so we keep more files re-downloadable) under the cap.
    let acc = 0;
    const kept: HistoryFile[] = [];
    for (const f of session.files) {
      const blob = blobs.get(f.id);
      const size = blob?.size ?? f.size;
      if (acc + size <= MAX_SESSION_BYTES && blob) {
        kept.push(f);
        acc += size;
      } else {
        // Keep metadata but drop the blob (re-download not available).
        kept.push(f);
      }
    }
    const capped: HistorySession = { ...session, files: kept };

    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([STORE_SESSIONS, STORE_BLOBS], "readwrite");
      t.objectStore(STORE_SESSIONS).put(capped);
      for (const f of kept) {
        const blob = blobs.get(f.id);
        if (blob) t.objectStore(STORE_BLOBS).put(blob, f.id);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* history is best-effort; never break the transfer flow */
  }
}

/** List recent sessions, newest first. */
export async function listSessions(): Promise<HistorySession[]> {
  try {
    const all = await tx<HistorySession[]>(STORE_SESSIONS, "readonly", (s) => s.getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** Get a file's blob for re-download. Returns null if not stored (evicted/oversized). */
export async function getFileBlob(fileId: string): Promise<Blob | null> {
  try {
    const blob = await tx<Blob>(STORE_BLOBS, "readonly", (s) => s.get(fileId));
    return blob ?? null;
  } catch {
    return null;
  }
}

/** Clear all history. */
export async function clearHistory(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([STORE_SESSIONS, STORE_BLOBS], "readwrite");
      t.objectStore(STORE_SESSIONS).clear();
      t.objectStore(STORE_BLOBS).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* ignore */
  }
}

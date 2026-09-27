/**
 * Next.js instrumentation hook — runs once when the server boots (server-side).
 *
 * Starts the Path B cleanup sweep (deletes expired stored files every 30s).
 *
 * On serverless hosts (Vercel) with no persistent disk + no DB, this is a
 * no-op: the cleanup loop simply isn't started, and the Path B store API
 * routes return a "storage unavailable" error. Path A (direct P2P) is the
 * default and works fully without any of this.
 *
 * A module-level flag (`cleanupStarted`) guards against double-registration
 * in dev hot-reload.
 */

export const runtime = "nodejs";

let cleanupStarted = false;

export async function register() {
  if (cleanupStarted) return;
  cleanupStarted = true;

  // Only start the cleanup sweep if we have a working DB + storage dir.
  // On Vercel (serverless, no persistent disk) this gracefully skips.
  try {
    const { cleanupExpired } = await import("@/lib/cleanup");
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const UPLOAD_DIR = path.join(process.cwd(), ".beam-store");
    try {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
    } catch {
      // Can't create the storage dir (read-only FS) → Path B unavailable.
      console.log("[beam-store] no writable storage dir — Path B disabled (Path A P2P still works)");
      return;
    }
    // Verify the DB is reachable too.
    const { db } = await import("@/lib/db");
    try {
      await db.storedFile.count();
    } catch {
      console.log("[beam-store] DB not reachable — Path B disabled (Path A P2P still works)");
      return;
    }

    const SWEEP_MS = 30_000;
    setInterval(async () => {
      try {
        const n = await cleanupExpired();
        if (n > 0) console.log("[beam-store] cleanup sweep ran — removed", n, "files");
        else console.log("[beam-store] cleanup sweep ran");
      } catch (err) {
        console.error("[beam-store] cleanup sweep error:", (err as Error)?.message ?? err);
      }
    }, SWEEP_MS);

    console.log("[beam-store] cleanup scheduler started (every " + SWEEP_MS / 1000 + "s)");
  } catch (err) {
    // Dynamic import failed (e.g. Prisma not generated) — Path B disabled.
    console.log("[beam-store] storage module unavailable — Path B disabled (Path A P2P still works)");
  }
}

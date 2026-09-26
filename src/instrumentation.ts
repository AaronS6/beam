import { cleanupExpired } from "@/lib/cleanup";

/**
 * Next.js instrumentation hook — runs once when the server boots (server-side
 * only; `register` is never invoked in the browser bundle).
 *
 * Path B (server-side file storage fallback) requires that uploaded files are
 * AUTO-DELETED no later than 5 minutes after upload, enforced server-side —
 * NOT just a client-side timer. Closing the recipient's tab cannot keep a
 * file alive past its 5-min ceiling.
 *
 * We start a single `setInterval` that runs `cleanupExpired()` every 30
 * seconds. Combined with the `expiresAt = createdAt + 5 min` invariant set at
 * upload time, this guarantees a file is gone within ~5:30 of upload worst
 * case (5:00 expiry + ≤0:30 sweep cadence), regardless of client behavior.
 *
 * A module-level flag (`cleanupStarted`) guards against double-registration in
 * dev hot-reload — `register()` can be called more than once when modules are
 * invalidated, but only the first call actually starts the interval.
 *
 * NOTE: Next.js 16's Turbopack attempts to bundle `instrumentation.ts` for
 * the Edge Runtime as well, which triggers a (harmless) build-time warning
 * about `node:fs` / Prisma not being available in Edge. The `register()`
 * function only ever runs in the Node.js server process (the
 * "scheduler started" log line confirms this); the Edge bundle is never
 * executed. The warning is cosmetic and does not affect functionality.
 */

export const runtime = "nodejs";

let cleanupStarted = false;

export async function register() {
  if (cleanupStarted) return;
  cleanupStarted = true;

  const SWEEP_MS = 30_000;

  setInterval(async () => {
    try {
      const n = await cleanupExpired();
      if (n > 0) {
        console.log("[beam-store] cleanup sweep ran — removed", n, "files");
      } else {
        console.log("[beam-store] cleanup sweep ran");
      }
    } catch (err) {
      // Never let a sweep failure kill the interval — next tick retries.
      console.error(
        "[beam-store] cleanup sweep error:",
        (err as Error)?.message ?? err,
      );
    }
  }, SWEEP_MS);

  console.log(
    "[beam-store] cleanup scheduler started (every " +
      SWEEP_MS / 1000 +
      "s)",
  );
}

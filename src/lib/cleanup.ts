import { promises as fs } from "node:fs";
import { db } from "@/lib/db";

/**
 * Path B cleanup sweep.
 *
 * Removes every `StoredFile` row whose time has come — three deletion reasons,
 * all enforced server-side (the frontend's countdown is just a courtesy):
 *
 *   1. `expired`     — `expiresAt < now`. The hard 5-minute ceiling. Even if
 *                       the recipient closed their tab, the file is gone no
 *                       later than ~5:30 after upload (30s sweep cadence).
 *   2. `downloaded`  — `downloadedAt IS NOT NULL`. The one-time-use rule: the
 *                       instant a successful full download completes, the
 *                       `.enc` blob + DB row are scheduled for removal. The
 *                       GET handler marks these and best-effort deletes inline;
 *                       this sweep is the safety net if any of that failed.
 *   3. `deleted`     — `deleted = true`. Defensive: a row the upload/GET path
 *                       marked but couldn't immediately remove.
 *
 * For each row: delete the on-disk `.enc` blob (best-effort, ignore ENOENT)
 * then delete the DB row. Returns the count of rows removed.
 */
export async function cleanupExpired(): Promise<number> {
  const now = new Date();
  const due = await db.storedFile.findMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { downloadedAt: { not: null } },
        { deleted: true },
      ],
    },
    select: { id: true, encPath: true, downloadedAt: true, expiresAt: true, deleted: true },
  });

  if (due.length === 0) {
    console.log("[beam-store] cleanup sweep ran — nothing to delete");
    return 0;
  }

  let removed = 0;
  for (const row of due) {
    const reason = row.downloadedAt
      ? "downloaded"
      : row.expiresAt < now
        ? "expired"
        : "deleted";
    // best-effort file removal — file may already be gone if GET handler
    // already deleted it after streaming the response.
    try {
      await fs.unlink(row.encPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") {
        // Log unexpected fs errors but keep sweeping — DB row removal is the
        // source of truth for "the link is dead".
        console.log(
          "[beam-store] fs.unlink failed for",
          row.id,
          "code=",
          code,
          "err=",
          (err as Error)?.message,
        );
      }
    }
    try {
      await db.storedFile.delete({ where: { id: row.id } });
      removed++;
      console.log("[beam-store] deleted", row.id, "reason=", reason);
    } catch (err: unknown) {
      // Row may have been deleted concurrently by another sweep or the GET
      // handler. Treat as already-cleaned.
      if ((err as { code?: string })?.code !== "P2025") {
        console.log(
          "[beam-store] db.delete failed for",
          row.id,
          "err=",
          (err as Error)?.message,
        );
      }
    }
  }
  return removed;
}

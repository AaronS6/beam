import { NextResponse } from "next/server";
import { cleanupExpired } from "@/lib/cleanup";

/**
 * Path B — internal cleanup trigger.
 *
 *   POST /api/beam/store/cleanup
 *
 * Runs `cleanupExpired()` synchronously and returns the count of rows
 * removed. The instrumentation `setInterval` (every 30s) is the primary
 * driver; this endpoint is a manual / health-check escape hatch. No auth —
 * it's safe because the operation is idempotent (deleting already-dead
 * rows) and has no user-controlled inputs.
 *
 * Response: { ok: true, deleted: <n> }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const deleted = await cleanupExpired();
  return NextResponse.json({ ok: true, deleted });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cleanupExpired } from "@/lib/cleanup";

/** GET /api/beam/store/list?sessionId=<sid>
 *  Returns all stored files for a Path B session (metadata only — does NOT
 *  consume the one-time-use links). The receiver uses this to render the
 *  file list before the user taps Save. */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "Missing sessionId" }, { status: 400 });
  }
  await cleanupExpired();
  const rows = await db.storedFile.findMany({
    where: { sessionId, downloadedAt: null, deleted: false },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) {
    return NextResponse.json({ ok: false, files: [] }, { status: 404 });
  }
  const earliest = rows.reduce((min, r) => (r.expiresAt < min ? r.expiresAt : min), rows[0].expiresAt);
  return NextResponse.json({
    ok: true,
    expiresAt: earliest.toISOString(),
    files: rows.map((r) => ({ id: r.id, name: r.name, mime: r.mime, size: r.size })),
  });
}

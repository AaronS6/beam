import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Path B — file metadata preview.
 *
 *   GET /api/beam/store/meta?id=<fileId>
 *
 * Returns enough metadata for the receiver to preview the file (name, mime,
 * size, expiry countdown, "already downloaded?" flag) BEFORE committing to a
 * download. The download itself is the one-time-use action — calling this
 * endpoint does NOT consume the link.
 *
 * Responses:
 *   200  { ok: true, id, sessionId, name, mime, size, expiresAt, downloaded }
 *   404  { ok: false, error: "Not found." }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "Missing id" },
      { status: 400 },
    );
  }

  const record = await db.storedFile.findUnique({
    where: { id },
    select: {
      id: true,
      sessionId: true,
      name: true,
      mime: true,
      size: true,
      createdAt: true,
      expiresAt: true,
      downloadedAt: true,
      deleted: true,
    },
  });

  if (!record || record.deleted) {
    return NextResponse.json(
      { ok: false, error: "Not found." },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    id: record.id,
    sessionId: record.sessionId,
    name: record.name,
    mime: record.mime,
    size: record.size,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    downloaded: record.downloadedAt !== null,
  });
}

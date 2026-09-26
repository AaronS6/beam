import { NextRequest, NextResponse } from "next/server";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { encryptBuffer, decryptStream } from "@/lib/storage-crypto";
import { cleanupExpired } from "@/lib/cleanup";

/**
 * Path B — server-side file storage fallback for the "send it, they grab it
 * later" mode.
 *
 *   POST /api/beam/store          upload an encrypted-at-rest file
 *   GET  /api/beam/store?id=...   one-time-use download
 *
 * Invariants enforced server-side (the frontend countdown is just courtesy):
 *   • File auto-deleted ≤ 5 min after upload (`expiresAt = createdAt + 5 min`,
 *     swept every 30s by `instrumentation.ts`).
 *   • First successful full download triggers immediate deletion. Atomic
 *     `updateMany` with `downloadedAt IS NULL` guard ensures only ONE GET can
 *     ever win — concurrent requests race to the 404 path.
 *   • Files are AES-256-GCM encrypted at rest with a per-file random key; key +
 *     IV live in the DB row, never alongside the ciphertext on disk.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** On-disk directory holding the per-file encrypted `.enc` blobs. */
const UPLOAD_DIR = path.join(process.cwd(), ".beam-store");

/** Hard 5-minute TTL ceiling for any uploaded file. */
const TTL_MS = 5 * 60 * 1000;

async function ensureUploadDir(): Promise<void> {
  if (!existsSync(UPLOAD_DIR)) {
    await fs.mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  }
}

// ─── POST /api/beam/store ─────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let encPath: string | null = null;

  try {
    const form = await req.formData();
    const sessionId = String(form.get("sessionId") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const mime = String(form.get("mime") ?? "application/octet-stream").trim();
    const file = form.get("file");

    if (!sessionId) {
      return NextResponse.json(
        { ok: false, error: "Missing sessionId" },
        { status: 400 },
      );
    }
    if (!name) {
      return NextResponse.json(
        { ok: false, error: "Missing name" },
        { status: 400 },
      );
    }
    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { ok: false, error: "Missing file" },
        { status: 400 },
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const size = buf.length;

    await ensureUploadDir();

    // Generate the public download token up-front so we can write the .enc
    // blob to disk before the DB insert (atomic-on-success: file write first,
    // DB insert second, best-effort cleanup of the blob on any failure path).
    const fileId = randomUUID();
    encPath = path.join(UPLOAD_DIR, `${fileId}.enc`);

    const { enc, iv, key } = encryptBuffer(buf);
    await fs.writeFile(encPath, enc, { mode: 0o600 });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MS);

    try {
      await db.storedFile.create({
        data: {
          id: fileId,
          sessionId,
          name,
          mime,
          size,
          encPath,
          iv,
          key,
          createdAt: now,
          expiresAt,
        },
      });
    } catch (dbErr) {
      // DB insert failed — remove the orphaned .enc blob so we don't leak.
      try {
        await fs.unlink(encPath);
      } catch {
        /* ignore */
      }
      encPath = null;
      throw dbErr;
    }

    // Opportunistic sweep — keeps things tidy even if the cron hasn't fired.
    // Best-effort, never blocks or fails the upload.
    cleanupExpired().catch((err) => {
      console.error(
        "[beam-store] opportunistic cleanup failed:",
        (err as Error)?.message ?? err,
      );
    });

    return NextResponse.json({
      ok: true,
      fileId,
      sessionId,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err: unknown) {
    // Defensive: if we got far enough to write the file but failed before the
    // DB row existed, remove the orphaned .enc blob.
    if (encPath) {
      try {
        await fs.unlink(encPath);
      } catch {
        /* ignore */
      }
    }
    const message = (err as Error)?.message ?? "upload failed";
    console.error("[beam-store] POST error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// ─── GET /api/beam/store?id=<fileId> ──────────────────────────────────────────
//
// One-time-use download. The link can only ever serve ONE successful download.
//
// Race safety: a Prisma `updateMany` with `where: { id, downloadedAt: null,
// deleted: false }` is the atomic check-and-set. If two concurrent GETs hit
// this route, exactly one of them gets `count === 1` and proceeds to serve
// the bytes; the other gets `count === 0` and 404s.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "Missing id" },
      { status: 400 },
    );
  }

  const now = new Date();

  // 1. Fetch the record to determine its current state (so we can pick the
  //    correct HTTP status: 404 vs 410 vs 200).
  const record = await db.storedFile.findUnique({ where: { id } });

  if (!record || record.deleted || record.downloadedAt) {
    // Either never existed, marked deleted, OR already grabbed by a previous
    // successful GET. Either way: the link is dead.
    return NextResponse.json(
      { ok: false, error: "This link has expired or already been used." },
      { status: 404 },
    );
  }

  if (record.expiresAt < now) {
    // TTL exceeded and no one downloaded it. Sweep the expired blob, then 410.
    cleanupExpired().catch(() => {
      /* best-effort */
    });
    return NextResponse.json(
      { ok: false, error: "This file expired." },
      { status: 410 },
    );
  }

  // 2. Atomic check-and-set: only this request can win. If `count === 0`,
  //    another concurrent GET already claimed the download — return 404 so
  //    the loser sees the same "link is dead" message as any later visitor.
  const claim = await db.storedFile.updateMany({
    where: { id, downloadedAt: null, deleted: false },
    data: { downloadedAt: now, deleted: true },
  });

  if (claim.count === 0) {
    // Lost the race — another GET got there first.
    return NextResponse.json(
      { ok: false, error: "This link has expired or already been used." },
      { status: 404 },
    );
  }

  // 3. We won the race. Decrypt the blob into memory BEFORE deleting the
  //    on-disk file (correctness over async pipelining — we hold the bytes,
  //    then nuke the source + DB row so the link is dead the instant the
  //    response is on the wire).
  let plain: Buffer;
  try {
    plain = await decryptStream(record.encPath, record.iv, record.key);
  } catch (err) {
    // Decrypt failed (tamper / corruption / bad key). The link is already
    // claimed (downloadedAt set, deleted=true), so future GETs 404. Best-effort
    // delete the bad blob + DB row.
    try {
      await fs.unlink(record.encPath);
    } catch {
      /* ignore */
    }
    try {
      await db.storedFile.delete({ where: { id } });
    } catch {
      /* ignore */
    }
    console.error(
      "[beam-store] decrypt failed for",
      id,
      "err=",
      (err as Error)?.message,
    );
    return NextResponse.json(
      {
        ok: false,
        error: "File could not be decrypted (corrupted or tampered).",
      },
      { status: 500 },
    );
  }

  // 4. Nuke the .enc blob + DB row. Future GETs will 404. Even if the
  //    response stream is dropped mid-flight by the client, the file is
  //    already gone — no second download.
  try {
    await fs.unlink(record.encPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") {
      console.error(
        "[beam-store] post-download unlink failed for",
        id,
        "code=",
        code,
      );
    }
  }
  try {
    await db.storedFile.delete({ where: { id } });
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2025") {
      console.error(
        "[beam-store] post-download db.delete failed for",
        id,
        "err=",
        (err as Error)?.message,
      );
    }
    // The cleanup sweep will catch it on the next tick.
  }

  // 5. Sanitize the filename for the Content-Disposition header (RFC 6266).
  //    Strip control chars + quotes; fallback to "download" if empty.
  const safeName =
    String(record.name || "download")
      .replace(/[\r\n"]/g, "")
      .replace(/[^\x20-\x7E]/g, "_")
      .slice(0, 200) || "download";

  return new Response(new Uint8Array(plain), {
    status: 200,
    headers: {
      "Content-Type": record.mime || "application/octet-stream",
      "Content-Length": String(plain.length),
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Beam-One-Time-Use": "true",
    },
  });
}

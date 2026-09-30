import { NextRequest, NextResponse } from "next/server";
import {
  randomId,
  storeUpload,
  storeDownload,
  storeDelete,
  storeSweepAndGetTotal,
  storeCheckCapacity,
  getPresignedUpload,
  getPresignedDownload,
  isR2,
  type RelayMeta,
} from "@/lib/relay-store";

/**
 * Beam — Encrypted relay store (R2-backed, disk-fallback, presigned-URL for Vercel).
 * ---------------------------------------------------------------------------
 * When the sender + receiver are on different networks (e.g. both on
 * cellular data) direct WebRTC P2P can't cross two carrier NATs, so the file
 * bytes have to relay through a server. To preserve Beam's "no server can
 * read your files" promise, the sender AES-GCM-256-encrypts the file in the
 * browser BEFORE upload (see src/lib/crypto.ts). This route only ever stores
 * CIPHERTEXT — without the key (which lives in the QR URL fragment, never
 * sent to the server) the bytes are useless.
 *
 * TWO MODES (auto-detected):
 *  • S3/R2 configured (Cloudflare R2, Backblaze B2, AWS S3, MinIO, etc.):
 *    PRESIGNED URLs. The serverless function mints a tiny time-limited URL
 *    (no body buffering) + the CLIENT uploads/downloads DIRECTLY to/from R2.
 *    This bypasses Vercel's 4.5 MB serverless body size limit — large files
 *    work. The R2 bucket needs CORS configured for PUT/GET from the Beam origin.
 *  • No S3 (disk fallback): STREAMING. The server streams the body to/from
 *    the ephemeral disk. Only works on a long-running server (Render/VPS).
 *    On Vercel serverless, this doesn't work (each invocation is a fresh
 *    instance, /tmp doesn't persist) → the route returns 503.
 *
 * Endpoints:
 *   POST   /api/relay?name=&size=&mime=
 *          S3 → { id, uploadUrl }   (client PUTs ciphertext to uploadUrl)
 *          disk → { id }            (ciphertext in the body, streamed to disk)
 *   GET    /api/relay?id=X
 *          S3 → { downloadUrl, name, size, mime }   (client GETs from downloadUrl)
 *          disk → raw ciphertext streamed back + X-File-* headers
 *   DELETE /api/relay?id=X  → remove (receiver calls this after a decrypt)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IS_SERVERLESS = !!(process.env.VERCEL || process.env.VERCEL_ENV);

export async function POST(req: NextRequest) {
  // On serverless, S3/R2 MUST be configured (the disk fallback doesn't work
  // on serverless). With S3, we use presigned URLs (no body buffering).
  if (IS_SERVERLESS && !isR2()) {
    return NextResponse.json(
      { error: "Relay storage not configured. On serverless (Vercel), set the R2_* env vars — the disk fallback doesn't work on serverless." },
      { status: 503 },
    );
  }
  await storeSweepAndGetTotal();
  const params = req.nextUrl.searchParams;

  // Two POST modes (distinguished by the query params):
  //   1. ?name=&size=&mime= (no body): PROBE. S3 mints a presigned upload URL,
  //      disk returns { needsBody: true } (the client then re-sends with the body).
  //   2. ?id=X (with body): DISK UPLOAD. Streams the ciphertext body to disk.
  const idParam = params.get("id");
  if (idParam) {
    // DISK UPLOAD mode (body = ciphertext). S3 mode never reaches here
    // (the client PUTs to the presigned URL instead).
    if (isR2()) {
      return NextResponse.json({ error: "use the presigned uploadUrl instead" }, { status: 400 });
    }
    if (!req.body) {
      return NextResponse.json({ error: "missing body" }, { status: 400 });
    }
    const meta: RelayMeta = {
      name: params.get("name") ?? "file",
      size: Number(params.get("size") ?? "0"),
      mime: params.get("mime") ?? "application/octet-stream",
    };
    try {
      const { written } = await storeUpload(idParam, req.body as unknown as ReadableStream<Uint8Array>, meta);
      if (!(await storeCheckCapacity(written))) {
        await storeDelete(idParam);
        return NextResponse.json({ error: "relay full — try again in a moment" }, { status: 507 });
      }
      return NextResponse.json({ id: idParam });
    } catch (e) {
      await storeDelete(idParam).catch(() => {});
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  // PROBE mode (?name=&size=&mime=, no body).
  const name = params.get("name") ?? "file";
  const size = Number(params.get("size") ?? "0");
  const mime = params.get("mime") ?? "application/octet-stream";
  const claimed = Number(size) || 0;
  if (!(await storeCheckCapacity(claimed))) {
    return NextResponse.json({ error: "relay full — try again in a moment" }, { status: 507 });
  }
  const id = randomId();
  const meta: RelayMeta = { name, size, mime };

  if (isR2()) {
    // S3 PRESIGNED mode: mint a time-limited PUT URL. The client uploads
    // the ciphertext directly to R2 via this URL (bypassing the serverless
    // function's body size limit). No body buffering → no 4.5 MB limit.
    try {
      const uploadUrl = await getPresignedUpload(id, meta);
      return NextResponse.json({ id, uploadUrl });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  // DISK mode: tell the client to re-send with the body (the disk mode
  // needs the ciphertext in the POST body, which only works on a long-running
  // server where there's no body-size limit).
  return NextResponse.json({ id, needsBody: true });
}

export async function GET(req: NextRequest) {
  if (IS_SERVERLESS && !isR2()) {
    return NextResponse.json(
      { error: "Relay storage not configured. Set the R2_* env vars." },
      { status: 503 },
    );
  }
  await storeSweepAndGetTotal();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  if (isR2()) {
    // PRESIGNED URL mode: mint a time-limited GET URL. The client downloads
    // the ciphertext directly from R2 via this URL (bypassing the serverless
    // function's response body size limit). Return the metadata alongside.
    const result = await getPresignedDownload(id);
    if (!result) {
      return NextResponse.json({ error: "not found or expired" }, { status: 404 });
    }
    return NextResponse.json({
      downloadUrl: result.url,
      name: result.meta.name,
      size: result.meta.size,
      mime: result.meta.mime,
    });
  }

  // DISK mode: stream the ciphertext back.
  const result = await storeDownload(id);
  if (!result) {
    return NextResponse.json({ error: "not found or expired" }, { status: 404 });
  }
  const { stream, meta, size } = result;
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
      "X-File-Name": encodeURIComponent(meta.name),
      "X-File-Size": String(meta.size),
      "X-File-Mime": encodeURIComponent(meta.mime),
      "Cache-Control": "no-store",
    },
  });
}

export async function DELETE(req: NextRequest) {
  await storeSweepAndGetTotal();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  await storeDelete(id);
  return NextResponse.json({ ok: true });
}

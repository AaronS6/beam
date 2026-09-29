import { NextRequest, NextResponse } from "next/server";
import {
  randomId,
  storeUpload,
  storeDownload,
  storeDelete,
  storeSweepAndGetTotal,
  storeCheckCapacity,
  isR2,
  type RelayMeta,
} from "@/lib/relay-store";

/**
 * Beam — Encrypted relay store (R2-backed, disk-fallback).
 * ---------------------------------------------------------------------------
 * When the sender + receiver are on different networks (e.g. both on
 * cellular data) direct WebRTC P2P can't cross two carrier NATs, so the file
 * bytes have to relay through a server. To preserve Beam's "no server can
 * read your files" promise, the sender AES-GCM-256-encrypts the file in the
 * browser BEFORE upload (see src/lib/crypto.ts). This route only ever stores
 * CIPHERTEXT — without the key (which lives in the QR URL fragment, never
 * sent to the server) the bytes are useless.
 *
 * STORAGE: src/lib/relay-store.ts picks Cloudflare R2 (S3-compatible, 10 GB
 * free + $0 egress) when the R2_* env vars are set, else falls back to the
 * ephemeral disk. Either way the full ciphertext is STREAMED (only a KB-sized
 * buffer sits in RAM — the free-tier RAM-ceiling fix). Set a 5-min lifecycle
 * rule on the R2 bucket for auto-expiry (see the setup guide).
 *
 * Endpoints:
 *   POST   /api/relay?name=&size=&mime=   — raw ciphertext as the body
 *                                            (NOT multipart, so the route can
 *                                            stream it; meta travels in query)
 *                                          → { id }
 *   GET    /api/relay?id=X                 — raw ciphertext streamed back +
 *                                            X-File-Name/Size/Mime headers
 *   DELETE /api/relay?id=X                 — remove (receiver calls this after
 *                                            a successful decrypt)
 *
 * Lifecycle: 5-min TTL (R2: bucket lifecycle rule; disk: sweep on request) +
 * one-time download enforced client-side (receiver DELETEs after decrypt) +
 * by TTL. The GET itself doesn't delete so a flaky network can retry within
 * the 5-min window.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await storeSweepAndGetTotal();
  const params = req.nextUrl.searchParams;
  const name = params.get("name") ?? "file";
  const size = Number(params.get("size") ?? "0");
  const mime = params.get("mime") ?? "application/octet-stream";

  if (!req.body) {
    return NextResponse.json({ error: "missing body" }, { status: 400 });
  }

  const claimed = Number(size) || 0;
  // Disk-only cap check (no-op on R2 — the bucket + lifecycle rule bound it).
  if (!(await storeCheckCapacity(claimed))) {
    return NextResponse.json(
      { error: "relay full — try again in a moment" },
      { status: 507 },
    );
  }

  const id = randomId();
  const meta: RelayMeta = { name, size, mime };
  try {
    const { written } = await storeUpload(id, req.body as unknown as ReadableStream<Uint8Array>, meta);
    // Disk only: post-flight cap check on actual bytes (catches client
    // under-reporting). R2 has no server-side cap.
    if (!isR2()) {
      if (!(await storeCheckCapacity(written))) {
        await storeDelete(id);
        return NextResponse.json(
          { error: "relay full — try again in a moment" },
          { status: 507 },
        );
      }
    }
    return NextResponse.json({ id });
  } catch (e) {
    await storeDelete(id).catch(() => {});
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  await storeSweepAndGetTotal();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  const result = await storeDownload(id);
  if (!result) {
    return NextResponse.json({ error: "not found or expired" }, { status: 404 });
  }
  const { stream, meta, size } = result;
  // CRITICAL: Content-Length MUST be the ACTUAL bytes (the ciphertext = original
  // size + 28 bytes IV/GCM-tag). Setting it to meta.size (the original file
  // size) truncates the download → decryption throws (GCM auth mismatch) →
  // image preview fails. `size` here is the real ciphertext length.
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

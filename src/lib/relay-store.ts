import { Readable } from "stream";
import { promises as fs, createWriteStream, createReadStream } from "fs";
import path from "path";
import os from "os";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Beam — relay storage adapter.
 *
 * Streams encrypted ciphertext to/from either Cloudflare R2 (S3-compatible,
 * 10 GB free + $0 egress) or the local disk (the dev / no-config fallback).
 * Picked automatically at module load based on env vars. Either way the
 * full ciphertext NEVER sits in RAM — only a KB-sized stream buffer does
 * (the free-tier RAM-ceiling fix).
 *
 * R2 env vars (SERVER-SIDE only — never expose to the client, no NEXT_PUBLIC_
 * prefix):
 *   R2_ACCOUNT_ID         — Cloudflare account ID (in the R2 dashboard URL)
 *   R2_ACCESS_KEY_ID       — from the R2 API token you create
 *   R2_SECRET_ACCESS_KEY   — from the R2 API token you create
 *   R2_BUCKET              — the bucket name you create (e.g. "beam-relay")
 *
 * When R2 is configured, this module uses it. Otherwise it falls back to the
 * ephemeral disk at os.tmpdir()/beam-relay (lost on restart — fine for dev).
 *
 * TTL: 5 minutes. On R2, set a bucket lifecycle rule to delete objects after
 * 5 min (one-time dashboard config — see the setup guide). The disk backend
 * sweeps expired files on every request.
 */

// 30-minute TTL. Was 5 min, but bulk transfers (30+ photos) on a slow
// cellular upload can take >5 min just to upload, so the EARLIEST shares
// expired before the receiver downloaded them, the receiver downloaded in
// order + the earliest ones 404'd, which is exactly the "2 succeed + 28
// fail" symptom. 30 min gives plenty of headroom; the disk-cap + the R2
// lifecycle rule still bound the total storage.
const TTL_MS = 30 * 60 * 1000;

export type RelayMeta = { name: string; size: number; mime: string };

// ---- Object storage configuration (S3-compatible) ----
// Works with ANY S3-compatible service, not just Cloudflare R2:
//   • Backblaze B2 (free tier: 10 GB storage + 1 GB/day egress)
//   • AWS S3 (free for 12 months: 5 GB storage, but egress fees)
//   • Wasabi (no egress fees, but a 90-day minimum storage charge — NOT
//     recommended for Beam since shares are deleted after 30 min)
//   • MinIO (self-hosted, free, no limits)
//   • Cloudflare R2 (free 10 GB, $0 egress)
//
// Two ways to configure:
//   GENERIC (any S3 service): set RELAY_S3_ENDPOINT + RELAY_S3_ACCESS_KEY_ID
//     + RELAY_S3_SECRET_ACCESS_KEY + RELAY_S3_BUCKET (+ optional
//     RELAY_S3_REGION, defaults to "auto").
//   CLOUDFLARE R2 (shorthand): set R2_ACCOUNT_ID + R2_ACCESS_KEY_ID +
//     R2_SECRET_ACCESS_KEY + R2_BUCKET (the endpoint is built from the
//     account ID as https://<account_id>.r2.cloudflarestorage.com).
//
// Generic takes precedence if both are set. All SERVER-SIDE only (no
// NEXT_PUBLIC_ prefix — must never reach the browser).
const RELAY_S3_ENDPOINT = process.env.RELAY_S3_ENDPOINT;
const RELAY_S3_REGION = process.env.RELAY_S3_REGION || "auto";
const RELAY_S3_ACCESS_KEY_ID = process.env.RELAY_S3_ACCESS_KEY_ID;
const RELAY_S3_SECRET_ACCESS_KEY = process.env.RELAY_S3_SECRET_ACCESS_KEY;
const RELAY_S3_BUCKET = process.env.RELAY_S3_BUCKET;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;

// Pick the config: generic S3 if the endpoint is set, else Cloudflare R2 if
// the account ID is set, else fall back to the ephemeral disk.
const s3Configured =
  !!(RELAY_S3_ENDPOINT && RELAY_S3_ACCESS_KEY_ID && RELAY_S3_SECRET_ACCESS_KEY && RELAY_S3_BUCKET) ||
  !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

let s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (!s3Client) {
    const isGeneric = !!RELAY_S3_ENDPOINT;
    s3Client = new S3Client({
      region: isGeneric ? RELAY_S3_REGION : "auto",
      endpoint: isGeneric
        ? RELAY_S3_ENDPOINT
        : `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: (isGeneric ? RELAY_S3_ACCESS_KEY_ID : R2_ACCESS_KEY_ID)!,
        secretAccessKey: (isGeneric ? RELAY_S3_SECRET_ACCESS_KEY : R2_SECRET_ACCESS_KEY)!,
      },
    });
  }
  return s3Client;
}

// ---- Hard cap for S3 (so you NEVER exceed the free tier + get charged) ----
// Default 10 GB (matches Cloudflare R2's free tier). Set RELAY_S3_MAX_BYTES
// to lower it (e.g. 9 GB for headroom) or raise it on a paid plan. When the
// spooled total would exceed this, the upload is rejected with HTTP 507
// ("relay full") instead of writing to the bucket + risking an overage charge.
const RELAY_S3_MAX_BYTES =
  Number(process.env.RELAY_S3_MAX_BYTES) || 10 * 1024 * 1024 * 1024;

/** The bucket name (generic RELAY_S3_BUCKET or Cloudflare R2_BUCKET). */
function s3Bucket(): string {
  return (RELAY_S3_ENDPOINT ? RELAY_S3_BUCKET : R2_BUCKET) || "";
}

// In-memory counter of the total bytes currently in the bucket. null =
// unknown (needs a one-time LIST to reconcile on first use). Tracked
// accurately via increment-on-upload / decrement-on-delete within a process;
// re-reconciled via LIST every 5 min to correct drift from lifecycle-rule
// deletions. A drift that OVERestimates is safe (rejects uploads before the
// actual total reaches the cap — no charges); an UNDERestimate would be
// unsafe, so we reconcile on startup + periodically to stay accurate.
let s3TotalBytes: number | null = null;
let s3LastReconcile = 0;
const S3_RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // re-LIST at most every 5 min

/** LIST all objects in the bucket + sum their sizes. Paginated (1000/page). */
async function reconcileS3Total(): Promise<void> {
  let total = 0;
  let token: string | undefined;
  do {
    const res = await getS3().send(
      new ListObjectsV2Command({ Bucket: s3Bucket(), ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      total += obj.Size ?? 0;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  s3TotalBytes = total;
  s3LastReconcile = Date.now();
}

export function isR2(): boolean { // kept for backward compat (the route imports this)
  return s3Configured;
}

// ---- Disk fallback ----
const SPILL_DIR = path.join(os.tmpdir(), "beam-relay");
// 1 GB default cap (was 500 MB). Raised so bulk transfers of 30+ photos
// (which can total hundreds of MB) don't hit the cap + 507 the later files.
// Configurable via BEAM_RELAY_MAX_BYTES. On R2 there's no server-side cap.
const MAX_TOTAL_BYTES =
  Number(process.env.BEAM_RELAY_MAX_BYTES) || 1024 * 1024 * 1024;

const diskMetaPath = (id: string) => path.join(SPILL_DIR, `${id}.meta.json`);
const diskBlobPath = (id: string) => path.join(SPILL_DIR, `${id}.bin`);

async function ensureDiskDir() {
  await fs.mkdir(SPILL_DIR, { recursive: true });
}

async function diskReadMeta(id: string): Promise<(RelayMeta & { expiresAt: number }) | null> {
  try {
    const raw = await fs.readFile(diskMetaPath(id), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function diskWriteMeta(id: string, m: RelayMeta & { expiresAt: number }) {
  await fs.writeFile(diskMetaPath(id), JSON.stringify(m), "utf8");
}

async function diskRemove(id: string) {
  await fs.rm(diskBlobPath(id), { force: true }).catch(() => {});
  await fs.rm(diskMetaPath(id), { force: true }).catch(() => {});
}

/** Sweep expired disk shares + return total spooled bytes. */
async function diskSweepAndGetTotal(): Promise<number> {
  await ensureDiskDir();
  const now = Date.now();
  const entries = await fs.readdir(SPILL_DIR).catch(() => [] as string[]);
  let total = 0;
  for (const e of entries) {
    try {
      const st = await fs.stat(path.join(SPILL_DIR, e));
      total += st.size;
    } catch {
      /* vanished */
    }
  }
  for (const e of entries) {
    if (e.endsWith(".meta.json")) {
      const id = e.slice(0, -".meta.json".length);
      const m = await diskReadMeta(id);
      if (!m || now > m.expiresAt) await diskRemove(id);
    }
  }
  return total;
}

// ---- Public adapter API ----

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Stream an upload body to storage. Returns nothing — the caller already
 *  has the id + meta. Throws on failure (caller surfaces an error). */
export async function storeUpload(
  id: string,
  body: ReadableStream<Uint8Array>,
  meta: RelayMeta,
): Promise<{ written: number }> {
  if (s3Configured) {
    // Stream req.body → R2 via PutObject. The SDK streams (chunked), so only
    // a KB-sized buffer sits in RAM. Custom metadata travels with the object.
    const nodeStream = Readable.fromWeb(body as unknown as import("stream/web").ReadableStream<Uint8Array>);
    await getS3().send(
      new PutObjectCommand({
        Bucket: s3Bucket(),
        Key: `${id}.bin`,
        Body: nodeStream,
        ContentType: "application/octet-stream",
        // S3/R2 metadata values must be strings + keys are lowercased.
        Metadata: {
          name: meta.name,
          size: String(meta.size),
          mime: meta.mime,
          expiresat: String(Date.now() + TTL_MS),
        },
      }),
    );
    // R2/S3 doesn't report bytes written back; use the claimed size.
    // Increment the in-memory total so storeCheckCapacity can enforce the cap.
    if (s3TotalBytes !== null) s3TotalBytes += meta.size;
    return { written: meta.size };
  }
  // Disk: stream to a temp file.
  await ensureDiskDir();
  const ws = createWriteStream(diskBlobPath(id));
  let written = 0;
  const nodeStream = Readable.fromWeb(body as unknown as import("stream/web").ReadableStream<Uint8Array>);
  nodeStream.on("data", (chunk: Buffer) => { written += chunk.length; });
  await new Promise<void>((resolve, reject) => {
    nodeStream.pipe(ws);
    ws.on("finish", () => resolve());
    nodeStream.on("error", reject);
    ws.on("error", reject);
  });
  await diskWriteMeta(id, { ...meta, expiresAt: Date.now() + TTL_MS });
  return { written };
}

/** Stream a download back. Returns null if the share is missing/expired. */
export async function storeDownload(
  id: string,
): Promise<{ stream: ReadableStream<Uint8Array>; meta: RelayMeta; size: number } | null> {
  if (s3Configured) {
    let res;
    try {
      res = await getS3().send(
        new GetObjectCommand({ Bucket: s3Bucket(), Key: `${id}.bin` }),
      );
    } catch {
      return null; // NoSuchKey → missing/expired
    }
    if (!res.Body || !res.Metadata) return null;
    const meta: RelayMeta = {
      name: res.Metadata.name ?? "file",
      size: Number(res.Metadata.size ?? "0"),
      mime: res.Metadata.mime ?? "application/octet-stream",
    };
    // res.Body is a StreamingBlobPayload with transformToWebStream().
    const stream = (res.Body as unknown as { transformToWebStream: () => ReadableStream<Uint8Array> }).transformToWebStream();
    // ContentLength is the actual ciphertext bytes on R2 (what we want for
    // the download — fixes the truncation bug).
    const size = res.ContentLength ?? meta.size;
    return { stream, meta, size };
  }
  // Disk
  const m = await diskReadMeta(id);
  if (!m) return null;
  try {
    await fs.access(diskBlobPath(id));
  } catch {
    await diskRemove(id);
    return null;
  }
  const stat = await fs.stat(diskBlobPath(id));
  const rs = createReadStream(diskBlobPath(id));
  const stream = Readable.toWeb(rs) as ReadableStream<Uint8Array>;
  return { stream, meta: { name: m.name, size: m.size, mime: m.mime }, size: stat.size };
}

/** Remove a share (one-time-use cleanup). Best-effort. */
export async function storeDelete(id: string): Promise<void> {
  if (s3Configured) {
    // Decrement the in-memory counter so the cap stays accurate. HEAD the
    // object to get its size without downloading the whole ciphertext.
    try {
      const head = await getS3().send(
        new HeadObjectCommand({ Bucket: s3Bucket(), Key: `${id}.bin` }),
      ).catch(() => null);
      if (head && s3TotalBytes !== null) {
        s3TotalBytes = Math.max(0, s3TotalBytes - (head.ContentLength ?? 0));
      }
      await getS3().send(
        new DeleteObjectCommand({ Bucket: s3Bucket(), Key: `${id}.bin` }),
      );
    } catch {
      /* best-effort */
    }
    return;
  }
  await diskRemove(id);
}

// ---- Presigned URLs (the Vercel fix) ----
// On serverless (Vercel), the serverless function has a 4.5 MB body size
// limit. The streaming approach (server buffers the body) fails for files
// > 4.5 MB. Presigned URLs solve this: the serverless function mints a tiny
// time-limited URL (no body buffering), + the CLIENT uploads/downloads
// DIRECTLY to/from R2, bypassing the function's body limit entirely.
// The R2 bucket needs CORS configured to allow PUT/GET from the Beam origin.

/** Mint a presigned PUT URL. The client uploads the ciphertext directly to
 *  R2 via this URL. Metadata (name/size/mime) travels with the PUT. */
export async function getPresignedUpload(id: string, meta: RelayMeta): Promise<string> {
  const url = await getSignedUrl(
    getS3(),
    new PutObjectCommand({
      Bucket: s3Bucket(),
      Key: `${id}.bin`,
      ContentType: "application/octet-stream",
      Metadata: {
        name: meta.name,
        size: String(meta.size),
        mime: meta.mime,
        expiresat: String(Date.now() + TTL_MS),
      },
    }),
    { expiresIn: 300 }, // 5 min to upload (the TTL is 30 min, this is just the upload window)
  );
  return url;
}

/** HEAD the object (get metadata) + mint a presigned GET URL. The client
 *  downloads the ciphertext directly from R2 via this URL. Returns null if
 *  the share is missing/expired. */
export async function getPresignedDownload(
  id: string,
): Promise<{ url: string; meta: RelayMeta; size: number } | null> {
  try {
    const head = await getS3().send(
      new HeadObjectCommand({ Bucket: s3Bucket(), Key: `${id}.bin` }),
    );
    const meta: RelayMeta = {
      name: head.Metadata?.name ?? "file",
      size: Number(head.Metadata?.size ?? "0"),
      mime: head.Metadata?.mime ?? "application/octet-stream",
    };
    const url = await getSignedUrl(
      getS3(),
      new GetObjectCommand({ Bucket: s3Bucket(), Key: `${id}.bin` }),
      { expiresIn: 300 }, // 5 min to download
    );
    return { url, meta, size: head.ContentLength ?? meta.size };
  } catch {
    return null; // NoSuchKey → missing/expired
  }
}

/** Sweep + return total spooled bytes (for the disk-cap check). On R2 this
 *  is a no-op (rely on the bucket lifecycle rule for expiry). */
export async function storeSweepAndGetTotal(): Promise<number> {
  if (s3Configured) return 0; // R2 lifecycle rule handles expiry
  return diskSweepAndGetTotal();
}

/** Reject if accepting this upload would blow the cap. On the disk fallback
 *  this is the 1 GB disk cap; on S3 this is the hard RELAY_S3_MAX_BYTES cap
 *  (default 10 GB) enforced via an in-memory counter reconciled by LISTing
 *  the bucket on first use + every 5 min — so you NEVER exceed the free tier
 *  + get charged. */
export async function storeCheckCapacity(claimedBytes: number): Promise<boolean> {
  if (s3Configured) {
    // Reconcile if unknown (first use after restart) or stale (>5 min).
    if (s3TotalBytes === null || Date.now() - s3LastReconcile > S3_RECONCILE_INTERVAL_MS) {
      try { await reconcileS3Total(); } catch { /* LIST failed — be conservative, reject */ return false; }
    }
    return (s3TotalBytes ?? 0) + claimedBytes <= RELAY_S3_MAX_BYTES;
  }
  const total = await diskSweepAndGetTotal();
  return total + claimedBytes <= MAX_TOTAL_BYTES;
}

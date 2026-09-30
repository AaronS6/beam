import { Readable } from "stream";
import { promises as fs, createWriteStream, createReadStream } from "fs";
import path from "path";
import os from "os";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

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

// ---- R2 (S3-compatible) configuration ----
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;

const r2Configured =
  !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

let r2Client: S3Client | null = null;
function getR2(): S3Client {
  if (!r2Client) {
    r2Client = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID!,
        secretAccessKey: R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return r2Client;
}

export function isR2(): boolean {
  return r2Configured;
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
  if (r2Configured) {
    // Stream req.body → R2 via PutObject. The SDK streams (chunked), so only
    // a KB-sized buffer sits in RAM. Custom metadata travels with the object.
    const nodeStream = Readable.fromWeb(body as unknown as import("stream/web").ReadableStream<Uint8Array>);
    await getR2().send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
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
    // R2 doesn't report bytes written back; use the claimed size.
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
  if (r2Configured) {
    let res;
    try {
      res = await getR2().send(
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: `${id}.bin` }),
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
  if (r2Configured) {
    try {
      await getR2().send(
        new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: `${id}.bin` }),
      );
    } catch {
      /* best-effort */
    }
    return;
  }
  await diskRemove(id);
}

/** Sweep + return total spooled bytes (for the disk-cap check). On R2 this
 *  is a no-op (rely on the bucket lifecycle rule for expiry). */
export async function storeSweepAndGetTotal(): Promise<number> {
  if (r2Configured) return 0; // R2 lifecycle rule handles expiry
  return diskSweepAndGetTotal();
}

/** Reject if accepting this upload would blow the disk cap. On R2 there's
 *  no server-side cap (the bucket + lifecycle rule bound it). */
export async function storeCheckCapacity(claimedBytes: number): Promise<boolean> {
  if (r2Configured) return true;
  const total = await diskSweepAndGetTotal();
  return total + claimedBytes <= MAX_TOTAL_BYTES;
}

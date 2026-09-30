/**
 * Beam — relay-path helpers (encrypt+upload on the sender, download+decrypt
 * on the receiver). The server only ever sees ciphertext; the AES-GCM key
 * lives in the QR URL fragment and never transits the server.
 *
 * TWO MODES (auto-detected by the server's response):
 *  • S3/R2 (Vercel/production): PRESIGNED URLs. The client uploads/downloads
 *    DIRECTLY to/from R2 via a time-limited presigned URL, bypassing the
 *    serverless function's 4.5 MB body size limit. No body buffering → large
 *    files work.
 *  • Disk (Render/dev): STREAMING. The client sends the ciphertext body to
 *    /api/relay, the server streams it to the ephemeral disk.
 */

import { encryptFile, decryptBlob } from "./crypto";
import type { RelayShare } from "./signaling";

type FileMeta = { name: string; size: number; mime: string };

// ---- Upload helpers ----

/** XHR-based PUT to a presigned URL (S3 mode). Reports upload progress. */
function putViaXhr(
  url: string,
  ciphertext: Blob,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`upload failed: HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("upload: network error"));
    xhr.send(ciphertext);
  });
}

/** XHR-based POST with the ciphertext body (disk mode). Reports upload progress. */
function uploadViaXhrDisk(
  id: string,
  ciphertext: Blob,
  meta: FileMeta,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = new URLSearchParams({
      id,
      name: meta.name,
      size: String(meta.size),
      mime: meta.mime,
    });
    xhr.open("POST", `/api/relay?${q.toString()}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else if (xhr.status === 507) reject(new Error("relay is full right now — try again in a moment"));
      else reject(new Error(`upload failed: HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("upload: network error"));
    xhr.send(ciphertext);
  });
}

/** Sender: encrypt one file with the session key + upload the ciphertext.
 *  Returns the RelayShare (id + original metadata) for the receiver.
 *  `onProgress(loadedBytes, totalBytes)` tracks the ciphertext upload.
 *  Auto-detects S3 (presigned URL) vs disk (streaming) mode. */
export async function encryptAndUpload(
  file: File,
  key: CryptoKey,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<RelayShare> {
  const meta: FileMeta = {
    name: file.name || "file",
    size: file.size,
    mime: file.type || "application/octet-stream",
  };
  // AES-GCM encrypt in the browser. Returns iv(12) || ciphertext (with auth
  // tag). The server stores this opaquely — without the key it's noise.
  const ciphertextBuf = await encryptFile(file, key);
  const ciphertextBlob = new Blob([ciphertextBuf]);

  // Probe: POST without body → { id, uploadUrl } (S3) OR { id, needsBody } (disk).
  const q = new URLSearchParams({
    name: meta.name,
    size: String(meta.size),
    mime: meta.mime,
  });
  const res = await fetch(`/api/relay?${q.toString()}`, { method: "POST" });
  if (res.status === 507) throw new Error("relay is full right now — try again in a moment");
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
  const body = (await res.json()) as { id: string; uploadUrl?: string; needsBody?: boolean };
  const id = body.id;

  if (body.uploadUrl) {
    // S3 mode: PUT the ciphertext directly to R2 via the presigned URL.
    // This bypasses the serverless function's body size limit (no body
    // buffering → no 4.5 MB limit on Vercel).
    await putViaXhr(body.uploadUrl, ciphertextBlob, onProgress);
  } else if (body.needsBody) {
    // Disk mode: POST the ciphertext body to /api/relay?id=X. Only works
    // on a long-running server (Render/dev) where there's no body-size limit.
    await uploadViaXhrDisk(id, ciphertextBlob, meta, onProgress);
  } else {
    throw new Error("upload: unexpected server response (no uploadUrl or needsBody)");
  }

  return { id, name: meta.name, size: meta.size, mime: meta.mime };
}

// ---- Download helpers ----

/** XHR-based GET from a presigned URL (S3 mode). Reports download progress. */
function downloadViaXhrFromUrl(
  url: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new Error(`download failed: HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("download: network error"));
    xhr.send();
  });
}

/** Receiver: download one share's ciphertext + decrypt it locally. Returns a
 *  Blob (typed with the original mime) + an object URL the UI can show.
 *  Throws on tamper (AES-GCM auth tag mismatch) — caller should mark the
 *  file errored, not lie "done".
 *  Auto-detects S3 (presigned downloadUrl) vs disk (raw ciphertext stream). */
export async function downloadAndDecrypt(
  shareId: string,
  key: CryptoKey,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<{ blob: Blob; url: string; name: string; size: number; mime: string }> {
  // Probe: GET /api/relay?id=X → S3 returns JSON { downloadUrl, name, size,
  // mime }, disk returns raw ciphertext (octet-stream) with X-File-* headers.
  const res = await fetch(`/api/relay?id=${encodeURIComponent(shareId)}`);
  if (res.status === 404) throw new Error("file expired or already downloaded");
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") || "";

  let buffer: ArrayBuffer;
  let name: string;
  let size: number;
  let mime: string;

  if (contentType.includes("application/json")) {
    // S3 mode: parse JSON → get the presigned downloadUrl → XHR GET from it
    // (with progress, bypassing the serverless function's response body limit).
    const body = (await res.json()) as {
      downloadUrl: string;
      name: string;
      size: number;
      mime: string;
    };
    name = body.name;
    size = body.size;
    mime = body.mime;
    buffer = await downloadViaXhrFromUrl(body.downloadUrl, onProgress);
  } else {
    // Disk mode: the response IS the ciphertext. (No download progress via
    // fetch, but disk mode is only used on Render/dev where transfers are
    // fast — acceptable tradeoff.)
    name = decodeURIComponent(res.headers.get("X-File-Name") || "file");
    size = Number(res.headers.get("X-File-Size") || "0");
    mime = decodeURIComponent(res.headers.get("X-File-Mime") || "application/octet-stream");
    buffer = await res.arrayBuffer();
  }

  const plaintext = await decryptBlob(buffer, key); // throws on tamper
  const blob = new Blob([plaintext], { type: mime });
  const url = URL.createObjectURL(blob);
  return { blob, url, name, size, mime };
}

/** Receiver: tell the server to delete a share (one-time-use cleanup).
 *  Best-effort — failure here just means the TTL/lifecycle rule sweeps it. */
export function deleteShare(shareId: string): void {
  try {
    void fetch(`/api/relay?id=${encodeURIComponent(shareId)}`, { method: "DELETE" });
  } catch { /* best-effort */ }
}

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

import { encryptFile, encryptBuffer, decryptBlob } from "./crypto";
import type { RelayShare } from "./signaling";

type FileMeta = { name: string; size: number; mime: string };

// Chunk large files to avoid OOM (the browser can't encrypt a 3.2 GB file
// all at once — it would need ~6.4 GB of RAM for plaintext + ciphertext).
// Each chunk is encrypted separately (own IV) + uploaded as a separate R2
// object. The receiver downloads + decrypts each chunk + reassembles.
const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB per chunk
const LARGE_FILE_THRESHOLD = 200 * 1024 * 1024; // chunk files > 200 MB

/** Infer the correct MIME type from the file extension when the browser
 *  didn't provide one (file.type is empty for some images, especially HEIC
 *  on Android Chrome). Without this, the blob is typed
 *  "application/octet-stream" → the <img> can't render it → shows a file
 *  icon instead of the image thumbnail. */
function inferMime(name: string, mime?: string): string {
  if (mime && mime !== "application/octet-stream" && mime !== "") return mime;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif",
    heic: "image/heic", heif: "image/heif", ico: "image/x-icon",
    pdf: "application/pdf", txt: "text/plain", mp4: "video/mp4", mov: "video/quicktime",
    webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
    zip: "application/zip", json: "application/json", csv: "text/csv",
    html: "text/html", css: "text/css", js: "text/javascript",
  };
  return map[ext] || mime || "application/octet-stream";
}

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

/** Upload one encrypted blob via the probe → presigned PUT path. Returns the
 *  share ID. Shared by both the whole-file + chunked paths. */
async function uploadEncryptedBlob(
  ciphertextBlob: Blob,
  meta: FileMeta,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<string> {
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
    await putViaXhr(body.uploadUrl, ciphertextBlob, onProgress);
  } else if (body.needsBody) {
    await uploadViaXhrDisk(id, ciphertextBlob, meta, onProgress);
  } else {
    throw new Error("upload: unexpected server response");
  }
  return id;
}

/** Sender: encrypt one file with the session key + upload the ciphertext.
 *  Returns the RelayShare (id + original metadata) for the receiver.
 *  `onProgress(loadedBytes, totalBytes)` tracks the ciphertext upload.
 *  For large files (>200 MB), uses CHUNKED encryption + upload to avoid OOM
 *  (the browser can't hold a 3.2 GB file in RAM for encryption). Each chunk
 *  is encrypted separately + uploaded as a separate R2 object. */
export async function encryptAndUpload(
  file: File,
  key: CryptoKey,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<RelayShare> {
  const meta: FileMeta = {
    name: file.name || "file",
    size: file.size,
    mime: inferMime(file.name, file.type),
  };

  // Large files: chunk to avoid OOM.
  if (file.size > LARGE_FILE_THRESHOLD) {
    const chunkCount = Math.ceil(file.size / CHUNK_SIZE);
    const chunkIds: string[] = [];
    let uploadedBytes = 0;
    for (let c = 0; c < chunkCount; c++) {
      const start = c * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunkData = await file.slice(start, end).arrayBuffer();
      const encryptedChunk = await encryptBuffer(chunkData, key);
      const chunkBlob = new Blob([encryptedChunk]);
      const chunkMeta: FileMeta = {
        name: `${meta.name}.part${c}`,
        size: chunkData.byteLength,
        mime: meta.mime,
      };
      const chunkId = await uploadEncryptedBlob(chunkBlob, chunkMeta, (loaded, total) => {
        // Scale the chunk progress to the whole-file progress.
        const chunkUploaded = total > 0 ? Math.round((loaded / total) * (end - start)) : 0;
        onProgress?.(uploadedBytes + chunkUploaded, file.size);
      });
      chunkIds.push(chunkId);
      uploadedBytes += end - start;
      onProgress?.(uploadedBytes, file.size);
    }
    return {
      id: chunkIds[0],
      name: meta.name,
      size: meta.size,
      mime: meta.mime,
      chunkCount,
      chunkIds,
      chunkSize: CHUNK_SIZE,
    };
  }

  // Small files: encrypt the whole file + upload as one share.
  const ciphertextBuf = await encryptFile(file, key);
  const ciphertextBlob = new Blob([ciphertextBuf]);
  const id = await uploadEncryptedBlob(ciphertextBlob, meta, onProgress);
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
 *  Auto-detects S3 (presigned downloadUrl) vs disk (raw ciphertext stream).
 *  For chunked shares (chunkIds present), downloads + decrypts each chunk +
 *  reassembles into one blob. */
export async function downloadAndDecrypt(
  shareId: string,
  key: CryptoKey,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
  chunkIds?: string[],
  totalSize?: number,
  fileMeta?: { name: string; mime: string },
): Promise<{ blob: Blob; url: string; name: string; size: number; mime: string }> {
  // Chunked download: download each chunk, decrypt, reassemble.
  if (chunkIds && chunkIds.length > 1) {
    const blobs: Blob[] = [];
    let downloadedBytes = 0;
    const total = totalSize ?? 0;
    for (let i = 0; i < chunkIds.length; i++) {
      const { blob } = await downloadOneChunk(chunkIds[i], key, (loaded, chunkTotal) => {
        const chunkDownloaded = chunkTotal > 0 ? Math.round((loaded / chunkTotal) * (total / chunkIds.length)) : 0;
        onProgress?.(downloadedBytes + chunkDownloaded, total);
      });
      blobs.push(blob);
      downloadedBytes += blob.size;
      onProgress?.(downloadedBytes, total);
    }
    const name = fileMeta?.name ?? "file";
    const mime = fileMeta?.mime ?? "application/octet-stream";
    const blob = new Blob(blobs, { type: inferMime(name, mime) });
    const url = URL.createObjectURL(blob);
    return { blob, url, name, size: total, mime: inferMime(name, mime) };
  }

  // Single-share download (small files or the first chunk of a chunked share).
  return downloadOneChunk(shareId, key, onProgress);
}

/** Download + decrypt a single share (one chunk or one whole file). */
async function downloadOneChunk(
  shareId: string,
  key: CryptoKey,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<{ blob: Blob; url: string; name: string; size: number; mime: string }> {
  const res = await fetch(`/api/relay?id=${encodeURIComponent(shareId)}`);
  if (res.status === 404) throw new Error("file expired or already downloaded");
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  let buffer: ArrayBuffer;
  let name: string;
  let size: number;
  let mime: string;

  if (contentType.includes("application/json")) {
    const body = (await res.json()) as { downloadUrl: string; name: string; size: number; mime: string };
    name = body.name;
    size = body.size;
    mime = body.mime;
    buffer = await downloadViaXhrFromUrl(body.downloadUrl, onProgress);
  } else {
    name = decodeURIComponent(res.headers.get("X-File-Name") || "file");
    size = Number(res.headers.get("X-File-Size") || "0");
    mime = decodeURIComponent(res.headers.get("X-File-Mime") || "application/octet-stream");
    buffer = await res.arrayBuffer();
  }

  const plaintext = await decryptBlob(buffer, key);
  const blob = new Blob([plaintext], { type: inferMime(name, mime) });
  const url = URL.createObjectURL(blob);
  return { blob, url, name, size, mime };
}

/** Receiver: tell the server to delete a share (one-time-use cleanup).
 *  For chunked shares, deletes all chunk objects. Best-effort. */
export function deleteShare(shareId: string, chunkIds?: string[]): void {
  try {
    void fetch(`/api/relay?id=${encodeURIComponent(shareId)}`, { method: "DELETE" });
    if (chunkIds) {
      for (const cid of chunkIds) {
        if (cid !== shareId) {
          void fetch(`/api/relay?id=${encodeURIComponent(cid)}`, { method: "DELETE" });
        }
      }
    }
  } catch { /* best-effort */ }
}

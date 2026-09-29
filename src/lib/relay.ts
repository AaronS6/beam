/**
 * Beam — relay-path helpers (encrypt+upload on the sender, download+decrypt
 * on the receiver). The server only ever sees ciphertext; the AES-GCM key
 * lives in the QR URL fragment and never transits the server.
 *
 * See src/lib/crypto.ts for the encryption + src/app/api/relay/route.ts for
 * the store.
 */

import { encryptFile, decryptBlob } from "./crypto";
import type { RelayShare } from "./signaling";

type FileMeta = { name: string; size: number; mime: string };

/** XHR-based POST that reports upload progress (fetch can't). Sends the
 *  ciphertext as the RAW request body (NOT multipart) with the file metadata
 *  in the query string — this lets the /api/relay route STREAM the upload
 *  straight to disk without ever buffering the whole ciphertext in RAM (the
 *  free-tier RAM-ceiling fix). Resolves with the share id. */
function uploadViaXhr(
  ciphertext: Blob,
  meta: FileMeta,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = new URLSearchParams({
      name: meta.name,
      size: String(meta.size),
      mime: meta.mime,
    });
    xhr.open("POST", `/api/relay?${q.toString()}`);
    // Raw binary body — no Content-Type so the route reads req.body as a
    // stream. (Don't set multipart/form-data; that would force buffering.)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText);
          if (body?.id) resolve(body.id as string);
          else reject(new Error("upload: missing id in response"));
        } catch {
          reject(new Error("upload: bad JSON response"));
        }
      } else if (xhr.status === 507) {
        reject(new Error("relay is full right now — try again in a moment"));
      } else {
        reject(new Error(`upload failed: HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("upload: network error"));
    xhr.send(ciphertext);
  });
}

/** Sender: encrypt one file with the session key + upload the ciphertext.
 *  Returns the RelayShare (id + original metadata) for the receiver.
 *  `onProgress(loadedBytes, totalBytes)` tracks the ciphertext upload. */
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
  const id = await uploadViaXhr(ciphertextBlob, meta, onProgress);
  return { id, name: meta.name, size: meta.size, mime: meta.mime };
}

/** XHR-based GET that reports download progress. Resolves with the raw
 *  ciphertext ArrayBuffer + the file metadata (parsed from response headers). */
function downloadViaXhr(
  shareId: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<{ buffer: ArrayBuffer; name: string; size: number; mime: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `/api/relay?id=${encodeURIComponent(shareId)}`);
    xhr.responseType = "arraybuffer";
    xhr.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const name = decodeURIComponent(xhr.getResponseHeader("X-File-Name") || "file");
        const size = Number(xhr.getResponseHeader("X-File-Size") || "0");
        const mime = decodeURIComponent(xhr.getResponseHeader("X-File-Mime") || "application/octet-stream");
        resolve({ buffer: xhr.response, name, size, mime });
      } else if (xhr.status === 404) {
        reject(new Error("file expired or already downloaded"));
      } else {
        reject(new Error(`download failed: HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("download: network error"));
    xhr.send();
  });
}

/** Receiver: download one share's ciphertext + decrypt it locally. Returns a
 *  Blob (typed with the original mime) + an object URL the UI can show.
 *  Throws on tamper (AES-GCM auth tag mismatch) — caller should mark the
 *  file errored, not lie "done". */
export async function downloadAndDecrypt(
  shareId: string,
  key: CryptoKey,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<{ blob: Blob; url: string; name: string; size: number; mime: string }> {
  const { buffer, name, size, mime } = await downloadViaXhr(shareId, onProgress);
  const plaintext = await decryptBlob(buffer, key); // throws on tamper
  const blob = new Blob([plaintext], { type: mime });
  const url = URL.createObjectURL(blob);
  return { blob, url, name, size, mime };
}

/** Receiver: tell the server to delete a share (one-time-use cleanup).
 *  Best-effort — failure here just means the 5-min TTL sweeps it later. */
export function deleteShare(shareId: string): void {
  try {
    void fetch(`/api/relay?id=${encodeURIComponent(shareId)}`, { method: "DELETE" });
  } catch { /* best-effort */ }
}

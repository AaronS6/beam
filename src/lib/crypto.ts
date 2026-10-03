/**
 * Beam — client-side end-to-end encryption for the relay fallback path.
 *
 * When the sender + receiver are on different networks (e.g. both on cellular
 * data) direct WebRTC P2P can't cross two carrier NATs, so the file bytes have
 * to relay through a server. To preserve Beam's "no server can read your
 * files" promise, we AES-GCM-256 encrypt the file in the sender's browser
 * BEFORE upload and decrypt it in the receiver's browser AFTER download. The
 * server only ever holds ciphertext.
 *
 * The 256-bit key is generated in the sender's browser and put in the QR URL's
 * FRAGMENT (`#k=...`). URL fragments are never sent to the server in HTTP
 * requests, so the server (and the signaling relay) never see the key. The
 * receiver picks it up locally when it parses the scanned QR URL.
 *
 * AES-GCM provides authenticated encryption — if a single byte of the
 * ciphertext is tampered with, decrypt() throws and we reject the file.
 */

/** Generate a fresh 256-bit AES-GCM key, return it as a base64url string
 *  safe to put in a URL fragment. */
export async function generateTransferKey(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64Url(new Uint8Array(raw));
}

/** Import a base64url key string (from the URL fragment) into a CryptoKey
 *  usable for decryption. */
export async function importTransferKey(b64url: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(b64url);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt an ArrayBuffer (a chunk or a whole file). Returns a single
 *  ArrayBuffer = iv(12 bytes) || ciphertext (with the GCM auth tag). */
export async function encryptBuffer(plaintext: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return combined.buffer;
}

/** Encrypt a File. Returns a single ArrayBuffer = iv(12 bytes) || ciphertext
 *  (with the GCM auth tag appended by Web Crypto). One self-contained blob to
 *  upload — the server stores this opaquely, the receiver splits + decrypts.
 *  For large files (>200 MB), use encryptBuffer per chunk instead (see
 *  relay.ts encryptAndUploadChunked) to avoid OOM. */
export async function encryptFile(file: File, key: CryptoKey): Promise<ArrayBuffer> {
  return encryptBuffer(await file.arrayBuffer(), key);
}

/** Decrypt a combined iv(12)||ciphertext blob back into the original bytes.
 *  Throws (auth tag mismatch) if the ciphertext was tampered with. */
export async function decryptBlob(combined: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const iv = new Uint8Array(combined, 0, 12);
  const ciphertext = new Uint8Array(combined, 12);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}

// ---- base64url helpers (URL-fragment-safe, no padding) ----

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

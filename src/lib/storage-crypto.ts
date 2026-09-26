import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * Path B storage crypto — AES-256-GCM, per-file random key + IV.
 *
 * Each uploaded file is encrypted with its own freshly-generated 32-byte key
 * and 12-byte IV before being written to disk. The key + IV live in the DB
 * record (`StoredFile.key` / `StoredFile.iv`), never on disk alongside the
 * ciphertext. The GCM auth tag is appended to the ciphertext blob so the
 * on-disk file is a single self-contained `.enc` buffer.
 *
 * Why GCM: an AEAD — authenticated encryption gives us confidentiality AND
 * integrity. If anyone flips a single bit of the `.enc` file on disk, the
 * decrypt step throws and the route handler returns an error rather than
 * silently serving corrupted bytes.
 */

export interface EncryptedPayload {
  /** Ciphertext + GCM auth tag appended (auth tag is the final 16 bytes). */
  enc: Buffer;
  /** base64-encoded 12-byte AES-GCM IV. */
  iv: string;
  /** base64-encoded 32-byte AES-256 key. */
  key: string;
}

/**
 * Encrypt a Buffer with a fresh per-file AES-256-GCM key.
 * The returned `enc` Buffer is `ciphertext || authTag` (auth tag is the final
 * 16 bytes) so the on-disk blob is a single contiguous buffer.
 */
export function encryptBuffer(buf: Buffer): EncryptedPayload {
  const key = randomBytes(32); // AES-256
  const iv = randomBytes(12); // GCM standard nonce length
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes
  return {
    enc: Buffer.concat([ciphertext, authTag]),
    iv: iv.toString("base64"),
    key: key.toString("base64"),
  };
}

/**
 * Decrypt a file from disk. Reads the `.enc` blob, splits off the trailing
 * 16-byte GCM auth tag, and runs AES-256-GCM decryption.
 *
 * Throws if the auth tag does not verify (tamper / corruption) — the route
 * handler is responsible for translating that into an HTTP error.
 */
export async function decryptStream(
  encPath: string,
  iv: string,
  key: string,
): Promise<Buffer> {
  const { promises: fs } = await import("node:fs");
  const enc = await fs.readFile(encPath); // ciphertext || authTag
  if (enc.length < 17) {
    // 1 byte ciphertext minimum + 16-byte tag; anything smaller is corrupt
    throw new Error("encrypted blob too small");
  }
  const authTag = enc.subarray(enc.length - 16);
  const ciphertext = enc.subarray(0, enc.length - 16);
  const keyBuf = Buffer.from(key, "base64");
  const ivBuf = Buffer.from(iv, "base64");
  if (keyBuf.length !== 32) {
    throw new Error("invalid key length (expected 32 bytes)");
  }
  if (ivBuf.length !== 12) {
    throw new Error("invalid IV length (expected 12 bytes)");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, ivBuf);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

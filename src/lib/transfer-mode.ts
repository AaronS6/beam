/**
 * Beam, transfer-mode preference (persisted) + URL-fragment key reader.
 *
 * Three modes:
 *  • "auto"    , try direct peer-to-peer first; if it can't connect (e.g.
 *                 both phones on cellular data, behind carrier NAT), fall
 *                 back to the encrypted server relay. The smart default.
 *  • "p2p"     , direct peer-to-peer only (both phones on the same wifi).
 *                 Never relays through the server. Use when you KNOW both
 *                 devices share a network and want max speed + zero relay.
 *  • "relay"   , server relay only. Use when the phones are on different
 *                 networks. Always works. Files are end-to-end encrypted
 *                 (AES-GCM), the server only holds ciphertext.
 *
 * The choice is persisted in localStorage so it sticks across sessions until
 * the user changes it, exactly what the user asked for.
 */

export type TransferMode = "auto" | "p2p" | "relay";

const STORAGE_KEY = "beam:transfer-mode";
// Default = "relay". The user asked for relay to be the default ("use relay
// for 100% of the time") because it works on ANY network (same wifi, cross-
// carrier, behind any NAT), the encrypted server relay always succeeds.
// If the user explicitly picks "Auto" or "Same Wi-Fi", that choice is
// persisted (see setTransferMode) and respected on the next visit.
const DEFAULT_MODE: TransferMode = "relay";

/** Read the persisted transfer mode (falls back to "auto"). Client-only. */
export function getTransferMode(): TransferMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "auto" || v === "p2p" || v === "relay") return v;
  } catch { /* localStorage blocked (private mode), use default */ }
  return DEFAULT_MODE;
}

/** Persist the transfer mode. Client-only. */
export function setTransferMode(mode: TransferMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch { /* ignore */ }
}

/** Human label for each mode (used by the UI toggle). */
export function modeLabel(mode: TransferMode): string {
  switch (mode) {
    case "auto": return "Auto";
    case "p2p": return "Same network";
    case "relay": return "Different networks";
  }
}

/** One-line description for each mode (used by the UI toggle / tooltips). */
export function modeDescription(mode: TransferMode): string {
  switch (mode) {
    case "auto":
      return "Tries direct peer-to-peer first, then falls back to the encrypted relay if it can't connect. The relay fallback is slower. Works on any network.";
    case "p2p":
      return "Direct peer-to-peer only. Fastest and most private. Use when both phones are on the same Wi-Fi.";
    case "relay":
      return "Encrypted server relay. Works 100% of the time on any network, same Wi-Fi or different. Always succeeds. End-to-end encrypted.";
  }
}

/** Shorter one-line label for the card (saves vertical space on phones). */
export function modeShortDescription(mode: TransferMode): string {
  switch (mode) {
    case "auto":
      return "P2P first, relay fallback (slower). Works anywhere.";
    case "p2p":
      return "Direct P2P. Same Wi-Fi only.";
    case "relay":
      return "Works 100% of the time. Any network.";
  }
}

/**
 * Read the per-session decryption key from the URL fragment (#k=...).
 * URL fragments are NEVER sent to the server in HTTP requests, so the server
 * (and the signaling relay) can never see the key. The receiver picks it up
 * locally when it parses the scanned QR URL.
 * Returns null if no key is present (e.g. the sender was in pure-P2P mode).
 */
export function readKeyFromUrlFragment(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash) return null;
  const m = hash.match(/[#&]k=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

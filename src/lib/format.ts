/**
 * Beam — small helpers: session id, device detection, byte/speed formatting.
 */

/** A short, unambiguous, URL-safe session id (6 chars). */
export function genSessionId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Human-readable byte sizes. */
export function formatBytes(bytes: number, digits = 1): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

/** Transfer speed in MB/s (or KB/s for slow links). */
export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "—";
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

/** Duration mm:ss. */
export function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Duration from ms — "1.2s", "12s", "1m 04s". */
export function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return "—";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r.toString().padStart(2, "0")}s`;
}

export type DeviceDescriptor = {
  label: string; // "iPhone", "MacBook", "Android Phone"
  short: string; // "iOS", "macOS", "Android", "Windows"
};

/** Best-effort device label from the user agent (for the "Connected to …" line). */
export function detectDevice(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): DeviceDescriptor {
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isMac = /Macintosh|Mac OS X/i.test(ua) && !isIOS;
  const isWin = /Windows/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const isLinux = /Linux/i.test(ua) && !isAndroid;

  const isEdge = /Edg/i.test(ua);
  const isChrome = /Chrome/i.test(ua) && !isEdge;
  const isFirefox = /Firefox/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !isChrome && !isEdge && !isFirefox;

  let os = "device";
  let label = "a device";
  if (isIOS) {
    os = "iOS";
    label = /iPad/i.test(ua) ? "iPad" : "iPhone";
  } else if (isMac) {
    os = "macOS";
    label = "Mac";
  } else if (isAndroid) {
    os = "Android";
    label = "Android device";
  } else if (isWin) {
    os = "Windows";
    label = "Windows PC";
  } else if (isLinux) {
    os = "Linux";
    label = "Linux desktop";
  }

  let browser = "";
  if (isChrome) browser = "Chrome";
  else if (isSafari) browser = "Safari";
  else if (isFirefox) browser = "Firefox";
  else if (isEdge) browser = "Edge";

  return { label: browser ? `${label} · ${browser}` : label, short: os };
}

export function deviceInfo(): { name?: string; ua?: string; platform?: string } {
  if (typeof navigator === "undefined") return {};
  const d = detectDevice(navigator.userAgent);
  return { name: d.label, ua: navigator.userAgent, platform: d.short };
}

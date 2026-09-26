"use client";

/**
 * useBeamSession — orchestrates the signaling + WebRTC lifecycle and exposes
 * a single state object the UI renders from.
 *
 * Modes:
 *  - sender:   no `?r=` query. Generates a session, shows a QR, waits for a peer,
 *              then streams the selected files.
 *  - receiver: `?r={sessionId}` query. Joins the session, receives files, offers saves.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignalingClient, type DeviceInfo } from "@/lib/signaling";
import {
  BeamTransfer,
  getIceServers,
  type IncomingFile,
  type TransferState,
} from "@/lib/webrtc";
import { genSessionId, deviceInfo, detectDevice, type DeviceDescriptor } from "@/lib/format";

export type FileItem = {
  id: string;
  name: string;
  size: number;
  mime?: string;
  received: number;
  status: "queued" | "transferring" | "done" | "error";
  url?: string;
  text?: string; // populated for small text-like files so the receiver can preview/copy
  imageUrl?: string; // object URL for image files → receiver shows a thumbnail
};

export type Phase = TransferState | "expired";

export type SessionState = {
  mode: "sender" | "receiver";
  phase: Phase;
  sessionId: string | null;
  qrUrl: string | null;
  peerDevice: DeviceDescriptor | null;
  files: FileItem[];
  totalBytes: number;
  receivedBytes: number;
  speed: number; // bytes/sec
  error: string | null;
  createdAt: number | null; // epoch ms — session start, for the expiry countdown
  quality: number; // 0..4 connection-quality signal-strength level
};

const INITIAL: SessionState = {
  mode: "sender",
  phase: "idle",
  sessionId: null,
  qrUrl: null,
  peerDevice: null,
  files: [],
  totalBytes: 0,
  receivedBytes: 0,
  speed: 0,
  error: null,
  createdAt: null,
  quality: 0,
};

export function useBeamSession(sessionIdParam?: string | null) {
  const mode: "sender" | "receiver" = sessionIdParam ? "receiver" : "sender";

  const [state, setState] = useState<SessionState>({
    ...INITIAL,
    mode,
    phase: mode === "receiver" ? "waiting" : "idle",
    sessionId: mode === "receiver" ? sessionIdParam! : null,
  });

  const signalingRef = useRef<SignalingClient | null>(null);
  const transferRef = useRef<BeamTransfer | null>(null);
  const rawFilesRef = useRef<File[]>([]); // sender's raw File objects
  const sessionIdRef = useRef<string | null>(mode === "receiver" ? sessionIdParam ?? null : null);
  const speedRef = useRef({ lastTs: 0, lastBytes: 0, ema: 0 });
  const reconnectPrevPhase = useRef<Phase | null>(null);

  const patch = useCallback((p: Partial<SessionState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  // Keep sessionIdRef in sync so the peer-joined handler always uses the latest.
  useEffect(() => {
    sessionIdRef.current = state.sessionId;
  }, [state.sessionId]);

  // ---- Speed sampler (runs while transferring) ----
  useEffect(() => {
    const t = setInterval(() => {
      setState((s) => {
        if (s.phase !== "transferring" && s.phase !== "reconnecting") {
          return s.speed === 0 ? s : { ...s, speed: 0 };
        }
        const now = performance.now();
        const sr = speedRef.current;
        if (sr.lastTs === 0) {
          sr.lastTs = now;
          sr.lastBytes = s.receivedBytes;
          return s;
        }
        const dt = (now - sr.lastTs) / 1000;
        if (dt < 0.4) return s;
        const dB = s.receivedBytes - sr.lastBytes;
        const inst = dt > 0 ? dB / dt : 0;
        sr.ema = sr.ema === 0 ? inst : sr.ema * 0.7 + inst * 0.3;
        sr.lastTs = now;
        sr.lastBytes = s.receivedBytes;
        return { ...s, speed: sr.ema };
      });
    }, 400);
    return () => clearInterval(t);
  }, []);

  // ---- Receiver: auto-join the session on mount ----
  useEffect(() => {
    if (mode !== "receiver" || !sessionIdParam) return;

    const signaling = new SignalingClient();
    signalingRef.current = signaling;

    signaling.onConnect = () => {
      signaling.joinSession(sessionIdParam, deviceInfo());
    };
    signaling.onSessionJoined = ({ sender }) => {
      patch({
        phase: "waiting",
        peerDevice: sender?.name ? labelToDescriptor(sender.name) : null,
      });
    };
    signaling.onError = (msg) => {
      if (/not found|expired/i.test(msg)) patch({ phase: "expired", error: msg });
      else patch({ error: msg });
    };
    signaling.onSessionExpired = () => patch({ phase: "expired" });
    signaling.onPeerLeft = () => {
      setState((s) =>
        s.phase === "done" ? s : { ...s, phase: "error", error: "The other device disconnected." },
      );
    };
    signaling.onSignal = (data) => {
      let transfer = transferRef.current;
      if (!transfer) {
        transfer = makeTransfer("receiver", sessionIdParam, signaling, patch, setState, reconnectPrevPhase);
        transferRef.current = transfer;
      }
      void transfer.handleSignal(data);
    };

    return () => {
      transferRef.current?.releaseAll();
      transferRef.current?.close();
      signaling.disconnect();
      transferRef.current = null;
      signalingRef.current = null;
    };
  }, [mode, sessionIdParam]);

  // ---- Sender actions ----
  const beginSending = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      rawFilesRef.current = files;

      const items: FileItem[] = files.map((f, i) => ({
        id: `${Date.now()}-${i}`,
        name: f.name || `file-${i + 1}`,
        size: f.size,
        mime: f.type || undefined,
        received: 0,
        status: "queued",
      }));
      const total = items.reduce((a, b) => a + b.size, 0);

      const sessionId = genSessionId();
      sessionIdRef.current = sessionId;
      const origin = typeof window !== "undefined" ? window.location.origin : "https://beam.app";
      const qrUrl = `${origin}/?r=${sessionId}`;

      patch({
        sessionId,
        qrUrl,
        files: items,
        totalBytes: total,
        receivedBytes: 0,
        phase: "waiting",
        error: null,
        createdAt: Date.now(),
      });

      // Tear down any prior transfer before starting fresh.
      transferRef.current?.close();
      transferRef.current = null;

      const signaling = new SignalingClient();
      signalingRef.current = signaling;
      speedRef.current = { lastTs: 0, lastBytes: 0, ema: 0 };

      signaling.onConnect = () => {
        signaling.createSession(sessionId, deviceInfo());
      };
      signaling.onSessionCreated = ({ createdAt }) => {
        // Server confirmed the session — record the start time for the countdown.
        patch({ createdAt });
      };
      signaling.onPeerJoined = ({ receiver }) => {
        // A receiver scanned the QR. Build the transfer + create the offer.
        const sid = sessionIdRef.current ?? sessionId;
        patch({ peerDevice: receiver?.name ? labelToDescriptor(receiver.name) : null });
        const transfer = makeTransfer("sender", sid, signaling, patch, setState, reconnectPrevPhase);
        transfer.queueFiles(rawFilesRef.current);
        transferRef.current = transfer;
        void transfer.createOffer();
      };
      signaling.onSignal = (data) => {
        transferRef.current?.handleSignal(data);
      };
      signaling.onPeerLeft = () => {
        setState((s) =>
          s.phase === "done"
            ? s
            : { ...s, phase: "error", error: "The receiver disconnected before the transfer finished." },
        );
      };
      signaling.onSessionExpired = () => patch({ phase: "expired" });
      signaling.onError = (msg) => patch({ error: msg });
      void getIceServers;
    },
    [patch],
  );

  // ---- Sender queue management (only valid while waiting, before a peer connects) ----
  const removeFile = useCallback(
    (id: string) => {
      setState((s) => {
        if (s.phase !== "waiting" && s.phase !== "connected") return s;
        const idx = s.files.findIndex((f) => f.id === id);
        if (idx === -1) return s;
        const files = s.files.filter((f) => f.id !== id);
        // Sync the raw File objects (same order) so the transfer sends the right set.
        rawFilesRef.current = rawFilesRef.current.filter((_, i) => i !== idx);
        const totalBytes = files.reduce((a, b) => a + b.size, 0);
        if (files.length === 0) {
          // Nothing left to send — tear down the waiting session.
          transferRef.current?.close();
          transferRef.current = null;
          signalingRef.current?.disconnect();
          signalingRef.current = null;
          return { ...s, ...INITIAL, mode: s.mode };
        }
        return { ...s, files, totalBytes };
      });
    },
    [],
  );

  const addMoreFiles = useCallback((more: File[]) => {
    if (more.length === 0) return;
    setState((s) => {
      if (s.phase !== "waiting" && s.phase !== "connected") return s;
      const extra: FileItem[] = more.map((f, i) => ({
        id: `${Date.now()}-${s.files.length + i}`,
        name: f.name || `file-${s.files.length + i + 1}`,
        size: f.size,
        mime: f.type || undefined,
        received: 0,
        status: "queued",
      }));
      rawFilesRef.current = [...rawFilesRef.current, ...more];
      const files = [...s.files, ...extra];
      return { ...s, files, totalBytes: files.reduce((a, b) => a + b.size, 0) };
    });
  }, []);

  /** Reorder the waiting queue (drag-reorder). from/to are file ids. */
  const reorderFiles = useCallback((fromId: string, toId: string) => {
    setState((s) => {
      if (s.phase !== "waiting" && s.phase !== "connected") return s;
      const from = s.files.findIndex((f) => f.id === fromId);
      const to = s.files.findIndex((f) => f.id === toId);
      if (from === -1 || to === -1 || from === to) return s;
      const files = [...s.files];
      const [moved] = files.splice(from, 1);
      files.splice(to, 0, moved);
      // Sync rawFilesRef to the same permutation.
      const rawFrom = rawFilesRef.current[from];
      const raws = [...rawFilesRef.current];
      raws.splice(from, 1);
      raws.splice(to, 0, rawFrom);
      rawFilesRef.current = raws;
      return { ...s, files };
    });
  }, []);

  /** Paste-to-send: turn pasted text into a snippet file. Used by the global
   *  paste listener on the idle dropzone. */
  const sendPastedText = useCallback(
    (text: string) => {
      const value = text.trim();
      if (!value) return;
      let name = "snippet.txt";
      if (/^https?:\/\//i.test(value)) name = "link.txt";
      const file = new File([value], name, { type: "text/plain" });
      beginSending([file]);
    },
    [beginSending],
  );

  const reset = useCallback(() => {
    transferRef.current?.releaseAll();
    transferRef.current?.close();
    transferRef.current = null;
    signalingRef.current?.disconnect();
    signalingRef.current = null;
    rawFilesRef.current = [];
    sessionIdRef.current = mode === "receiver" ? sessionIdParam ?? null : null;
    speedRef.current = { lastTs: 0, lastBytes: 0, ema: 0 };
    reconnectPrevPhase.current = null;
    patch({
      ...INITIAL,
      mode,
      sessionId: mode === "receiver" ? sessionIdParam ?? null : null,
    });
  }, [mode, patch, sessionIdParam]);

  const cancel = useCallback(() => {
    transferRef.current?.cancel();
    patch({ phase: "error", error: "Transfer cancelled." });
  }, [patch]);

  const saveFile = useCallback((url: string, name: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const copyLink = useCallback(async (): Promise<boolean> => {
    if (!state.qrUrl) return false;
    try {
      await navigator.clipboard.writeText(state.qrUrl);
      return true;
    } catch {
      return false;
    }
  }, [state.qrUrl]);

  return useMemo(
    () => ({
      state,
      beginSending,
      reset,
      cancel,
      saveFile,
      copyLink,
      removeFile,
      addMoreFiles,
      reorderFiles,
      sendPastedText,
    }),
    [
      state,
      beginSending,
      reset,
      cancel,
      saveFile,
      copyLink,
      removeFile,
      addMoreFiles,
      reorderFiles,
      sendPastedText,
    ],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function labelToDescriptor(label: string): DeviceDescriptor {
  const short = detectDevice(` ${label}`).short;
  return { label, short };
}

/**
 * Factory that wires a BeamTransfer's callbacks to React state setters.
 * Shared by both sender & receiver paths so progress/reconnect UX is identical.
 */
function makeTransfer(
  role: "sender" | "receiver",
  sessionId: string,
  signaling: SignalingClient,
  patch: (p: Partial<SessionState>) => void,
  setState: React.Dispatch<React.SetStateAction<SessionState>>,
  reconnectPrev: React.MutableRefObject<Phase | null>,
): BeamTransfer {
  const ice = getIceServers();
  const t = new BeamTransfer(role, sessionId, signaling, ice);

  t.onChannelOpen = () => {
    speedRefResetLocal();
    patch({ phase: "transferring", error: null });
  };
  t.onChannelClose = () => {
    setState((s) => (s.phase === "done" ? s : { ...s, phase: "error", error: "Connection closed." }));
  };
  t.onReconnecting = () => {
    setState((s) => {
      if (s.phase === "reconnecting") return s;
      reconnectPrev.current = s.phase;
      return { ...s, phase: "reconnecting" };
    });
  };
  t.onReconnected = () => {
    setState((s) => {
      const restore =
        reconnectPrev.current && reconnectPrev.current !== "reconnecting"
          ? reconnectPrev.current
          : "transferring";
      reconnectPrev.current = null;
      return { ...s, phase: restore as Phase };
    });
  };
  t.onFailed = (reason) => patch({ phase: "error", error: reason });
  t.onQuality = (level) => patch({ quality: level });

  t.onFileMeta = (files: IncomingFile[]) => {
    setState((s) => ({
      ...s,
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mime: f.mime,
        received: 0,
        status: "queued" as const,
      })),
      totalBytes: files.reduce((a, b) => a + b.size, 0),
      receivedBytes: 0,
      phase: "connected",
    }));
  };
  t.onFileStart = (file: IncomingFile) => {
    setState((s) => ({
      ...s,
      phase: "transferring",
      files: s.files.map((f) => (f.id === file.id ? { ...f, status: "transferring" as const } : f)),
    }));
  };
  t.onFileProgress = (id, received, size) => {
    setState((s) => {
      let receivedBytes = 0;
      const files = s.files.map((f) => {
        if (f.id === id) {
          receivedBytes += received;
          return { ...f, received, status: "transferring" as const };
        }
        receivedBytes += f.received;
        return f;
      });
      return {
        ...s,
        files,
        receivedBytes,
        totalBytes: s.totalBytes || files.reduce((a, b) => a + b.size, 0),
      };
    });
  };
  t.onFileComplete = (file: IncomingFile, url: string) => {
    // For small text-like files, read the content so the receiver can preview +
    // copy it inline (no forced download needed for a URL or code snippet).
    const isText = isTextLike(file.name, file.mime);
    const isImage = isImageLike(file.name, file.mime);

    if (url && isText && file.size > 0 && file.size <= 256 * 1024) {
      fetch(url)
        .then((r) => r.text())
        .then((text) => {
          setState((s) => ({
            ...s,
            files: s.files.map((f) =>
              f.id === file.id ? { ...f, status: "done" as const, received: f.size, url, text } : f,
            ),
          }));
        })
        .catch(() => {
          setState((s) => ({
            ...s,
            files: s.files.map((f) =>
              f.id === file.id ? { ...f, status: "done" as const, received: f.size, url } : f,
            ),
          }));
        });
    } else if (url && isImage && file.size > 0 && file.size <= 16 * 1024 * 1024) {
      // Images: keep the object URL for an inline thumbnail. (Object URL == blob URL,
      // safe to use directly as <img src>.) Cap at 16MB to avoid burning memory.
      setState((s) => ({
        ...s,
        files: s.files.map((f) =>
          f.id === file.id
            ? { ...f, status: "done" as const, received: f.size, url: url || f.url, imageUrl: url }
            : f,
        ),
      }));
    } else {
      setState((s) => ({
        ...s,
        files: s.files.map((f) =>
          f.id === file.id ? { ...f, status: "done" as const, received: f.size, url: url || f.url } : f,
        ),
      }));
    }
  };
  t.onAllComplete = () => {
    patch({ phase: "done", speed: 0 });
  };
  t.onCancel = () => patch({ phase: "error", error: "Transfer cancelled by the other device." });

  return t;
}

function speedRefResetLocal() {
  // no-op; the speed sampler resets itself via its own closure.
}

/** True for files we should inline-preview as text (snippets, URLs, notes). */
function isTextLike(name: string, mime?: string): boolean {
  if (mime) {
    if (mime.startsWith("text/")) return true;
    if (mime === "application/json" || mime === "application/xml") return true;
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return [
    "txt", "md", "markdown", "json", "js", "ts", "tsx", "jsx", "css", "scss",
    "html", "htm", "xml", "yaml", "yml", "csv", "tsv", "sh", "py", "rb", "go",
    "rs", "java", "c", "cc", "cpp", "h", "hpp", "sql", "toml", "ini", "env",
    "log", "conf", "gitignore", "env",
  ].includes(ext);
}

/** True for image files we can show as an inline thumbnail. */
function isImageLike(name: string, mime?: string): boolean {
  if (mime && mime.startsWith("image/")) return true;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"].includes(ext);
}

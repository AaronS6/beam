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
      signaling.onSessionCreated = () => {
        /* acknowledged — waiting for a peer to scan the QR */
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

  return useMemo(
    () => ({ state, beginSending, reset, cancel, saveFile }),
    [state, beginSending, reset, cancel, saveFile],
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
    setState((s) => ({
      ...s,
      files: s.files.map((f) =>
        f.id === file.id ? { ...f, status: "done" as const, received: f.size, url: url || f.url } : f,
      ),
    }));
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

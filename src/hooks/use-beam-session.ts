"use client";

/**
 * useBeamSession — orchestrates the signaling + WebRTC lifecycle (Path A) AND
 * the temporary-storage fallback (Path B), exposing a single state object.
 *
 * Path A (default): true peer-to-peer over parallel WebRTC DataChannels.
 *   Nothing is stored anywhere. QR/session expires after 5 min if no peer connects.
 * Path B (opt-in "Store temporarily"): files upload once to encrypted server
 *   storage; auto-delete within 5 min OR the instant the receiver finishes
 *   downloading — one-time-use. The backend enforces both ceilings; the client
 *   countdown is just a courtesy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignalingClient } from "@/lib/signaling";
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
  text?: string;
  imageUrl?: string;
};

export type Phase = TransferState | "expired";

/** 5-minute ceiling for both paths (Path A session idle, Path B storage). */
const SESSION_TTL_MS = 5 * 60 * 1000;

export type SessionState = {
  mode: "sender" | "receiver";
  phase: Phase;
  sessionId: string | null;
  qrUrl: string | null;
  peerDevice: DeviceDescriptor | null;
  files: FileItem[];
  totalBytes: number;
  receivedBytes: number;
  speed: number;
  error: string | null;
  createdAt: number | null;
  quality: number;
  transferStartedAt: number | null;
  transferEndedAt: number | null;
  peakSpeed: number;
  candidateType: "host" | "srflx" | "prflx" | "relay" | "unknown" | null;
  /** Whether Path B (server storage) is available on this host. False on
   *  serverless hosts (Vercel) with no persistent disk → "Store temporarily"
   *  toggle is hidden. */
  /** Path B: epoch ms when stored files expire (createdAt + 5 min). Null on Path A. */
  /** Nearby devices seen via the lobby (presence). Sender can tap one to send. */
  nearby: { socketId: string; label: string; short: string }[];
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
  transferStartedAt: null,
  transferEndedAt: null,
  peakSpeed: 0,
  candidateType: null,
  nearby: [],
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
  const lobbyRef = useRef<SignalingClient | null>(null);
  const transferRef = useRef<BeamTransfer | null>(null);
  const rawFilesRef = useRef<File[]>([]);
  const sessionIdRef = useRef<string | null>(mode === "receiver" ? sessionIdParam ?? null : null);
  const speedRef = useRef({ lastTs: 0, lastBytes: 0, ema: 0 });
  const reconnectPrevPhase = useRef<Phase | null>(null);
  // Stashed nearby target: when the user taps a nearby device before picking
  // files, we store the target here, open the file picker, and auto-send to
  // them once files are chosen (in beginSending).
  const pendingNearbyRef = useRef<{ socketId: string; deviceLabel?: string } | null>(null);

  const patch = useCallback((p: Partial<SessionState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  useEffect(() => {
    sessionIdRef.current = state.sessionId;
  }, [state.sessionId]);



  // ---- Lobby / nearby-device presence ----
  // Every device (sender OR receiver) joins the lobby so others can discover
  // it. The lobby client is separate from the session signaling client so it
  // can stay alive across session lifecycle changes.
  useEffect(() => {
    const lobby = new SignalingClient();
    lobbyRef.current = lobby;
    const myDevice = deviceInfo();
    lobby.onConnect = () => lobby.joinLobby(myDevice);
    // Re-join on reconnect (socket.io auto-reconnects; re-announce presence)
    lobby.onDisconnect = () => {
      // Clear the nearby list on disconnect — will repopulate on reconnect
      setState((s) => ({ ...s, nearby: [] }));
    };
    lobby.onLobbyList = (devices) => {
      // Fully REPLACE the nearby list (authoritative snapshot from server)
      const seen = new Set<string>();
      const deduped = devices.filter((d) => {
        if (seen.has(d.socketId)) return false;
        seen.add(d.socketId);
        return true;
      }).map((d) => ({
        socketId: d.socketId,
        label: d.device.name ?? "a device",
        short: d.device.platform ?? "",
      }));
      setState((s) => ({ ...s, nearby: deduped }));
    };
    lobby.onLobbyUpdate = (evt) => {
      setState((s) => {
        if (evt.kind === "join") {
          // Deduplicate: if this socketId is already in the list, update its
          // info rather than adding a duplicate.
          const exists = s.nearby.some((n) => n.socketId === evt.socketId);
          if (exists) {
            return {
              ...s,
              nearby: s.nearby.map((n) =>
                n.socketId === evt.socketId
                  ? { ...n, label: evt.device?.name ?? n.label, short: evt.device?.platform ?? n.short }
                  : n,
              ),
            };
          }
          return {
            ...s,
            nearby: [
              ...s.nearby,
              {
                socketId: evt.socketId,
                label: evt.device?.name ?? "a device",
                short: evt.device?.platform ?? "",
              },
            ],
          };
        }
        return { ...s, nearby: s.nearby.filter((n) => n.socketId !== evt.socketId) };
      });
    };
    lobby.onInvite = (payload) => {
      // A nearby sender picked THIS device to receive files. Auto-accept:
      // join their session via a SEPARATE SignalingClient (not the lobby socket)
      // so the session handlers don't collide with lobby presence handlers.
      const sid = payload.sessionId;
      const inviter = payload.device?.name ?? "a device";
      setState((s) => ({
        ...s,
        mode: "receiver" as const,
        sessionId: sid,
        peerDevice: { label: inviter, short: payload.device?.platform ?? "" },
        phase: "waiting" as const,
        files: (payload.files ?? []).map((f, i) => ({
          id: `inv-${i}`,
          name: f.name,
          size: f.size,
          mime: f.mime,
          received: 0,
          status: "queued" as const,
        })),
        totalBytes: (payload.files ?? []).reduce((a, b) => a + b.size, 0),
        receivedBytes: 0,
        error: null,
      }));
      // Use a SEPARATE SignalingClient for the session (not the lobby socket).
      const sessionSignaling = new SignalingClient();
      signalingRef.current = sessionSignaling;
      sessionSignaling.onConnect = () => sessionSignaling.joinSession(sid, deviceInfo());
      sessionSignaling.onSessionJoined = ({ sender }) => {
        patch({ phase: "waiting", peerDevice: sender?.name ? { label: sender.name, short: sender.platform ?? "" } : null });
      };
      sessionSignaling.onSignal = (sigdata) => {
        let transfer = transferRef.current;
        if (!transfer) {
          transfer = makeTransfer("receiver", sid, sessionSignaling, patch, setState, reconnectPrevPhase);
          transferRef.current = transfer;
        }
        void transfer.handleSignal(sigdata);
      };
      sessionSignaling.onPeerLeft = () => {
        setState((s) =>
          s.phase === "done" ? s : { ...s, phase: "error", error: "The other device disconnected." },
        );
      };
      sessionSignaling.onSessionExpired = () => patch({ phase: "expired" });
      sessionSignaling.onError = (msg) => patch({ error: msg });
    };
    return () => {
      lobby.leaveLobby();
      lobby.disconnect();
      lobbyRef.current = null;
    };
  }, [patch]);

  // ---- Speed sampler (tracks peak too) ----
  useEffect(() => {
    const t = setInterval(() => {
      setState((s) => {
        if (s.phase !== "transferring" && s.phase !== "reconnecting") {
          return s.speed === 0 ? s : { ...s, speed: 0 };
        }
        const now = performance.now();
        const sr = speedRef.current;
        if (sr.lastTs === 0) { sr.lastTs = now; sr.lastBytes = s.receivedBytes; return s; }
        const dt = (now - sr.lastTs) / 1000;
        if (dt < 0.4) return s;
        const dB = s.receivedBytes - sr.lastBytes;
        const inst = dt > 0 ? dB / dt : 0;
        sr.ema = sr.ema === 0 ? inst : sr.ema * 0.7 + inst * 0.3;
        sr.lastTs = now;
        sr.lastBytes = s.receivedBytes;
        const peakSpeed = Math.max(s.peakSpeed, sr.ema);
        return { ...s, speed: sr.ema, peakSpeed };
      });
    }, 400);
    return () => clearInterval(t);
  }, []);

  // ---- Path A: 5-min session-expiry countdown (no peer → expire) ----
  useEffect(() => {
    if (mode !== "sender") return;
    if (state.phase !== "waiting") return;
    if (!state.createdAt) return;
    const expiry = state.createdAt + SESSION_TTL_MS;
    const t = setInterval(() => {
      if (Date.now() >= expiry) {
        // Expire the session locally + tell signaling to leave.
        signalingRef.current?.leaveSession(state.sessionId ?? "");
        patch({ phase: "expired" });
      }
    }, 1000);
    return () => clearInterval(t);
  }, [mode, state.phase, state.createdAt, state.sessionId, patch]);

  // ---- Receiver: auto-join the signaling session on mount ----
  useEffect(() => {
    if (mode !== "receiver" || !sessionIdParam) return;

    let cancelled = false;
    const signaling = new SignalingClient();
    signalingRef.current = signaling;
    signaling.onConnect = () => signaling.joinSession(sessionIdParam, deviceInfo());
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
    signaling.onSignal = (sigdata) => {
      let transfer = transferRef.current;
      if (!transfer) {
        transfer = makeTransfer("receiver", sessionIdParam, signaling, patch, setState, reconnectPrevPhase);
        transferRef.current = transfer;
      }
      void transfer.handleSignal(sigdata);
    };

    return () => {
      cancelled = true;
      transferRef.current?.releaseAll();
      transferRef.current?.close();
      signaling.disconnect();
      transferRef.current = null;
      signalingRef.current = null;
    };
  }, [mode, sessionIdParam]);

  // ---- Sender actions ----
  const sendToNearbyRef = useRef<((socketId: string, deviceLabel?: string) => void) | null>(null);

  const beginSending = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      rawFilesRef.current = files;

      // If the user tapped a nearby device before picking files, auto-send to
      // them now (instead of showing the QR code).
      const pending = pendingNearbyRef.current;
      if (pending) {
        pendingNearbyRef.current = null;
        sendToNearbyRef.current?.(pending.socketId, pending.deviceLabel);
        return;
      }

      const items: FileItem[] = files.map((f, i) => ({
        id: `${Date.now()}-${i}`,
        name: f.name || `file-${i + 1}`,
        size: f.size,
        mime: f.type || undefined,
        received: 0,
        status: "queued",
        imageUrl: isImageLike(f.name, f.type) ? URL.createObjectURL(f) : undefined,
      }));
      const total = items.reduce((a, b) => a + b.size, 0);

      const sessionId = genSessionId();
      sessionIdRef.current = sessionId;
      const origin = typeof window !== "undefined" ? window.location.origin : "https://beam.app";
      const qrUrl = `${origin}/?r=${sessionId}`;
      const now = Date.now();

      patch({
        sessionId,
        qrUrl,
        files: items,
        totalBytes: total,
        receivedBytes: 0,
        phase: "waiting",
        error: null,
        createdAt: now,
      });

      transferRef.current?.close();
      transferRef.current = null;

      // ---- PATH A: peer-to-peer via signaling + WebRTC ----
      const signaling = new SignalingClient();
      signalingRef.current = signaling;
      speedRef.current = { lastTs: 0, lastBytes: 0, ema: 0 };

      signaling.onConnect = () => signaling.createSession(sessionId, deviceInfo());
      signaling.onSessionCreated = ({ createdAt }) => patch({ createdAt });
      signaling.onPeerJoined = ({ receiver }) => {
        const sid = sessionIdRef.current ?? sessionId;
        patch({ peerDevice: receiver?.name ? labelToDescriptor(receiver.name) : null });
        const transfer = makeTransfer("sender", sid, signaling, patch, setState, reconnectPrevPhase);
        transfer.queueFiles(rawFilesRef.current);
        transferRef.current = transfer;
        void transfer.createOffer();
      };
      signaling.onSignal = (data) => transferRef.current?.handleSignal(data);
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

  /** Sender: pick a nearby device (by socketId) to send the selected files to.
   *  Creates a session + sends an invite; when the invitee joins, the WebRTC
   *  offer flow runs just like the QR path. Uses a SEPARATE SignalingClient
   *  for the session (not the lobby socket) so handlers don't collide. */
  const sendToNearby = useCallback(
    (socketId: string, deviceLabel?: string) => {
      const files = rawFilesRef.current;
      // If no files selected yet, open the file picker. Once the user picks
      // files, beginSending() runs — but we stash the intended nearby target
      // so we can auto-send to them right after.
      if (files.length === 0) {
        pendingNearbyRef.current = { socketId, deviceLabel };
        if (typeof document !== "undefined") {
          const input = document.querySelector<HTMLInputElement>('input[type="file"]');
          input?.click();
        }
        return;
      }
      const lobby = lobbyRef.current;
      if (!lobby || !lobby.connected) {
        patch({ error: "Not connected to nearby discovery yet — try again in a moment." });
        return;
      }
      const sessionId = genSessionId();
      sessionIdRef.current = sessionId;
      const now = Date.now();
      const items: FileItem[] = files.map((f, i) => ({
        id: `${now}-${i}`,
        name: f.name || `file-${i + 1}`,
        size: f.size,
        mime: f.type || undefined,
        received: 0,
        status: "queued",
        imageUrl: isImageLike(f.name, f.type) ? URL.createObjectURL(f) : undefined,
      }));
      const total = items.reduce((a, b) => a + b.size, 0);
      patch({
        sessionId,
        qrUrl: null, // no QR for nearby send
        files: items,
        totalBytes: total,
        receivedBytes: 0,
        phase: "waiting",
        error: null,
        createdAt: now,
        peerDevice: deviceLabel ? { label: deviceLabel, short: "" } : null,
      });

      transferRef.current?.close();
      transferRef.current = null;

      // Use a SEPARATE SignalingClient for the session (NOT the lobby socket).
      // This prevents handler collisions between lobby presence + session signaling.
      const signaling = new SignalingClient();
      signalingRef.current = signaling;
      speedRef.current = { lastTs: 0, lastBytes: 0, ema: 0 };

      signaling.onConnect = () => {
        signaling.createSession(sessionId, deviceInfo());
      };
      signaling.onSessionCreated = () => {
        // Session is created — now invite the target device via the LOBBY socket.
        // The invitee's lobby onInvite handler will make them join this session.
        lobby.invite(socketId, sessionId, deviceInfo(), items.map((f) => ({ name: f.name, size: f.size, mime: f.mime })));
      };
      signaling.onPeerJoined = ({ receiver }) => {
        patch({ peerDevice: receiver?.name ? labelToDescriptor(receiver.name) : null });
        const transfer = makeTransfer("sender", sessionId, signaling, patch, setState, reconnectPrevPhase);
        transfer.queueFiles(rawFilesRef.current);
        transferRef.current = transfer;
        void transfer.createOffer();
      };
      signaling.onSignal = (data) => transferRef.current?.handleSignal(data);
      signaling.onPeerLeft = () => {
        setState((s) =>
          s.phase === "done"
            ? s
            : { ...s, phase: "error", error: "The other device disconnected before the transfer finished." },
        );
      };
      signaling.onSessionExpired = () => patch({ phase: "expired" });
      signaling.onError = (msg) => patch({ error: msg });
      void getIceServers;
    },
    [patch],
  );
  // Keep the ref current so beginSending can call it without a forward-ref issue.
  // Must run in an effect (not during render) per React's ref rules.
  useEffect(() => { sendToNearbyRef.current = sendToNearby; }, [sendToNearby]);


  // ---- Queue management (Path A sender, while waiting) ----
  const removeFile = useCallback((id: string) => {
    setState((s) => {
      if (s.phase !== "waiting" && s.phase !== "connected") return s;
      const idx = s.files.findIndex((f) => f.id === id);
      if (idx === -1) return s;
      const files = s.files.filter((f) => f.id !== id);
      rawFilesRef.current = rawFilesRef.current.filter((_, i) => i !== idx);
      const totalBytes = files.reduce((a, b) => a + b.size, 0);
      if (files.length === 0) {
        transferRef.current?.close();
        transferRef.current = null;
        signalingRef.current?.disconnect();
        signalingRef.current = null;
        return { ...s, ...INITIAL, mode: s.mode };
      }
      return { ...s, files, totalBytes };
    });
  }, []);

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
        imageUrl: isImageLike(f.name, f.type) ? URL.createObjectURL(f) : undefined,
      }));
      rawFilesRef.current = [...rawFilesRef.current, ...more];
      const files = [...s.files, ...extra];
      return { ...s, files, totalBytes: files.reduce((a, b) => a + b.size, 0) };
    });
  }, []);

  const reorderFiles = useCallback((fromId: string, toId: string) => {
    setState((s) => {
      if (s.phase !== "waiting" && s.phase !== "connected") return s;
      const from = s.files.findIndex((f) => f.id === fromId);
      const to = s.files.findIndex((f) => f.id === toId);
      if (from === -1 || to === -1 || from === to) return s;
      const files = [...s.files];
      const [moved] = files.splice(from, 1);
      files.splice(to, 0, moved);
      const rawFrom = rawFilesRef.current[from];
      const raws = [...rawFilesRef.current];
      raws.splice(from, 1);
      raws.splice(to, 0, rawFrom);
      rawFilesRef.current = raws;
      return { ...s, files };
    });
  }, []);

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
    if (typeof window !== "undefined") {
      setState((s) => {
        s.files.forEach((f) => {
          if (f.imageUrl) {
            try { URL.revokeObjectURL(f.imageUrl); } catch { /* ignore */ }
          }
        });
        return s;
      });
    }
    rawFilesRef.current = [];
    sessionIdRef.current = mode === "receiver" ? sessionIdParam ?? null : null;
    speedRef.current = { lastTs: 0, lastBytes: 0, ema: 0 };
    reconnectPrevPhase.current = null;
    patch({ ...INITIAL, mode, sessionId: mode === "receiver" ? sessionIdParam ?? null : null });
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

  const shareImage = useCallback(
    async (url: string, name: string, mime: string): Promise<"shared" | "downloaded" | "failed"> => {
      if (typeof navigator === "undefined" || !navigator.canShare) return "failed";
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        const file = new File([blob], name, { type: mime || blob.type || "image/png" });
        if (!navigator.canShare({ files: [file] })) return "failed";
        await navigator.share({ files: [file], title: name });
        return "shared";
      } catch {
        try {
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          return "downloaded";
        } catch {
          return "failed";
        }
      }
    },
    [],
  );

  const shareAll = useCallback(async (): Promise<"shared" | "downloaded" | "failed"> => {
    const done = state.files.filter((f) => f.url);
    if (done.length === 0) return "failed";
    if (typeof navigator === "undefined" || !navigator.canShare) {
      done.forEach((f) => saveFile(f.url!, f.name));
      return "downloaded";
    }
    try {
      const files: File[] = [];
      for (const f of done) {
        const res = await fetch(f.url!);
        const blob = await res.blob();
        files.push(new File([blob], f.name, { type: f.mime || blob.type || "application/octet-stream" }));
      }
      if (!navigator.canShare({ files })) {
        done.forEach((f) => saveFile(f.url!, f.name));
        return "downloaded";
      }
      await navigator.share({ files, title: `${done.length} files from Beam` });
      return "shared";
    } catch {
      return "failed";
    }
  }, [state.files, saveFile]);

  const copyAllText = useCallback(async (): Promise<number> => {
    const texts = state.files.filter((f) => f.text).map((f) => f.text as string);
    if (texts.length === 0) return 0;
    const joined = texts.join("\n\n— — —\n\n");
    try {
      await navigator.clipboard.writeText(joined);
    } catch {
      return 0;
    }
    return texts.length;
  }, [state.files]);

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
      sendToNearby,
      reset,
      cancel,
      saveFile,
      shareImage,
      shareAll,
      copyAllText,
      copyLink,
      removeFile,
      addMoreFiles,
      reorderFiles,
      sendPastedText,
    }),
    [
      state, beginSending, sendToNearby, reset, cancel, saveFile, shareImage, shareAll,
      copyAllText, copyLink, removeFile, addMoreFiles, reorderFiles, sendPastedText,
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
    patch({
      phase: "transferring",
      error: null,
      transferStartedAt: Date.now(),
      transferEndedAt: null,
      peakSpeed: 0,
    });
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
  t.onCandidateType = (ct) => patch({ candidateType: ct });

  t.onFileMeta = (files: IncomingFile[]) => {
    setState((s) => ({
      ...s,
      files: files.map((f) => ({
        id: f.id, name: f.name, size: f.size, mime: f.mime, received: 0, status: "queued" as const,
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
      return { ...s, files, receivedBytes, totalBytes: s.totalBytes || files.reduce((a, b) => a + b.size, 0) };
    });
  };
  t.onFileComplete = (file: IncomingFile, url: string) => {
    const isText = isTextLike(file.name, file.mime);
    const isImage = isImageLike(file.name, file.mime);
    if (url && isText && file.size > 0 && file.size <= 256 * 1024) {
      fetch(url).then((r) => r.text()).then((text) => {
        setState((s) => ({
          ...s,
          files: s.files.map((f) =>
            f.id === file.id ? { ...f, status: "done" as const, received: f.size, url, text } : f,
          ),
        }));
      }).catch(() => {
        setState((s) => ({
          ...s,
          files: s.files.map((f) =>
            f.id === file.id ? { ...f, status: "done" as const, received: f.size, url } : f,
          ),
        }));
      });
    } else if (url && isImage && file.size > 0 && file.size <= 16 * 1024 * 1024) {
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
    setState((s) => ({
      ...s,
      phase: "done",
      speed: 0,
      transferEndedAt: Date.now(),
      // SENDER: mark all files as done (they were sent — no URL needed).
      // RECEIVER: do NOT mark files as done here. The receiver's finalizeFile
      // (async) is still reassembling blobs + creating URLs. If we mark them
      // done here, they'd be "done" with no URL → stuck at 100% with no
      // Download button. finalizeFile's onFileComplete is the ONLY place that
      // should mark each receiver file done (with a real blob URL).
      files: role === "sender"
        ? s.files.map((f) => ({ ...f, status: "done" as const, received: f.size }))
        : s.files,
    }));
    // RECEIVER SAFETY NET: if any files are still "transferring" after 5s
    // (finalizeFile should have finished by then), force them to "done" with
    // whatever URL they have (or none). This prevents a permanent stuck state
    // if finalizeFile somehow doesn't fire onAllComplete.
    if (role === "receiver") {
      setTimeout(() => {
        setState((s) => ({
          ...s,
          files: s.files.map((f) =>
            f.status === "transferring" ? { ...f, status: "done" as const, received: f.size } : f,
          ),
        }));
      }, 5000);
    }
  };
  t.onCancel = () => patch({ phase: "error", error: "Transfer cancelled by the other device." });

  return t;
}


// ---- helpers ----
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
    "log", "conf", "gitignore",
  ].includes(ext);
}

function isImageLike(name: string, mime?: string): boolean {
  if (mime && mime.startsWith("image/")) return true;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"].includes(ext);
}

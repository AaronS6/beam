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
  storeMode: boolean; // Path B toggle
  /** Path B: epoch ms when stored files expire (createdAt + 5 min). Null on Path A. */
  storeExpiresAt: number | null;
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
  storeMode: false,
  storeExpiresAt: null,
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
  const storeModeRef = useRef<boolean>(false);
  const speedRef = useRef({ lastTs: 0, lastBytes: 0, ema: 0 });
  const reconnectPrevPhase = useRef<Phase | null>(null);

  const patch = useCallback((p: Partial<SessionState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  useEffect(() => {
    sessionIdRef.current = state.sessionId;
    storeModeRef.current = state.storeMode;
  }, [state.sessionId, state.storeMode]);

  const setStoreMode = useCallback((v: boolean) => {
    patch({ storeMode: v });
  }, [patch]);

  // ---- Lobby / nearby-device presence ----
  // Every device (sender OR receiver) joins the lobby so others can discover
  // it. The lobby client is separate from the session signaling client so it
  // can stay alive across session lifecycle changes.
  useEffect(() => {
    const lobby = new SignalingClient();
    lobbyRef.current = lobby;
    lobby.onConnect = () => lobby.joinLobby(deviceInfo());
    lobby.onLobbyList = (devices) => {
      setState((s) => ({
        ...s,
        nearby: devices.map((d) => ({
          socketId: d.socketId,
          label: d.device.name ?? "a device",
          short: d.device.platform ?? "",
        })),
      }));
    };
    lobby.onLobbyUpdate = (evt) => {
      setState((s) => {
        if (evt.kind === "join") {
          // Avoid duplicates.
          if (s.nearby.some((n) => n.socketId === evt.socketId)) return s;
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
      // join their session via the existing Path A receiver flow.
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
      // Use the SAME lobby client to join the session (reuse the socket).
      lobby.joinSession(sid, deviceInfo());
      lobby.onSessionJoined = ({ sender }) => {
        patch({ phase: "waiting", peerDevice: sender?.name ? { label: sender.name, short: sender.platform ?? "" } : null });
      };
      lobby.onSignal = (sigdata) => {
        let transfer = transferRef.current;
        if (!transfer) {
          transfer = makeTransfer("receiver", sid, lobby, patch, setState, reconnectPrevPhase);
          transferRef.current = transfer;
        }
        void transfer.handleSignal(sigdata);
      };
      lobby.onPeerLeft = () => {
        setState((s) =>
          s.phase === "done" ? s : { ...s, phase: "error", error: "The other device disconnected." },
        );
      };
      lobby.onSessionExpired = () => patch({ phase: "expired" });
      lobby.onError = (msg) => patch({ error: msg });
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

  // ---- Receiver: auto-join (Path A) OR fetch stored files (Path B) on mount ----
  useEffect(() => {
    if (mode !== "receiver" || !sessionIdParam) return;

    let cancelled = false;

    // First, probe Path B: does this session have stored files?
    fetch(`/api/beam/store/list?sessionId=${encodeURIComponent(sessionIdParam)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data) => {
        if (cancelled) return;
        if (data && data.ok && Array.isArray(data.files) && data.files.length > 0) {
          // ---- PATH B (receiver) ----
          patch({
            phase: "connected",
            peerDevice: { label: "Stored transfer", short: "stored" },
            storeMode: true,
            files: data.files.map((f: any) => ({
              id: f.id,
              name: f.name,
              size: f.size,
              mime: f.mime,
              received: 0,
              status: "queued" as const,
            })),
            totalBytes: data.files.reduce((a: number, b: any) => a + (b.size as number), 0),
            storeExpiresAt: new Date(data.expiresAt).getTime(),
          });
        } else {
          // ---- PATH A (receiver) — join the signaling session ----
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
        }
      })
      .catch(() => {
        // Network error probing — fall back to Path A.
        if (cancelled) return;
        const signaling = new SignalingClient();
        signalingRef.current = signaling;
        signaling.onConnect = () => signaling.joinSession(sessionIdParam, deviceInfo());
        signaling.onSessionJoined = ({ sender }) =>
          patch({ phase: "waiting", peerDevice: sender?.name ? labelToDescriptor(sender.name) : null });
        signaling.onError = (msg) => {
          if (/not found|expired/i.test(msg)) patch({ phase: "expired", error: msg });
        };
        signaling.onSessionExpired = () => patch({ phase: "expired" });
        signaling.onSignal = (sigdata) => {
          let transfer = transferRef.current;
          if (!transfer) {
            transfer = makeTransfer("receiver", sessionIdParam, signaling!, patch, setState, reconnectPrevPhase);
            transferRef.current = transfer;
          }
          void transfer.handleSignal(sigdata);
        };
      });

    return () => {
      cancelled = true;
      transferRef.current?.releaseAll();
      transferRef.current?.close();
      signalingRef.current?.disconnect();
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
        storeExpiresAt: storeModeRef.current ? now + SESSION_TTL_MS : null,
      });

      transferRef.current?.close();
      transferRef.current = null;

      // ---- PATH B: upload to server storage instead of WebRTC ----
      if (storeModeRef.current) {
        void uploadPathB(sessionId, files, items, patch, setState).then((ok) => {
          if (!ok) {
            patch({ phase: "error", error: "Upload failed. Try peer-to-peer mode instead." });
          } else {
            // Stay in "waiting" — the QR now points to the stored files.
            // No signaling/WebRTC needed; the receiver fetches on scan.
          }
        });
        return;
      }

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
   *  offer flow runs just like the QR path. The files must already be selected
   *  (in rawFilesRef) before calling this. */
  const sendToNearby = useCallback(
    (socketId: string, deviceLabel?: string) => {
      const files = rawFilesRef.current;
      if (files.length === 0) return;
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
        storeExpiresAt: null,
      });
      // Wire the lobby client as the session signaling transport.
      transferRef.current?.close();
      transferRef.current = null;
      lobby.onSessionCreated = () => {
        // Now invite the target device — they'll join-session on receipt.
        lobby.invite(socketId, sessionId, deviceInfo(), items.map((f) => ({ name: f.name, size: f.size, mime: f.mime })));
      };
      lobby.onPeerJoined = ({ receiver }) => {
        patch({ peerDevice: receiver?.name ? labelToDescriptor(receiver.name) : null });
        const transfer = makeTransfer("sender", sessionId, lobby, patch, setState, reconnectPrevPhase);
        transfer.queueFiles(rawFilesRef.current);
        transferRef.current = transfer;
        void transfer.createOffer();
      };
      lobby.onSignal = (data) => transferRef.current?.handleSignal(data);
      lobby.onPeerLeft = () => {
        setState((s) =>
          s.phase === "done"
            ? s
            : { ...s, phase: "error", error: "The other device disconnected before the transfer finished." },
        );
      };
      lobby.onSessionExpired = () => patch({ phase: "expired" });
      lobby.onError = (msg) => patch({ error: msg });
      // Create the session via the lobby socket.
      lobby.createSession(sessionId, deviceInfo());
    },
    [patch],
  );

  // ---- Path B receiver: download a single stored file (one-time-use) ----
  const downloadStored = useCallback(async (fileId: string) => {
    // Mark transferring, fetch the bytes (this consumes the link server-side).
    setState((s) => ({
      ...s,
      files: s.files.map((f) => (f.id === fileId ? { ...f, status: "transferring" } : f)),
    }));
    const meta = state.files.find((f) => f.id === fileId);
    try {
      const res = await fetch(`/api/beam/store?id=${encodeURIComponent(fileId)}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: "Download failed" }));
        setState((s) => ({
          ...s,
          files: s.files.map((f) => (f.id === fileId ? { ...f, status: "error" } : f)),
          error: j.error ?? "Download failed",
        }));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setState((s) => ({
        ...s,
        files: s.files.map((f) =>
          f.id === fileId
            ? {
                ...f,
                status: "done",
                received: f.size,
                url,
                text: isTextLike(f.name, f.mime) && f.size <= 256 * 1024 ? undefined : f.text,
                imageUrl: isImageLike(f.name, f.mime) ? url : f.imageUrl,
              }
            : f,
        ),
      }));
      // If it's a small text file, read it for preview.
      if (meta && isTextLike(meta.name, meta.mime) && meta.size > 0 && meta.size <= 256 * 1024) {
        const text = await blob.text();
        setState((s) => ({
          ...s,
          files: s.files.map((f) => (f.id === fileId ? { ...f, text } : f)),
        }));
      }
    } catch (e) {
      setState((s) => ({
        ...s,
        files: s.files.map((f) => (f.id === fileId ? { ...f, status: "error" } : f)),
        error: String(e),
      }));
    }
  }, [state.files]);

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
      if (s.storeMode) return s; // Path B: no mid-flight queue changes after upload
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
      setStoreMode,
      downloadStored,
    }),
    [
      state, beginSending, sendToNearby, reset, cancel, saveFile, shareImage, shareAll, copyAllText,
      copyLink, removeFile, addMoreFiles, reorderFiles, sendPastedText, setStoreMode, downloadStored,
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
      receivedBytes: s.totalBytes,
      files: s.files.map((f) => ({ ...f, status: "done" as const, received: f.size })),
    }));
  };
  t.onCancel = () => patch({ phase: "error", error: "Transfer cancelled by the other device." });

  return t;
}

// ---- Path B: upload all files to encrypted server storage ----
async function uploadPathB(
  sessionId: string,
  files: File[],
  items: FileItem[],
  patch: (p: Partial<SessionState>) => void,
  setState: React.Dispatch<React.SetStateAction<SessionState>>,
): Promise<boolean> {
  let uploaded = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const meta = items[i];
    setState((s) => ({
      ...s,
      files: s.files.map((f) => (f.id === meta.id ? { ...f, status: "transferring" } : f)),
    }));
    try {
      const fd = new FormData();
      fd.append("sessionId", sessionId);
      fd.append("name", file.name);
      fd.append("mime", file.type || "application/octet-stream");
      fd.append("file", file, file.name);
      const res = await fetch("/api/beam/store", { method: "POST", body: fd });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "upload failed");
      uploaded++;
      setState((s) => ({
        ...s,
        files: s.files.map((f) =>
          f.id === meta.id ? { ...f, status: "done", received: f.size, id: data.fileId ?? f.id } : f,
        ),
        receivedBytes: s.receivedBytes + file.size,
      }));
    } catch {
      return false;
    }
  }
  // Mark waiting state — QR now points to stored files.
  patch({ phase: "waiting", error: null });
  void uploaded;
  return true;
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

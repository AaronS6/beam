"use client";

/**
 * useBeamSession, orchestrates the signaling + WebRTC lifecycle (Path A) AND
 * the temporary-storage fallback (Path B), exposing a single state object.
 *
 * Path A (default): true peer-to-peer over parallel WebRTC DataChannels.
 *   Nothing is stored anywhere. QR/session expires after 5 min if no peer connects.
 * Path B (opt-in "Store temporarily"): files upload once to encrypted server
 *   storage; auto-delete within 5 min OR the instant the receiver finishes
 *   downloading, one-time-use. The backend enforces both ceilings; the client
 *   countdown is just a courtesy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignalingClient, type RelayShare } from "@/lib/signaling";
import {
  BeamTransfer,
  getIceServers,
  type IncomingFile,
  type TransferState,
} from "@/lib/webrtc";
import { genSessionId, deviceInfo, detectDevice, type DeviceDescriptor } from "@/lib/format";
import { generateTransferKey, importTransferKey } from "@/lib/crypto";
import { encryptAndUpload, downloadAndDecrypt, deleteShare } from "@/lib/relay";
import {
  getTransferMode,
  setTransferMode as persistTransferMode,
  readKeyFromUrlFragment,
  type TransferMode,
} from "@/lib/transfer-mode";

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
/** Debounce for "peer-left" events. socket.io auto-reconnects on transient
 *  network blips, killing the session immediately on the first disconnect
 *  is the #1 cause of "stuck at connecting" when the user's wifi flutters.
 *  We wait this long to see if the peer rejoins before showing an error. */
const PEER_LEFT_GRACE_MS = 3000;

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
  /** Sender-side: true once the sender has sent every chunk + the "done"
   *  control message and is WAITING for the receiver's "all-received" ack.
   *  The UI uses this to swap "Beaming to X" → "Finishing up on X, keep
   *  this app open" so the user doesn't close the sender phone while the
   *  receiver is still draining late chunks + reassembling blobs. */
  finishing: boolean;
  /** Transfer mode the user picked (persisted in localStorage). "auto" = try
   *  P2P then fall back to the encrypted relay; "p2p" = direct only; "relay"
   *  = encrypted server relay only. */
  transferMode: TransferMode;
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
  finishing: false,
  transferMode: "relay",
  nearby: [],
};

export function useBeamSession(sessionIdParam?: string | null) {
  const mode: "sender" | "receiver" = sessionIdParam ? "receiver" : "sender";

  const [state, setState] = useState<SessionState>({
    ...INITIAL,
    mode,
    phase: mode === "receiver" ? "waiting" : "idle",
    sessionId: mode === "receiver" ? sessionIdParam! : null,
    // Read the persisted transfer mode on first render so the toggle shows
    // the user's last choice immediately (and the relay/P2P branch in
    // beginSending uses it).
    transferMode: getTransferMode(),
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
  // peer-left debounce timer, socket.io auto-reconnects, so a brief signaling
  // disconnect shouldn't immediately kill the session. We wait PEER_LEFT_GRACE_MS
  // to see if the peer comes back; if they do (server re-emits peer-joined),
  // we cancel the timer and the user keeps their transfer.
  const peerLeftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Relay-path refs. `transferModeRef` + `phaseRef` mirror state so callbacks
  // (beginSending, onPeerJoined, onSignal, timers) read the CURRENT values
  // without re-creating on every state change. `keyRef` holds the AES key
  // (base64url) for the current session, generated in beginSending for
  // auto/relay modes, put in the QR fragment, read by the receiver from the
  // URL fragment. `relayFallbackTimerRef` is the auto-mode 8s "P2P taking too
  // long → pivot to relay" timer.
  const transferModeRef = useRef<TransferMode>(state.transferMode);
  const phaseRef = useRef<Phase>(state.phase);
  const keyRef = useRef<string | null>(null);
  const relayFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Relay-path ack: the sender waits for the receiver's "relay-complete"
  // signal before showing "All delivered" (otherwise it'd say done while the
  // receiver is still downloading). Same pattern as the P2P "all-received"
  // ack, but over the signaling socket (relay has no WebRTC channel).
  const relayAckResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const relayAckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { transferModeRef.current = state.transferMode; }, [state.transferMode]);
  useEffect(() => { phaseRef.current = state.phase; }, [state.phase]);
  // Receiver: read the decryption key from the URL fragment on mount.
  useEffect(() => {
    if (mode === "receiver") {
      keyRef.current = readKeyFromUrlFragment();
    }
  }, [mode]);

  const patch = useCallback((p: Partial<SessionState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  // ---- Relay-path ack (declared early so beginSending/sendToNearby can
  // reference it). The sender waits for the receiver's "relay-complete"
  // signal before showing "All delivered", so the sender doesn't say done
  // while the receiver is still downloading. Mirrors the P2P all-received
  // ack but over the signaling socket. ----
  const resolveRelayAck = useCallback((ok: boolean) => {
    if (relayAckResolverRef.current) {
      const r = relayAckResolverRef.current;
      relayAckResolverRef.current = null;
      r(ok);
    }
    if (relayAckTimerRef.current) {
      clearTimeout(relayAckTimerRef.current);
      relayAckTimerRef.current = null;
    }
  }, []);
  const waitForRelayAck = useCallback((): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      relayAckResolverRef.current = resolve;
      // 20s fallback: if the receiver never acks (closed early, flaky
      // socket), show done anyway so the sender doesn't hang forever.
      relayAckTimerRef.current = setTimeout(() => resolveRelayAck(false), 20000);
    });
  }, [resolveRelayAck]);

  /** Schedule a peer-left error after PEER_LEFT_GRACE_MS. If a peer-joined /
   *  session-joined / re-join event arrives before the timer fires, cancel it
   *  so the user keeps their transfer across brief signaling socket blips. */
  const schedulePeerLeftError = useCallback((errorMsg: string) => {
    if (peerLeftTimerRef.current) clearTimeout(peerLeftTimerRef.current);
    peerLeftTimerRef.current = setTimeout(() => {
      peerLeftTimerRef.current = null;
      setState((s) =>
        s.phase === "done" || s.phase === "error"
          ? s
          : { ...s, phase: "error", error: errorMsg },
      );
    }, PEER_LEFT_GRACE_MS);
  }, []);

  /** Cancel a pending peer-left error, called whenever we get evidence the
   *  peer is back (peer-joined, session-joined, any signal received). */
  const cancelPeerLeftError = useCallback(() => {
    if (peerLeftTimerRef.current) {
      clearTimeout(peerLeftTimerRef.current);
      peerLeftTimerRef.current = null;
    }
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
      // Clear the nearby list on disconnect, will repopulate on reconnect
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
      // Stash the sender's relay encryption key (if the sender is using
      // relay/auto mode) so the relay-meta handler can decrypt with it.
      if (payload.keyB64) keyRef.current = payload.keyB64;
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
        cancelPeerLeftError();
        patch({ phase: "waiting", peerDevice: sender?.name ? { label: sender.name, short: sender.platform ?? "" } : null });
      };
      sessionSignaling.onSignal = (sigdata) => {
        cancelPeerLeftError();
        // Relay path (same handler shape as the QR-receiver path).
        if (sigdata.kind === "relay-start") {
          handleRelayStart(sigdata.payload.files, setState);
          return;
        }
        if (sigdata.kind === "relay-meta") {
          const keyB64 = keyRef.current;
          if (!keyB64) {
            patch({ phase: "error", error: "Decryption key missing from the URL, ask the sender to invite you again." });
            return;
          }
          void runReceiverRelay(sigdata.payload.files, keyB64, sessionSignaling, sid, patch, setState);
          return;
        }
        let transfer = transferRef.current;
        if (!transfer) {
          transfer = makeTransfer("receiver", sid, sessionSignaling, patch, setState, reconnectPrevPhase);
          transferRef.current = transfer;
        }
        void transfer.handleSignal(sigdata);
      };
      sessionSignaling.onPeerLeft = () => {
        schedulePeerLeftError("The other device disconnected.");
      };
      sessionSignaling.onSessionExpired = () => patch({ phase: "expired" });
      sessionSignaling.onError = (msg) => patch({ error: msg });
    };
    return () => {
      lobby.leaveLobby();
      lobby.disconnect();
      lobbyRef.current = null;
    };
  }, [patch, cancelPeerLeftError, schedulePeerLeftError]);

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
      cancelPeerLeftError();
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
      // Don't immediately error, wait PEER_LEFT_GRACE_MS for the peer to
      // come back. Brief signaling disconnects are common on mobile.
      schedulePeerLeftError("The other device disconnected.");
    };
    signaling.onSignal = (sigdata) => {
      cancelPeerLeftError();
      // RELAY path: the sender (on a different network) encrypted + uploaded
      // the files to /api/share and sent us the share manifest. We fetch +
      // decrypt each one locally with the key from the URL fragment. The
      // signaling server only relayed the tiny manifest, never file bytes.
      if (sigdata.kind === "relay-start") {
        handleRelayStart(sigdata.payload.files, setState);
        return;
      }
      if (sigdata.kind === "relay-meta") {
        const keyB64 = keyRef.current;
        if (!keyB64) {
          patch({ phase: "error", error: "This transfer was sent via the encrypted relay, but the decryption key is missing from the URL. Ask the sender to share the QR link again." });
          return;
        }
        void runReceiverRelay(sigdata.payload.files, keyB64, signaling, sessionIdParam, patch, setState);
        return;
      }
      // P2P path: WebRTC offer/answer/candidate.
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
  }, [mode, sessionIdParam, cancelPeerLeftError, schedulePeerLeftError]);

  // ---- Sender actions ----
  const sendToNearbyRef = useRef<((socketId: string, deviceLabel?: string) => void) | null>(null);

  const beginSending = useCallback(
    async (files: File[]) => {
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
      const now = Date.now();

      // Generate the per-session AES-GCM key for auto/relay modes. The relay
      // path needs it to encrypt; auto needs it so the QR carries it in case
      // P2P fails + we fall back to relay. p2p-only mode skips it (cleaner QR).
      // The key goes in the URL FRAGMENT (#k=...) which browsers never send to
      // the server, so the signaling relay + the Next.js server never see it.
      const m = transferModeRef.current;
      let keyB64: string | null = null;
      if (m !== "p2p") {
        keyB64 = await generateTransferKey();
        keyRef.current = keyB64;
      } else {
        keyRef.current = null;
      }
      const fragment = keyB64 ? `#k=${keyB64}` : "";
      const qrUrl = `${origin}/?r=${sessionId}${fragment}`;

      patch({
        sessionId,
        qrUrl,
        files: items,
        totalBytes: total,
        receivedBytes: 0,
        phase: "waiting",
        error: null,
        createdAt: now,
        transferMode: m,
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
        // Peer came back (or joined fresh), cancel any pending peer-left
        // error that was queued during a brief signaling disconnect.
        cancelPeerLeftError();
        const m = transferModeRef.current;
        const keyB64 = keyRef.current;
        // RELAY mode: skip WebRTC entirely + go STRAIGHT to transferring.
        // No "connecting" flicker (the relay path is server-mediated, not
        // ICE, so there's nothing to negotiate). Previously this patched
        // "connecting" first, which flashed "Connecting…" for a frame +
        // made the user think it was using peer-to-peer.
        if (m === "relay" && keyB64) {
          patch({
            peerDevice: receiver?.name ? labelToDescriptor(receiver.name) : null,
            phase: "transferring",
            transferStartedAt: Date.now(),
            transferEndedAt: null,
            peakSpeed: 0,
            error: null,
            finishing: false,
          });
          void runSenderRelay(sid, signaling, rawFilesRef.current, keyB64, patch, setState, waitForRelayAck);
          return;
        }
        // P2P or AUTO: show "Connecting…" while ICE negotiates.
        patch({
          peerDevice: receiver?.name ? labelToDescriptor(receiver.name) : null,
          phase: "connecting",
        });
        // P2P or AUTO: set up WebRTC.
        const transfer = makeTransfer("sender", sid, signaling, patch, setState, reconnectPrevPhase);
        transfer.queueFiles(rawFilesRef.current);
        transferRef.current = transfer;
        void transfer.createOffer();
        // AUTO: if P2P can't connect (onFailed) OR doesn't reach
        // "transferring" within 8s, pivot to the encrypted relay. The
        // receiver already has the key from the QR fragment, so the fallback
        // is seamless, the user doesn't need to do anything.
        if (m === "auto" && keyB64) {
          const pivotToRelay = () => {
            if (relayFallbackTimerRef.current) { clearTimeout(relayFallbackTimerRef.current); relayFallbackTimerRef.current = null; }
            try { transfer.close(); } catch { /* ignore */ }
            transferRef.current = null;
            patch({ phase: "transferring", error: null, transferStartedAt: Date.now(), transferEndedAt: null, peakSpeed: 0, finishing: false });
            void runSenderRelay(sid, signaling, rawFilesRef.current, keyB64, patch, setState, waitForRelayAck);
          };
          // Override the P2P onFailed (which would normally error) → pivot.
          transfer.onFailed = () => pivotToRelay();
          // 8s safety: if P2P hasn't reached "transferring" by then, pivot.
          // (onChannelOpen sets phase="transferring" → the check skips.)
          relayFallbackTimerRef.current = setTimeout(() => {
            if (phaseRef.current !== "transferring" && phaseRef.current !== "done") {
              pivotToRelay();
            }
          }, 8000);
        }
      };
      signaling.onSignal = (data) => {
        // Any signal from the peer means they're alive, cancel pending errors.
        cancelPeerLeftError();
        // Relay-path ack: the receiver finished downloading + decrypting.
        // Resolve the sender's waitForRelayAck so it can show "All delivered"
        // only once the receiver actually has the files (was previously
        // premature, the sender said done while the receiver was still
        // downloading).
        if (data.kind === "relay-complete") {
          resolveRelayAck(true);
          return;
        }
        transferRef.current?.handleSignal(data);
      };
      signaling.onPeerLeft = () => {
        // Don't immediately go to error, socket.io auto-reconnects on brief
        // network blips. Wait PEER_LEFT_GRACE_MS for the peer to come back.
        schedulePeerLeftError("The receiver disconnected before the transfer finished.");
      };
      signaling.onSessionExpired = () => patch({ phase: "expired" });
      signaling.onError = (msg) => patch({ error: msg });
      void getIceServers;
    },
    [patch, cancelPeerLeftError, schedulePeerLeftError],
  );

  /** Sender: pick a nearby device (by socketId) to send the selected files to.
   *  Creates a session + sends an invite; when the invitee joins, the WebRTC
   *  offer flow runs just like the QR path. Uses a SEPARATE SignalingClient
   *  for the session (not the lobby socket) so handlers don't collide. */
  const sendToNearby = useCallback(
    async (socketId: string, deviceLabel?: string) => {
      const files = rawFilesRef.current;
      // If no files selected yet, open the file picker. Once the user picks
      // files, beginSending() runs, but we stash the intended nearby target
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
        patch({ error: "Not connected to nearby discovery yet, try again in a moment." });
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

      // Generate the relay key (for auto/relay modes). For nearby there's no
      // QR to carry the key in a URL fragment, so we pass it via the invite
      // payload (transits the user's own signaling server over WSS). The
      // invitee stores it in keyRef via the onInvite handler.
      const m = transferModeRef.current;
      let keyB64: string | null = null;
      if (m !== "p2p") {
        keyB64 = await generateTransferKey();
        keyRef.current = keyB64;
      } else {
        keyRef.current = null;
      }

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
        transferMode: m,
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
        // Session is created, now invite the target device via the LOBBY
        // socket. The invitee's lobby onInvite handler will make them join
        // this session. Pass the relay key so the invitee can decrypt (only
        // when using auto/relay mode).
        lobby.invite(
          socketId,
          sessionId,
          deviceInfo(),
          items.map((f) => ({ name: f.name, size: f.size, mime: f.mime })),
          keyB64 ?? undefined,
        );
      };
      signaling.onPeerJoined = ({ receiver }) => {
        cancelPeerLeftError();
        const m = transferModeRef.current;
        const keyB64 = keyRef.current;
        // RELAY mode: skip WebRTC, go straight to transferring (no
        // "connecting" flicker, same as the QR path).
        if (m === "relay" && keyB64) {
          patch({
            peerDevice: receiver?.name ? labelToDescriptor(receiver.name) : null,
            phase: "transferring",
            transferStartedAt: Date.now(),
            transferEndedAt: null,
            peakSpeed: 0,
            error: null,
            finishing: false,
          });
          void runSenderRelay(sessionId, signaling, rawFilesRef.current, keyB64, patch, setState, waitForRelayAck);
          return;
        }
        // P2P or AUTO: show "Connecting…" while ICE negotiates.
        patch({
          peerDevice: receiver?.name ? labelToDescriptor(receiver.name) : null,
          phase: "connecting",
        });
        // P2P or AUTO: set up WebRTC.
        const transfer = makeTransfer("sender", sessionId, signaling, patch, setState, reconnectPrevPhase);
        transfer.queueFiles(rawFilesRef.current);
        transferRef.current = transfer;
        void transfer.createOffer();
        // AUTO: 8s relay fallback (same as the QR path).
        if (m === "auto" && keyB64) {
          const pivotToRelay = () => {
            if (relayFallbackTimerRef.current) { clearTimeout(relayFallbackTimerRef.current); relayFallbackTimerRef.current = null; }
            try { transfer.close(); } catch { /* ignore */ }
            transferRef.current = null;
            patch({ phase: "transferring", error: null, transferStartedAt: Date.now(), transferEndedAt: null, peakSpeed: 0, finishing: false });
            void runSenderRelay(sessionId, signaling, rawFilesRef.current, keyB64, patch, setState, waitForRelayAck);
          };
          transfer.onFailed = () => pivotToRelay();
          relayFallbackTimerRef.current = setTimeout(() => {
            if (phaseRef.current !== "transferring" && phaseRef.current !== "done") {
              pivotToRelay();
            }
          }, 8000);
        }
      };
      signaling.onSignal = (data) => {
        cancelPeerLeftError();
        // Relay-path ack: the receiver finished downloading + decrypting.
        // Resolve the sender's waitForRelayAck so it can show "All delivered"
        // only once the receiver actually has the files (was previously
        // premature, the sender said done while the receiver was still
        // downloading).
        if (data.kind === "relay-complete") {
          resolveRelayAck(true);
          return;
        }
        transferRef.current?.handleSignal(data);
      };
      signaling.onPeerLeft = () => {
        schedulePeerLeftError("The other device disconnected before the transfer finished.");
      };
      signaling.onSessionExpired = () => patch({ phase: "expired" });
      signaling.onError = (msg) => patch({ error: msg });
      void getIceServers;
    },
    [patch, cancelPeerLeftError, schedulePeerLeftError],
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
    if (peerLeftTimerRef.current) {
      clearTimeout(peerLeftTimerRef.current);
      peerLeftTimerRef.current = null;
    }
    if (relayFallbackTimerRef.current) {
      clearTimeout(relayFallbackTimerRef.current);
      relayFallbackTimerRef.current = null;
    }
    // Settle any pending relay-ack wait so it doesn't hang across a reset.
    resolveRelayAck(false);
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
    // CRITICAL FIX: preserve the user's chosen transferMode across reset.
    // Previously reset used `...INITIAL` which hardcoded transferMode: "auto",
    // so pressing Done + adding a new file flipped Relay back to Auto — and
    // then the next transfer used Auto (P2P first) instead of Relay, which
    // is why "relay sometimes felt like auto". Now we keep the persisted choice.
    patch({ ...INITIAL, mode, sessionId: mode === "receiver" ? sessionIdParam ?? null : null, transferMode: transferModeRef.current });
  }, [mode, patch, sessionIdParam]);

  const cancel = useCallback(() => {
    if (peerLeftTimerRef.current) {
      clearTimeout(peerLeftTimerRef.current);
      peerLeftTimerRef.current = null;
    }
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
    const joined = texts.join("\n\n—, —\n\n");
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

  /** Change the transfer mode (Auto / Same network / Different networks) and
   *  persist it to localStorage so it sticks across sessions, exactly what
   *  the user asked for ("keep it next time you open the site or until you
   *  change it"). Only applies to the NEXT transfer (the current QR/session
   *  is already locked to its mode at creation time). */
  const changeTransferMode = useCallback((m: TransferMode) => {
    persistTransferMode(m);
    transferModeRef.current = m;
    setState((s) => ({ ...s, transferMode: m }));
  }, []);

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
      changeTransferMode,
    }),
    [
      state, beginSending, sendToNearby, reset, cancel, saveFile, shareImage, shareAll,
      copyAllText, copyLink, removeFile, addMoreFiles, reorderFiles, sendPastedText,
      changeTransferMode,
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
      // New transfer starting, clear any stale "finishing" flag from a
      // previous run.
      finishing: false,
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
  // Sender has sent every chunk + the "done" message and is now waiting for
  // the receiver's "all-received" ack. Flip the UI to a "finishing up —
  // keep this app open" state so the user doesn't close the sender phone
  // (which would tear down the WebRTC connection and strand the receiver
  // at 100% with no Download button).
  t.onSenderFinishing = () => patch({ finishing: true });

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
  // A single file couldn't be completed (connection died mid-file → we ended
  // up with fewer bytes than expected). Mark it errored INSTEAD of leaving it
  // "transferring" at 100% with a corrupt blob URL, which is what produced
  // the "photos turn black" symptom (a partial image renders as black/blank).
  t.onFileError = (file: IncomingFile, reason: string) => {
    setState((s) => ({
      ...s,
      files: s.files.map((f) =>
        f.id === file.id
          ? { ...f, status: "error" as const, received: f.size, url: undefined }
          : f,
      ),
      error: s.error ?? `${file.name}: ${reason}`,
    }));
  };
  t.onFileComplete = (file: IncomingFile, url: string) => {
    // CRITICAL FIX for "stuck at 100% with no download button":
    // Mark the file done + set the URL SYNCHRONOUSLY for ALL file types.
    // The text/image fetch happens in the background and patches `text` /
    // `imageUrl` in afterwards, the Download button renders immediately.
    // (Previously the text branch awaited fetch(url).then(r => r.text())
    // before marking done, so the user saw 100% with no button for the
    // fetch duration, which could be 100s of ms or never resolve if the
    // blob URL fetch was somehow interrupted.)
    const isText = isTextLike(file.name, file.mime);
    const isImage = isImageLike(file.name, file.mime);
    setState((s) => ({
      ...s,
      files: s.files.map((f) =>
        f.id === file.id
          ? { ...f, status: "done" as const, received: f.size, url }
          : f,
      ),
    }));
    // Side-load text content (small text-like files) in the background.
    if (url && isText && file.size > 0 && file.size <= 256 * 1024) {
      fetch(url)
        .then((r) => r.text())
        .then((text) => {
          setState((s) => ({
            ...s,
            files: s.files.map((f) =>
              f.id === file.id ? { ...f, text } : f,
            ),
          }));
        })
        .catch(() => { /* URL already set; text is optional */ });
    }
    // Side-load image preview URL in the background (only for small images
    // where reusing the object URL is fine, the FileRow already shows it).
    if (url && isImage && file.size > 0 && file.size <= 16 * 1024 * 1024) {
      setState((s) => ({
        ...s,
        files: s.files.map((f) =>
          f.id === file.id ? { ...f, imageUrl: url } : f,
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
      // The wait is over (receiver acked, or 20s fallback). Either way the
      // sender is no longer "finishing".
      finishing: false,
      // SENDER: mark all files as done (they were sent, no URL needed).
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
    // (finalizeFile should have finished by then), force them to "done" and
    // ALSO recover any URL that finalizeFile created but onFileComplete didn't
    // get to apply (e.g., the React state batch raced). This prevents a
    // permanent stuck state if finalizeFile somehow doesn't fire onAllComplete.
    if (role === "receiver") {
      setTimeout(() => {
        setState((s) => ({
          ...s,
          files: s.files.map((f) => {
            if (f.status === "transferring") {
              // Try to recover the URL from the transfer's incoming map
              // (it may have been finalized but the onFileComplete callback
              // raced with the React state update).
              const recoveredUrl = t.getFinalizedUrl(f.id);
              return {
                ...f,
                status: "done" as const,
                received: f.size,
                url: f.url ?? recoveredUrl,
              };
            }
            // Also catch any "done" file that somehow has no URL.
            if (f.status === "done" && !f.url) {
              const recoveredUrl = t.getFinalizedUrl(f.id);
              return recoveredUrl ? { ...f, url: recoveredUrl } : f;
            }
            return f;
          }),
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
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "heic", "heif"].includes(ext);
}

// ---------------------------------------------------------------------------
// Relay path (Option B, encrypted server relay for cross-network transfers)
// ---------------------------------------------------------------------------
// The sender encrypts each file client-side (AES-GCM), uploads the ciphertext
// to /api/relay, and sends the receiver a `relay-meta` signal with the share
// IDs (tiny, just IDs, no file bytes). The receiver fetches each share,
// decrypts with the key from the URL fragment, and reuses the exact same
// onFileStart/onFileProgress/onFileComplete-style state updates so the UI is
// identical to the P2P path.

/** Sender relay: encrypt + upload each file, send the share manifest to the
 *  receiver via the signaling server, then mark the phase done. */

/** Receiver: handle a `relay-start` signal (sent by the sender the instant it
 *  begins the relay upload, BEFORE the upload completes). Shows the file list
 *  + "Receiving files" immediately so the receiver isn't stuck on the dark
 *  "Connecting…" screen for the entire upload duration (which looked like a
 *  stuck black screen). The IDs match runReceiverRelay's (`relay-${i}`) so
 *  when relay-meta arrives + the download starts, the rows don't flicker. */
function handleRelayStart(
  manifest: { name: string; size: number; mime?: string }[],
  setState: React.Dispatch<React.SetStateAction<SessionState>>,
) {
  const items: FileItem[] = manifest.map((f, i) => ({
    id: `relay-${i}`,
    name: f.name,
    size: f.size,
    mime: f.mime,
    received: 0,
    status: "queued" as const,
  }));
  setState((s) => ({
    ...s,
    files: items,
    totalBytes: items.reduce((a, b) => a + b.size, 0),
    receivedBytes: 0,
    phase: "transferring",
    transferStartedAt: Date.now(),
    transferEndedAt: null,
    error: null,
  }));
}

async function runSenderRelay(
  sessionId: string,
  signaling: SignalingClient,
  files: File[],
  keyB64: string,
  patch: (p: Partial<SessionState>) => void,
  setState: React.Dispatch<React.SetStateAction<SessionState>>,
  waitForAck: () => Promise<boolean>,
) {
  try {
    const key = await importTransferKey(keyB64);
    // Send a relay-start signal IMMEDIATELY (before the upload) so the
    // receiver stops showing "Connecting…" + shows "Receiving files" with
    // the file list right away. Without this, the receiver sits on the dark
    // "Connecting…" screen for the entire upload duration (which can be a
    // few seconds for larger files), which looks like a stuck black screen.
    signaling.sendSignal(sessionId, {
      kind: "relay-start",
      payload: {
        files: files.map((f) => ({ name: f.name || `file`, size: f.size, mime: f.type || undefined })),
      },
    });
    let receivedBytes = 0;
    const shares: RelayShare[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Mark this file "transferring".
      setState((s) => ({
        ...s,
        phase: "transferring",
        files: s.files.map((f, idx) => (idx === i ? { ...f, status: "transferring" as const } : f)),
      }));
      try {
        const share = await encryptAndUpload(file, key, (loaded, total) => {
          // Scale ciphertext upload progress → original file bytes.
          const received = total > 0 ? Math.min(file.size, Math.round((loaded / total) * file.size)) : 0;
          setState((s) => {
            let rb = 0;
            const fs = s.files.map((f, idx) => {
              if (idx === i) { rb += received; return { ...f, received, status: "transferring" as const }; }
              rb += f.received; return f;
            });
            return { ...s, files: fs, receivedBytes: rb };
          });
        });
        shares.push(share);
        receivedBytes += file.size;
        // Sender-side: the receiver has the blob, so mark this file done
        // (no URL on the sender, only the receiver builds one).
        setState((s) => ({
          ...s,
          files: s.files.map((f, idx) => (idx === i ? { ...f, status: "done" as const, received: f.size } : f)),
          receivedBytes,
        }));
      } catch (e) {
        // CRITICAL: push a FAILED share entry so the receiver still knows this
        // file exists + can mark it errored. Previously the catch only marked
        // the file errored on the SENDER side + skipped pushing a share, so
        // the relay-meta manifest was missing the failed file → the receiver
        // rebuilt its file list from the (incomplete) manifest + silently
        // dropped the failed file ("not all pictures sent" for multi-file
        // transfers). Now every file gets an entry (successful with id, failed
        // with failed=true) so the receiver's list always matches the sender's.
        shares.push({ name: file.name || `file`, size: file.size, mime: file.type || undefined, failed: true });
        setState((s) => ({
          ...s,
          files: s.files.map((f, idx) => (idx === i ? { ...f, status: "error" as const } : f)),
          error: s.error ?? `${file.name}: ${String(e)}`,
        }));
      }
    }
    // Send the share manifest to the receiver via the signaling server. The
    // server relays only this tiny JSON (share IDs + original metadata),
    // never file bytes. The receiver uses the IDs to GET the ciphertext from
    // /api/relay and decrypts locally with the key from the URL fragment.
    signaling.sendSignal(sessionId, { kind: "relay-meta", payload: { files: shares } });
    // Flip to "finishing" while we wait for the receiver to confirm it
    // downloaded + decrypted everything. Previously the sender showed "All
    // delivered" the instant relay-meta was sent, which was premature, the
    // receiver was still downloading. Now we wait for the "relay-complete"
    // ack (with a 20s fallback) before declaring done.
    patch({ finishing: true });
    await waitForAck();
    setState((s) => ({ ...s, phase: "done", transferEndedAt: Date.now(), speed: 0, finishing: false }));
  } catch (e) {
    patch({ phase: "error", error: `Relay upload failed: ${String(e)}` });
  }
}

/** Receiver relay: fetch + decrypt each share, fire onFileComplete-equivalent
 *  state updates (reusing the same FileItem shape so the UI is identical to
 *  the P2P path). One-time-use: DELETE each share after a successful decrypt.
 *  Sends a `relay-complete` signal to the sender when done so it knows the
 *  receiver actually has every file (otherwise the sender would show "All
 *  delivered" while the receiver is still downloading). */
async function runReceiverRelay(
  shares: RelayShare[],
  keyB64: string,
  signaling: SignalingClient,
  sessionId: string,
  patch: (p: Partial<SessionState>) => void,
  setState: React.Dispatch<React.SetStateAction<SessionState>>,
) {
  try {
    const key = await importTransferKey(keyB64);
    // Build the file list from the shares.
    const items: FileItem[] = shares.map((sh, i) => ({
      id: `relay-${i}`,
      name: sh.name,
      size: sh.size,
      mime: sh.mime,
      received: 0,
      status: "queued" as const,
    }));
    setState((s) => ({
      ...s,
      files: items,
      totalBytes: items.reduce((a, b) => a + b.size, 0),
      receivedBytes: 0,
      phase: "transferring",
      transferStartedAt: Date.now(),
      transferEndedAt: null,
      error: null,
    }));
    for (let i = 0; i < shares.length; i++) {
      const sh = shares[i];
      const id = items[i].id;
      // FAILED upload (the sender pushed a share with failed=true). Mark the
      // file errored on the receiver + skip the download — don't silently
      // drop it. The user sees which file failed + can ask the sender to
      // re-send just that one.
      if (sh.failed) {
        setState((s) => ({
          ...s,
          files: s.files.map((f) => (f.id === id ? { ...f, status: "error" as const } : f)),
          error: s.error ?? `${sh.name}: upload failed on the sender's side`,
        }));
        continue;
      }
      setState((s) => ({
        ...s,
        files: s.files.map((f) => (f.id === id ? { ...f, status: "transferring" as const } : f)),
      }));
      try {
        const { url, name, size, mime } = await downloadAndDecrypt(sh.id!, key, (loaded, total) => {
          const received = total > 0 ? Math.min(size, Math.round((loaded / total) * size)) : 0;
          setState((s) => {
            let rb = 0;
            const fs = s.files.map((f) => {
              if (f.id === id) { rb += received; return { ...f, received, status: "transferring" as const }; }
              rb += f.received; return f;
            });
            return { ...s, files: fs, receivedBytes: rb };
          });
        }, sh.chunkIds, sh.size, { name: sh.name, mime: sh.mime });
        // Mark done + set the blob URL (same shape as the P2P onFileComplete).
        setState((s) => ({
          ...s,
          files: s.files.map((f) => (f.id === id ? { ...f, status: "done" as const, received: f.size, url, mime } : f)),
        }));
        // Side-load text/image previews (same as the P2P path).
        if (url && isTextLike(name, mime) && size > 0 && size <= 256 * 1024) {
          fetch(url).then((r) => r.text()).then((text) => setState((s) => ({ ...s, files: s.files.map((f) => (f.id === id ? { ...f, text } : f)) }))).catch(() => {});
        }
        if (url && isImageLike(name, mime) && size > 0 && size <= 16 * 1024 * 1024) {
          setState((s) => ({ ...s, files: s.files.map((f) => (f.id === id ? { ...f, imageUrl: url } : f)) }));
        }
        // One-time-use cleanup.
        deleteShare(sh.id!, sh.chunkIds);
      } catch (e) {
        setState((s) => ({
          ...s,
          files: s.files.map((f) => (f.id === id ? { ...f, status: "error" as const } : f)),
          error: s.error ?? `${sh.name}: ${String(e)}`,
        }));
      }
    }
    setState((s) => ({ ...s, phase: "done", transferEndedAt: Date.now(), speed: 0 }));
    // Tell the sender the receiver has every file. Without this the sender
    // would show "All delivered" the moment it sent relay-meta, while the
    // receiver was still downloading. (Best-effort, the sender has a 20s
    // fallback if this is lost.)
    try {
      signaling.sendSignal(sessionId, { kind: "relay-complete", payload: {} });
    } catch { /* best-effort */ }
  } catch (e) {
    patch({ phase: "error", error: `Relay download failed: ${String(e)}` });
  }
}

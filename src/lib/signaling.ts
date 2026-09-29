/**
 * Beam — Signaling client
 *
 * A thin wrapper around socket.io-client that speaks the Beam signaling protocol.
 * The signaling server's ONLY job is to relay WebRTC metadata (SDP offer/answer,
 * ICE candidates) between the two peers. File bytes NEVER go through here — they
 * flow directly device-to-device over an RTCDataChannel once ICE connects.
 *
 * Transport note: Caddy gateway routes the request to port 3003 via the
 * `?XTransformPort=3003` query param. The socket.io path MUST stay "/".
 */

import { io, type Socket } from "socket.io-client";

export type DeviceInfo = {
  name?: string;
  ua?: string;
  platform?: string;
};

export type NearbyDevice = {
  socketId: string;
  device: DeviceInfo;
};

export type InvitePayload = {
  sessionId: string;
  from: string;
  device: DeviceInfo;
  files?: { name: string; size: number; mime?: string }[];
  /** AES-GCM key (base64url) for the relay path. Only set when the sender
   *  picked "Different networks" / "Auto" mode. NOTE: unlike the QR path
   *  (where the key lives in the URL fragment and never hits the server),
   *  this transits the signaling server over WSS. Acceptable because the
   *  user operates their own signaling server; for a third-party signaling
   *  server, prefer the QR + relay flow instead. */
  keyB64?: string;
};

export type RelayShare = {
  /** The /api/relay share id. Absent (with failed=true) when this file's
   *  upload failed, so the receiver still knows the file exists + can mark
   *  it errored instead of silently dropping it. */
  id?: string;
  name: string;
  size: number;
  mime?: string;
  failed?: boolean;
};

export type RelayManifestEntry = { name: string; size: number; mime?: string };

export type SignalData =
  | { kind: "offer"; payload: RTCSessionDescriptionInit }
  | { kind: "answer"; payload: RTCSessionDescriptionInit }
  | { kind: "candidate"; payload: RTCIceCandidateInit }
  | { kind: "relay-start"; payload: { files: RelayManifestEntry[] } }
  | { kind: "relay-meta"; payload: { files: RelayShare[] } }
  | { kind: "relay-complete"; payload: Record<string, never> };

const SIGNALING_PORT = "3003";

export class SignalingClient {
  private socket: Socket;

  // Single-consumer event callbacks (assigned by the React hook).
  onConnect?: () => void;
  onDisconnect?: () => void;
  onSessionCreated?: (payload: { sessionId: string; createdAt: number }) => void;
  onSessionJoined?: (payload: { sessionId: string; sender: DeviceInfo }) => void;
  onPeerJoined?: (payload: { receiver: DeviceInfo }) => void;
  onPeerLeft?: () => void;
  onSignal?: (data: SignalData) => void;
  onSessionExpired?: () => void;
  onError?: (message: string) => void;
  // Lobby / nearby-device callbacks
  onLobbyList?: (devices: NearbyDevice[]) => void;
  onLobbyUpdate?: (event: { kind: "join" | "leave"; socketId: string; device?: DeviceInfo }) => void;
  onInvite?: (payload: InvitePayload) => void;

  constructor() {
    // In production: set NEXT_PUBLIC_SIGNALING_URL to the signaling server's
    // public URL (e.g. "https://beam.example.com" or "https://signal.beam.example.com").
    // In the sandbox/dev: falls back to the Caddy ?XTransformPort convention.
    const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL;
    if (signalingUrl) {
      // Production: connect directly to the signaling server URL.
      // The server runs Socket.IO with path: "/" (or "/socket.io/" if behind nginx).
      this.socket = io(signalingUrl, {
        path: process.env.NEXT_PUBLIC_SIGNALING_PATH || "/",
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 10000,
        forceNew: true,
      });
    } else {
      // Sandbox/dev: Caddy gateway routes ?XTransformPort=3003 → port 3003.
      this.socket = io(`/?XTransformPort=${SIGNALING_PORT}`, {
        path: "/",
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 10000,
        forceNew: true,
      });
    }

    this.socket.on("connect", () => this.onConnect?.());
    this.socket.on("disconnect", () => this.onDisconnect?.());

    this.socket.on("session-created", (p: { sessionId: string; createdAt: number }) =>
      this.onSessionCreated?.(p),
    );
    this.socket.on("session-joined", (p: { sessionId: string; sender: DeviceInfo }) =>
      this.onSessionJoined?.(p),
    );
    this.socket.on("peer-joined", (p: { receiver: DeviceInfo }) => this.onPeerJoined?.(p));
    this.socket.on("peer-left", () => this.onPeerLeft?.());
    this.socket.on("session-expired", () => this.onSessionExpired?.());
    this.socket.on("signal", (p: { data: SignalData }) => this.onSignal?.(p.data));
    this.socket.on("error", (p: { message: string }) => this.onError?.(p.message));
    // Lobby events
    this.socket.on("lobby-list", (p: { devices: NearbyDevice[] }) => this.onLobbyList?.(p.devices));
    this.socket.on("lobby-update", (p: { kind: "join" | "leave"; socketId: string; device?: DeviceInfo }) =>
      this.onLobbyUpdate?.(p),
    );
    this.socket.on("invite", (p: InvitePayload) => this.onInvite?.(p));
  }

  get connected() {
    return this.socket.connected;
  }

  /** Sender: create (or re-create) a session and become its sender. */
  createSession(sessionId: string, device: DeviceInfo) {
    this.socket.emit("create-session", { sessionId, device });
  }

  /** Receiver: join an existing session as the receiver. */
  joinSession(sessionId: string, device: DeviceInfo) {
    this.socket.emit("join-session", { sessionId, device });
  }

  /** Relay a WebRTC signaling message (offer / answer / ICE candidate). */
  sendSignal(sessionId: string, data: SignalData) {
    this.socket.emit("signal", { sessionId, data });
  }

  leaveSession(sessionId: string) {
    this.socket.emit("leave-session", { sessionId });
  }

  /** Join the nearby-devices lobby. Others will see this device; this device
   *  gets back the current roster via `onLobbyList`. */
  joinLobby(device: DeviceInfo) {
    this.socket.emit("join-lobby", { device });
  }

  leaveLobby() {
    this.socket.emit("leave-lobby", {});
  }

  /** Sender: invite a specific nearby device (by socketId) to receive files.
   *  The target's `onInvite` fires; they call joinSession(sessionId). `keyB64`
   *  is only set for relay/auto mode (so the invitee can decrypt the relayed
   *  ciphertext); omitted for pure-P2P mode. */
  invite(
    toSocketId: string,
    sessionId: string,
    device: DeviceInfo,
    files?: { name: string; size: number; mime?: string }[],
    keyB64?: string,
  ) {
    this.socket.emit("invite", { to: toSocketId, sessionId, device, files, keyB64 });
  }

  disconnect() {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}

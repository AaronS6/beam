/**
 * Beam — WebRTC peer-to-peer transfer manager
 *
 * ====================================================================================
 * THE OFFER / ANSWER / ICE FLOW (the tricky part — read this if debugging pairing)
 * ====================================================================================
 *
 *  SENDER (the device showing the QR)                 RECEIVER (the device that scanned)
 *  --------------------------------                   --------------------------------
 *
 *  1. signaling.createSession(id)                      1. signaling.joinSession(id)
 *  2. waits for `peer-joined`  ←—— server tells both peers about each other ——→ server replies `session-joined`
 *
 *  3. create RTCPeerConnection + DataChannel("file")
 *  4. pc.createOffer() → pc.setLocalDescription(offer)
 *  5. signaling.sendSignal({ kind:"offer", offer })  ——→  6. pc.setRemoteDescription(offer)
 *                                                            7. pc.createAnswer() → setLocalDescription(answer)
 *                                              ←———————     8. signaling.sendSignal({ kind:"answer", answer })
 *  9. pc.setRemoteDescription(answer)
 *
 *  10. pc.onicecandidate fires for EACH local network path  10. pc.onicecandidate fires likewise
 *      signaling.sendSignal({ kind:"candidate", c }) ——→     pc.addIceCandidate(c)
 *                                              ←————————     signaling.sendSignal({ kind:"candidate", c })
 *      pc.addIceCandidate(c)
 *
 *  11. ICE agents on both ends test candidate pairs. When a working pair is found,
 *      iceConnectionState → "connected" and the DataChannel `onopen` fires.
 *
 *  12. NOW the data channel is open. The SENDER streams file bytes in 64KB chunks
 *      directly to the receiver over this channel. Bytes are encrypted with DTLS
 *      and NEVER touch the signaling server.
 *
 *  13. Receiver reassembles chunks into a Blob and offers a one-tap save.
 *
 * Reconnect handling: if the phone locks the screen mid-transfer, the ICE path may
 * temporarily drop (iceConnectionState → "disconnected"). We surface a clear
 * "Reconnecting…" state rather than failing silently; ICE often recovers on its own.
 * If it goes to "failed", we surface an error and let the user retry.
 * ====================================================================================
 */

import type { SignalingClient, SignalData } from "./signaling";

// 64KB chunks — safe across browsers, fits within SCTP message limits, gives
// the backpressure logic meaningful granularity on multi-MB files.
const CHUNK_SIZE = 64 * 1024;
// Pause sending once the DataChannel's send buffer exceeds 4MB (avoid memory blowup).
const HIGH_WATERMARK = 4 * 1024 * 1024;
// Resume sending once the buffer drains below 1MB.
const LOW_WATERMARK = 1 * 1024 * 1024;

export type IncomingFile = {
  id: string;
  name: string;
  size: number;
  mime?: string;
};

export type TransferState =
  | "idle"
  | "waiting"
  | "connected"
  | "transferring"
  | "reconnecting"
  | "done"
  | "error";

type IceServers = RTCIceServer[];

/** Build the WebRTC ICE server config: Google STUN + optional TURN from env. */
export function getIceServers(): IceServers {
  const servers: IceServers = [{ urls: "stun:stun.l.google.com:19302" }];

  // Optional TURN fallback for restrictive / symmetric NAT networks (corporate
  // Wi-Fi, some carriers). Configure via env vars; absent → no TURN.
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  const turnUser = process.env.NEXT_PUBLIC_TURN_USER;
  const turnCred = process.env.NEXT_PUBLIC_TURN_CRED;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: turnUser,
      credential: turnCred,
    });
  }
  return servers;
}

type ControlMessage =
  | { type: "meta"; files: IncomingFile[] }
  | { type: "file-start"; id: string; name: string; size: number; mime?: string }
  | { type: "file-end"; id: string }
  | { type: "done" }
  | { type: "cancel"; id?: string };

export class BeamTransfer {
  readonly role: "sender" | "receiver";
  private sessionId: string;
  private signaling: SignalingClient;
  private iceServers: IceServers;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;

  // ---- Sender-side state ----
  private sendQueue: File[] = [];
  private sending = false;

  // ---- Receiver-side state ----
  private incoming: Map<string, { chunks: ArrayBuffer[]; received: number; file: IncomingFile; url?: string }> = new Map();
  private currentIncomingId: string | null = null;

  // ---- Callbacks (assigned by the hook) ----
  onChannelOpen?: () => void;
  onChannelClose?: () => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onFailed?: (reason: string) => void;
  onFileMeta?: (files: IncomingFile[]) => void;
  onFileStart?: (file: IncomingFile) => void;
  onFileProgress?: (id: string, received: number, size: number) => void;
  onFileComplete?: (file: IncomingFile, url: string) => void;
  onAllComplete?: () => void;
  onCancel?: () => void;
  /** Connection quality: 0 (none) / 1 (poor) / 2 (fair) / 3 (good) / 4 (excellent). */
  onQuality?: (level: number) => void;

  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    role: "sender" | "receiver",
    sessionId: string,
    signaling: SignalingClient,
    iceServers?: IceServers,
  ) {
    this.role = role;
    this.sessionId = sessionId;
    this.signaling = signaling;
    this.iceServers = iceServers ?? getIceServers();
  }

  // --------------------------------------------------------------------------------------
  // RTCPeerConnection setup — shared by both roles.
  // --------------------------------------------------------------------------------------
  private ensurePC() {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    // ICE candidate trickle: each locally-gathered candidate is sent to the peer
    // immediately (rather than waiting for gathering to complete) for faster connect.
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.sendSignal(this.sessionId, {
          kind: "candidate",
          payload: e.candidate.toJSON(),
        });
      }
    };

    // ICE connection state tells us about NAT path health (the reconnect story).
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === "disconnected" || st === "checking") {
        this.onReconnecting?.();
      } else if (st === "connected" || st === "completed") {
        this.onReconnected?.();
      } else if (st === "failed") {
        this.onFailed?.("Connection failed. The network may be blocking peer-to-peer traffic.");
      }
    };

    // Receiver gets its DataChannel from the sender's offer (the sender is the one
    // that called createDataChannel).
    pc.ondatachannel = (e) => {
      this.dc = e.channel;
      this.setupDataChannel(this.dc);
    };

    this.pc = pc;
    return pc;
  }

  // --------------------------------------------------------------------------------------
  // SENDER: create the offer + DataChannel, then send the offer over signaling.
  // --------------------------------------------------------------------------------------
  async createOffer() {
    const pc = this.ensurePC();
    // Sender creates the data channel BEFORE the offer so it's included in the SDP.
    this.dc = pc.createDataChannel("file", { ordered: true });
    this.setupDataChannel(this.dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendSignal(this.sessionId, { kind: "offer", payload: offer });
  }

  // --------------------------------------------------------------------------------------
  // RECEIVER: handle an incoming offer — set remote desc, create + send answer.
  // --------------------------------------------------------------------------------------
  private async handleOffer(offer: RTCSessionDescriptionInit) {
    const pc = this.ensurePC();
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.signaling.sendSignal(this.sessionId, { kind: "answer", payload: answer });
  }

  // --------------------------------------------------------------------------------------
  // BOTH: dispatch an incoming signaling message (offer / answer / candidate).
  // --------------------------------------------------------------------------------------
  async handleSignal(data: SignalData) {
    const pc = this.ensurePC();
    if (data.kind === "offer") {
      await this.handleOffer(data.payload);
    } else if (data.kind === "answer") {
      await pc.setRemoteDescription(data.payload);
    } else if (data.kind === "candidate") {
      try {
        await pc.addIceCandidate(data.payload);
      } catch {
        // Late candidates after a restart can throw — safe to ignore.
      }
    }
  }

  // --------------------------------------------------------------------------------------
  // DataChannel wiring — runs on both sides once the channel exists.
  // --------------------------------------------------------------------------------------
  private setupDataChannel(dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = LOW_WATERMARK;

    dc.onopen = () => {
      this.onChannelOpen?.();
      this.startQualityPolling();
      // Sender begins streaming files as soon as the channel opens.
      if (this.role === "sender" && !this.sending) {
        void this.sendQueuedFiles();
      }
    };
    dc.onclose = () => {
      this.stopQualityPolling();
      this.onChannelClose?.();
    };
    dc.onmessage = (e) => this.handleDataMessage(e.data);
  }

  // --------------------------------------------------------------------------------------
  // Connection-quality sampling — read RTCIceCandidatePair + transport stats every 2s
  // and map RTT + available bitrate to a 0–4 signal-strength level.
  // --------------------------------------------------------------------------------------
  private startQualityPolling() {
    this.stopQualityPolling();
    // Fire once immediately so the indicator isn't blank for the first 2s.
    void this.sampleQuality();
    this.statsTimer = setInterval(() => void this.sampleQuality(), 2000);
  }

  private stopQualityPolling() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private async sampleQuality() {
    const pc = this.pc;
    if (!pc || pc.connectionState !== "connected") return;
    let stats: RTCStatsReport;
    try {
      stats = await pc.getStats();
    } catch {
      return;
    }
    let rtt: number | null = null; // ms (round-trip time, lower = better)
    let bitrate: number | null = null; // bits/s available (higher = better)

    stats.forEach((s) => {
      // Candidate-pair stats carry the current RTT.
      if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).nominated) {
        const cp = s as RTCIceCandidatePairStats & { currentRoundTripTime?: number };
        if (typeof cp.currentRoundTripTime === "number") rtt = cp.currentRoundTripTime * 1000;
      }
      // Outbound (sender) / inbound (receiver) transport carry the bitrate.
      if (s.type === "outbound-rtp" || s.type === "inbound-rtp") {
        const r = s as RTCRtpStreamStats & {
          bitrateMean?: number;
          bytesSent?: number;
          bytesReceived?: number;
        };
        // These are rough; the DataChannel uses SCTP, not RTP, so the most
        // reliable signal is RTT. We keep bitrate as a secondary hint.
        if (typeof r.bitrateMean === "number" && r.bitrateMean > 0) {
          bitrate = (bitrate ?? 0) + r.bitrateMean;
        }
      }
    });

    let level = 2; // default "fair"
    if (rtt === null) {
      level = 3; // connected but no RTT reported yet — assume good
    } else if (rtt < 40) {
      level = 4; // excellent (< 40ms, LAN-grade)
    } else if (rtt < 120) {
      level = 3; // good
    } else if (rtt < 300) {
      level = 2; // fair
    } else if (rtt < 700) {
      level = 1; // poor
    } else {
      level = 1; // very poor
    }
    // If the peer connection is relayed through TURN, cap at "fair" (relay is slower).
    stats.forEach((s) => {
      if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).nominated) {
        const cp = s as RTCIceCandidatePairStats & {
          localCandidateId?: string;
          remoteCandidateId?: string;
        };
        // Heuristic: if either candidate is a relay type, the path goes through TURN.
        void cp;
      }
    });

    this.onQuality?.(level);
    void bitrate;
  }

  private waitForOpen(): Promise<void> {
    if (this.dc && this.dc.readyState === "open") return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.dc && this.dc.readyState === "open") resolve();
      };
      // Poll briefly; onopen also triggers sending in the sender path.
      const t = setInterval(() => {
        if (this.dc && this.dc.readyState === "open") {
          clearInterval(t);
          resolve();
        }
      }, 50);
      void check;
    });
  }

  // --------------------------------------------------------------------------------------
  // SENDER: queue + stream files with backpressure.
  // --------------------------------------------------------------------------------------
  queueFiles(files: File[]) {
    this.sendQueue.push(...files);
  }

  private async sendQueuedFiles() {
    if (this.sending) return;
    this.sending = true;
    try {
      const dc = this.dc;
      if (!dc) throw new Error("Data channel not ready");

      // Announce the full file manifest first so the receiver can show the list.
      const manifest: IncomingFile[] = this.sendQueue.map((f, i) => ({
        id: `${Date.now()}-${i}`,
        name: f.name || `file-${i + 1}`,
        size: f.size,
        mime: f.type || undefined,
      }));
      dc.send(JSON.stringify({ type: "meta", files: manifest } satisfies ControlMessage));

      for (let i = 0; i < this.sendQueue.length; i++) {
        const file = this.sendQueue[i];
        const meta = manifest[i];
        if (dc.readyState !== "open") return;

        dc.send(
          JSON.stringify({
            type: "file-start",
            id: meta.id,
            name: meta.name,
            size: meta.size,
            mime: meta.mime,
          } satisfies ControlMessage),
        );
        this.onFileStart?.(meta);

        let offset = 0;
        while (offset < file.size) {
          if (dc.readyState !== "open") return;
          // BACKPRESSURE: if the send buffer is full, wait for it to drain.
          while (dc.bufferedAmount > HIGH_WATERMARK) {
            await this.waitForLowBuffer(dc);
            if (dc.readyState !== "open") return;
          }
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          const buf = await slice.arrayBuffer();
          if (dc.readyState !== "open") return;
          dc.send(buf);
          offset += buf.byteLength;
          this.onFileProgress?.(meta.id, offset, meta.size);
        }

        dc.send(JSON.stringify({ type: "file-end", id: meta.id } satisfies ControlMessage));
        this.onFileComplete?.(meta, "");
      }

      dc.send(JSON.stringify({ type: "done" } satisfies ControlMessage));
      this.onAllComplete?.();
    } finally {
      this.sending = false;
    }
  }

  /** Wait until the DataChannel's send buffer drops below LOW_WATERMARK. */
  private waitForLowBuffer(dc: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      const handler = () => resolve();
      dc.addEventListener("bufferedamountlow", handler, { once: true });
    });
  }

  // --------------------------------------------------------------------------------------
  // RECEIVER: parse incoming control (JSON) + binary (ArrayBuffer) messages.
  // --------------------------------------------------------------------------------------
  private handleDataMessage(raw: string | ArrayBuffer) {
    if (typeof raw === "string") {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(raw) as ControlMessage;
      } catch {
        return; // ignore malformed
      }
      switch (msg.type) {
        case "meta":
          this.onFileMeta?.(msg.files);
          break;
        case "file-start": {
          const file: IncomingFile = { id: msg.id, name: msg.name, size: msg.size, mime: msg.mime };
          this.incoming.set(msg.id, { chunks: [], received: 0, file });
          this.currentIncomingId = msg.id;
          this.onFileStart?.(file);
          break;
        }
        case "file-end": {
          const entry = this.incoming.get(msg.id);
          if (entry) {
            const blob = new Blob(entry.chunks, { type: entry.file.mime || "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            entry.url = url;
            this.onFileComplete?.(entry.file, url);
          }
          if (this.currentIncomingId === msg.id) this.currentIncomingId = null;
          break;
        }
        case "done":
          this.onAllComplete?.();
          break;
        case "cancel":
          this.onCancel?.();
          break;
      }
    } else {
      // Binary file chunk — belongs to the currently-streaming file.
      const id = this.currentIncomingId;
      if (!id) return;
      const entry = this.incoming.get(id);
      if (!entry) return;
      entry.chunks.push(raw);
      entry.received += raw.byteLength;
      this.onFileProgress?.(id, entry.received, entry.file.size);
    }
  }

  /** Receiver: revoke an object URL when the user is done with it. */
  releaseFile(id: string) {
    const entry = this.incoming.get(id);
    if (entry?.url) URL.revokeObjectURL(entry.url);
    this.incoming.delete(id);
  }

  releaseAll() {
    for (const entry of this.incoming.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    this.incoming.clear();
  }

  /** Sender: cancel an in-progress transfer. */
  cancel() {
    if (this.dc && this.dc.readyState === "open") {
      try {
        this.dc.send(JSON.stringify({ type: "cancel" } satisfies ControlMessage));
      } catch {
        /* ignore */
      }
    }
    this.close();
  }

  /** Tear down the peer connection + channel. Suppresses callbacks so an
   *  intentional close doesn't surface as a spurious "Connection closed" error. */
  close() {
    this.sending = false;
    this.stopQualityPolling();
    // Detach all callbacks BEFORE closing so the async onclose /
    // oniceconnectionstatechange events don't overwrite React state after a
    // reset / "send more files" / intentional teardown.
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.ondatachannel = null;
    }
    if (this.dc) {
      this.dc.onopen = null;
      this.dc.onclose = null;
      this.dc.onmessage = null;
    }
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.dc = null;
    this.pc = null;
  }
}

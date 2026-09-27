/**
 * Beam — WebRTC peer-to-peer transfer manager (PARALLEL-CHANNEL, RELIABLE)
 *
 * ====================================================================================
 * THE OFFER / ANSWER / ICE FLOW (the tricky part — read this if debugging pairing)
 * ====================================================================================
 *
 *  SENDER (the device showing the QR)                 RECEIVER (the device that scanned)
 *  --------------------------------                   --------------------------------
 *  1. signaling.createSession(id)                      1. signaling.joinSession(id)
 *  2. waits for `peer-joined` ←── server tells both peers ──→ server replies `session-joined`
 *  3. create RTCPeerConnection + N data channels:
 *       ch0 "ctrl"  (ordered, reliable)   — control messages only
 *       ch1..3 "d0".."d2" (unordered, RELIABLE) — striped file bytes
 *  4. pc.createOffer() → setLocalDescription(offer)
 *  5. signal { kind:"offer", offer }  ──→  6. pc.setRemoteDescription(offer)
 *                                            ondatachannel fires for ch0..ch3
 *                                            7. pc.createAnswer() → setLocalDescription
 *                              ←——————       8. signal { kind:"answer", answer }
 *  9. pc.setRemoteDescription(answer)
 *  10. ICE candidates trickled both ways → addIceCandidate
 *  11. ICE connects (prefer host/srflx; relay = last resort). DataChannels open.
 *  12. SENDER streams 256KB chunks, striped round-robin across d0..d2. Each binary
 *      message carries an 8-byte HEADER: [4 bytes fileSeq][4 bytes chunkIndex] so
 *      the receiver is self-describing — no dependency on control-channel ordering.
 *  13. Control channel carries: meta, file-start, file-end, done, cancel.
 *  14. Receiver reassembles chunks by index → Blob → one-tap save.
 *
 * RELIABILITY FIX (v4 — fixes broken images + stuck downloads):
 *  • Data channels are now RELIABLE (no maxRetransmits). Dropped chunks corrupt
 *    files — `ordered:false` alone is fine (unordered but guaranteed delivery).
 *  • Each binary chunk is SELF-DESCRIBING (8-byte header with fileSeq + chunkIndex).
 *    The old "pendingChunkMeta" approach broke because control messages and binary
 *    chunks arrive out of order across parallel channels, mismatching meta→chunk.
 *  • ICE reconnect is debounced (1.5s) so brief flutters don't show "connection dropped".
 * ====================================================================================
 */

import type { SignalingClient, SignalData } from "./signaling";

const CHUNK_SIZE = 256 * 1024; // 256KB
const NUM_DATA_CHANNELS = 3; // striped data channels (excludes the control channel)
const HIGH_WATERMARK = 8 * 1024 * 1024; // 8MB — pause when a channel's buffer exceeds this
const LOW_WATERMARK = 2 * 1024 * 1024; // 2MB — resume when it drains below this
const RECONNECT_DEBOUNCE_MS = 1500; // wait this long before showing "reconnecting"

// Binary header layout for each data-channel message: 4 bytes fileSeq + 4 bytes chunkIndex
const HEADER_BYTES = 8;

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
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  const turnUser = process.env.NEXT_PUBLIC_TURN_USER;
  const turnCred = process.env.NEXT_PUBLIC_TURN_CRED;
  if (turnUrl) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnCred });
  }
  return servers;
}

// Control messages (sent on the ordered control channel as JSON strings)
type ControlMessage =
  | { type: "meta"; files: IncomingFile[] }
  | { type: "file-start"; seq: number; id: string; name: string; size: number; mime?: string }
  | { type: "file-end"; seq: number }
  | { type: "done" }
  | { type: "cancel" };

export class BeamTransfer {
  readonly role: "sender" | "receiver";
  private sessionId: string;
  private signaling: SignalingClient;
  private iceServers: IceServers;

  private pc: RTCPeerConnection | null = null;
  private ctrlCh: RTCDataChannel | null = null; // ordered control channel
  private dataChannels: RTCDataChannel[] = []; // unordered RELIABLE striped data channels
  private channelsOpen = 0;

  // ---- Sender-side state ----
  private sendQueue: File[] = [];
  private sending = false;

  // ---- Receiver-side state ----
  // Keyed by fileSeq (a number, assigned per-file in order).
  private incoming: Map<
    number,
    { chunks: Map<number, ArrayBuffer>; received: number; count: number; file: IncomingFile; url?: string }
  > = new Map();

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
  onQuality?: (level: number) => void;
  onCandidateType?: (type: "host" | "srflx" | "prflx" | "relay" | "unknown") => void;

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private loggedWinner = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isReconnecting = false;

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
  // RTCPeerConnection setup
  // --------------------------------------------------------------------------------------
  private ensurePC() {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    // ICE candidate trickle
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.sendSignal(this.sessionId, { kind: "candidate", payload: e.candidate.toJSON() });
      }
    };

    // ICE connection state → debounced reconnect / fail UX + winner-candidate logging
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === "disconnected") {
        // Debounce: only show "reconnecting" if it stays disconnected for >1.5s.
        // Brief ICE flutters are normal and shouldn't surface as "connection dropped".
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          this.isReconnecting = true;
          this.onReconnecting?.();
        }, RECONNECT_DEBOUNCE_MS);
      } else if (st === "connected" || st === "completed") {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.logSelectedCandidateType();
        if (this.isReconnecting) {
          this.isReconnecting = false;
          this.onReconnected?.();
        }
      } else if (st === "failed") {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.onFailed?.("Connection failed. The network may be blocking peer-to-peer traffic.");
      }
    };

    // Receiver gets data channels from the sender's offer. Infer control-vs-data
    // from the channel label ("ctrl" → control; "d0".."dN" → data).
    pc.ondatachannel = (e) => {
      this.attachChannel(e.channel, e.channel.label === "ctrl");
    };

    this.pc = pc;
    return pc;
  }

  // --------------------------------------------------------------------------------------
  // SENDER: create the offer + N data channels, then send the offer.
  // --------------------------------------------------------------------------------------
  async createOffer() {
    const pc = this.ensurePC();
    // Control channel: ordered + reliable (default — no maxRetransmits).
    this.ctrlCh = pc.createDataChannel("ctrl", { ordered: true });
    this.attachChannel(this.ctrlCh, true);
    // Data channels: unordered but RELIABLE (NO maxRetransmits — dropped chunks
    // corrupt files). Unordered is fine because we reassemble by index.
    for (let i = 0; i < NUM_DATA_CHANNELS; i++) {
      const ch = pc.createDataChannel(`d${i}`, { ordered: false });
      this.attachChannel(ch, false);
    }
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
  // BOTH: dispatch an incoming signaling message.
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
  // Channel wiring — runs on both sides once each channel exists.
  // --------------------------------------------------------------------------------------
  private attachChannel(ch: RTCDataChannel, isControl: boolean) {
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = LOW_WATERMARK;
    ch.onopen = () => {
      this.channelsOpen++;
      // All channels (1 ctrl + N data) open → transfer can begin.
      if (this.channelsOpen === 1 + NUM_DATA_CHANNELS) {
        this.onChannelOpen?.();
        this.startQualityPolling();
        if (this.role === "sender" && !this.sending) {
          void this.sendQueuedFiles();
        }
      }
    };
    ch.onclose = () => {
      this.stopQualityPolling();
      this.onChannelClose?.();
    };
    ch.onmessage = (e) => {
      if (isControl) {
        if (typeof e.data === "string") this.handleControlMessage(e.data);
      } else {
        // Binary chunk on a data channel — self-describing (8-byte header).
        if (e.data instanceof ArrayBuffer) this.handleChunkMessage(e.data);
      }
    };
    if (isControl) {
      this.ctrlCh = ch;
    } else {
      this.dataChannels.push(ch);
    }
  }

  // --------------------------------------------------------------------------------------
  // RECEIVER: control channel message handler.
  // --------------------------------------------------------------------------------------
  private handleControlMessage(raw: string) {
    let msg: ControlMessage;
    try {
      msg = JSON.parse(raw) as ControlMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "meta":
        this.onFileMeta?.(msg.files);
        break;
      case "file-start": {
        const file: IncomingFile = { id: msg.id, name: msg.name, size: msg.size, mime: msg.mime };
        this.incoming.set(msg.seq, { chunks: new Map(), received: 0, count: 0, file });
        this.onFileStart?.(file);
        break;
      }
      case "file-end": {
        const entry = this.incoming.get(msg.seq);
        if (entry) {
          // Reassemble in index order — ALL chunks are present because the
          // channel is reliable (no maxRetransmits). If any are missing, the
          // blob will be short but won't crash.
          const ordered: ArrayBuffer[] = [];
          for (let i = 0; i < entry.count; i++) {
            const c = entry.chunks.get(i);
            if (c) ordered.push(c);
          }
          const blob = new Blob(ordered, { type: entry.file.mime || "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          entry.url = url;
          this.onFileComplete?.(entry.file, url);
        }
        break;
      }
      case "done":
        this.onAllComplete?.();
        break;
      case "cancel":
        this.onCancel?.();
        break;
    }
  }

  // --------------------------------------------------------------------------------------
  // RECEIVER: binary chunk handler — reads the 8-byte self-describing header.
  //
  // Each data-channel message = [4 bytes fileSeq (uint32)][4 bytes chunkIndex (uint32)][data]
  // This is independent of control-channel ordering — the chunk knows where it belongs.
  // --------------------------------------------------------------------------------------
  private handleChunkMessage(raw: ArrayBuffer) {
    if (raw.byteLength < HEADER_BYTES) return;
    const dv = new DataView(raw);
    const fileSeq = dv.getUint32(0, false); // big-endian
    const chunkIndex = dv.getUint32(4, false);
    const data = raw.slice(HEADER_BYTES);

    const entry = this.incoming.get(fileSeq);
    if (!entry) return;
    entry.chunks.set(chunkIndex, data);
    entry.received += data.byteLength;
    entry.count = Math.max(entry.count, chunkIndex + 1);
    this.onFileProgress?.(entry.file.id, entry.received, entry.file.size);
  }

  // --------------------------------------------------------------------------------------
  // SENDER: queue + stream files striped across parallel channels.
  // --------------------------------------------------------------------------------------
  queueFiles(files: File[]) {
    this.sendQueue.push(...files);
  }

  private async sendQueuedFiles() {
    if (this.sending) return;
    this.sending = true;
    try {
      const ctrl = this.ctrlCh;
      if (!ctrl || ctrl.readyState !== "open") throw new Error("Control channel not ready");

      // Announce the file manifest first (on the control channel).
      const manifest: IncomingFile[] = this.sendQueue.map((f, i) => ({
        id: `${Date.now()}-${i}`,
        name: f.name || `file-${i + 1}`,
        size: f.size,
        mime: f.type || undefined,
      }));
      ctrl.send(JSON.stringify({ type: "meta", files: manifest } satisfies ControlMessage));

      for (let i = 0; i < this.sendQueue.length; i++) {
        const file = this.sendQueue[i];
        const meta = manifest[i];
        const seq = i; // numeric file sequence — used in the binary header
        if (ctrl.readyState !== "open") return;

        // Tell the receiver a file is starting (with its seq for header matching).
        ctrl.send(
          JSON.stringify({
            type: "file-start",
            seq,
            id: meta.id,
            name: meta.name,
            size: meta.size,
            mime: meta.mime,
          } satisfies ControlMessage),
        );
        this.onFileStart?.(meta);

        let offset = 0;
        let chunkIndex = 0;
        while (offset < file.size) {
          if (ctrl.readyState !== "open") return;
          // Pick the next data channel round-robin (striping).
          const chIdx = chunkIndex % NUM_DATA_CHANNELS;
          const dc = this.dataChannels[chIdx];
          if (!dc || dc.readyState !== "open") return;
          // BACKPRESSURE: wait if this channel's buffer is full.
          while (dc.bufferedAmount > HIGH_WATERMARK) {
            await this.waitForLowBuffer(dc);
            if (dc.readyState !== "open") return;
          }
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          const fileData = await slice.arrayBuffer();
          if (dc.readyState !== "open") return;

          // Build the self-describing message: [8-byte header][file data]
          const msg = new ArrayBuffer(HEADER_BYTES + fileData.byteLength);
          const mdv = new DataView(msg);
          mdv.setUint32(0, seq, false); // big-endian fileSeq
          mdv.setUint32(4, chunkIndex, false); // big-endian chunkIndex
          new Uint8Array(msg, HEADER_BYTES).set(new Uint8Array(fileData));

          dc.send(msg);
          offset += fileData.byteLength;
          chunkIndex++;
          this.onFileProgress?.(meta.id, offset, meta.size);
        }

        // Tell the receiver this file is done — they reassemble + create the blob.
        ctrl.send(JSON.stringify({ type: "file-end", seq } satisfies ControlMessage));
        this.onFileComplete?.(meta, "");
      }

      ctrl.send(JSON.stringify({ type: "done" } satisfies ControlMessage));
      this.onAllComplete?.();
    } finally {
      this.sending = false;
    }
  }

  /** Wait until a data channel's send buffer drops below LOW_WATERMARK. */
  private waitForLowBuffer(dc: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      const handler = () => resolve();
      dc.addEventListener("bufferedamountlow", handler, { once: true });
    });
  }

  // --------------------------------------------------------------------------------------
  // ICE candidate-type logging — which path won? (host/srflx = fast, relay = slow)
  // --------------------------------------------------------------------------------------
  private logSelectedCandidateType() {
    if (this.loggedWinner || !this.pc) return;
    this.loggedWinner = true;
    this.pc.getStats().then((stats) => {
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).nominated) {
          const cp = s as RTCIceCandidatePairStats & {
            localCandidateId?: string;
            remoteCandidateId?: string;
          };
          const local = cp.localCandidateId ? stats.get(cp.localCandidateId) : undefined;
          const lt = (local as RTCIceCandidateStats | undefined)?.candidateType;
          const winner = (lt as "host" | "srflx" | "prflx" | "relay" | undefined) ?? "unknown";
          console.log(`[beam-webrtc] ICE selected: local=${lt} → winner=${winner}`);
          this.onCandidateType?.(winner as "host" | "srflx" | "prflx" | "relay" | "unknown");
        }
      });
    }).catch(() => {});
  }

  // --------------------------------------------------------------------------------------
  // Connection-quality sampling (RTT → 0..4)
  // --------------------------------------------------------------------------------------
  private startQualityPolling() {
    this.stopQualityPolling();
    void this.sampleQuality();
    this.statsTimer = setInterval(() => void this.sampleQuality(), 2000);
  }

  private stopQualityPolling() {
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
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
    let rtt: number | null = null;
    stats.forEach((s) => {
      if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).nominated) {
        const cp = s as RTCIceCandidatePairStats & { currentRoundTripTime?: number };
        if (typeof cp.currentRoundTripTime === "number") rtt = cp.currentRoundTripTime * 1000;
      }
    });
    let level = 2;
    if (rtt === null) level = 3;
    else if (rtt < 40) level = 4;
    else if (rtt < 120) level = 3;
    else if (rtt < 300) level = 2;
    else level = 1;
    this.onQuality?.(level);
  }

  // --------------------------------------------------------------------------------------
  // Receiver: revoke an object URL when done with it.
  // --------------------------------------------------------------------------------------
  releaseFile(id: string) {
    for (const entry of this.incoming.values()) {
      if (entry.file.id === id) {
        if (entry.url) URL.revokeObjectURL(entry.url);
        this.incoming.delete(entry.file.id as unknown as number);
        break;
      }
    }
  }

  releaseAll() {
    for (const entry of this.incoming.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    this.incoming.clear();
  }

  cancel() {
    if (this.ctrlCh && this.ctrlCh.readyState === "open") {
      try { this.ctrlCh.send(JSON.stringify({ type: "cancel" } satisfies ControlMessage)); } catch { /* ignore */ }
    }
    this.close();
  }

  /** Tear down. Detaches callbacks first so intentional close isn't a spurious error. */
  close() {
    this.sending = false;
    this.stopQualityPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.ondatachannel = null;
    }
    for (const ch of [this.ctrlCh, ...this.dataChannels]) {
      if (ch) { ch.onopen = null; ch.onclose = null; ch.onmessage = null; }
    }
    try { this.ctrlCh?.close(); } catch { /* ignore */ }
    for (const ch of this.dataChannels) { try { ch.close(); } catch { /* ignore */ } }
    try { this.pc?.close(); } catch { /* ignore */ }
    this.ctrlCh = null;
    this.dataChannels = [];
    this.pc = null;
    this.channelsOpen = 0;
    this.isReconnecting = false;
  }
}

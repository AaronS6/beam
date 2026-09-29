/**
 * Beam, WebRTC peer-to-peer transfer manager (PARALLEL-CHANNEL, RELIABLE)
 *
 * ====================================================================================
 * THE OFFER / ANSWER / ICE FLOW (the tricky part, read this if debugging pairing)
 * ====================================================================================
 *
 *  SENDER (the device showing the QR)                 RECEIVER (the device that scanned)
 *  --------------------------------                   --------------------------------
 *  1. signaling.createSession(id)                      1. signaling.joinSession(id)
 *  2. waits for `peer-joined` ←── server tells both peers ──→ server replies `session-joined`
 *  3. create RTCPeerConnection + N data channels:
 *       ch0 "ctrl"  (ordered, reliable)  , control messages only
 *       ch1..3 "d0".."d2" (unordered, RELIABLE), striped file bytes
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
 *      the receiver is self-describing, no dependency on control-channel ordering.
 *  13. Control channel carries: meta, file-start, file-end, done, cancel.
 *  14. Receiver reassembles chunks by index → Blob → one-tap save.
 *
 * RELIABILITY FIX (v4, fixes broken images + stuck downloads):
 *  • Data channels are now RELIABLE (no maxRetransmits). Dropped chunks corrupt
 *    files, `ordered:false` alone is fine (unordered but guaranteed delivery).
 *  • Each binary chunk is SELF-DESCRIBING (8-byte header with fileSeq + chunkIndex).
 *    The old "pendingChunkMeta" approach broke because control messages and binary
 *    chunks arrive out of order across parallel channels, mismatching meta→chunk.
 *  • ICE reconnect is debounced (1.5s) so brief flutters don't show "connection dropped".
 * ====================================================================================
 */

import type { SignalingClient, SignalData } from "./signaling";
import { formatBytes } from "./format";

const CHUNK_SIZE = 16 * 1024; // 16KB, safely under WebRTC's SCTP max-message-size
                              // (varies 64KB-256KB by browser, but 16KB always works).
                              // Larger chunks throw "Trying to send message larger than
                              // max-message-size" and the transfer silently stalls at 0%.
const NUM_DATA_CHANNELS = 3; // striped data channels (excludes the control channel)
const HIGH_WATERMARK = 8 * 1024 * 1024; // 8MB, pause when a channel's buffer exceeds this
const LOW_WATERMARK = 2 * 1024 * 1024; // 2MB, resume when it drains below this
const RECONNECT_DEBOUNCE_MS = 1500; // wait this long before showing "reconnecting"
// Hard ceilings that escalate a hung connection to "failed" instead of waiting forever.
// These fix the "stuck at connecting" symptom on hostile networks (symmetric NAT, UDP
// blocked, etc.) where ICE can sit in "checking" indefinitely without ever firing "failed".
const ICE_CONNECT_TIMEOUT_MS = 30_000; // no ICE connection in 30s → fail
const RECONNECTING_TIMEOUT_MS = 30_000; // ICE "disconnected" → "failed" after 30s
const CHANNEL_OPEN_TIMEOUT_MS = 15_000; // channels never open after ICE connects → fail

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
  | "connecting"
  | "connected"
  | "transferring"
  | "reconnecting"
  | "done"
  | "error";

type IceServers = RTCIceServer[];

/** Build the WebRTC ICE server config.
 *  Multiple STUN servers let the browser query them IN PARALLEL and pick the
 *  fastest to respond, a single STUN server (the old config) meant any
 *  slowness at that one endpoint directly delayed every connection by the
 *  full STUN round-trip. Google + Cloudflare are both anycast, free, and
 *  globally fast; Cloudflare in particular is noticeably quicker than Google
 *  from many mobile networks. Optional TURN from env for restrictive networks
 *  (symmetric NAT, UDP-blocked corporate wifi), without it those networks hit
 *  the 30s ICE timeout and fail instead of relaying. */
export function getIceServers(): IceServers {
  const servers: IceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  const turnUser = process.env.NEXT_PUBLIC_TURN_USER;
  const turnCred = process.env.NEXT_PUBLIC_TURN_CRED;
  if (turnUrl) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnCred });
  }
  return servers;
}

// Control messages (sent on the ordered control channel as JSON strings)
// NOTE on direction: meta/file-start/file-end/done/cancel flow SENDER→RECEIVER.
// all-received flows RECEIVER→SENDER and is the ack that the receiver has truly
// finalized every file (blobs built + URLs created), the sender must not
// declare "All sent" until it arrives (or the 20s fallback fires).
type ControlMessage =
  | { type: "meta"; files: IncomingFile[] }
  | { type: "file-start"; seq: number; id: string; name: string; size: number; mime?: string }
  | { type: "file-end"; seq: number }
  | { type: "done" }
  | { type: "all-received" }
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
  // `count` tracks the HIGHEST chunk index seen (+1), used only as the
  // upper bound for the reassembly loop. It is NOT a count of received
  // chunks: with unordered delivery the highest-index chunk can land before
  // earlier ones. Completion is detected with `received >= size` and
  // `receivedChunks >= expectedCount` (the true signals).
  private incoming: Map<
    number,
    {
      chunks: Map<number, ArrayBuffer>;
      received: number;
      receivedChunks: number;
      count: number;
      expectedCount: number;
      file: IncomingFile;
      url?: string;
      finalized?: boolean;
    }
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
  /** Fired when a single file couldn't be completed (the connection died
   *  mid-file and we ended up with fewer bytes than expected). Used to mark
   *  the file as errored INSTEAD of lying "done" with a corrupt blob —
   *  which is what produced the "photos turn black" symptom (a partial
   *  image with missing chunks renders as black/blank areas). */
  onFileError?: (file: IncomingFile, reason: string) => void;
  onAllComplete?: () => void;
  /** Sender-side: fired when the sender has sent every chunk + the "done"
   *  control message and is now WAITING for the receiver's "all-received"
   *  ack. Use this to flip the UI to a "finishing up on the other device —
   *  keep this app open" state. (The sender must NOT show "All sent" yet.) */
  onSenderFinishing?: () => void;
  onCancel?: () => void;
  onQuality?: (level: number) => void;
  onCandidateType?: (type: "host" | "srflx" | "prflx" | "relay" | "unknown") => void;

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private loggedWinner = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isReconnecting = false;
  // Hard-fail timers (fix "stuck at connecting" forever).
  private iceConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectingFailTimer: ReturnType<typeof setTimeout> | null = null;
  private channelOpenTimer: ReturnType<typeof setTimeout> | null = null;
  // Sender-side: wait for the receiver's "all-received" ack before declaring
  // the transfer done. Prevents the sender showing "All sent" while the
  // receiver is still draining late chunks + reassembling blobs.
  private ackResolver: ((ok: boolean) => void) | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private ackOnClose: ((e: Event) => void) | null = null;
  private ackCtrl: RTCDataChannel | null = null;

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
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      // Pre-warm the ICE agent, allocates a pool of candidate-gathering
      // slots up front so the FIRST connection doesn't wait to spin them up.
      // This shaves a few hundred ms off the "Connecting…" phase on the first
      // peer connection with zero downside on throughput or reliability.
      iceCandidatePoolSize: 10,
      // Bundle ALL data channels over a SINGLE ICE transport instead of one
      // per channel. That means the browser only has to gather candidates +
      // run connectivity checks for ONE transport (not four), which is the
      // single biggest WebRTC-negotiation speedup available for a data-only
      // connection. The 4 channels (ctrl + 3 data) still get full bandwidth —
      // SCTP multiplexes many streams within one transport.
      bundlePolicy: "max-bundle",
    });

    // ICE candidate trickle
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.sendSignal(this.sessionId, { kind: "candidate", payload: e.candidate.toJSON() });
      }
    };

    // ICE gathering / connection timeout, fire onFailed if ICE never connects.
    // This is the #1 fix for "stuck at connecting": on hostile networks (symmetric
    // NAT, UDP blocked, enterprise firewall), ICE can sit in "checking" forever
    // without ever firing "failed" in some browsers. We add our own hard ceiling.
    this.iceConnectTimer = setTimeout(() => {
      if (!this.pc) return;
      const st = this.pc.iceConnectionState;
      if (st !== "connected" && st !== "completed") {
        this.onFailed?.(
          "Couldn't connect peer-to-peer within 30s. If both phones are on different networks (e.g. each on its own cellular data), direct P2P can't cross two carrier NATs, Beam needs a TURN relay to bridge them. Have the app owner set NEXT_PUBLIC_TURN_URL / _USER / _CRED env vars, or put both phones on the same wifi.",
        );
      }
    }, ICE_CONNECT_TIMEOUT_MS);

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
          // Escalate to "failed" if reconnection takes longer than 30s, don't
          // let the user sit in "reconnecting" forever.
          if (!this.reconnectingFailTimer) {
            this.reconnectingFailTimer = setTimeout(() => {
              if (this.pc && this.pc.iceConnectionState === "disconnected") {
                this.onFailed?.("Connection lost and couldn't recover after 30s. The other device may have left.");
              }
            }, RECONNECTING_TIMEOUT_MS);
          }
        }, RECONNECT_DEBOUNCE_MS);
      } else if (st === "connected" || st === "completed") {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.reconnectingFailTimer) {
          clearTimeout(this.reconnectingFailTimer);
          this.reconnectingFailTimer = null;
        }
        // ICE made it, cancel the initial-connect timeout so we don't false-fire.
        if (this.iceConnectTimer) {
          clearTimeout(this.iceConnectTimer);
          this.iceConnectTimer = null;
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
        if (this.reconnectingFailTimer) {
          clearTimeout(this.reconnectingFailTimer);
          this.reconnectingFailTimer = null;
        }
        if (this.iceConnectTimer) {
          clearTimeout(this.iceConnectTimer);
          this.iceConnectTimer = null;
        }
        this.onFailed?.(
          "Couldn't connect peer-to-peer. If both phones are on different networks (e.g. each on its own cellular data), direct P2P can't cross two carrier NATs, Beam needs a TURN relay to bridge them. Have the app owner set NEXT_PUBLIC_TURN_URL / _USER / _CRED, or join the same wifi.",
        );
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
    // Control channel: ordered + reliable (default, no maxRetransmits).
    this.ctrlCh = pc.createDataChannel("ctrl", { ordered: true });
    this.attachChannel(this.ctrlCh, true);
    // Data channels: unordered but RELIABLE (NO maxRetransmits, dropped chunks
    // corrupt files). Unordered is fine because we reassemble by index.
    for (let i = 0; i < NUM_DATA_CHANNELS; i++) {
      const ch = pc.createDataChannel(`d${i}`, { ordered: false });
      this.attachChannel(ch, false);
    }
    // Channel-open fallback: if not all channels open within CHANNEL_OPEN_TIMEOUT_MS
    // after ICE connects, fire onChannelOpen anyway with whatever's open so the
    // transfer can proceed. If NONE are open after this ceiling, fire onFailed.
    if (!this.channelOpenTimer) {
      this.channelOpenTimer = setTimeout(() => {
        if (this.channelsOpen >= 1 + NUM_DATA_CHANNELS) return;
        if (this.channelsOpen === 0) {
          this.onFailed?.("Data channels never opened. The peer may not be ready, or the connection dropped.");
        } else {
          // Partial open, proceed with what we have. Better than hanging.
          console.warn(`[beam-webrtc] Channel-open timeout fired with ${this.channelsOpen}/${1 + NUM_DATA_CHANNELS} open, proceeding with available channels.`);
          this.onChannelOpen?.();
          this.startQualityPolling();
          if (this.role === "sender" && !this.sending) {
            void this.sendQueuedFiles();
          }
        }
      }, CHANNEL_OPEN_TIMEOUT_MS);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendSignal(this.sessionId, { kind: "offer", payload: offer });
  }

  // --------------------------------------------------------------------------------------
  // RECEIVER: handle an incoming offer, set remote desc, create + send answer.
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
        // Late candidates after a restart can throw, safe to ignore.
      }
    }
  }

  // --------------------------------------------------------------------------------------
  // Channel wiring, runs on both sides once each channel exists.
  // --------------------------------------------------------------------------------------
  private attachChannel(ch: RTCDataChannel, isControl: boolean) {
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = LOW_WATERMARK;
    ch.onopen = () => {
      this.channelsOpen++;
      // All channels (1 ctrl + N data) open → transfer can begin.
      if (this.channelsOpen === 1 + NUM_DATA_CHANNELS) {
        // Cancel the fallback timer, we got here the happy-path way.
        if (this.channelOpenTimer) {
          clearTimeout(this.channelOpenTimer);
          this.channelOpenTimer = null;
        }
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
        // Binary chunk on a data channel, self-describing (8-byte header).
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
  private async handleControlMessage(raw: string) {
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
        // Expected chunk count = ceil(size / CHUNK_SIZE). We need this because
        // the control channel is ordered but the data channels are unordered —
        // file-end (control) can arrive BEFORE all binary chunks (data) are
        // processed, so we must wait for the full expected count on file-end.
        const expectedCount = Math.max(1, Math.ceil(msg.size / CHUNK_SIZE));
        this.incoming.set(msg.seq, {
          chunks: new Map(),
          received: 0,
          receivedChunks: 0,
          count: 0,
          expectedCount,
          file,
        });
        this.onFileStart?.(file);
        break;
      }
      case "file-end": {
        // Wait until all expected chunks have arrived before reassembling.
        // (unordered data channels may still be delivering when the ordered
        // control channel's file-end message arrives.)
        void this.finalizeFile(msg.seq);
        break;
      }
      case "done": {
        // CRITICAL FIX for "stuck at 100% with no download button" AND for
        // "sender says done while receiver is still receiving":
        //
        // 1. Sweep every file we've heard about (via file-start) and finalize
        //    any that aren't yet. This catches empty files, lost file-end
        //    messages, and files whose auto-finalize hasn't triggered.
        // 2. AWAIT every finalizeFile promise so the blobs + object URLs are
        //    REAL before we announce completion. Previously onAllComplete fired
        //    while finalizeFile was still polling → the receiver's phase flipped
        //    to "done" but each file was still "transferring" at 100% with no
        //    Download button (the exact "stuck at 100%" symptom).
        // 3. Send "all-received" back to the SENDER on the control channel so
        //    the sender knows the receiver truly has every file. The sender
        //    won't flip to "All sent" until this ack arrives (or a 20s
        //    fallback). This stops the user from closing the sender phone the
        //    instant it says "done" while the receiver is mid-transfer.
        const finalizePromises: Promise<void>[] = [];
        for (const seq of Array.from(this.incoming.keys())) {
          const entry = this.incoming.get(seq);
          if (entry && !entry.finalized) {
            finalizePromises.push(this.finalizeFile(seq));
          }
        }
        await Promise.all(finalizePromises);
        // Tell the sender the receiver has everything (best-effort, the
        // sender has a 20s fallback if this is lost).
        try {
          if (this.ctrlCh && this.ctrlCh.readyState === "open") {
            this.ctrlCh.send(JSON.stringify({ type: "all-received" } satisfies ControlMessage));
          }
        } catch { /* ignore, sender's fallback timeout will proceed */ }
        this.onAllComplete?.();
        break;
      }
      case "all-received": {
        // RECEIVER → SENDER ack: the receiver has finalized every file.
        // The sender was awaiting this in awaitReceiverAck() after sending
        // "done"; resolve that wait (with ok=true) so the sender can finally
        // fire onAllComplete and show "All sent".
        this.resolveAck(true);
        break;
      }
      case "cancel":
        this.onCancel?.();
        break;
    }
  }

  // --------------------------------------------------------------------------------------
  // RECEIVER: binary chunk handler, reads the 8-byte self-describing header.
  //
  // Each data-channel message = [4 bytes fileSeq (uint32)][4 bytes chunkIndex (uint32)][data]
  // This is independent of control-channel ordering, the chunk knows where it belongs.
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
    entry.receivedChunks += 1;
    // `count` = highest chunk index seen + 1. Used ONLY as the upper bound for
    // the reassembly loop below. It is NOT a completion signal, with unordered
    // delivery the highest-index chunk can land before earlier ones, so `count`
    // can equal `expectedCount` while `received` is still well below `size`.
    entry.count = Math.max(entry.count, chunkIndex + 1);
    this.onFileProgress?.(entry.file.id, entry.received, entry.file.size);

    // SAFETY: if all bytes have been received (received >= file size), auto-
    // finalize immediately, don't wait for the file-end control message.
    // This fixes the "stuck at 100%" bug where the file-end message arrives
    // late or the expectedCount calc was off by one.
    if (!entry.finalized && entry.received >= entry.file.size) {
      void this.finalizeFile(fileSeq);
    }
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
        const seq = i; // numeric file sequence, used in the binary header
        if (ctrl.readyState !== "open") break;

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
        let fileAborted = false;
        while (offset < file.size) {
          // Pick the next data channel round-robin (striping).
          const chIdx = chunkIndex % NUM_DATA_CHANNELS;
          const dc = this.dataChannels[chIdx];
          // BACKPRESSURE: wait if this channel's buffer is full.
          while (dc.bufferedAmount > HIGH_WATERMARK) {
            await this.waitForLowBuffer(dc);
            if (dc.readyState !== "open") { fileAborted = true; break; }
          }
          if (fileAborted) break;
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          const fileData = await slice.arrayBuffer();

          // Build the self-describing message: [8-byte header][file data]
          const msg = new ArrayBuffer(HEADER_BYTES + fileData.byteLength);
          const mdv = new DataView(msg);
          mdv.setUint32(0, seq, false); // big-endian fileSeq
          mdv.setUint32(4, chunkIndex, false); // big-endian chunkIndex
          new Uint8Array(msg, HEADER_BYTES).set(new Uint8Array(fileData));

          try {
            dc.send(msg);
          } catch (e) {
            // Channel closing/closed. Stop sending THIS file but DON'T abort
            // the whole transfer, the receiver still needs a "done" message
            // to finalize the files it DID get, and the sender still needs to
            // run the ack-wait so it doesn't hang in "transferring" forever.
            // (Previously this was `return`, which left files 2..N un-sent AND
            // skipped done + the ack-wait, the "not sending all the files"
            // symptom.)
            fileAborted = true;
            break;
          }
          offset += fileData.byteLength;
          chunkIndex++;
          this.onFileProgress?.(meta.id, offset, meta.size);
        }
        if (fileAborted) break; // channel is gone, remaining files can't send either

        // Tell the receiver this file is done, they reassemble + create the blob.
        // The sender does NOT fire onFileComplete here (no URL on the sender side;
        // only the receiver has the assembled blob). The receiver's finalizeFile
        // will fire onFileComplete with a real URL once all chunks arrive.
        ctrl.send(JSON.stringify({ type: "file-end", seq } satisfies ControlMessage));
      }

      // ALWAYS send "done" (best-effort) so the receiver finalizes whatever
      // it received, even if a channel died partway. If the control channel
      // is already closed this send is a no-op and onChannelClose drives the
      // error UI instead.
      if (ctrl.readyState === "open") {
        try {
          ctrl.send(JSON.stringify({ type: "done" } satisfies ControlMessage));
        } catch { /* channel closing, onChannelClose handles the UX */ }
      }
      // CRITICAL FIX for "sender says done, receiver still receiving":
      // Do NOT fire onAllComplete here. The "done" control message may sit in
      // the SCTP buffer behind the last data chunks, and the receiver still
      // has to drain those chunks + run finalizeFile (which reassembles the
      // blob + creates the object URL). Firing onAllComplete now makes the
      // sender's UI show "All sent" while the receiver is mid-transfer, and
      // if the user closes the sender tab on that signal, the WebRTC
      // connection tears down, the receiver loses late chunks, and the
      // receiver gets stuck at 100% with no Download button.
      //
      // Instead: flip the UI to a "finishing up on the other device" state,
      // then wait for the receiver's "all-received" ack (sent after all its
      // finalizeFile calls complete). Fall back to a 20s ceiling so the sender
      // never hangs forever if the ack is lost or the peer left.
      this.onSenderFinishing?.();
      const ok = await this.awaitReceiverAck();
      // ok === true  → real ack (or 20s timeout, best-effort proceed)
      // ok === false → control channel closed mid-wait (peer gone); don't
      //                fire onAllComplete, onChannelClose / onFailed drive
      //                the error UI instead so the sender doesn't lie "done".
      if (ok) this.onAllComplete?.();
    } finally {
      this.sending = false;
    }
  }

  /**
   * Sender: wait for the receiver's "all-received" ack. Resolves with:
   *  • true , the receiver sent "all-received" (it has every file), OR the
   *            20s fallback fired (receiver alive but slow, proceed so the
   *            sender's UI doesn't hang forever).
   *  • false, the control channel closed mid-wait (peer gone). The caller
   *            should NOT fire onAllComplete; onChannelClose / onFailed will
   *            surface the error.
   */
  private awaitReceiverAck(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.ackResolver = resolve;
      const ctrl = this.ctrlCh;
      const onClose = () => this.resolveAck(false);
      if (ctrl) {
        ctrl.addEventListener("close", onClose, { once: true });
        this.ackOnClose = onClose;
        this.ackCtrl = ctrl;
      }
      this.ackTimer = setTimeout(() => {
        console.warn("[beam-webrtc] No all-received ack within 20s, proceeding. The receiver may still be finishing.");
        this.resolveAck(true);
      }, 20000);
    });
  }

  /** Resolve the pending ack wait (if any). `ok` follows awaitReceiverAck's
   *  contract: true = proceed with onAllComplete, false = peer gone (don't). */
  private resolveAck(ok: boolean) {
    if (this.ackResolver) {
      const r = this.ackResolver;
      this.ackResolver = null;
      r(ok);
    }
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.ackOnClose && this.ackCtrl) {
      this.ackCtrl.removeEventListener("close", this.ackOnClose);
      this.ackOnClose = null;
      this.ackCtrl = null;
    }
  }

  /**
   * Receiver: wait for all expected chunks to arrive, then reassemble into a
   * Blob + fire onFileComplete. Handles the case where the ordered control
   * channel's file-end arrives before the unordered data channels finish
   * delivering chunks, polls up to ~3s, then finalizes with whatever's there.
   *
   * CRITICAL: We set `entry.finalized = true` IMMEDIATELY after the guard
   * check, BEFORE any `await`. This prevents the race where two concurrent
   * callers (one from `handleChunkMessage`'s auto-finalize trigger, one from
   * `handleControlMessage`'s file-end) both pass the guard, both run the
   * polling loop, both reassemble, and both fire `onFileComplete`, leaking
   * a blob URL and confusing the React state.
   */
  private async finalizeFile(seq: number) {
    const entry = this.incoming.get(seq);
    if (!entry || entry.finalized) return;
    entry.finalized = true; // ← claim now, before any await

    // Wait until we ACTUALLY have all the bytes before reassembling. The true
    // completion signals are: `received >= file.size` (bytes) OR
    // `receivedChunks >= expectedCount` (chunk count). We deliberately do NOT
    // use `count` (highest index) here, with unordered reliable delivery the
    // highest-index chunk can arrive BEFORE earlier ones, so `count` can equal
    // `expectedCount` while `received` is still far below `size`. Exiting the
    // poll on `count` would reassemble a PARTIAL blob and then, because
    // `finalized` is already true, suppress the auto-finalize when the missing
    // chunks finally arrive, leaving the user with a corrupt file or a
    // "stuck at 100%" UI.
    //
    // 10s ceiling: file-end can arrive on the ordered control channel while
    // late data chunks are still draining from the SCTP buffers. 10s is plenty
    // on any connection healthy enough to have gotten this far; if chunks
    // still haven't arrived after 10s the connection is effectively dead and
    // we finalize with what we have (better than hanging the UI forever).
    const deadline = Date.now() + 10000;
    while (
      entry.received < entry.file.size &&
      entry.receivedChunks < entry.expectedCount &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Reassemble in index order. Iterate up to the highest index we've seen
    // so we include every chunk that arrived; `if (c)` skips any still-missing
    // slots (shouldn't happen on a healthy connection after the poll above,
    // but is a safe degradation if the 10s ceiling fired).
    //
    // CRITICAL: if we STILL don't have all the bytes after the 10s ceiling,
    // the connection died mid-file. Do NOT reassemble a partial blob and lie
    // "done", that's what produced the "photos turn black" symptom (a
    // corrupt image with missing chunks renders as black/blank areas). Mark
    // the file as errored so the user knows it didn't make it and can ask the
    // sender to re-send just that one.
    if (entry.received < entry.file.size) {
      this.onFileError?.(
        entry.file,
        `Only got ${formatBytes(entry.received)} of ${formatBytes(entry.file.size)}, the connection dropped mid-file. Ask the sender to send ${entry.file.name} again.`,
      );
      return;
    }
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

  /** Wait until a data channel's send buffer drops below LOW_WATERMARK.
   *  Hardened: resolves on the bufferedamountlow event, OR on a 5s timeout,
   *  OR if the channel closes, so the sender can never hang forever waiting
   *  on a channel that died mid-transfer. */
  private waitForLowBuffer(dc: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        dc.removeEventListener("bufferedamountlow", onLow);
        dc.removeEventListener("close", onClose);
        clearTimeout(timer);
        resolve();
      };
      const onLow = () => finish();
      const onClose = () => finish();
      const timer = setTimeout(finish, 5000);
      dc.addEventListener("bufferedamountlow", onLow, { once: true });
      dc.addEventListener("close", onClose, { once: true });
    });
  }

  // --------------------------------------------------------------------------------------
  // ICE candidate-type logging, which path won? (host/srflx = fast, relay = slow)
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

  /**
   * Look up the object URL for a given file ID, if finalizeFile has run.
   * Used by the React hook's safety net to recover URLs that were created
   * AFTER onFileComplete fired (e.g., text-fetch path was still pending when
   * onAllComplete marked the file done without a URL).
   */
  getFinalizedUrl(id: string): string | undefined {
    for (const entry of this.incoming.values()) {
      if (entry.file.id === id && entry.finalized) return entry.url;
    }
    return undefined;
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
    if (this.iceConnectTimer) {
      clearTimeout(this.iceConnectTimer);
      this.iceConnectTimer = null;
    }
    if (this.reconnectingFailTimer) {
      clearTimeout(this.reconnectingFailTimer);
      this.reconnectingFailTimer = null;
    }
    if (this.channelOpenTimer) {
      clearTimeout(this.channelOpenTimer);
      this.channelOpenTimer = null;
    }
    // Settle any pending receiver-ack wait as not-ok (peer gone) so an
    // awaiting sendQueuedFiles doesn't fire onAllComplete on teardown.
    this.resolveAck(false);
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

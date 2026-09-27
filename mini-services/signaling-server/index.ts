/**
 * Beam — Signaling Server
 * ---------------------------------------------------------------------------
 * A tiny Socket.IO service whose ONLY job is to shuttle WebRTC connection
 * metadata (SDP offer/answer + ICE candidates) between two paired browsers.
 * File bytes NEVER touch this server — they flow directly device-to-device
 * over an RTCDataChannel once ICE completes.
 *
 * PORT: 3003 (hardcoded — Caddy routes ?XTransformPort=3003 here).
 *
 * ---------------------------------------------------------------------------
 * FULL WEBRTC / SIGNALING FLOW (the tricky part — read this before editing):
 * ---------------------------------------------------------------------------
 * 1. SENDER opens Beam, client generates a 6-char sessionId, calls
 *    `create-session { sessionId, device }`. Server joins socket to room
 *    `session:{sessionId}` and records sender. Replies `session-created`.
 *
 * 2. SENDER renders a QR code encoding `{origin}/?r={sessionId}` and shows it
 *    on screen. RECEIVER scans the QR, opens that URL, sees it has `?r=...`
 *    and calls `join-session { sessionId, device }`.
 *
 * 3. Server replies to RECEIVER with `session-joined { sender }` and emits
 *    `peer-joined { receiver }` to the SENDER. Both peers now know the other
 *    is present. ONLY the sender is the WebRTC initiator (it created the
 *    offer — see step 4).
 *
 * 4. SDP OFFER: Sender creates RTCPeerConnection + RTCDataChannel, calls
 *    `pc.createOffer()` → `pc.setLocalDescription(offer)`, then sends
 *    `signal { data: { kind: "offer", payload: offer } }`. Server relays
 *    `signal { data }` to the RECEIVER ONLY (never echoes back to sender).
 *
 * 5. SDP ANSWER: Receiver receives the offer, calls
 *    `pc.setRemoteDescription(offer)` → `pc.createAnswer()` →
 *    `pc.setLocalDescription(answer)`, then sends
 *    `signal { data: { kind: "answer", payload: answer } }`. Server relays
 *    to the SENDER ONLY. Sender calls `pc.setRemoteDescription(answer)`.
 *
 * 6. ICE CANDIDATES: Both peers' ICE agents gather local network paths
 *    (host / srflx STUN / relay TURN candidates). For each candidate, the
 *    peer sends `signal { data: { kind: "candidate", payload: candidate } }`.
 *    Server relays each to the OTHER peer, which calls
 *    `pc.addIceCandidate(candidate)`. This is bidirectional and may interleave
 *    with steps 4/5 (trickle ICE).
 *
 * 7. ICE CONNECT → DataChannel opens → file bytes flow directly P2P, encrypted
 *    via DTLS. The signaling server sees nothing of the file data. After this
 *    point the signaling socket can close; the WebRTC connection stays up
 *    until either side closes the DataChannel or the page unloads.
 *
 * Key invariant for the relay: ONLY forward to the OTHER peer in the room.
 * Never broadcast, never echo back to the sender — otherwise the sender would
 * receive its own offer and the SDP negotiation would loop/corrupt.
 * ---------------------------------------------------------------------------
 */

import { createServer } from "node:http";
import { Server } from "socket.io";

// Hardcoded per spec — Caddy gateway expects this exact port.
const PORT = 3003;

// Room namespacing: every session lives in a room named `session:{sessionId}`.
const roomName = (sessionId: string) => `session:${sessionId}`;

// 10 minutes of inactivity → evict the session entirely.
const SESSION_IDLE_TTL_MS = 10 * 60 * 1000;
// Grace period after BOTH peers leave: keep the record so the same sessionId
// can be rejoined for reconnect/retry, then evict if still empty.
const EMPTY_GRACE_MS = 60 * 1000;
// Sweep cadence for the eviction loop.
const CLEANUP_INTERVAL_MS = 60 * 1000;

// Only these `data.kind` values may be relayed. Anything else is dropped —
// defense in depth so the server is never an arbitrary message bus (and can
// never accidentally become a file-byte channel).
const ALLOWED_SIGNAL_KINDS = new Set(["offer", "answer", "candidate"]);

type DeviceInfo = {
  name?: string;
  ua?: string;
  platform?: string;
};

type Session = {
  sessionId: string;
  sender: string | null; // socket.id
  receiver: string | null; // socket.id
  senderInfo?: DeviceInfo;
  receiverInfo?: DeviceInfo;
  createdAt: number;
  lastActivity: number;
  // Timestamp at which BOTH peers became absent; used for the grace window.
  emptiedAt?: number;
};

// In-memory session table. This is a signaling server, not a database —
// all state is ephemeral and lost on restart, which is fine: clients will
// just re-scan the QR / re-create the session.
const sessions = new Map<string, Session>();

// Reverse index: socket.id → set of sessionIds that socket participates in.
// Used on disconnect to find which sessions to clean up.
const socketToSessions = new Map<string, Set<string>>();

const startedAt = Date.now();

// ---------------------------------------------------------------------------
// HTTP server — minimal `/health` endpoint. Socket.IO binds on top.
// IMPORTANT: engine.io (path: "/") intercepts ALL requests whose URL starts
// with "/" — i.e. every request — including ones the cors middleware
// (configured via the `cors` option below) will try to attach CORS headers
// to. If we let engine.io handle `/health` it returns its own
// "Transport unknown" 400; if we respond from a listener registered AFTER
// `new Server(...)`, the cors middleware still fires next and throws a noisy
// "Cannot set headers after they are sent" error (non-fatal but ugly).
//
// So we capture engine.io's request listeners, remove them, and re-wrap with
// a single 'request' listener that short-circuits `/health` and otherwise
// delegates to engine.io. This keeps `/health` off the cors middleware
// entirely.
// ---------------------------------------------------------------------------
const httpServer = createServer();

const io = new Server(httpServer, {
  // CRITICAL: path MUST be "/". The Caddy gateway forwards requests that
  // carry ?XTransformPort=3003 to localhost:3003 and expects Socket.IO to
  // live at the root. Do NOT change this to /socket.io/.
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Capture the request listeners engine.io just registered on the http
// server (its own request handler + anything else it added). Then strip them
// and re-install a single wrapper that short-circuits /health.
const engineRequestListeners = httpServer
  .listeners("request")
  .slice() as ((req: any, res: any) => void)[];
httpServer.removeAllListeners("request");

httpServer.on("request", (req, res) => {
  // Health probe — used by ops / Caddy / curl sanity checks. Handled here
  // BEFORE delegating to engine.io so we never touch the cors middleware.
  if (req.url === "/health" || req.url === "/health/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "beam-signaling",
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        rooms: sessions.size,
      }),
    );
    return;
  }
  // Anything else: hand off to engine.io (it'll handle the Socket.IO
  // handshake / polling / websocket upgrade paths).
  for (const fn of engineRequestListeners) {
    try {
      fn.call(httpServer, req, res);
    } catch (err) {
      // Should not happen — but never let a bad engine.io call kill us.
      console.error("[signaling] engine request handler error", err);
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Touch a session's lastActivity timestamp (e.g. on signaling relay). */
function touch(session: Session) {
  session.lastActivity = Date.now();
  // Session has activity again — clear any "emptied" marker.
  if (session.emptiedAt) session.emptiedAt = undefined;
}

/** Emit an event to a specific socket by id, ignoring unknown sockets. */
function emitTo(socketId: string | null, event: string, payload?: unknown) {
  if (!socketId) return;
  const s = io.sockets.sockets.get(socketId);
  if (!s) return;
  s.emit(event, payload);
}

/** Remove a socket from a session's room and forget the reverse index. */
function detachSocket(socketId: string, sessionId: string) {
  const socket = io.sockets.sockets.get(socketId);
  if (socket) socket.leave(roomName(sessionId));
  const set = socketToSessions.get(socketId);
  if (set) {
    set.delete(sessionId);
    if (set.size === 0) socketToSessions.delete(socketId);
  }
}

/**
 * Evict a session: tell any still-present peers it expired, kick them out of
 * the room, then delete the session record. Logs the eviction.
 */
function evictSession(sessionId: string, reason: string) {
  const session = sessions.get(sessionId);
  if (!session) return;
  console.log(
    `[signaling] evict session=${sessionId} reason=${reason} sender=${
      session.sender ?? "-"
    } receiver=${session.receiver ?? "-"}`,
  );
  // Notify + detach any sockets still attached.
  if (session.sender) {
    emitTo(session.sender, "session-expired", {});
    detachSocket(session.sender, sessionId);
  }
  if (session.receiver) {
    emitTo(session.receiver, "session-expired", {});
    detachSocket(session.receiver, sessionId);
  }
  sessions.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Socket.IO connection lifecycle
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  console.log(`[signaling] connect socket=${socket.id}`);

  // ---- create-session (SENDER) -----------------------------------------
  socket.on("create-session", (payload: any) => {
    try {
      const sessionId = String(payload?.sessionId ?? "").trim();
      if (!sessionId) {
        socket.emit("error", { message: "Missing sessionId" });
        return;
      }
      const device = (payload?.device ?? {}) as DeviceInfo;
      const now = Date.now();

      // Re-create semantics: if a sender already exists for this session,
      // notify any existing peers that the other side left first — this
      // supports a sender reconnecting with the same sessionId after a
      // page refresh / network blip.
      const existing = sessions.get(sessionId);
      if (existing) {
        if (existing.sender && existing.sender !== socket.id) {
          emitTo(existing.sender, "peer-left", {});
          detachSocket(existing.sender, sessionId);
        }
        // Drop the old receiver too — a fresh create resets the session.
        if (existing.receiver && existing.receiver !== socket.id) {
          emitTo(existing.receiver, "peer-left", {});
          detachSocket(existing.receiver, sessionId);
        }
        // Keep createdAt if the session already existed (continuity for UX)
        // but bump lastActivity.
        existing.sender = socket.id;
        existing.senderInfo = device;
        existing.receiver = null;
        existing.receiverInfo = undefined;
        touch(existing);
        existing.emptiedAt = undefined;
        sessions.set(sessionId, existing);
      } else {
        sessions.set(sessionId, {
          sessionId,
          sender: socket.id,
          receiver: null,
          senderInfo: device,
          createdAt: now,
          lastActivity: now,
        });
      }

      // Join the room so socket.to(room) reaches the other peer.
      socket.join(roomName(sessionId));
      // Reverse index for cleanup on disconnect.
      let set = socketToSessions.get(socket.id);
      if (!set) {
        set = new Set();
        socketToSessions.set(socket.id, set);
      }
      set.add(sessionId);

      console.log(
        `[signaling] create-session sessionId=${sessionId} socket=${
          socket.id
        } device=${device.name ?? "-"}`,
      );
      socket.emit("session-created", {
        sessionId,
        createdAt: sessions.get(sessionId)!.createdAt,
      });
    } catch (err) {
      console.error("[signaling] create-session error", err);
      socket.emit("error", { message: "Failed to create session" });
    }
  });

  // ---- join-session (RECEIVER) -----------------------------------------
  socket.on("join-session", (payload: any) => {
    try {
      const sessionId = String(payload?.sessionId ?? "").trim();
      if (!sessionId) {
        socket.emit("error", { message: "Missing sessionId" });
        return;
      }
      const device = (payload?.device ?? {}) as DeviceInfo;
      const session = sessions.get(sessionId);

      if (!session || !session.sender) {
        // No sender means the session never existed or was already evicted.
        socket.emit("error", { message: "Session not found or expired" });
        return;
      }

      // Enforce exactly one receiver. If one already exists, evict/replace
      // it (peer-left) — supports receiver reconnecting with same sessionId.
      if (session.receiver && session.receiver !== socket.id) {
        emitTo(session.receiver, "peer-left", {});
        detachSocket(session.receiver, sessionId);
      }

      session.receiver = socket.id;
      session.receiverInfo = device;
      touch(session);
      sessions.set(sessionId, session);

      socket.join(roomName(sessionId));
      let set = socketToSessions.get(socket.id);
      if (!set) {
        set = new Set();
        socketToSessions.set(socket.id, set);
      }
      set.add(sessionId);

      console.log(
        `[signaling] join-session sessionId=${sessionId} socket=${
          socket.id
        } device=${device.name ?? "-"}`,
      );

      // Reply to receiver with sender info, and notify sender that the
      // receiver is here. Sender is the WebRTC initiator (see header).
      socket.emit("session-joined", {
        sessionId,
        sender: session.senderInfo ?? {},
      });
      emitTo(session.sender, "peer-joined", { receiver: device });
    } catch (err) {
      console.error("[signaling] join-session error", err);
      socket.emit("error", { message: "Failed to join session" });
    }
  });

  // ---- signal (relay SDP offer/answer + ICE candidates) ---------------
  // This is the heart of the signaling server — and the ONLY channel that
  // carries WebRTC metadata. The relay rule is critical:
  //   relay to the OTHER peer only — never broadcast, never echo to sender.
  socket.on("signal", (payload: any) => {
    try {
      const sessionId = String(payload?.sessionId ?? "").trim();
      const data = payload?.data;
      if (!sessionId || !data || typeof data.kind !== "string") {
        // Malformed — drop silently. Don't even error back; clients that
        // send junk shouldn't learn anything about the server.
        return;
      }
      // Defense in depth: only offer/answer/candidate ever get relayed.
      if (!ALLOWED_SIGNAL_KINDS.has(data.kind)) {
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        socket.emit("error", { message: "Session not found or expired" });
        return;
      }
      // The sender must not be able to relay to itself, and vice versa.
      const otherSocketId =
        session.sender === socket.id
          ? session.receiver
          : session.receiver === socket.id
            ? session.sender
            : null;
      if (!otherSocketId) {
        // Other peer not present yet — drop. (A real client should wait for
        // `session-joined` / `peer-joined` before signaling.)
        return;
      }

      // IMPORTANT: relay to the OTHER peer only — never broadcast, never
      // echo to the sender. Echoing the offer back to the sender would
      // corrupt the SDP negotiation.
      emitTo(otherSocketId, "signal", { data });
      touch(session);
    } catch (err) {
      console.error("[signaling] signal error", err);
    }
  });

  // ---- leave-session ---------------------------------------------------
  socket.on("leave-session", (payload: any) => {
    try {
      const sessionId = String(payload?.sessionId ?? "").trim();
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (!session) return;

      // Figure out which role this socket played so we notify the OTHER.
      const wasSender = session.sender === socket.id;
      const wasReceiver = session.receiver === socket.id;

      detachSocket(socket.id, sessionId);

      if (wasSender) {
        session.sender = null;
        session.senderInfo = undefined;
        // Tell the receiver their peer left.
        emitTo(session.receiver, "peer-left", {});
      }
      if (wasReceiver) {
        session.receiver = null;
        session.receiverInfo = undefined;
        emitTo(session.sender, "peer-left", {});
      }

      // If both peers are now gone, start the grace timer (handled in the
      // cleanup loop using `emptiedAt`).
      if (session.sender === null && session.receiver === null) {
        if (!session.emptiedAt) session.emptiedAt = Date.now();
      }

      console.log(
        `[signaling] leave-session sessionId=${sessionId} socket=${
          socket.id
        } role=${wasSender ? "sender" : wasReceiver ? "receiver" : "?"}`,
      );
    } catch (err) {
      console.error("[signaling] leave-session error", err);
    }
  });

  // ---- LOBBY / NEARBY DEVICES -----------------------------------------
  // A presence layer separate from sessions. Every connected device that
  // isn't mid-transfer joins the "lobby" room and broadcasts its device
  // info. Other lobby members see it as "nearby" and can tap it to send.
  //
  //   join-lobby { device }       → server adds socket to the lobby room,
  //                                 replies lobby-list { devices: [...] },
  //                                 and broadcasts lobby-update to all
  //                                 other lobby members.
  //   invite { sessionId, to, device, files }
  //                              → server relays `invite` to the target
  //                                 socket. The target auto-joins the
  //                                 session via the existing join-session
  //                                 flow (no new transport needed).
  //
  // On disconnect (below) or leave-lobby, the socket leaves the lobby and
  // a lobby-update is broadcast so others remove it from their nearby list.
  socket.on("join-lobby", (payload: any) => {
    try {
      const device = (payload?.device ?? {}) as DeviceInfo;
      socket.join("lobby");
      socket.data.lobbyDevice = device; // stashed for lobby-list + leave
      console.log(
        `[signaling] join-lobby socket=${socket.id} device=${device.name ?? "-"}`,
      );
      // Send this socket the current lobby roster (everyone except itself).
      const roster: { socketId: string; device: DeviceInfo }[] = [];
      for (const [sid, s] of io.sockets.sockets) {
        if (sid === socket.id) continue;
        if (s.data.lobbyDevice) {
          roster.push({ socketId: sid, device: s.data.lobbyDevice });
        }
      }
      socket.emit("lobby-list", { devices: roster });
      // Tell everyone else this device just appeared.
      socket.to("lobby").emit("lobby-update", {
        kind: "join",
        socketId: socket.id,
        device,
      });
    } catch (err) {
      console.error("[signaling] join-lobby error", err);
    }
  });

  socket.on("leave-lobby", () => {
    if (socket.data.lobbyDevice) {
      socket.leave("lobby");
      socket.to("lobby").emit("lobby-update", {
        kind: "leave",
        socketId: socket.id,
      });
      socket.data.lobbyDevice = undefined;
    }
  });

  // invite: a sender picks a nearby device by socketId to send to.
  // Server relays the invite to the target; the target's client calls
  // join-session(sessionId) on receipt → existing flow takes over.
  socket.on("invite", (payload: any) => {
    try {
      const to = String(payload?.to ?? "").trim();
      const sessionId = String(payload?.sessionId ?? "").trim();
      const device = (payload?.device ?? {}) as DeviceInfo;
      const files = payload?.files;
      if (!to || !sessionId) {
        socket.emit("error", { message: "invite requires `to` and `sessionId`" });
        return;
      }
      const target = io.sockets.sockets.get(to);
      if (!target) {
        socket.emit("error", { message: "That device isn't online anymore" });
        return;
      }
      console.log(
        `[signaling] invite sessionId=${sessionId} from=${socket.id} to=${to}`,
      );
      emitTo(to, "invite", {
        sessionId,
        from: socket.id,
        device,
        files,
      });
    } catch (err) {
      console.error("[signaling] invite error", err);
    }
  });

  // ---- disconnect ------------------------------------------------------
  socket.on("disconnect", (reason) => {
    console.log(`[signaling] disconnect socket=${socket.id} reason=${reason}`);
    // Lobby cleanup: tell others this device is gone.
    if (socket.data.lobbyDevice) {
      socket.to("lobby").emit("lobby-update", {
        kind: "leave",
        socketId: socket.id,
      });
    }
    const set = socketToSessions.get(socket.id);
    if (!set) return;
    for (const sessionId of set) {
      const session = sessions.get(sessionId);
      if (!session) continue;
      const wasSender = session.sender === socket.id;
      const wasReceiver = session.receiver === socket.id;

      if (wasSender) {
        session.sender = null;
        session.senderInfo = undefined;
        // Tell the remaining peer so it can update UI / tear down PC.
        emitTo(session.receiver, "peer-left", {});
      }
      if (wasReceiver) {
        session.receiver = null;
        session.receiverInfo = undefined;
        emitTo(session.sender, "peer-left", {});
      }
      // Leave the room membership tidy (no-op if already detached above).
      detachSocket(socket.id, sessionId);

      // Both peers gone? Start grace window for reconnect. Otherwise the
      // cleanup loop will eventually evict by idle timeout.
      if (session.sender === null && session.receiver === null) {
        if (!session.emptiedAt) session.emptiedAt = Date.now();
      }
    }
    socketToSessions.delete(socket.id);
  });
});

// ---------------------------------------------------------------------------
// Cleanup loop — runs every 60s.
// Evict a session if:
//   (a) it's been idle (no signaling activity) for > 10 minutes, OR
//   (b) both peers are gone and the 60s grace window has elapsed.
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    const idleMs = now - session.lastActivity;
    const bothGone =
      session.sender === null && session.receiver === null;
    if (idleMs > SESSION_IDLE_TTL_MS) {
      evictSession(sessionId, `idle ${Math.round(idleMs / 1000)}s`);
    } else if (
      bothGone &&
      session.emptiedAt &&
      now - session.emptiedAt > EMPTY_GRACE_MS
    ) {
      evictSession(sessionId, "empty-after-grace");
    }
  }
}, CLEANUP_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal: string) {
  console.log(`[signaling] ${signal} received, shutting down...`);
  // Notify all connected sockets so clients can show a clean error.
  for (const [, session] of sessions) {
    if (session.sender) emitTo(session.sender, "session-expired", {});
    if (session.receiver) emitTo(session.receiver, "session-expired", {});
  }
  sessions.clear();
  io.close(() => {
    httpServer.close(() => {
      console.log("[signaling] closed, exiting");
      process.exit(0);
    });
  });
  // Hard exit fallback if close hangs.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Bind
// ---------------------------------------------------------------------------
httpServer.listen(PORT, () => {
  console.log(
    `[signaling] beam-signaling-server listening on http://0.0.0.0:${PORT} (path=/)`,
  );
});

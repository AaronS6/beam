# Beam Signaling Server

A minimal Bun + Socket.IO service that pairs two browsers (sender ↔ receiver
via a 6-char session ID rendered as a QR code) and relays WebRTC signaling
metadata — SDP offer / SDP answer / ICE candidates — between them. **File
bytes never touch this server**; they flow directly device-to-device over an
`RTCDataChannel` once ICE connects.

## What it does

- Accepts a `create-session` from the sender (the device that shows the QR).
- Accepts a `join-session` from the receiver (the device that scanned the QR).
- Relays `signal` messages (`offer` / `answer` / `candidate`) **only to the
  other peer** in the room — never echoes back, never broadcasts.
- Cleans up idle / abandoned sessions automatically.

## How to run

```bash
cd mini-services/signaling-server
bun install           # first time only
bun run dev           # auto-restart on file change (bun --hot)
# or: bun run start   # no hot reload
```

The server listens on **port 3003** (hardcoded — the Caddy gateway expects
this exact port for `?XTransformPort=3003` forwarding).

Health check:

```bash
curl http://localhost:3003/health
# {"ok":true,"service":"beam-signaling","uptime":12,"rooms":0}
```

## Environment variables

**None.** Port is hardcoded to `3003` per the Caddy gateway contract.

## Event protocol

### Client → Server

| Event             | Payload                                                                                                | Notes                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `create-session`  | `{ sessionId, device?: { name?, ua?, platform? } }`                                                     | Sender. Re-creating replaces existing peers (reconnect).     |
| `join-session`    | `{ sessionId, device?: {...} }`                                                                        | Receiver. Errors if no sender. Only one receiver at a time.  |
| `signal`          | `{ sessionId, data: { kind: "offer" \| "answer" \| "candidate", payload: any } }`                       | Relayed to the OTHER peer only. Other `kind`s are dropped.  |
| `leave-session`   | `{ sessionId }`                                                                                        | Leaves room, notifies other peer with `peer-left`.          |

### Server → Client

| Event              | Payload                                            | Recipient                          |
| ------------------ | -------------------------------------------------- | ---------------------------------- |
| `session-created`  | `{ sessionId, createdAt }`                         | sender                             |
| `session-joined`   | `{ sessionId, sender: DeviceInfo }`                | receiver                           |
| `peer-joined`      | `{ receiver: DeviceInfo }`                          | sender                             |
| `signal`           | `{ data }`                                          | the other peer (relay target only) |
| `peer-left`        | `{}`                                                | the remaining peer                 |
| `session-expired`  | `{}`                                                | present peers on eviction           |
| `error`            | `{ message }`                                       | the offending socket                |

## Lifecycle / expiry

- Sessions live in memory (lost on restart — clients re-scan the QR).
- 10 minutes of inactivity → evicted (`session-expired` emitted to peers).
- Both peers gone → kept for a 60-second grace window to allow reconnect,
  then evicted.
- Cleanup sweep runs every 60 seconds.

# Beam

**Just drop your files and scan.** Beam is a cross-device file-transfer tool with a warm, human design and two transfer paths: **direct peer-to-peer** (default, nothing stored) and **temporary server storage** (opt-in, auto-deletes within 5 minutes or the instant the file is grabbed). No app install required.

Works between Android, iPhone, laptop, and desktop — any combination with a browser and a camera.

---

## What's new in this version (v2 redesign)

This is a full redesign + stricter file-lifecycle + throughput overhaul of the original Beam. Three things changed:

### 1. Visual redesign — WeTransfer-style warmth, not Apple-minimal
The old version was a stark white Apple-style page. v2 is a **bold warm coral full-bleed background** (`#FF7A5C`) with a single **white floating card** as the focal point. Big friendly sentence-case headline ("Just drop your files and scan."), generous 28px rounded corners, soft warm shadows, drifting blob decorations behind the card, and micro-copy that sounds like a person ("Drop your files here" / "Scan to grab them" / "This disappears in 4:32"). Dark mode shifts to a **deep warm espresso** (`#2A1812`) so the brand color still reads through — never pure black. One accent (coral), one background, one card.

### 2. Two file-lifecycle paths with hard auto-deletion
- **Path A — Direct peer-to-peer (default):** files stream over WebRTC DataChannels, never touch any server, nothing to delete. The QR/session expires after **5 minutes** if no second device connects.
- **Path B — Store temporarily (opt-in toggle):** if the sender enables "Store temporarily" before generating the code, files upload **once** to encrypted-at-rest server storage (AES-256-GCM, per-file random key) instead of streaming P2P. Two hard server-side rules:
  - **Auto-delete ≤ 5 min after upload** — enforced by a `setInterval` cleanup job in `src/instrumentation.ts` that runs every 30 seconds and physically deletes the encrypted blob + DB row. Not a client timer; cannot be bypassed by closing the tab.
  - **Instant delete on first full download** — a `GET /api/beam/store?id=...` atomically claims the record (`updateMany` check-and-set on `downloadedAt IS NULL`), then deletes the file + row before returning the bytes. A second GET returns **404 "This link has expired or already been used."** — one-time-use only.
  - Both screens show an honest live countdown ("Disappears in 4:32" / "Gone once they download it").

### 3. Maximum transfer speed — specific optimizations for Path A
The old version used a single ordered DataChannel with 64 KB chunks. v2 implements, in `src/lib/webrtc.ts`:
- **4 parallel RTCDataChannels**: 1 ordered control channel (`ctrl`) + 3 unordered data channels (`d0`,`d1`,`d2` with `ordered:false, maxRetransmits:3`). File chunks are **striped round-robin** across the 3 data channels, each tagged with `{fileId, index}`; the receiver reassembles by index. SCTP delivers them in parallel → roughly 2-3× throughput on fast links.
- **256 KB chunks** (vs the 16 KB default) — fewer syscall round-trips per byte.
- **Per-channel backpressure** via `bufferedAmountLowThreshold` (2 MB) + the `bufferedamountlow` event (pause at 8 MB high watermark) — never overflows or stalls.
- **`ordered:false` + bounded `maxRetransmits`** on data channels — strict ordering isn't needed because chunks reassemble by index; unordered lets SCTP skip head-of-line blocking.
- **ICE candidate-type logging**: the winning pair is read from `getStats()` and surfaced as a **"Direct" / "Relay" badge** in the UI + logged to the console (`[beam-webrtc] ICE selected: local=host remote=srflx → winner=host`). Direct (host/srflx) is preferred; TURN relay is a last-resort fallback.
- **Live MB/s display** during transfer.

### Real-world speed reality (read this)
Throughput depends on two things the code cannot control:
1. **Connection type**: a direct P2P path (host/srflx ICE candidate — shows "Direct") is fast. A TURN relay (shows "Relay") is meaningfully slower because bytes bounce through a third server. Beam prefers direct and only falls back to relay when the network blocks direct P2P (symmetric NAT, restrictive corporate Wi-Fi). Configure TURN via `NEXT_PUBLIC_TURN_URL` / `NEXT_PUBLIC_TURN_USER` / `NEXT_PUBLIC_TURN_CRED`.
2. **The slower device's upload bandwidth**: P2P is limited by whichever side uploads slower. A phone on cellular will be slower than a laptop on fiber, regardless of code quality. The speed optimizations above (parallel channels, larger chunks, unordered delivery) raise the ceiling toward the network's actual limit — they don't create bandwidth that isn't there.

### The WebRTC offer / answer / ICE flow

This is the trickiest part of the codebase (`src/lib/webrtc.ts`, `src/lib/signaling.ts`, `mini-services/signaling-server/index.ts`):

```
SENDER (shows QR)                         RECEIVER (scans QR)
─────────────────                         ────────────────────
1. signaling.createSession(id)            1. signaling.joinSession(id)
2. waits for `peer-joined`  ←── server tells both peers about each other ──→ server replies `session-joined`
3. create RTCPeerConnection + DataChannel
4. pc.createOffer() → setLocalDescription
5. signal { kind:"offer", offer }  ──→    6. pc.setRemoteDescription(offer)
                                          7. pc.createAnswer() → setLocalDescription
                              ←──────     8. signal { kind:"answer", answer }
9. pc.setRemoteDescription(answer)
10. pc.onicecandidate → signal { kind:"candidate", c }  (both sides, trickled)
11. ICE agents test candidate pairs → "connected" → DataChannel `onopen`
12. Sender streams 64 KB chunks over the DataChannel (with backpressure)
13. Receiver assembles Blob → one-tap save
```

Reconnect handling: if the phone locks its screen mid-transfer, the ICE path may temporarily drop (`iceConnectionState → "disconnected"`). Beam surfaces a clear **"Reconnecting…"** state rather than failing silently; ICE often recovers on its own. If it goes to `"failed"`, an error is shown with a retry.

---

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn/ui |
| Realtime | Socket.IO (signaling only) + WebRTC (RTCPeerConnection / RTCDataChannel) |
| QR | `qrcode` npm package, rendered client-side (no external API) |
| STUN | `stun:stun.l.google.com:19302` (NAT traversal) |
| TURN | Optional, via env vars (fallback for symmetric NATs / corporate networks) |
| PWA | `manifest.json` + service worker (offline shell caching only — never file transfers) |
| Signaling server | Standalone Bun + Socket.IO service |

---

## Project structure

```
.
├── src/
│   ├── app/
│   │   ├── layout.tsx          # Root layout: fonts, theme, manifest, SW registration
│   │   ├── page.tsx            # Single user route — wraps BeamApp in Suspense
│   │   └── globals.css         # Apple-tier design system (colors, beam gradient, motion)
│   ├── components/
│   │   ├── beam/
│   │   │   ├── beam-app.tsx        # Top-level app: routes sender vs receiver via ?r=
│   │   │   ├── beam-stage.tsx      # Floating frame w/ animated beam-pulse glow
│   │   │   ├── beam-qr.tsx         # Client-side QR renderer
│   │   │   ├── file-dropzone.tsx   # Drag-and-drop + browse
│   │   │   ├── file-row.tsx        # File list item w/ progress + save
│   │   │   ├── progress-ring.tsx   # Circular progress (beam gradient stroke)
│   │   │   ├── sender-panel.tsx    # All sender states (idle/waiting/transfer/done/…)
│   │   │   ├── receiver-panel.tsx  # All receiver states
│   │   │   ├── nav.tsx · footer.tsx · sections.tsx · sw-register.tsx
│   │   ├── beam-logo.tsx      # Inline SVG brand mark
│   │   ├── theme-provider.tsx · theme-toggle.tsx
│   │   └── ui/                 # shadcn/ui components
│   ├── hooks/
│   │   └── use-beam-session.ts # Orchestrates signaling + WebRTC + UI state
│   └── lib/
│       ├── signaling.ts        # Socket.IO client wrapper (typed protocol)
│       ├── webrtc.ts           # RTCPeerConnection + DataChannel + chunked transfer
│       ├── format.ts           # Session IDs, byte/speed/device helpers
│       ├── register-sw.ts      # Service worker registration (prod only)
│       └── db.ts               # Prisma client (unused by Beam — scaffold leftover)
├── mini-services/
│   └── signaling-server/       # Standalone Socket.IO signaling service (port 3003)
│       ├── index.ts            # Room-based session handling, relay-only, expiry
│       └── package.json
├── public/
│   ├── manifest.json
│   ├── sw.js                    # App-shell service worker
│   ├── beam-logo.svg
│   ├── icons/                   # 192/512/maskable PNGs
│   └── apple-touch-icon.png · icon-32.png
├── scripts/
│   └── gen-icons.mjs            # Regenerate PNG icons from the SVG (uses sharp)
├── prisma/                      # Prisma schema (unused by Beam)
├── Caddyfile                    # Gateway: routes ?XTransformPort=3003 → signaling
└── package.json
```

---

## Local setup

### Prerequisites
- Node.js 20+ or [Bun](https://bun.sh)
- Two browser tabs (or two devices on the same network) to test the transfer

### 1. Install & run the frontend
```bash
bun install
bun run dev          # Next.js on http://localhost:3000
```

### 2. Install & run the signaling server
```bash
cd mini-services/signaling-server
bun install
bun run dev          # Socket.IO signaling server on http://localhost:3003
```

### 3. Open the app
Open `http://localhost:3000` (or your gateway host). Pick a file → a QR appears. Open the QR's URL in a second tab (or scan it with a phone on the same network) → the file transfers directly between the two.

> **Gateway note:** This repo ships with a Caddy gateway (`Caddyfile`) that exposes one external port and routes signaling traffic via the `?XTransformPort=3003` query param. The frontend connects with `io("/?XTransformPort=3003")` so the gateway can forward WebSocket traffic to port 3003. In a plain local setup (no gateway), you can instead point the frontend directly at the signaling server by editing the transport in `src/lib/signaling.ts`.

---

## Environment variables

All optional. The app works with zero configuration using Google's public STUN server.

| Variable | Where | Purpose |
|----------|-------|---------|
| `NEXT_PUBLIC_TURN_URL` | frontend | TURN server URL(s), e.g. `turn:turn.example.com:3478` (comma-separated supported by WebRTC) |
| `NEXT_PUBLIC_TURN_USER` | frontend | TURN username |
| `NEXT_PUBLIC_TURN_CRED` | frontend | TURN credential |

Create a `.env.local` in the project root:
```bash
# Optional — only needed for restrictive networks (symmetric NAT, corporate Wi-Fi)
NEXT_PUBLIC_TURN_URL=turn:turn.example.com:3478
NEXT_PUBLIC_TURN_USER=your-username
NEXT_PUBLIC_TURN_CRED=your-credential
```

Recommended TURN providers if you need one: [Twilio](https://www.twilio.com/stun-turn), [metered.ca](https://www.metered.ca/stun-and-turn-turn-server), or self-host [coturn](https://github.com/coturn/coturn).

---

## Deployment

### Option A — Separate deployments (recommended for scale)

**Frontend → Vercel / Netlify**
```bash
# Vercel
vercel deploy
# Set NEXT_PUBLIC_TURN_* env vars in the project settings if needed.
```
The frontend is a standard Next.js app — deploy as usual. The signaling server URL is derived from the same origin via the `?XTransformPort` gateway convention; if you deploy the signaling server on a different host, update `src/lib/signaling.ts` to connect to that host directly.

**Signaling server → Railway / Render / Fly.io**
```bash
cd mini-services/signaling-server
# Railway
railway up
# Render: create a Web Service from this directory, build = `bun install`, start = `bun run start`
# Fly.io: fly launch --no-deploy && fly deploy
```
The signaling server is a tiny stateless-in-memory service (rooms live in process memory). For multi-instance deployments behind a load balancer, use sticky sessions (Socket.IO) or add Redis adapter — see `mini-services/signaling-server/README.md`.

### Option B — Single-host deployment

Run one Node/Bun process that serves **both** the static frontend and the WebSocket endpoint. The signaling server's `index.ts` already exposes `/health`; to serve the frontend too, add an `express`/static handler in front of Socket.IO on the same port, then run the built Next.js output alongside it. A minimal sketch:

```ts
import { createServer } from "http";
import { Server } from "socket.io";
import { serve } from "bun"; // or express.static for the Next build output

// Serve Next.js static export from ./out (next.config: output: "export")
// + attach Socket.IO to the same HTTP server.
```

For this repo's default dev experience, the Next.js app (port 3000) and the signaling server (port 3003) run as two processes, unified behind the Caddy gateway on a single external port.

---

## PWA

Beam is installable. The service worker (`public/sw.js`) caches the **app shell only** (navigations + static assets, network-first) so the UI loads offline. **File transfers are never cached** — they're live WebRTC streams that don't pass through the service worker.

Icons are generated from `public/beam-logo.svg`:
```bash
bun scripts/gen-icons.mjs     # regenerates public/icons/*.png + apple-touch-icon.png
```

---

## Design system

A single accent — the **beam gradient** (`#0A84FF → #7B61FF` at 135°) — is used sparingly: the QR frame glow, the primary button, the progress fill, and the logo. Everything else is neutral (Apple light: `#FAFAFA`/`#FFFFFF`/`#1D1D1F`; dark: `#000`/`#1C1C1E`/`#F5F5F7`). Dark mode is automatic via `prefers-color-scheme` with a manual toggle. Motion respects `prefers-reduced-motion`.

---

## License

MIT. See source.

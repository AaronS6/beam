# Beam

**Send files without the cables.** Beam is a cross-device file-transfer tool that works by scanning a QR code. Two devices pair through a lightweight signaling server, then transfer files **directly peer-to-peer over WebRTC** — encrypted end to end, with no file bytes ever touching a server. No app install required.

Works between Android, iPhone, laptop, and desktop — any combination that has a browser and a camera.

---

## How it works

1. **Sender** opens the site, picks one or more files. The site generates a short-lived session ID and renders a QR code encoding `https://<your-host>/?r=<sessionId>`.
2. **Receiver** scans the QR with any phone camera. The URL opens the same page, which joins the session over the signaling server.
3. The signaling server relays **only** WebRTC connection metadata (SDP offer/answer, ICE candidates) between the two browsers. It never sees file data.
4. Once the WebRTC `RTCPeerConnection` + `RTCDataChannel` is established, file bytes flow **directly device-to-device**, encrypted with DTLS.
5. Files are sent in 64 KB chunks with `bufferedAmount` backpressure handling. The receiver reassembles chunks into a Blob and offers a one-tap save.
6. The session expires automatically after ~10 minutes of inactivity.

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

# Beam — Deploy Guide

Your repo already has `vercel.json`, `mini-services/signaling-server/render.yaml`, and `deploy.sh` set up. Based on your worklog you have working Vercel + Render deployments — pushing the new code will trigger auto-redeploys.

This guide walks you through applying the bug-fix patch and getting the new version live.

---

## Prerequisites (one-time setup)

You should already have these from your previous deploys. If not, do them first:

1. **GitHub repo**: `github.com/AaronS6/beam` ✅ (already exists)
2. **Vercel project** linked to that repo (frontend)
3. **Render web service** for `mini-services/signaling-server/` (signaling server)
4. **Env vars set** on Vercel:
   - `NEXT_PUBLIC_SIGNALING_URL` = `https://<your-render-signaling-url>` (e.g. `https://beam-signaling.onrender.com`)

If you don't have these yet, see the "Fresh deploy" section at the bottom.

---

## Step 1 — Apply the patch locally

The patch contains all 11 bug fixes (stuck-at-100% + stuck-at-connecting + new "connecting" phase UI).

```bash
cd /path/to/your/beam-repo   # your local clone of AaronS6/beam

# Download the patch from this conversation's download folder, or copy it from
# /home/z/my-project/download/beam-transfer-fixes.patch

# Apply it
git apply beam-transfer-fixes.patch

# Verify it applied cleanly
git diff --stat
# Expected output:
#  src/components/beam/sender-panel.tsx |  33 +++++-
#  src/hooks/use-beam-session.ts        | 197 +++++++++++++++++++++++++----------
#  src/lib/webrtc.ts                    | 141 +++++++++++++++++++++++--
#  3 files changed, 307 insertions(+), 64 deletions(-)

# If the patch fails to apply, fall back to manually copying the files from
# /home/z/my-project/repo/src/ into your local repo's src/ folder.
```

**Quick sanity check:**
```bash
# Install deps if needed
bun install

# Verify TypeScript still compiles (one pre-existing error in webrtc.ts is fine)
bunx tsc --noEmit

# Verify lint passes
bunx eslint src/lib/webrtc.ts src/hooks/use-beam-session.ts src/components/beam/sender-panel.tsx

# Verify production build still succeeds
bun run build
```

---

## Step 2 — Commit & push

```bash
git add src/lib/webrtc.ts src/hooks/use-beam-session.ts src/components/beam/sender-panel.tsx
git commit -m "Fix: stuck-at-100% + stuck-at-connecting — finalizeFile race, ICE timeouts, peer-left debounce, connecting phase

Root causes fixed:
- Stuck at 100%: finalizeFile race condition, done-before-file-end, async fetch delay, safety net URL recovery
- Stuck at connecting: ICE gather timeout (30s), channel open timeout (15s), reconnecting escalation (30s),
  new 'connecting' phase for sender during ICE negotiation, peer-left debounce (3s grace)

Files: webrtc.ts, use-beam-session.ts, sender-panel.tsx"

git push origin main
```

---

## Step 3 — Vercel auto-redeploys the frontend

When you push to `main`:

1. Vercel detects the push via the GitHub integration
2. Triggers a new deployment automatically
3. Build runs `bun run build` (per `vercel.json`)
4. Once done, your production URL (e.g. `https://beam.vercel.app` or your custom domain) serves the new code

**To monitor:**
- Go to https://vercel.com/dashboard
- Click your Beam project
- Watch the "Deployments" tab — the latest should show "Building" → "Ready"
- Build should take ~30-60 seconds

**If the build fails:**
- Check the build logs in Vercel
- Most likely cause: a TypeScript error in code I didn't catch
- Fix it locally, commit, push again

---

## Step 4 — Render auto-redeploys the signaling server

If you set up auto-deploy on Render (the default when you connect a GitHub repo):

1. Render detects the push to `main`
2. Triggers a new deploy of the `beam-signaling` service
3. Build runs `bun install` in `mini-services/signaling-server/`
4. Start command: `bun run start` (which runs `tsx index.ts`)
5. Once live, the signaling server is reachable at your Render URL

**To monitor:**
- Go to https://dashboard.render.com
- Click your `beam-signaling` service
- Watch the "Events" tab — should show "Deploy started" → "Deploy live"
- Deploy takes ~1-3 minutes (Render free tier is slow to wake up)

**If the deploy fails:**
- Check Render logs
- Most likely cause: missing env vars or build error
- Render free tier services sleep after 15 min idle — the first request after sleep takes ~30s to wake

---

## Step 5 — Verify the live site

Once both services are deployed:

1. **Visit your Vercel URL** (e.g. `https://beam.vercel.app`)
   - Should show the Beam landing page with hero "Just drop your files and scan."
   - File picker should work

2. **Test the signaling server health:**
   ```bash
   curl https://<your-render-signaling-url>/health
   # Should return: {"ok":true,"service":"beam-signaling","uptime":N,"rooms":N}
   ```

3. **Test a real transfer:**
   - On a laptop: visit the Vercel URL, pick a file
   - You should see the QR code + "Ready to scan"
   - On your phone: scan the QR with the camera app
   - The phone opens the Vercel URL with `?r=SESSIONID`
   - The sender should now show **"Connecting…"** (new UI from my fixes — was the QR staying up before)
   - After 2-10 seconds, the transfer should start
   - When done, the receiver should show a Download button for every file
   - No file should be stuck at 100% without a Download button

4. **Test on a network that blocks WebRTC** (corporate wifi, mobile hotspot):
   - Should show a clean error after 30s instead of hanging forever (new fix)

---

## Step 6 — (Optional) Set up TURN for hostile networks

If you find transfers fail on some networks (corporate wifi, carrier-grade NAT, etc.), you'll need a TURN relay server. The code already supports it via env vars:

On **Vercel** (Project Settings → Environment Variables):
```
NEXT_PUBLIC_TURN_URL=turn:turn.your-provider.com:3478
NEXT_PUBLIC_TURN_USER=your-username
NEXT_PUBLIC_TURN_CRED=your-credential
```

Free TURN options:
- [Open Relay](https://openrelay.metered.ca/) — free public TURN (rate-limited)
- [Metered TURN](https://www.metered.ca/turn) — free tier with 1TB/month
- Self-hosted [coturn](https://github.com/coturn/coturn) on a $5 VPS

Without TURN, transfers on hostile networks will hit the new 30s timeout and show a clean error message instead of hanging forever.

---

## Fresh deploy (only if you don't have Vercel/Render set up yet)

### Frontend → Vercel

1. Go to https://vercel.com and sign in with GitHub
2. Click "Add New" → "Project"
3. Import your `AaronS6/beam` repo
4. Vercel auto-detects Next.js (uses `vercel.json`)
5. Set env var: `NEXT_PUBLIC_SIGNALING_URL` = your Render URL (set this AFTER the signaling server is deployed — see below)
6. Click "Deploy"
7. Wait for the build (~1-2 min)
8. You'll get a URL like `https://beam-xxx.vercel.app`

### Signaling server → Render

1. Go to https://render.com and sign in with GitHub
2. Click "New" → "Web Service"
3. Select your `AaronS6/beam` repo
4. In "Root Directory" set: `mini-services/signaling-server` (or use the render.yaml blueprint)
5. Build command: `bun install`
6. Start command: `bun run start`
7. Plan: Free
8. Click "Create Web Service"
9. Wait for the deploy (~1-3 min)
10. You'll get a URL like `https://beam-signaling.onrender.com`
11. **Test it:** `curl https://beam-signaling.onrender.com/health` → should return `{"ok":true,...}`

### Wire them together

1. Copy your Render URL (e.g. `https://beam-signaling.onrender.com`)
2. Go back to Vercel → your Beam project → Settings → Environment Variables
3. Add: `NEXT_PUBLIC_SIGNALING_URL` = `https://beam-signaling.onrender.com`
4. Trigger a redeploy on Vercel (Deployments → ⋮ → Redeploy)

Done!

---

## Single-VPS alternative (using deploy.sh)

If you'd rather deploy everything on one VPS:

```bash
# On your VPS:
git clone https://github.com/AaronS6/beam.git /opt/beam
cd /opt/beam
bash deploy.sh
# Edit .env.production with your domain + TURN creds
# Start services with PM2 or systemd:
NODE_ENV=production bun .next/standalone/server.js &
cd mini-services/signaling-server && bun run start &
# Copy Caddyfile.prod to /etc/caddy/Caddyfile, edit domain, reload Caddy
```

This requires a VPS with Node.js 20+, Bun, and Caddy installed. Good for self-hosting.

---

## Troubleshooting

**"stuck at connecting" on production**
- Check Render signaling server is awake: `curl https://<render-url>/health`
- If sleeping, first request wakes it (takes ~30s)
- Check Vercel env var `NEXT_PUBLIC_SIGNALING_URL` is set correctly (no trailing slash)

**"stuck at 100%" still happens**
- Hard-refresh the browser (Cmd/Ctrl+Shift+R) — the old JS may be cached by the service worker
- Check browser console for errors
- If still happening: report the exact file type, size, and browser to me

**Transfer fails on mobile data**
- Carrier NAT often blocks WebRTC
- Set up TURN (see Step 6 above)
- Or use a different network (wifi usually works)

**Vercel build fails with "Cannot find module"**
- Delete `node_modules` and `bun.lock`, run `bun install` locally
- Commit the updated `bun.lock`
- Push again

**Render service crashes**
- Check logs in Render dashboard
- Make sure `bun` is available — Render's free tier has Node, not Bun. The start script is `bun run start` which calls `tsx index.ts` — if `tsx` isn't found, install it: `bun install tsx --dev` (already in devDeps)

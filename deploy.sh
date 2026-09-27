#!/usr/bin/env bash
# Beam — production deploy script for a single VPS.
# Run this ON the server after cloning the repo.
#
# Prerequisites: Node.js 20+, Bun, Caddy installed.
#
# Usage:
#   git clone <your-repo> /opt/beam && cd /opt/beam
#   bash deploy.sh
#
# Then edit .env.production with your domain + TURN creds, and re-run.

set -euo pipefail

echo "=== Beam deploy ==="

# 1. Install frontend deps
echo "[1/7] Installing frontend dependencies..."
bun install

# 2. Build Next.js (production standalone)
echo "[2/7] Building Next.js..."
bun run build

# 3. Install signaling server deps
echo "[3/7] Installing signaling server dependencies..."
cd mini-services/signaling-server
bun install
cd ../..

# 4. Init database
echo "[4/7] Pushing Prisma schema..."
bun run db:push

# 5. Create .beam-store directory (Path B encrypted storage)
echo "[5/7] Creating .beam-store/..."
mkdir -p .beam-store
chmod 700 .beam-store

# 6. Copy production env template if not present
if [ ! -f .env.production ]; then
  echo "[6/7] Creating .env.production from template..."
  cat > .env.production << 'ENVEOF'
# Beam production environment
DATABASE_URL=file:/opt/beam/db/custom.db

# Your public domain (for the QR codes to encode the right URL):
# NEXT_PUBLIC_SIGNALING_URL=https://signal.yourdomain.com
# (Leave unset in dev/sandbox — falls back to the ?XTransformPort convention.)

# Optional TURN server (for restrictive networks — not required for local testing):
# NEXT_PUBLIC_TURN_URL=turn:turn.example.com:3478
# NEXT_PUBLIC_TURN_USER=your-username
# NEXT_PUBLIC_TURN_CRED=your-credential
ENVEOF
  echo "  → Edit .env.production with your domain, then re-run."
  exit 0
fi

echo "[6/7] .env.production found."

# 7. Print next steps
echo "[7/7] Done! Next steps:"
echo ""
echo "  1. Edit .env.production with your domain."
echo "  2. Start the services with PM2 or systemd:"
echo ""
echo "     # Frontend (Next.js production):"
echo "     NODE_ENV=production bun .next/standalone/server.js &"
echo ""
echo "     # Signaling server:"
echo "     cd mini-services/signaling-server && bun run start &"
echo ""
echo "  3. Copy Caddyfile.prod to /etc/caddy/Caddyfile, edit the domain,"
echo "     then: systemctl reload caddy"
echo ""
echo "  4. Visit https://yourdomain.com — you're live!"

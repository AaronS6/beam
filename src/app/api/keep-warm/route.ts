/**
 * Keep-warm cron endpoint — Vercel calls this every 10 min (via vercel.json
 * crons) to ping the Render signaling server's health endpoint. This prevents
 * Render's free tier from sleeping (it sleeps after 15 min idle, taking ~30s
 * to wake on the next request — which is the "black screen for a very long
 * time" the receiver sees after scanning the QR). With this ping, the
 * signaling server stays warm → the receiver's socket.io connects instantly.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL;
  if (signalingUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      await fetch(`${signalingUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
    } catch {
      /* best-effort — the server might be waking up */
    }
  }
  return Response.json({ ok: true, signaled: !!signalingUrl });
}

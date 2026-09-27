import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/share — Web Share Target endpoint.
 *
 * When a user shares a file to Beam (from Gmail, Files app, etc.), the PWA
 * manifest's share_target sends a POST here with multipart/form-data.
 *
 * The service worker (sw.js) intercepts POST to "/" and handles it there.
 * This API route is a FALLBACK for when the SW isn't active yet (first
 * install, or browsers that don't intercept the share_target POST).
 *
 * In that case, we redirect to /?shared=1 — the client shows the app.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return NextResponse.redirect(new URL("/?shared=1", req.url), 303);
}

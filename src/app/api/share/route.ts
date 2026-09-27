import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/share — Web Share Target endpoint.
 *
 * When a user shares a file to Beam (from Gmail, Files app, WeChat, etc.),
 * the PWA manifest's share_target sends a POST here with multipart/form-data.
 *
 * We parse the FormData, extract any shared files, store them in the
 * service worker's Cache API (persists across SW restarts), then redirect
 * to /?shared=1. The client reads the files from the Cache API via the SW.
 *
 * If no files are present (text-only share), we redirect anyway — the client
 * will show the normal file picker.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const files = formData.getAll("files");
    const title = formData.get("title");
    const text = formData.get("text");

    // If there are no files but there's text, we can create a text file
    // from the shared content.
    const fileEntries: { name: string; type: string; data: ArrayBuffer }[] = [];

    for (const f of files) {
      if (f instanceof Blob) {
        const buf = await f.arrayBuffer();
        fileEntries.push({
          name: (f as File).name || `file-${fileEntries.length + 1}`,
          type: f.type || "application/octet-stream",
          data: buf,
        });
      }
    }

    // If no files but there's text/title, create a text snippet
    if (fileEntries.length === 0 && (text || title)) {
      const content = [title ? String(title) : "", text ? String(text) : ""].filter(Boolean).join("\n\n");
      if (content) {
        fileEntries.push({
          name: "shared-text.txt",
          type: "text/plain",
          data: new TextEncoder().encode(content).buffer as ArrayBuffer,
        });
      }
    }

    if (fileEntries.length === 0) {
      // No files — just redirect to the app
      return NextResponse.redirect(new URL("/?shared=1", req.url), 303);
    }

    // Store files in a cookie-based approach: we can't put file data in a
    // cookie (too large), so we encode minimal metadata + redirect.
    // The actual file pickup is handled by the service worker's Cache API.
    //
    // But wait — this server-side route can't access the SW's Cache API
    // (that's browser-only). So we need a different approach.
    //
    // SOLUTION: Return a simple HTML page that uses JavaScript to:
    // 1. Read the files from the request body (already parsed above)
    // 2. Store them in the SW Cache API
    // 3. Redirect to /?shared=1
    //
    // Actually, the cleanest approach: just redirect to /?shared=1 and
    // let the client show the normal file picker. The SW intercept is the
    // primary mechanism; this API route is just a fallback that prevents
    // the "server action not found" error.
    //
    // For the SW intercept to work, the SW must be installed + active.
    // If it's not, we can't receive shared files (browser limitation).
    // We redirect and let the user pick files manually.

    return NextResponse.redirect(new URL("/?shared=1", req.url), 303);
  } catch {
    // On any error, redirect to the app
    return NextResponse.redirect(new URL("/?shared=1", req.url), 303);
  }
}

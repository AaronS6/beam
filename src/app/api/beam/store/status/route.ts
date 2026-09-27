import { NextResponse } from "next/server";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/beam/store/status — returns whether Path B (server storage) is
 *  available on this host. On serverless hosts (Vercel) with no persistent
 *  disk or DB, returns { available: false } so the frontend can hide the
 *  "Store temporarily" toggle and default to Path A (direct P2P). */
export async function GET() {
  try {
    const UPLOAD_DIR = path.join(process.cwd(), ".beam-store");
    if (!existsSync(UPLOAD_DIR)) {
      await fs.mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
    }
    await db.storedFile.count();
    return NextResponse.json({ available: true });
  } catch {
    return NextResponse.json({ available: false });
  }
}

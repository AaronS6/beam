"use client";

import * as React from "react";
import { ExternalLink, AlertCircle } from "lucide-react";

/**
 * InAppBrowserDetect — detects if the user is in a restricted in-app browser
 * (Instagram, Facebook, TikTok, LinkedIn, Snapchat, etc.) that blocks
 * WebSockets and/or WebRTC. Shows a banner prompting them to open in
 * Chrome/Safari, which are required for Beam to work.
 */

function isInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // Common in-app browser identifiers
  const inAppPatterns = [
    "Instagram",
    "FBAN",
    "FBAV",
    "Facebook",
    "TikTok",
    "LinkedIn",
    "Snapchat",
    "Twitter",
    "Line/",
    "WhatsApp",
    "MicroMessenger",
    "Messenger",
  ];
  return inAppPatterns.some((p) => ua.includes(p));
}

export function InAppBrowserDetect() {
  const [show, setShow] = React.useState(false);
  const [url, setUrl] = React.useState("");

  React.useEffect(() => {
    if (isInAppBrowser()) {
      setShow(true);
      // Build the "open in browser" URL
      const currentUrl = window.location.href;
      setUrl(currentUrl);
    }
  }, []);

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 p-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-3xl bg-destructive/10">
          <AlertCircle className="h-8 w-8 text-destructive" strokeWidth={1.75} />
        </div>
        <h2 className="font-display text-[22px] font-bold text-foreground">
          Open in a real browser
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
          In-app browsers (like Instagram's) block the peer-to-peer connection
          Beam needs. Open this link in Chrome or Safari to send files.
        </p>
        <button
          type="button"
          onClick={() => {
            // Try to open in the system's default browser
            // On iOS, this opens Safari; on Android, this opens the default browser
            window.open(url, "_system");
            // Fallback: copy the URL so the user can paste it manually
            try {
              navigator.clipboard?.writeText(url);
            } catch {
              /* ignore */
            }
          }}
          className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-bold text-primary-foreground transition-all duration-200 active:scale-[0.97] hover:scale-[1.03]"
        >
          <ExternalLink className="h-4 w-4" strokeWidth={2.5} />
          Open in browser
        </button>
        <p className="mt-3 text-xs text-muted-foreground">
          Or copy this link and paste it in Chrome/Safari:
        </p>
        <p className="mt-1 break-all rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
          {url}
        </p>
      </div>
    </div>
  );
}

"use client";

import * as React from "react";
import { ExternalLink, AlertCircle, Copy, Check } from "lucide-react";

/**
 * InAppBrowserDetect, detects if the user is in a restricted in-app browser
 * (Instagram, Facebook, TikTok, LinkedIn, Snapchat, etc.) that blocks
 * WebSockets and/or WebRTC. Shows a clean URL they can copy or type into
 * their real browser.
 */

function isInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
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
  const [copied, setCopied] = React.useState(false);

  // The clean URL to show, just the origin, no query params.
  // E.g. "mybeam.vercel.app" instead of "mybeam.vercel.app/?r=ABC123&utm_source=ig"
  const cleanUrl = typeof window !== "undefined" ? window.location.origin.replace(/^https?:\/\//, "") : "";

  React.useEffect(() => {
    if (isInAppBrowser()) {
      setShow(true);
    }
  }, []);

  const handleCopy = () => {
    try {
      navigator.clipboard?.writeText(window.location.origin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

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
          Instagram's browser blocks file transfers. Open Chrome or Safari and go to:
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-secondary px-4 py-3">
          <span className="flex-1 text-left text-[15px] font-bold text-foreground">
            {cleanUrl}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-transform active:scale-[0.97]"
            aria-label="Copy URL"
          >
            {copied ? (
              <Check className="h-4 w-4" strokeWidth={2.5} />
            ) : (
              <Copy className="h-4 w-4" strokeWidth={2} />
            )}
          </button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {copied ? "Copied! Paste it in Chrome or Safari." : "Tap copy, then paste it in your browser."}
        </p>
      </div>
    </div>
  );
}

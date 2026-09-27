"use client";

import * as React from "react";

export function Footer() {
  return (
    <footer className="relative z-10 border-t border-border bg-background/40 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-5 py-10 text-center sm:flex-row sm:justify-between sm:px-8 sm:text-left">
        <div className="flex items-center gap-2.5">
          <svg width="20" height="20" viewBox="0 0 64 64" fill="none" aria-hidden>
            <defs>
              <linearGradient id="footerMarkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#FF6B4A" />
                <stop offset="100%" stopColor="#FF4D8D" />
              </linearGradient>
            </defs>
            <rect x="8" y="14" width="16" height="36" rx="4.5" fill="none" stroke="url(#footerMarkGrad)" strokeWidth="2.4" />
            <rect x="40" y="16" width="16" height="24" rx="3" fill="none" stroke="url(#footerMarkGrad)" strokeWidth="2.4" />
            <rect x="36" y="42" width="24" height="3.5" rx="1.75" fill="none" stroke="url(#footerMarkGrad)" strokeWidth="2.4" />
            <g fill="none" stroke="url(#footerMarkGrad)" strokeWidth="2.4" strokeLinecap="round">
              <path d="M 26 32 Q 32 23 38 32" />
              <path d="M 24.5 32 Q 32 18.5 39.5 32" opacity="0.45" />
            </g>
          </svg>
          <span className="text-sm text-muted-foreground">
            Files that disappear — by design.
          </span>
        </div>
        <div className="flex items-center gap-5 text-sm text-muted-foreground">
          <a href="#privacy" className="transition-colors hover:text-foreground">Privacy</a>
          <a href="#how-it-works" className="transition-colors hover:text-foreground">How it works</a>
          <a href="https://webrtc.org" target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
            WebRTC
          </a>
        </div>
      </div>
    </footer>
  );
}

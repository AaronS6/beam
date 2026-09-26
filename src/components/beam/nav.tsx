"use client";

import * as React from "react";

export function Nav() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/50 bg-background/70 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a
          href="/"
          className="flex items-center rounded-lg outline-none transition-opacity hover:opacity-80"
          aria-label="Beam home"
        >
          <span className="inline-flex items-center gap-2.5">
            <svg width="26" height="26" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
              <defs>
                <linearGradient id="navMarkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#FF6B4A" />
                  <stop offset="100%" stopColor="#FF4D8D" />
                </linearGradient>
              </defs>
              <rect x="8" y="14" width="16" height="36" rx="4.5" fill="url(#navMarkGrad)" />
              <rect x="40" y="16" width="16" height="24" rx="3" fill="url(#navMarkGrad)" />
              <rect x="36" y="42" width="24" height="3.5" rx="1.75" fill="url(#navMarkGrad)" />
              <g fill="none" stroke="url(#navMarkGrad)" strokeWidth="2.6" strokeLinecap="round">
                <path d="M 26 32 Q 32 23 38 32" />
                <path d="M 24.5 32 Q 32 18.5 39.5 32" opacity="0.5" />
              </g>
            </svg>
            <span className="text-[17px] font-bold tracking-tight text-foreground">Beam</span>
          </span>
        </a>
        <div className="flex items-center gap-1 sm:gap-1.5">
          <a
            href="#how-it-works"
            className="hidden rounded-full px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:inline-block"
          >
            How it works
          </a>
          <a
            href="#privacy"
            className="hidden rounded-full px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:inline-block"
          >
            Privacy
          </a>
        </div>
      </nav>
    </header>
  );
}

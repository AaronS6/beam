"use client";

import * as React from "react";
import { BeamLogo } from "@/components/beam-logo";

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border/60">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-5 py-10 sm:flex-row sm:justify-between sm:px-8">
        <div className="flex items-center gap-2.5">
          <BeamLogo size={22} withWordmark={false} />
          <span className="text-sm text-muted-foreground">
            Peer-to-peer file transfer. Nothing stored, nothing uploaded.
          </span>
        </div>
        <div className="flex items-center gap-5 text-sm text-muted-foreground">
          <a href="#privacy" className="transition-colors hover:text-foreground">
            Privacy
          </a>
          <a href="#how-it-works" className="transition-colors hover:text-foreground">
            How it works
          </a>
          <a
            href="https://webrtc.org"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground"
          >
            WebRTC
          </a>
        </div>
      </div>
    </footer>
  );
}

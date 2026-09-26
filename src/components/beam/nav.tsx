"use client";

import * as React from "react";
import { BeamLogo } from "@/components/beam-logo";
import { ThemeToggle } from "@/components/theme-toggle";

export function Nav() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a
          href="/"
          className="flex items-center rounded-lg outline-none transition-opacity hover:opacity-80"
          aria-label="Beam home"
        >
          <BeamLogo size={26} />
        </a>
        <div className="flex items-center gap-1 sm:gap-1.5">
          <a
            href="#how-it-works"
            className="hidden rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:inline-block"
          >
            How it works
          </a>
          <a
            href="#privacy"
            className="hidden rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:inline-block"
          >
            Privacy
          </a>
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}

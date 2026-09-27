"use client";

import * as React from "react";

/**
 * BackgroundDecor — soft blue glows drifting behind the central card on the
 * dark charcoal-blue background. Subtle, atmospheric.
 */
export function BackgroundDecor() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Soft blue glow top-left */}
      <div
        className="animate-beam-drift absolute -left-32 -top-20 h-96 w-96 rounded-full opacity-20 blur-3xl"
        style={{ background: "radial-gradient(circle, #7AB8F0 0%, transparent 70%)" }}
      />
      {/* Lighter blue glow top-right */}
      <div
        className="animate-beam-drift absolute -right-32 top-32 h-[28rem] w-[28rem] rounded-full opacity-15 blur-3xl"
        style={{ background: "radial-gradient(circle, #9CCAF6 0%, transparent 70%)", animationDelay: "3s" }}
      />
      {/* Pale blue glow bottom */}
      <div
        className="animate-beam-drift absolute bottom-0 left-1/4 h-80 w-80 rounded-full opacity-12 blur-3xl"
        style={{ background: "radial-gradient(circle, #B8DCF8 0%, transparent 70%)", animationDelay: "6s" }}
      />
      {/* Subtle dotted texture overlay */}
      <div className="texture-dots absolute inset-0 opacity-[0.04]" />
    </div>
  );
}

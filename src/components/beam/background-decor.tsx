"use client";

import * as React from "react";

/**
 * BackgroundDecor — soft abstract blobs floating behind the central card.
 * Adds warmth + a hand-made feel without cluttering. Purely decorative.
 */
export function BackgroundDecor() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Soft blurred blobs in warm tones drifting slowly */}
      <div
        className="animate-beam-drift absolute -left-20 top-10 h-72 w-72 rounded-full opacity-40 blur-3xl"
        style={{ background: "radial-gradient(circle, #FFD9CC 0%, transparent 70%)" }}
      />
      <div
        className="animate-beam-drift absolute -right-24 top-40 h-80 w-80 rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(circle, #FF4D8D 0%, transparent 70%)", animationDelay: "3s" }}
      />
      <div
        className="animate-beam-drift absolute bottom-0 left-1/3 h-64 w-64 rounded-full opacity-25 blur-3xl"
        style={{ background: "radial-gradient(circle, #FFB59E 0%, transparent 70%)", animationDelay: "6s" }}
      />
      {/* Subtle dotted texture overlay for warmth */}
      <div className="texture-dots absolute inset-0 opacity-30" />
    </div>
  );
}

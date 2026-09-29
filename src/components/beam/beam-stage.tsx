"use client";

import * as React from "react";

/**
 * BeamStage, the central floating dark card on the charcoal background.
 * When `active` (waiting for a device), an AirDrop-style radar pulse + slow
 * conic halo plays around its frame. Respects prefers-reduced-motion.
 *
 * Visual layering (back-to-front):
 *   1. ambient blue glow pool under the card (the "lit space")
 *   2. the rotating conic halo + radar pulse rings (when active)
 *   3. the floating card itself, with a layered shadow + top-edge light
 *      reflection that makes it read as glass.
 */
export function BeamStage({
  active,
  children,
  className,
}: {
  active?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative ${className ?? ""}`}>
      {/* Ambient blue pool, a diffuse glow under the card so it feels like
          it's floating in a lit space rather than sitting on flat color. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-8 -bottom-6 top-1/2 -z-10 rounded-[40px] opacity-70 blur-2xl"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 50%, color-mix(in srgb, var(--brand) 30%, transparent) 0%, transparent 70%)",
        }}
      />

      {/* Rotating conic halo, the beam sweeping the frame */}
      {active && (
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-4 rounded-[36px] opacity-40 blur-2xl animate-beam-spin"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0deg, #7AB8F0 60deg, transparent 140deg, #9CCAF6 210deg, transparent 300deg)",
          }}
        />
      )}
      {/* Radar pulse rings */}
      {active && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[28px] animate-beam-pulse"
            style={{ border: "1px solid color-mix(in srgb, #7AB8F0 55%, transparent)" }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[28px] animate-beam-pulse"
            style={{ border: "1px solid color-mix(in srgb, #9CCAF6 55%, transparent)", animationDelay: "1.6s" }}
          />
        </>
      )}

      {/* The floating card, dark glass, 28px radius, layered shadow + edge light */}
      <div className="edge-light relative rounded-[28px] bg-card shadow-float-strong">
        {children}
      </div>
    </div>
  );
}

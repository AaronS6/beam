"use client";

import * as React from "react";

/**
 * BeamStage — the floating QR/dropzone frame with the animated "beam" glow.
 *
 * The static 2px gradient border is always present (the brand frame). When
 * `active` (waiting for a device), an AirDrop-style radar pulse + a slow
 * rotating conic halo play around it. Respects prefers-reduced-motion via
 * the global CSS rule in globals.css.
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
      {/* Rotating conic halo — the beam sweeping the frame */}
      {active && (
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-4 rounded-[28px] opacity-50 blur-2xl animate-beam-spin"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0deg, var(--beam-from) 60deg, transparent 140deg, var(--beam-to) 210deg, transparent 300deg)",
          }}
        />
      )}
      {/* Radar pulse rings */}
      {active && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[24px] animate-beam-pulse"
            style={{ border: "1px solid color-mix(in srgb, var(--beam-from) 55%, transparent)" }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[24px] animate-beam-pulse"
            style={{
              border: "1px solid color-mix(in srgb, var(--beam-to) 55%, transparent)",
              animationDelay: "1.3s",
            }}
          />
        </>
      )}
      {/* The gradient frame */}
      <div className="relative rounded-[24px] bg-beam p-[2px] shadow-beam">
        <div className="overflow-hidden rounded-[22px] bg-card">{children}</div>
      </div>
    </div>
  );
}

"use client";

import * as React from "react";

/**
 * BeamStage — the central floating white card on the coral background.
 * When `active` (waiting for a device), an AirDrop-style radar pulse + slow
 * conic halo plays around its frame. Respects prefers-reduced-motion.
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
            style={{ border: "1px solid color-mix(in srgb, #9CCAF6 55%, transparent)", animationDelay: "1.4s" }}
          />
        </>
      )}
      {/* The floating card — white, 28px radius, soft warm shadow */}
      <div className="relative rounded-[28px] bg-card shadow-float">
        {children}
      </div>
    </div>
  );
}

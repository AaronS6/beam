"use client";

import * as React from "react";

/**
 * BeamLogo — inline SVG brand mark.
 * Two rounded-rect "device" shapes with a beam arc passing between them,
 * in the coral→pink gradient. Crisp at any size.
 */
export function BeamLogo({
  className,
  size = 28,
  withWordmark = true,
}: {
  className?: string;
  size?: number;
  withWordmark?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Beam"
        className="shrink-0"
      >
        <defs>
          <linearGradient id="beamMarkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FF7A5C" />
            <stop offset="100%" stopColor="#FF4D8D" />
          </linearGradient>
        </defs>
        {/* Phone */}
        <rect x="8" y="14" width="16" height="36" rx="4.5" fill="url(#beamMarkGrad)" />
        <rect x="11" y="18" width="10" height="28" rx="2" fill="white" fillOpacity="0.2" />
        {/* Laptop */}
        <rect x="40" y="16" width="16" height="24" rx="3" fill="url(#beamMarkGrad)" />
        <rect x="43" y="19" width="10" height="18" rx="1.5" fill="white" fillOpacity="0.2" />
        <rect x="36" y="42" width="24" height="3.5" rx="1.75" fill="url(#beamMarkGrad)" />
        {/* Beam arcs */}
        <g fill="none" stroke="url(#beamMarkGrad)" strokeWidth="2.6" strokeLinecap="round">
          <path d="M 26 32 Q 32 23 38 32" />
          <path d="M 24.5 32 Q 32 18.5 39.5 32" opacity="0.5" />
        </g>
      </svg>
      {withWordmark && (
        <span
          className="font-semibold tracking-tight"
          style={{ fontSize: size * 0.62, letterSpacing: "-0.02em" }}
        >
          Beam
        </span>
      )}
    </span>
  );
}

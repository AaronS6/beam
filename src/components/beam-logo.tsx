"use client";

import * as React from "react";

/**
 * BeamLogo — inline SVG brand mark.
 * Transparent / outline-only version: two rounded-rect "device" shapes with a
 * beam arc passing between them, drawn as thin strokes (no solid fill).
 * Subtle and monochrome — lets the layout breathe instead of competing.
 */
export function BeamLogo({
  className,
  size = 28,
  withWordmark = true,
  stroke = "currentColor",
}: {
  className?: string;
  size?: number;
  withWordmark?: boolean;
  /** SVG stroke color. Defaults to currentColor so it inherits text color. */
  stroke?: string;
}) {
  const gid = React.useId();
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
          <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FF6B4A" />
            <stop offset="100%" stopColor="#FF4D8D" />
          </linearGradient>
        </defs>
        {/* Outline-only device shapes — transparent fill, thin gradient stroke */}
        <rect
          x="8" y="14" width="16" height="36" rx="4.5"
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth="2.4"
        />
        <rect
          x="40" y="16" width="16" height="24" rx="3"
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth="2.4"
        />
        <rect
          x="36" y="42" width="24" height="3.5" rx="1.75"
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth="2.4"
        />
        {/* Beam arcs — the only solid stroke, the brand's signal */}
        <g fill="none" stroke={`url(#${gid})`} strokeWidth="2.4" strokeLinecap="round">
          <path d="M 26 32 Q 32 23 38 32" />
          <path d="M 24.5 32 Q 32 18.5 39.5 32" opacity="0.45" />
        </g>
      </svg>
      {withWordmark && (
        <span
          className="font-display font-bold tracking-tight"
          style={{ fontSize: size * 0.62, letterSpacing: "-0.025em" }}
        >
          Beam
        </span>
      )}
    </span>
  );
}

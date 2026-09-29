"use client";

import * as React from "react";

/**
 * QualityBars, a 4-bar signal-strength indicator driven by the WebRTC stats
 * poll (RTT → 0..4 level). Quiet, informational. Hidden (0 bars) when no
 * connection is active.
 */
const LABELS = ["No signal", "Poor", "Fair", "Good", "Excellent"];

export function QualityBars({
  level,
  className,
}: {
  level: number; // 0..4
  className?: string;
}) {
  if (level <= 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className ?? ""}`}
      role="status"
      aria-label={`Connection ${LABELS[level]}`}
      title={`Connection ${LABELS[level]}`}
    >
      <span className="flex items-end gap-[2px]" aria-hidden>
        {[1, 2, 3, 4].map((bar) => {
          const active = bar <= level;
          return (
            <span
              key={bar}
              className={`w-[3px] rounded-full transition-all duration-300 ${
                active ? "bg-beam" : "bg-border"
              }`}
              style={{ height: `${4 + bar * 3}px` }}
            />
          );
        })}
      </span>
      <span className="text-[11px] font-medium text-muted-foreground">
        {LABELS[level]}
      </span>
    </span>
  );
}

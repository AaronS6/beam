"use client";

import * as React from "react";
import { Zap, Route } from "lucide-react";

/**
 * CandidateBadge, shows whether the WebRTC connection is direct (host/srflx)
 * or relayed through TURN. Honest about the speed reality.
 */
export function CandidateBadge({
  type,
  className,
}: {
  type: "host" | "srflx" | "prflx" | "relay" | "unknown" | null;
  className?: string;
}) {
  if (!type) return null;
  const direct = type === "host" || type === "srflx" || type === "prflx";
  const label = direct ? "Direct" : "Relay";
  const Icon = direct ? Zap : Route;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground ${className ?? ""}`}
      title={
        direct
          ? "Direct peer-to-peer connection (host/srflx ICE candidate)"
          : "Relayed through TURN, slower, used only when direct P2P is blocked"
      }
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
      {label}
    </span>
  );
}

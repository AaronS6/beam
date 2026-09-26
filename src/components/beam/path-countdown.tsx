"use client";

import * as React from "react";
import { Clock } from "lucide-react";

/**
 * PathCountdown — honest countdown to deletion.
 * Path A: counts down the 5-min session window (no peer → expire).
 * Path B: counts down the 5-min storage window (auto-delete server-side).
 */
export function PathCountdown({
  expiresAt,
  storeMode,
  className,
}: {
  expiresAt: number | null;
  storeMode: boolean;
  className?: string;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  if (!expiresAt) return null;
  const remaining = Math.max(0, expiresAt - now);
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const low = remaining < 60_000;
  const label = storeMode ? "Disappears in" : "Link expires in";

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${
        low ? "text-amber-100" : "text-muted-foreground"
      } ${className ?? ""}`}
      aria-label={`${label} ${mins} minutes ${secs} seconds`}
    >
      <Clock className="h-3.5 w-3.5" strokeWidth={2} />
      {label}{" "}
      <span className="tabular-nums">
        {mins}:{secs.toString().padStart(2, "0")}
      </span>
    </span>
  );
}

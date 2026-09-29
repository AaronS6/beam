"use client";

import * as React from "react";

/**
 * SessionCountdown, shows the remaining time before the session auto-expires
 * (~10 min from createdAt). Calm, muted; turns amber in the final minute.
 */
const SESSION_TTL_MS = 10 * 60 * 1000;

export function SessionCountdown({ createdAt }: { createdAt: number | null }) {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!createdAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [createdAt]);

  if (!createdAt) return null;
  const remaining = Math.max(0, SESSION_TTL_MS - (now - createdAt));
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const low = remaining < 60_000;

  return (
    <span
      className={`tabular-nums ${low ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
      aria-label={`Session expires in ${mins} minutes ${secs} seconds`}
    >
      {mins}:{secs.toString().padStart(2, "0")}
    </span>
  );
}

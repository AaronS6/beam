"use client";

import * as React from "react";
import { Clock, Gauge, Files, Zap } from "lucide-react";
import { formatBytes, formatSpeed, formatDuration } from "@/lib/format";
import type { SessionState } from "@/hooks/use-beam-session";

/**
 * TransferSummary — a calm stats grid shown on the complete screen
 * (files / size / time / peak speed). Restraint over flash.
 */
export function TransferSummary({ state }: { state: SessionState }) {
  const { files, totalBytes, transferStartedAt, transferEndedAt, peakSpeed } = state;
  const durationMs =
    transferStartedAt && transferEndedAt ? transferEndedAt - transferStartedAt : 0;
  const avgSpeed = durationMs > 0 ? totalBytes / (durationMs / 1000) : 0;

  const stats = [
    {
      icon: Files,
      label: "Files",
      value: `${files.length}`,
    },
    {
      icon: Clock,
      label: "Time",
      value: formatDuration(durationMs),
    },
    {
      icon: Gauge,
      label: "Average",
      value: formatSpeed(avgSpeed),
    },
    {
      icon: Zap,
      label: "Peak",
      value: formatSpeed(peakSpeed),
    },
  ];

  return (
    <div className="mx-auto grid w-full max-w-xs grid-cols-4 gap-2">
      {stats.map((s) => (
        <div key={s.label} className="flex flex-col items-center gap-1 text-center">
          <s.icon className="h-3.5 w-3.5 text-muted-foreground/60" strokeWidth={1.75} />
          <span className="text-[13px] font-semibold tabular-nums text-foreground">
            {s.value}
          </span>
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
            {s.label}
          </span>
        </div>
      ))}
      <span className="sr-only">{`Total ${formatBytes(totalBytes)}`}</span>
    </div>
  );
}

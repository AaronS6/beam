"use client";

import * as React from "react";
import {
  Loader2,
  Check,
  AlertCircle,
  Clock,
  Download,
  RotateCcw,
  WifiOff,
  Smartphone,
} from "lucide-react";
import { BeamStage } from "./beam-stage";
import { FileRow } from "./file-row";
import { ProgressRing } from "./progress-ring";
import { QualityBars } from "./quality-bars";
import { TransferSummary } from "./transfer-summary";
import { formatBytes, formatSpeed, formatEta } from "@/lib/format";
import type { SessionState } from "@/hooks/use-beam-session";

export function ReceiverPanel({
  state,
  onSave,
  onSaveAll,
  onShareImage,
  onReset,
}: {
  state: SessionState;
  onSave: (url: string, name: string) => void;
  onSaveAll: () => void;
  onShareImage: (url: string, name: string, mime: string) => void;
  onReset: () => void;
}) {
  const { phase, files, totalBytes, receivedBytes, speed, peerDevice, quality } = state;
  const overall = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
  const remaining = speed > 0 ? (totalBytes - receivedBytes) / speed : Infinity;
  const completedCount = files.filter((f) => f.status === "done").length;

  const copyText = React.useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  // Connecting / waiting state — before the data channel opens.
  if (phase === "waiting") {
    return (
      <div className="w-full max-w-[320px]">
        <BeamStage active>
          <div className="flex flex-col items-center px-6 py-14">
            <div className="relative flex h-[120px] w-[120px] items-center justify-center">
              <Loader2 className="h-9 w-9 animate-spin text-muted-foreground" strokeWidth={1.5} />
              <div
                className="absolute inset-0 animate-beam-pulse rounded-full"
                style={{ border: "1px solid color-mix(in srgb, var(--beam-from) 50%, transparent)" }}
              />
            </div>
            <p className="mt-6 text-[17px] font-medium text-foreground">Connecting…</p>
            <p className="mt-1 text-center text-sm text-muted-foreground">
              Linking to {peerDevice?.label ?? "the sender"}
            </p>
          </div>
        </BeamStage>
      </div>
    );
  }

  if (phase === "expired") {
    return (
      <div className="w-full max-w-[420px]">
        <BeamStage>
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
              <Clock className="h-8 w-8 text-muted-foreground" strokeWidth={1.75} />
            </div>
            <p className="mt-5 text-[20px] font-semibold text-foreground">This link has expired</p>
            <p className="mt-1.5 max-w-[32ch] text-sm text-muted-foreground">
              Ask the sender to generate a new QR code and scan it again.
            </p>
            <button
              type="button"
              onClick={onReset}
              className="mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
            >
              <RotateCcw className="h-4 w-4" strokeWidth={2} />
              Go back
            </button>
          </div>
        </BeamStage>
      </div>
    );
  }

  // Connected / transferring / reconnecting / done / error — show file list view.
  return (
    <div className="w-full max-w-[520px]">
      {/* Header */}
      <div className="mb-6 flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-beam text-white">
          <Smartphone className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-semibold text-foreground">
            {phase === "done" ? "Transfer complete" : "Receiving files"}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {phase === "done" ? "Saved to your device" : `From ${peerDevice?.label ?? "a device"}`}
          </p>
        </div>
        {phase === "transferring" && (
          <div className="ml-auto flex items-center gap-3">
            <QualityBars level={quality} />
            <ProgressRing value={overall} size={56} stroke={5}>
              <span className="text-[11px] font-semibold tabular-nums text-foreground">{overall}</span>
            </ProgressRing>
          </div>
        )}
        {phase === "done" && (
          <div className="ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-beam">
            <Check className="h-5 w-5 text-white" strokeWidth={2.5} />
          </div>
        )}
      </div>

      {/* Transfer summary on completion */}
      {phase === "done" && totalBytes > 0 && (
        <div className="mb-5 rounded-2xl border border-border bg-card/60 p-4">
          <TransferSummary state={state} />
        </div>
      )}

      {/* Reconnecting banner */}
      {phase === "reconnecting" && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-border bg-secondary/60 px-4 py-3">
          <WifiOff className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <p className="text-sm text-muted-foreground">
            The connection dipped. Reconnecting — hold on.
          </p>
        </div>
      )}

      {/* Transfer stats */}
      {(phase === "transferring" || phase === "connected") && totalBytes > 0 && (
        <div className="mb-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {completedCount} of {files.length} files
          </span>
          <span>
            {formatBytes(receivedBytes)} · {isFinite(remaining) ? `~${formatEta(remaining)}` : formatSpeed(speed)}
          </span>
        </div>
      )}

      {/* Error banner */}
      {phase === "error" && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" strokeWidth={1.75} />
          <div>
            <p className="text-sm font-medium text-foreground">Transfer interrupted</p>
            {state.error && <p className="mt-0.5 text-sm text-muted-foreground">{state.error}</p>}
          </div>
        </div>
      )}

      {/* File list */}
      {files.length > 0 ? (
        <div className="space-y-2">
          {files.map((f) => (
            <FileRow
              key={f.id}
              file={f}
              onSave={onSave}
              onCopyText={copyText}
              onShareImage={onShareImage}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center rounded-2xl border border-border bg-card px-6 py-12 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" strokeWidth={1.75} />
          <p className="mt-3 text-sm text-muted-foreground">Waiting for the file list…</p>
        </div>
      )}

      {/* Actions */}
      <div className="mt-7 flex items-center justify-center gap-3">
        {phase === "done" && (
          <>
            <button
              type="button"
              onClick={onSaveAll}
              className="inline-flex items-center gap-2 rounded-full bg-beam px-5 py-2.5 text-sm font-medium text-white transition-transform active:scale-[0.97] hover:opacity-90"
            >
              <Download className="h-4 w-4" strokeWidth={2} />
              Save all
            </button>
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
            >
              <Check className="h-4 w-4" strokeWidth={2} />
              Done
            </button>
          </>
        )}
        {(phase === "error" || phase === "reconnecting") && (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
          >
            <RotateCcw className="h-4 w-4" strokeWidth={2} />
            Start over
          </button>
        )}
      </div>
    </div>
  );
}

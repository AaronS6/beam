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
  Share2,
  Copy,
  Server,
} from "lucide-react";
import { BeamStage } from "./beam-stage";
import { FileRow } from "./file-row";
import { ProgressRing } from "./progress-ring";
import { QualityBars } from "./quality-bars";
import { CandidateBadge } from "./candidate-badge";
import { TransferSummary } from "./transfer-summary";
import { PathCountdown } from "./path-countdown";
import { formatBytes, formatSpeed, formatEta } from "@/lib/format";
import type { SessionState } from "@/hooks/use-beam-session";

export function ReceiverPanel({
  state,
  onSave,
  onSaveAll,
  onShareImage,
  onShareAll,
  onCopyAllText,
  onDownloadStored,
  onReset,
}: {
  state: SessionState;
  onSave: (url: string, name: string) => void;
  onSaveAll: () => void;
  onShareImage: (url: string, name: string, mime: string) => void;
  onShareAll: () => Promise<"shared" | "downloaded" | "failed">;
  onCopyAllText: () => Promise<number>;
  onDownloadStored: (fileId: string) => Promise<void>;
  onReset: () => void;
}) {
  const {
    phase, files, totalBytes, receivedBytes, speed, peerDevice, quality,
    candidateType, storeMode, storeExpiresAt,
  } = state;
  const overall = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
  const remaining = speed > 0 ? (totalBytes - receivedBytes) / speed : Infinity;
  const completedCount = files.filter((f) => f.status === "done").length;

  const copyText = React.useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  const [copiedAll, setCopiedAll] = React.useState(false);
  const [sharedAll, setSharedAll] = React.useState(false);
  const handleCopyAll = async () => {
    const n = await onCopyAllText();
    if (n > 0) { setCopiedAll(true); setTimeout(() => setCopiedAll(false), 1800); }
  };
  const handleShareAll = async () => {
    await onShareAll(); setSharedAll(true); setTimeout(() => setSharedAll(false), 1800);
  };

  const textCount = files.filter((f) => f.text).length;
  const hasMultiple = files.length > 1;

  // Connecting / waiting state — Path A only (Path B jumps straight to connected).
  if (phase === "waiting") {
    return (
      <div className="w-full max-w-[340px]">
        <BeamStage active>
          <div className="flex flex-col items-center px-6 py-14">
            <div className="relative flex h-[120px] w-[120px] items-center justify-center">
              <Loader2 className="h-9 w-9 animate-spin text-muted-foreground" strokeWidth={1.5} />
              <div className="absolute inset-0 animate-beam-pulse rounded-full" style={{ border: "1px solid color-mix(in srgb, var(--brand) 50%, transparent)" }} />
            </div>
            <p className="font-display mt-6 text-[18px] font-bold text-foreground">Connecting…</p>
            <p className="mt-1 text-center text-sm text-muted-foreground">
              Linking up with {peerDevice?.label ?? "the sender"}
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
            <p className="font-display mt-5 text-[22px] font-bold text-foreground">This link's gone</p>
            <p className="mt-1.5 max-w-[32ch] text-sm text-muted-foreground">
              {storeMode ? "The 5 minutes are up — files are deleted for good." : "Ask the sender to whip up a new QR code and try again."}
            </p>
            <button
              type="button"
              onClick={onReset}
              className="mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
            >
              <RotateCcw className="h-4 w-4" strokeWidth={2} /> Go back
            </button>
          </div>
        </BeamStage>
      </div>
    );
  }

  // Connected / transferring / done / error — file list view.
  return (
    <div className="w-full max-w-[540px]">
      {/* Header */}
      <div className="mb-5 flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Smartphone className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-display text-[19px] font-bold text-foreground">
            {phase === "done" ? "All yours" : storeMode ? "Grab your files" : "Receiving files"}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {phase === "done" ? "Saved to your device" : `From ${peerDevice?.label ?? "a device"}`}
          </p>
        </div>
        {phase === "transferring" && (
          <div className="ml-auto flex items-center gap-3">
            <QualityBars level={quality} />
            <ProgressRing value={overall} size={56} stroke={5}>
              <span className="text-[11px] font-bold tabular-nums text-foreground">{overall}</span>
            </ProgressRing>
          </div>
        )}
        {phase === "done" && (
          <div className="ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary">
            <Check className="h-5 w-5 text-primary-foreground" strokeWidth={2.5} />
          </div>
        )}
      </div>

      {/* Path B notice */}
      {storeMode && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-secondary/60 px-4 py-3">
          <Server className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="text-sm font-medium text-foreground">Stored temporarily</span>
          <span className="text-sm text-muted-foreground">·</span>
          <PathCountdown expiresAt={storeExpiresAt} storeMode={storeMode} />
        </div>
      )}

      {/* Candidate badge (Path A) */}
      {!storeMode && (phase === "transferring" || phase === "done") && candidateType && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <CandidateBadge type={candidateType} />
          {phase === "transferring" && <QualityBars level={quality} />}
        </div>
      )}

      {/* Summary on completion */}
      {phase === "done" && totalBytes > 0 && (
        <div className="mb-5 rounded-2xl border border-border bg-card/60 p-4">
          <TransferSummary state={state} />
        </div>
      )}

      {/* Reconnecting banner */}
      {phase === "reconnecting" && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-border bg-secondary/60 px-4 py-3">
          <WifiOff className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <p className="text-sm text-muted-foreground">Connection dipped. Reconnecting — hang on.</p>
        </div>
      )}

      {/* Transfer stats */}
      {(phase === "transferring" || phase === "connected") && totalBytes > 0 && (
        <div className="mb-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>{completedCount} of {files.length} files</span>
          <span>{formatBytes(receivedBytes)} · {isFinite(remaining) ? `~${formatEta(remaining)}` : formatSpeed(speed)}</span>
        </div>
      )}

      {/* Error banner */}
      {phase === "error" && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" strokeWidth={1.75} />
          <div>
            <p className="font-display text-sm font-bold text-foreground">Transfer interrupted</p>
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
              storeMode={storeMode}
              onSave={(url, name) => {
                if (storeMode) { void onDownloadStored(f.id); }
                else onSave(url, name);
              }}
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
      <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
        {phase === "done" && (
          <>
            <button
              type="button"
              onClick={onSaveAll}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.97] hover:opacity-90"
            >
              <Download className="h-4 w-4" strokeWidth={2} /> Save all
            </button>
            {hasMultiple && (
              <button
                type="button"
                onClick={handleShareAll}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
              >
                {sharedAll ? <Check className="h-4 w-4 text-foreground/70" strokeWidth={2} /> : <Share2 className="h-4 w-4" strokeWidth={2} />}
                {sharedAll ? "Sent" : "Share all"}
              </button>
            )}
            {textCount > 0 && (
              <button
                type="button"
                onClick={handleCopyAll}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
              >
                {copiedAll ? <Check className="h-4 w-4 text-foreground/70" strokeWidth={2} /> : <Copy className="h-4 w-4" strokeWidth={2} />}
                {copiedAll ? "Copied" : `Copy ${textCount} ${textCount === 1 ? "text" : "texts"}`}
              </button>
            )}
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
            >
              <Check className="h-4 w-4" strokeWidth={2} /> Done
            </button>
          </>
        )}
        {(phase === "error" || phase === "reconnecting") && (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
          >
            <RotateCcw className="h-4 w-4" strokeWidth={2} /> Start over
          </button>
        )}
      </div>
    </div>
  );
}

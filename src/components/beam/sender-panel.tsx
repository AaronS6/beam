"use client";

import * as React from "react";
import {
  Loader2,
  Check,
  AlertCircle,
  Clock,
  X,
  RotateCcw,
  Plus,
  WifiOff,
  Link2,
  Check as CheckIcon,
  ShieldCheck,
  FilePlus2,
} from "lucide-react";
import { BeamStage } from "./beam-stage";
import { BeamQR } from "./beam-qr";
import { FileDropzone } from "./file-dropzone";
import { FileRow } from "./file-row";
import { ProgressRing } from "./progress-ring";
import { SessionCountdown } from "./session-countdown";
import { QualityBars } from "./quality-bars";
import { formatBytes, formatSpeed, formatEta } from "@/lib/format";
import type { SessionState } from "@/hooks/use-beam-session";

export function SenderPanel({
  state,
  onFiles,
  onCancel,
  onReset,
  onCopyLink,
  onRemoveFile,
  onAddMoreFiles,
  onReorderFiles,
  onPasteText,
}: {
  state: SessionState;
  onFiles: (files: File[]) => void;
  onCancel: () => void;
  onReset: () => void;
  onCopyLink: () => Promise<boolean>;
  onRemoveFile: (id: string) => void;
  onAddMoreFiles: (files: File[]) => void;
  onReorderFiles: (fromId: string, toId: string) => void;
  onPasteText: (text: string) => void;
}) {
  const { phase, qrUrl, files, totalBytes, receivedBytes, speed, peerDevice, createdAt, quality } = state;
  const overall = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
  const remaining = speed > 0 ? (totalBytes - receivedBytes) / speed : Infinity;

  // Copy-link feedback
  const [copied, setCopied] = React.useState(false);
  const handleCopy = async () => {
    const ok = await onCopyLink();
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  // Add-more-files hidden input (waiting state)
  const moreInputRef = React.useRef<HTMLInputElement>(null);
  const handleAddMore = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onAddMoreFiles(Array.from(list));
  };

  // Drag-reorder state (waiting queue)
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null);
  const handleDragStart = (id: string) => (e: React.DragEvent) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (id: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragId && dragId !== id) setOverId(id);
  };
  const handleDrop = (id: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragId && dragId !== id) onReorderFiles(dragId, id);
    setDragId(null);
    setOverId(null);
  };

  const canEditQueue = phase === "waiting" || phase === "connected";

  return (
    <div className="flex flex-col items-center">
      {/* ---------- Stage ---------- */}
      <div className="w-full max-w-[320px]">
        {phase === "idle" && (
          <BeamStage>
            <FileDropzone onFiles={onFiles} onPasteText={onPasteText} />
          </BeamStage>
        )}

        {(phase === "waiting" || phase === "connected") && qrUrl && (
          <BeamStage active={phase === "waiting"}>
            <div className="flex flex-col items-center px-6 py-6">
              <BeamQR value={qrUrl} size={236} />
              <p className="mt-4 text-center text-sm text-muted-foreground">
                Scan with a phone camera
              </p>
            </div>
          </BeamStage>
        )}

        {phase === "transferring" && (
          <BeamStage>
            <div className="flex flex-col items-center px-6 py-8">
              <ProgressRing value={overall} size={168}>
                <span className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">
                  {overall}
                  <span className="text-lg text-muted-foreground">%</span>
                </span>
                <span className="mt-0.5 text-xs font-medium text-muted-foreground">
                  {formatSpeed(speed)}
                </span>
              </ProgressRing>
              <p className="mt-4 text-sm text-muted-foreground">
                Sending to {peerDevice?.label ?? "device"}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  <ShieldCheck className="h-3 w-3" strokeWidth={2} />
                  Encrypted · peer-to-peer
                </div>
                <QualityBars level={quality} />
              </div>
            </div>
          </BeamStage>
        )}

        {phase === "reconnecting" && (
          <BeamStage>
            <div className="flex flex-col items-center px-6 py-12">
              <div className="relative flex h-[168px] w-[168px] items-center justify-center">
                <WifiOff className="h-10 w-10 text-muted-foreground" strokeWidth={1.5} />
                <div
                  className="absolute inset-0 animate-beam-pulse rounded-full"
                  style={{ border: "1px solid color-mix(in srgb, var(--beam-from) 50%, transparent)" }}
                />
              </div>
              <p className="mt-5 text-[17px] font-medium text-foreground">Reconnecting…</p>
              <p className="mt-1 text-center text-sm text-muted-foreground">
                The connection dipped. Hold tight — it usually comes back.
              </p>
            </div>
          </BeamStage>
        )}

        {phase === "done" && (
          <BeamStage>
            <div className="flex flex-col items-center px-6 py-12">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-beam">
                <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
                  <path
                    d="M12 24.5 L20.5 33 L36 16"
                    stroke="white"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="animate-beam-check"
                  />
                </svg>
              </div>
              <p className="mt-5 text-[20px] font-semibold text-foreground">Sent</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(totalBytes)}
              </p>
            </div>
          </BeamStage>
        )}

        {phase === "error" && (
          <BeamStage>
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
                <AlertCircle className="h-8 w-8 text-destructive" strokeWidth={1.75} />
              </div>
              <p className="mt-5 text-[17px] font-medium text-foreground">
                {state.error ? "Transfer stopped" : "Something interrupted the transfer"}
              </p>
              {state.error && (
                <p className="mt-1 max-w-[30ch] text-sm text-muted-foreground">{state.error}</p>
              )}
            </div>
          </BeamStage>
        )}

        {phase === "expired" && (
          <BeamStage>
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
                <Clock className="h-8 w-8 text-muted-foreground" strokeWidth={1.75} />
              </div>
              <p className="mt-5 text-[17px] font-medium text-foreground">Session expired</p>
              <p className="mt-1 max-w-[30ch] text-sm text-muted-foreground">
                This session timed out. Start a new one to send files.
              </p>
            </div>
          </BeamStage>
        )}
      </div>

      {/* ---------- Status + actions below the stage ---------- */}
      <div className="mt-7 w-full max-w-[460px]">
        {(phase === "waiting" || phase === "connected") && (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex items-center gap-2 text-[15px] text-muted-foreground">
              <span className="h-2 w-2 animate-beam-breathe rounded-full bg-beam" />
              Waiting for a device to connect
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
              >
                {copied ? (
                  <CheckIcon className="h-3.5 w-3.5 text-foreground/70" strokeWidth={2} />
                ) : (
                  <Link2 className="h-3.5 w-3.5" strokeWidth={2} />
                )}
                {copied ? "Link copied" : "Copy link"}
              </button>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" strokeWidth={2} />
                Expires in <SessionCountdown createdAt={createdAt} />
              </span>
            </div>
          </div>
        )}

        {phase === "transferring" && (
          <div className="mb-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {formatBytes(receivedBytes)} of {formatBytes(totalBytes)}
            </span>
            <span>
              {isFinite(remaining) ? `~${formatEta(remaining)} left` : `${formatSpeed(speed)}`}
            </span>
          </div>
        )}

        {/* File list */}
        {files.length > 0 && phase !== "done" && phase !== "expired" && (
          <div className="space-y-2">
            {files.map((f) => (
              <div
                key={f.id}
                className={`transition-opacity ${overId === f.id ? "opacity-60" : ""}`}
              >
                <FileRow
                  file={f}
                  onRemove={canEditQueue ? onRemoveFile : undefined}
                  draggable={canEditQueue}
                  onDragStart={canEditQueue ? handleDragStart(f.id) : undefined}
                  onDragOver={canEditQueue ? handleDragOver(f.id) : undefined}
                  onDrop={canEditQueue ? handleDrop(f.id) : undefined}
                />
              </div>
            ))}
            {canEditQueue && (
              <button
                type="button"
                onClick={() => moreInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                <FilePlus2 className="h-4 w-4" strokeWidth={2} />
                Add more files
              </button>
            )}
            {canEditQueue && files.length > 1 && (
              <p className="pt-1 text-center text-[11px] text-muted-foreground/60">
                Drag to reorder · files send in the order shown
              </p>
            )}
            <input
              ref={moreInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => {
                handleAddMore(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="mt-6 flex items-center justify-center gap-3">
          {(phase === "waiting" || phase === "connected") && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
            >
              <X className="h-4 w-4" strokeWidth={2} />
              Cancel
            </button>
          )}

          {phase === "transferring" && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
            >
              <X className="h-4 w-4" strokeWidth={2} />
              Cancel transfer
            </button>
          )}

          {(phase === "done" || phase === "error" || phase === "expired") && (
            <>
              <button
                type="button"
                onClick={onReset}
                className="inline-flex items-center gap-2 rounded-full bg-beam px-5 py-2.5 text-sm font-medium text-white transition-transform active:scale-[0.97] hover:opacity-90"
              >
                <Plus className="h-4 w-4" strokeWidth={2} />
                Send more files
              </button>
              {phase === "done" && (
                <button
                  type="button"
                  onClick={onReset}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
                >
                  <Check className="h-4 w-4" strokeWidth={2} />
                  Done
                </button>
              )}
              {(phase === "error" || phase === "expired") && (
                <button
                  type="button"
                  onClick={onReset}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
                >
                  <RotateCcw className="h-4 w-4" strokeWidth={2} />
                  Start over
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

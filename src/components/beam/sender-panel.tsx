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
  Server,
} from "lucide-react";
import { BeamStage } from "./beam-stage";
import { BeamQR } from "./beam-qr";
import { FileComposer } from "./file-composer";
import { FileRow } from "./file-row";
import { ProgressRing } from "./progress-ring";
import { PathCountdown } from "./path-countdown";
import { CandidateBadge } from "./candidate-badge";
import { QualityBars } from "./quality-bars";
import { TransferSummary } from "./transfer-summary";
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
  onToggleStoreMode,
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
  onToggleStoreMode: (v: boolean) => void;
}) {
  const {
    phase, qrUrl, files, totalBytes, receivedBytes, speed, peerDevice,
    createdAt, quality, candidateType, storeMode, storeExpiresAt,
  } = state;
  const overall = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
  const remaining = speed > 0 ? (totalBytes - receivedBytes) / speed : Infinity;

  const [copied, setCopied] = React.useState(false);
  const handleCopy = async () => {
    const ok = await onCopyLink();
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1800); }
  };

  const moreInputRef = React.useRef<HTMLInputElement>(null);
  const handleAddMore = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onAddMoreFiles(Array.from(list));
  };

  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null);
  const handleDragStart = (id: string) => (e: React.DragEvent) => {
    setDragId(id); e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (id: string) => (e: React.DragEvent) => {
    e.preventDefault(); if (dragId && dragId !== id) setOverId(id);
  };
  const handleDrop = (id: string) => (e: React.DragEvent) => {
    e.preventDefault(); if (dragId && dragId !== id) onReorderFiles(dragId, id);
    setDragId(null); setOverId(null);
  };

  const canEditQueue = (phase === "waiting" || phase === "connected") && !storeMode;
  const pathExpiry = storeMode ? storeExpiresAt : createdAt ? createdAt + 5 * 60 * 1000 : null;

  return (
    <div className="flex flex-col items-center">
      {/* ---------- Stage ---------- */}
      <div className="w-full max-w-[340px]">
        {phase === "idle" && (
          <BeamStage>
            <FileComposer
              onFiles={onFiles}
              onPasteText={onPasteText}
              storeMode={storeMode}
              onToggleStoreMode={onToggleStoreMode}
            />
          </BeamStage>
        )}

        {(phase === "waiting" || phase === "connected") && qrUrl && (
          <BeamStage active={phase === "waiting"}>
            <div key="waiting" className="animate-beam-pop flex flex-col items-center px-6 py-7">
              <BeamQR value={qrUrl} size={236} />
              <p className="mt-4 text-center text-sm font-medium text-muted-foreground">
                {storeMode ? "Scan to grab them — link's good for 5 min" : "Scan to grab them"}
              </p>
            </div>
          </BeamStage>
        )}

        {phase === "transferring" && (
          <BeamStage>
            <div key="transferring" className="animate-beam-pop flex flex-col items-center px-6 py-8">
              <ProgressRing value={overall} size={168}>
                <span className="text-3xl font-bold tabular-nums tracking-tight text-foreground">
                  {overall}<span className="text-lg text-muted-foreground">%</span>
                </span>
                <span className="mt-0.5 text-xs font-medium text-muted-foreground">{formatSpeed(speed)}</span>
              </ProgressRing>
              <p className="mt-4 text-sm text-muted-foreground">
                Beaming to {peerDevice?.label ?? "device"}
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  <ShieldCheck className="h-3 w-3" strokeWidth={2} />
                  Encrypted
                </div>
                <CandidateBadge type={candidateType} />
                <QualityBars level={quality} />
              </div>
            </div>
          </BeamStage>
        )}

        {phase === "reconnecting" && (
          <BeamStage>
            <div key="reconnecting" className="animate-beam-pop flex flex-col items-center px-6 py-12">
              <div className="relative flex h-[168px] w-[168px] items-center justify-center">
                <WifiOff className="h-10 w-10 text-muted-foreground" strokeWidth={1.5} />
                <div className="absolute inset-0 animate-beam-pulse rounded-full" style={{ border: "1px solid color-mix(in srgb, var(--brand) 50%, transparent)" }} />
              </div>
              <p className="mt-5 text-[17px] font-semibold text-foreground">Reconnecting…</p>
              <p className="mt-1 text-center text-sm text-muted-foreground">
                The connection dipped. Hang on — it usually comes back.
              </p>
            </div>
          </BeamStage>
        )}

        {phase === "done" && (
          <BeamStage>
            <div key="done" className="flex flex-col items-center px-6 py-10">
              <div className="animate-beam-bounce flex h-20 w-20 items-center justify-center rounded-full bg-primary">
                <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
                  <path d="M12 24.5 L20.5 33 L36 16" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="animate-beam-check" />
                </svg>
              </div>
              <p className="mt-5 text-[22px] font-bold text-foreground">All sent</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(totalBytes)}
              </p>
              <div className="mt-5 w-full"><TransferSummary state={state} /></div>
            </div>
          </BeamStage>
        )}

        {phase === "error" && (
          <BeamStage>
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
                <AlertCircle className="h-8 w-8 text-destructive" strokeWidth={1.75} />
              </div>
              <p className="mt-5 text-[18px] font-semibold text-foreground">
                {state.error ? "Hmm, that stopped" : "Something interrupted the transfer"}
              </p>
              {state.error && <p className="mt-1 max-w-[30ch] text-sm text-muted-foreground">{state.error}</p>}
            </div>
          </BeamStage>
        )}

        {phase === "expired" && (
          <BeamStage>
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
                <Clock className="h-8 w-8 text-muted-foreground" strokeWidth={1.75} />
              </div>
              <p className="mt-5 text-[18px] font-semibold text-foreground">Link expired</p>
              <p className="mt-1 max-w-[30ch] text-sm text-muted-foreground">
                {storeMode ? "The 5 minutes ran out — files are deleted for good." : "Nobody connected in time. Start fresh?"}
              </p>
            </div>
          </BeamStage>
        )}
      </div>

      {/* ---------- Status + actions below the stage ---------- */}
      <div className="mt-6 w-full max-w-[480px]">
        {(phase === "waiting" || phase === "connected") && (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex items-center gap-2 text-[15px] font-medium text-white">
              <span className="h-2 w-2 animate-beam-breathe rounded-full bg-white" />
              {storeMode ? "Stored — waiting for them to grab it" : "Waiting for a device to connect"}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 text-xs">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 font-medium text-white backdrop-blur-sm transition-transform active:scale-[0.97] hover:bg-white/20"
              >
                {copied ? <CheckIcon className="h-3.5 w-3.5" strokeWidth={2} /> : <Link2 className="h-3.5 w-3.5" strokeWidth={2} />}
                {copied ? "Copied" : "Copy link"}
              </button>
              <PathCountdown expiresAt={pathExpiry} storeMode={storeMode} className="text-white/80" />
            </div>
            {storeMode && (
              <div className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-medium text-white/80">
                <Server className="h-3 w-3" strokeWidth={2} />
                Path B · encrypted server storage
              </div>
            )}
          </div>
        )}

        {phase === "transferring" && (
          <div className="mb-4 flex items-center justify-between text-sm font-medium text-white">
            <span>{formatBytes(receivedBytes)} of {formatBytes(totalBytes)}</span>
            <span>{isFinite(remaining) ? `~${formatEta(remaining)} left` : formatSpeed(speed)}</span>
          </div>
        )}

        {/* File list */}
        {files.length > 0 && phase !== "done" && phase !== "expired" && (
          <div className="space-y-2">
            {files.map((f) => (
              <div key={f.id} className={`transition-opacity ${overId === f.id ? "opacity-60" : ""}`}>
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
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <FilePlus2 className="h-4 w-4" strokeWidth={2} /> Add more files
              </button>
            )}
            {canEditQueue && files.length > 1 && (
              <p className="pt-1 text-center text-[11px] text-muted-foreground/70">Drag to reorder · files send in the order shown</p>
            )}
            <input
              ref={moreInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => { handleAddMore(e.target.files); e.target.value = ""; }}
            />
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-center gap-3">
          {(phase === "waiting" || phase === "connected") && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-5 py-2.5 text-sm font-semibold text-white backdrop-blur-sm transition-transform active:scale-[0.97] hover:bg-white/20"
            >
              <X className="h-4 w-4" strokeWidth={2} /> Cancel
            </button>
          )}
          {phase === "transferring" && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-5 py-2.5 text-sm font-semibold text-white backdrop-blur-sm transition-transform active:scale-[0.97] hover:bg-white/20"
            >
              <X className="h-4 w-4" strokeWidth={2} /> Cancel transfer
            </button>
          )}
          {(phase === "done" || phase === "error" || phase === "expired") && (
            <>
              <button
                type="button"
                onClick={onReset}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.97] hover:opacity-90"
              >
                <Plus className="h-4 w-4" strokeWidth={2} /> Send more files
              </button>
              {phase === "done" && (
                <button
                  type="button"
                  onClick={onReset}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
                >
                  <Check className="h-4 w-4" strokeWidth={2} /> Done
                </button>
              )}
              {(phase === "error" || phase === "expired") && (
                <button
                  type="button"
                  onClick={onReset}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
                >
                  <RotateCcw className="h-4 w-4" strokeWidth={2} /> Start over
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

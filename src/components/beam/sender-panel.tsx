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
  Smartphone,
  AlertTriangle,
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
import { NearbyDevices } from "./nearby-devices";
import { TransferModeToggle } from "./transfer-mode-toggle";
import { formatBytes, formatSpeed, formatEta } from "@/lib/format";
import { modeShortDescription, type TransferMode } from "@/lib/transfer-mode";
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
  onPickNearby,
  transferMode,
  onTransferModeChange,
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
  onPickNearby: (socketId: string, label: string) => void;
  transferMode: TransferMode;
  onTransferModeChange: (m: TransferMode) => void;
}) {
  const {
    phase, qrUrl, files, totalBytes, receivedBytes, speed, peerDevice,
    createdAt, quality, candidateType, nearby, finishing,
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

  const canEditQueue = phase === "waiting" || phase === "connected" || phase === "connecting";
  const pathExpiry = createdAt ? createdAt + 5 * 60 * 1000 : null;

  return (
    <div className="flex flex-col items-center">
      {/* ---------- Stage ---------- */}
      <div className="w-full max-w-[340px]">
        {phase === "idle" && (
          <BeamStage>
            <FileComposer
              onFiles={onFiles}
              onPasteText={onPasteText}
            />
            {/* Transfer-mode toggle, persisted in localStorage so it sticks
                across sessions. Helps the user tell Beam whether both phones
                share a network (direct P2P) or are on different networks
                (encrypted relay) so cross-network transfers actually work. */}
            <div className="mt-3 flex w-full flex-col items-center gap-1.5 px-5 pb-5">
              <TransferModeToggle value={transferMode} onChange={onTransferModeChange} />
              <p className="text-center text-[11px] leading-tight text-muted-foreground">
                {modeShortDescription(transferMode)}
              </p>
            </div>
          </BeamStage>
        )}

        {(phase === "waiting" || phase === "connected") && qrUrl && (
          <BeamStage active={phase === "waiting"}>
            <div key="waiting" className="animate-beam-pop flex flex-col items-center px-7 py-8">
              {/* "Ready" badge above the QR */}
              <div className="edge-light animate-beam-scale mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-secondary/80 px-3 py-1.5 text-xs font-bold text-foreground backdrop-blur-sm">
                <span className="h-2 w-2 animate-beam-breathe rounded-full bg-primary shadow-[0_0_8px_var(--brand)]" />
                Ready to scan
              </div>
              {/* QR code with a layered blue glow ring */}
              <div className="relative">
                {/* Outer halo, a wider, softer pool of light around the QR */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute -inset-5 -z-10 rounded-[32px] opacity-50 blur-2xl"
                  style={{ background: "radial-gradient(circle, var(--brand) 0%, transparent 70%)" }}
                />
                {/* Inner ring glow, the sharp, focused halo */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute -inset-2 rounded-[24px] opacity-40 blur-md"
                  style={{ background: "radial-gradient(circle, var(--brand-haze) 0%, transparent 70%)" }}
                />
                <BeamQR value={qrUrl} size={232} className="relative" />
              </div>
              <p className="font-display mt-5 text-center text-[17px] font-bold tracking-[-0.01em] text-foreground">
                Point a phone camera here
              </p>
              <p className="mt-1.5 max-w-[28ch] text-center text-sm leading-relaxed text-muted-foreground">
                They'll connect straight to your device
              </p>
            </div>
          </BeamStage>
        )}

        {phase === "connecting" && (
          <BeamStage active>
            <div key="connecting" className="animate-beam-pop flex flex-col items-center px-6 py-14">
              <div className="relative flex h-[120px] w-[120px] items-center justify-center">
                <Loader2 className="h-9 w-9 animate-spin text-muted-foreground" strokeWidth={1.5} />
                <div className="absolute inset-0 animate-beam-pulse rounded-full" style={{ border: "1px solid color-mix(in srgb, var(--brand) 50%, transparent)" }} />
              </div>
              <p className="font-display mt-6 text-[18px] font-bold text-foreground">
                Connecting…
              </p>
              <p className="mt-1.5 max-w-[28ch] text-center text-sm text-muted-foreground">
                Linking up with {peerDevice?.label ?? "the receiver"}. This usually takes a few seconds.
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
                <span className="mt-0.5 text-xs font-medium text-muted-foreground">
                  {finishing ? "finishing…" : formatSpeed(speed)}
                </span>
              </ProgressRing>
              <p className="font-display mt-4 text-[17px] font-bold text-foreground">
                {finishing
                  ? `Finishing up on ${peerDevice?.label ?? "the other device"}`
                  : `Beaming to ${peerDevice?.label ?? "device"}`}
              </p>
              {finishing ? (
                <p className="mt-1 max-w-[30ch] text-center text-xs leading-relaxed text-muted-foreground">
                  Almost done, the other device is saving your files. Keep this app open.
                </p>
              ) : (
                <p className="mt-1 text-center text-xs text-muted-foreground">
                  {overall < 100 ? "Sending your files peer-to-peer" : "Wrapping up"}
                </p>
              )}
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
              <p className="font-display mt-5 text-[22px] font-bold text-foreground">Reconnecting…</p>
              <p className="mt-1 text-center text-sm text-muted-foreground">
                The connection dipped. Hang on, it usually comes back.
              </p>
            </div>
          </BeamStage>
        )}

        {phase === "done" && (
          <BeamStage>
            <div key="done" className="flex flex-col items-center px-6 py-10">
              {/* Success check + a single bloom halo that plays once on entry */}
              <div className="relative flex h-20 w-20 items-center justify-center">
                <div
                  aria-hidden
                  className="animate-beam-bloom absolute inset-0 rounded-full"
                  style={{ border: "2px solid var(--brand)" }}
                />
                <div
                  aria-hidden
                  className="pointer-events-none absolute -inset-4 -z-10 rounded-full opacity-50 blur-xl"
                  style={{ background: "radial-gradient(circle, var(--brand) 0%, transparent 70%)" }}
                />
                <div className="edge-light flex h-20 w-20 items-center justify-center rounded-full bg-primary shadow-[0_8px_32px_-6px_var(--brand)]">
                  <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
                    <path d="M12 24.5 L20.5 33 L36 16" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="animate-beam-check" />
                  </svg>
                </div>
              </div>
              <p className="font-display mt-5 text-[24px] font-bold tracking-[-0.02em] text-foreground">All delivered</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(totalBytes)}
              </p>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                The receiver confirmed every file arrived safely.
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
              <p className="font-display mt-5 text-[20px] font-bold text-foreground">
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
              <p className="font-display mt-5 text-[20px] font-bold text-foreground">Link expired</p>
              <p className="mt-1 max-w-[30ch] text-sm text-muted-foreground">
                Nobody connected in time. Start fresh?
              </p>
            </div>
          </BeamStage>
        )}
      </div>

      {/* ---------- Status + actions below the stage ---------- */}
      <div className="mt-6 w-full max-w-[480px]">
        {(phase === "waiting" || phase === "connected") && (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex items-center gap-2 text-[15px] font-medium text-foreground">
              <span className="h-2 w-2 animate-beam-breathe rounded-full bg-primary" />
              Waiting for a device to connect
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 text-xs">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 font-medium text-foreground backdrop-blur-sm transition-transform active:scale-[0.97] hover:bg-secondary"
              >
                {copied ? <CheckIcon className="h-3.5 w-3.5" strokeWidth={2} /> : <Link2 className="h-3.5 w-3.5" strokeWidth={2} />}
                {copied ? "Copied" : "Copy link"}
              </button>
              <PathCountdown expiresAt={pathExpiry} storeMode={false} className="text-muted-foreground" />
            </div>
          </div>
        )}

        {phase === "connecting" && (
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex items-center gap-2 text-[15px] font-medium text-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" strokeWidth={2} />
              Establishing peer-to-peer connection
            </div>
            <p className="text-xs text-muted-foreground">
              If this takes more than 30s, the network may be blocking WebRTC.
            </p>
          </div>
        )}

        {phase === "transferring" && (
          <div
            className={`mb-4 flex items-start gap-3 rounded-2xl border px-4 py-3 ${
              finishing
                ? "border-primary/30 bg-primary/5"
                : "border-border bg-secondary/60"
            }`}
          >
            {finishing ? (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-primary" strokeWidth={1.75} />
            ) : (
              <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            )}
            <div>
              <p className="font-display text-[14px] font-bold text-foreground">
                {finishing ? "Don't close this app yet" : "Keep both phones on"}
              </p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                {finishing
                  ? "Beam is still delivering the last pieces to the other device. Closing this app or locking your phone can interrupt the transfer."
                  : "Keep both phones unlocked and this app open until the transfer finishes. Closing either device can interrupt it."}
              </p>
            </div>
          </div>
        )}

        {phase === "transferring" && (
          <div className="mb-4 flex items-center justify-between text-sm font-medium text-foreground">
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

        {/* Nearby devices, tap one to send directly (no QR needed).
            Shows whenever another device is on the Beam site, even before
            you've picked files (idle). Only hidden in store mode. */}
        {(phase === "idle" || phase === "waiting" || phase === "connected") && (
          <NearbyDevices nearby={nearby} onPick={onPickNearby} />
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-center gap-3">
          {(phase === "waiting" || phase === "connected" || phase === "connecting") && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
            >
              <X className="h-4 w-4" strokeWidth={2} /> Cancel
            </button>
          )}
          {phase === "transferring" && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
            >
              <X className="h-4 w-4" strokeWidth={2} /> Cancel transfer
            </button>
          )}
          {(phase === "done" || phase === "error" || phase === "expired") && (
            <>
              <button
                type="button"
                onClick={onReset}
                className="edge-light inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_4px_16px_-4px_var(--brand)] transition-all duration-200 active:scale-[0.97] hover:scale-[1.03] hover:brightness-110"
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

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
} from "lucide-react";
import { BeamStage } from "./beam-stage";
import { BeamQR } from "./beam-qr";
import { FileDropzone } from "./file-dropzone";
import { FileRow } from "./file-row";
import { ProgressRing } from "./progress-ring";
import { formatBytes, formatSpeed, formatEta } from "@/lib/format";
import type { SessionState } from "@/hooks/use-beam-session";

export function SenderPanel({
  state,
  onFiles,
  onCancel,
  onReset,
}: {
  state: SessionState;
  onFiles: (files: File[]) => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const { phase, qrUrl, files, totalBytes, receivedBytes, speed, peerDevice } = state;
  const overall = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
  const remaining = speed > 0 ? (totalBytes - receivedBytes) / speed : Infinity;

  return (
    <div className="flex flex-col items-center">
      {/* ---------- Stage ---------- */}
      <div className="w-full max-w-[320px]">
        {phase === "idle" && (
          <BeamStage>
            <FileDropzone onFiles={onFiles} />
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
                Sending {files.filter((f) => f.status !== "done").length + 1 <= files.length
                  ? `to ${peerDevice?.label ?? "device"}`
                  : ""}
              </p>
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
          <div className="flex flex-col items-center text-center">
            <div className="flex items-center gap-2 text-[15px] text-muted-foreground">
              <span className="h-2 w-2 animate-beam-breathe rounded-full bg-beam" />
              Waiting for a device to connect
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
              <FileRow key={f.id} file={f} />
            ))}
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

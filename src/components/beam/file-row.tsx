"use client";

import * as React from "react";
import { Check, Download, Loader2, FileIcon, AlertCircle } from "lucide-react";
import { formatBytes } from "@/lib/format";
import type { FileItem } from "@/hooks/use-beam-session";

function fileKind(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].includes(ext)) return "Image";
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "Video";
  if (["mp3", "wav", "flac", "aac", "m4a"].includes(ext)) return "Audio";
  if (["pdf"].includes(ext)) return "PDF";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "Archive";
  if (["doc", "docx", "txt", "md", "rtf", "pages"].includes(ext)) return "Document";
  if (["xls", "xlsx", "csv", "numbers"].includes(ext)) return "Spreadsheet";
  return ext ? ext.toUpperCase() : "File";
}

export function FileRow({
  file,
  onSave,
}: {
  file: FileItem;
  onSave?: (url: string, name: string) => void;
}) {
  const pct = file.size > 0 ? Math.min(100, Math.round((file.received / file.size) * 100)) : 0;
  const done = file.status === "done";

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3.5 transition-colors">
      {/* Type chip */}
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
        <FileIcon className="h-5 w-5" strokeWidth={1.75} />
      </div>

      {/* Name + meta */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-[15px] font-medium text-foreground">{file.name}</p>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatBytes(file.size)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-200 ease-out ${
                done ? "bg-foreground/80" : "bg-beam"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {done ? "100" : pct}%
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{fileKind(file.name)}</span>
          {file.status === "transferring" && (
            <>
              <span>·</span>
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{formatBytes(file.received)} received</span>
            </>
          )}
          {done && (
            <>
              <span>·</span>
              <Check className="h-3 w-3 text-foreground/70" />
              <span>Ready</span>
            </>
          )}
          {file.status === "error" && (
            <>
              <span>·</span>
              <AlertCircle className="h-3 w-3 text-destructive" />
              <span className="text-destructive">Failed</span>
            </>
          )}
        </div>
      </div>

      {/* Action */}
      <div className="shrink-0">
        {done && onSave && file.url ? (
          <button
            type="button"
            onClick={() => onSave(file.url!, file.name)}
            className="inline-flex items-center gap-1.5 rounded-full bg-beam px-3.5 py-2 text-xs font-medium text-white transition-transform active:scale-[0.97] hover:opacity-90"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2} />
            Save
          </button>
        ) : done ? (
          <Check className="h-5 w-5 text-foreground/70" strokeWidth={2} />
        ) : null}
      </div>
    </div>
  );
}

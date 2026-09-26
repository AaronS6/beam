"use client";

import * as React from "react";
import {
  Check,
  Download,
  Loader2,
  FileIcon,
  AlertCircle,
  X,
  Copy,
  ChevronDown,
  FileText,
} from "lucide-react";
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
  onRemove,
  onCopyText,
}: {
  file: FileItem;
  onSave?: (url: string, name: string) => void;
  onRemove?: (id: string) => void;
  onCopyText?: (text: string) => void;
}) {
  const pct = file.size > 0 ? Math.min(100, Math.round((file.received / file.size) * 100)) : 0;
  const done = file.status === "done";
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const hasText = done && !!file.text;

  const handleCopy = () => {
    if (!file.text || !onCopyText) return;
    onCopyText(file.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const isSnippet = file.name === "snippet.txt" || file.name === "link.txt";

  return (
    <div className="rounded-2xl border border-border bg-card p-3.5 transition-colors">
      <div className="flex items-center gap-3">
        {/* Type chip */}
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
          {hasText ? (
            <FileText className="h-5 w-5" strokeWidth={1.75} />
          ) : (
            <FileIcon className="h-5 w-5" strokeWidth={1.75} />
          )}
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
        <div className="flex shrink-0 items-center gap-1.5">
          {hasText && (
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-transform active:scale-[0.97] hover:bg-secondary"
              aria-label="Copy text"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-foreground/70" strokeWidth={2} />
              ) : (
                <Copy className="h-3.5 w-3.5" strokeWidth={2} />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {done && onSave && file.url && (
            <button
              type="button"
              onClick={() => onSave(file.url!, file.name)}
              className="inline-flex items-center gap-1.5 rounded-full bg-beam px-3.5 py-2 text-xs font-medium text-white transition-transform active:scale-[0.97] hover:opacity-90"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={2} />
              Save
            </button>
          )}
          {done && !onSave && !hasText && (
            <Check className="h-5 w-5 text-foreground/70" strokeWidth={2} />
          )}
          {onRemove && file.status === "queued" && (
            <button
              type="button"
              onClick={() => onRemove(file.id)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label={`Remove ${file.name} from queue`}
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      {/* Text preview (receiver, expandable) */}
      {hasText && (
        <div className="mt-3 border-t border-border/70 pt-3">
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>{isSnippet ? "Snippet" : "Preview"}</span>
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${previewOpen ? "rotate-180" : ""}`}
              strokeWidth={2}
            />
          </button>
          {previewOpen && (
            <pre className="scroll-beam mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-secondary/60 p-3 text-[13px] leading-relaxed text-foreground">
              {file.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

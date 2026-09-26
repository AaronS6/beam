"use client";

import * as React from "react";
import { UploadCloud, FilePlus2, Type, Send, Clock } from "lucide-react";
import { formatBytes } from "@/lib/format";

/**
 * FileDropzone — drag-and-drop + browse, OR text-snippet mode.
 * Also hosts the Path B "Store temporarily (5 min max)" toggle.
 */
export function FileDropzone({
  onFiles,
  onPasteText,
  storeMode,
  onToggleStoreMode,
}: {
  onFiles: (files: File[]) => void;
  onPasteText?: (text: string) => void;
  storeMode: boolean;
  onToggleStoreMode: (v: boolean) => void;
}) {
  const [mode, setMode] = React.useState<"files" | "text">("files");
  const [text, setText] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  // Global paste-to-send
  React.useEffect(() => {
    if (!onPasteText) return;
    const onPaste = (e: ClipboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const t = e.clipboardData?.getData("text");
      if (t && t.trim().length > 0) {
        e.preventDefault();
        setMode("text");
        setText(t);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onPasteText]);

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  const sendText = () => {
    const value = text.trim();
    if (!value) return;
    if (onPasteText) {
      onPasteText(value);
      return;
    }
    let name = "snippet.txt";
    if (/^https?:\/\//i.test(value)) name = "link.txt";
    const file = new File([value], name, { type: "text/plain" });
    onFiles([file]);
  };

  return (
    <div className="flex flex-col">
      {/* Mode toggle */}
      <div className="flex items-center justify-center gap-1 pt-5">
        <div className="inline-flex items-center rounded-full bg-secondary p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setMode("files")}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 font-medium transition-colors ${
              mode === "files" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
            aria-pressed={mode === "files"}
          >
            <FilePlus2 className="h-3.5 w-3.5" strokeWidth={2} />
            Files
          </button>
          <button
            type="button"
            onClick={() => setMode("text")}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 font-medium transition-colors ${
              mode === "text" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
            aria-pressed={mode === "text"}
          >
            <Type className="h-3.5 w-3.5" strokeWidth={2} />
            Text
          </button>
        </div>
      </div>

      {mode === "files" ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
          className={`flex flex-col items-center justify-center px-6 py-10 text-center transition-colors sm:py-12 ${
            dragging ? "bg-secondary/70" : ""
          }`}
        >
          <div
            className={`mb-4 flex h-16 w-16 items-center justify-center rounded-2xl transition-transform ${
              dragging ? "scale-110" : ""
            }`}
            style={{ background: "var(--beam-gradient)" }}
          >
            <UploadCloud className="h-8 w-8 text-white" strokeWidth={1.75} />
          </div>
          <p className="text-[19px] font-semibold text-foreground">
            {dragging ? "Drop them in" : "Drop your files here"}
          </p>
          <p className="mt-1.5 max-w-[30ch] text-sm text-muted-foreground">
            Or tap below to browse. They go straight to the other device — we never see them.
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.97] hover:opacity-90"
          >
            <FilePlus2 className="h-4 w-4" strokeWidth={2} />
            Choose files
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
          />
          {onPasteText && (
            <p className="mt-3 text-xs text-muted-foreground/80">
              or paste text anywhere to send it as a snippet
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col px-6 py-5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste a link, a note, a code snippet…"
            rows={5}
            className="w-full resize-none rounded-2xl border border-border bg-secondary/40 px-4 py-3 text-[15px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/40"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendText(); }
            }}
          />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs tabular-nums text-muted-foreground">
              {text.length.toLocaleString()} characters · {formatBytes(new Blob([text]).size)}
            </span>
            <button
              type="button"
              onClick={sendText}
              disabled={!text.trim()}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.97] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send className="h-4 w-4" strokeWidth={2} />
              Send text
            </button>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            ⌘/Ctrl + Enter to send
          </p>
        </div>
      )}

      {/* Path B toggle — opt-in temporary storage */}
      <div className="border-t border-border px-6 py-4">
        <button
          type="button"
          onClick={() => onToggleStoreMode(!storeMode)}
          className="flex w-full items-start gap-3 text-left"
          aria-pressed={storeMode}
        >
          <span
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
              storeMode ? "border-primary bg-primary" : "border-input bg-card"
            }`}
          >
            {storeMode && (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6.2 L4.8 8.3 L9.3 3.6" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2} />
              Store temporarily
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              {storeMode
                ? "Files upload to encrypted server storage and auto-delete within 5 minutes — or the moment they're downloaded. Good for when the other device isn't online yet."
                : "Off — files stream peer-to-peer and never touch a server. Turn on if the other device isn't online right now."}
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

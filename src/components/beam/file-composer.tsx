"use client";

import * as React from "react";
import { UploadCloud, FilePlus2, Type, Send, Zap, Clock } from "lucide-react";
import { formatBytes } from "@/lib/format";

/**
 * FileComposer — the idle-state hero inside the card.
 *
 * Design intent: NO always-visible dropzone. The card stays clean and
 * inviting — a big icon, a prominent "Choose files" button, a Files/Text
 * toggle, and a BIG visible "Store temporarily" segmented toggle.
 *
 * Drag-and-drop is handled at the window level by <DragOverlay/> — it only
 * appears the moment a user starts dragging files in.
 */
export function FileComposer({
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
    <div className="flex flex-col px-7 pb-7 pt-8">
      {/* Icon (static — no floating) */}
      <div
        className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-[26px] shadow-float"
        style={{ background: "var(--beam-gradient)" }}
      >
        {mode === "files" ? (
          <UploadCloud className="h-10 w-10 text-white" strokeWidth={1.75} />
        ) : (
          <Type className="h-10 w-10 text-white" strokeWidth={1.75} />
        )}
      </div>

      {/* Headline + subcopy */}
      <h2 className="font-display text-center text-[24px] font-bold tracking-tight text-foreground">
        {mode === "files" ? "Pick your files" : "Type something to send"}
      </h2>
      <p className="mx-auto mt-1.5 max-w-[30ch] text-center text-sm leading-relaxed text-muted-foreground">
        {mode === "files"
          ? "Tap below, or just drag them onto the page whenever."
          : "A link, a note, a snippet — sent as a tiny file."}
      </p>

      {/* Files / Text toggle */}
      <div className="mx-auto mt-5 inline-flex items-center rounded-full bg-secondary p-1 text-sm">
        <button
          type="button"
          onClick={() => setMode("files")}
          className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 font-semibold transition-all duration-300 ${
            mode === "files"
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          aria-pressed={mode === "files"}
        >
          <FilePlus2 className="h-3.5 w-3.5" strokeWidth={2.5} /> Files
        </button>
        <button
          type="button"
          onClick={() => setMode("text")}
          className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 font-semibold transition-all duration-300 ${
            mode === "text"
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          aria-pressed={mode === "text"}
        >
          <Type className="h-3.5 w-3.5" strokeWidth={2.5} /> Text
        </button>
      </div>

      {/* Mode body */}
      {mode === "files" ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="animate-glow-pulse group mx-auto mt-6 inline-flex items-center gap-2.5 rounded-full bg-primary px-7 py-3.5 text-base font-bold text-primary-foreground transition-all duration-200 active:scale-[0.96] hover:scale-[1.03]"
        >
          <FilePlus2 className="h-5 w-5 transition-transform duration-300 group-hover:rotate-6" strokeWidth={2.5} />
          Choose files
        </button>
      ) : (
        <div className="mt-5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste a link, a note, a code snippet…"
            rows={4}
            className="w-full resize-none rounded-2xl border border-border bg-secondary/40 px-4 py-3 text-[15px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/40"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendText(); }
            }}
          />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs tabular-nums text-muted-foreground">
              {text.length.toLocaleString()} chars · {formatBytes(new Blob([text]).size)}
            </span>
            <button
              type="button"
              onClick={sendText}
              disabled={!text.trim()}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground transition-all duration-200 active:scale-[0.96] hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
            >
              <Send className="h-4 w-4" strokeWidth={2.5} /> Send text
            </button>
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
      />

      {/* ===========================================================
          STORE TEMPORARILY — big, visible segmented toggle
          (was a buried checkbox; now an obvious two-option switch)
         =========================================================== */}
      <div className="mt-7">
        <p className="mb-2.5 text-center text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70">
          How should they go?
        </p>
        <div className="grid grid-cols-2 gap-2">
          {/* Direct (Path A) — default */}
          <button
            type="button"
            onClick={() => onToggleStoreMode(false)}
            aria-pressed={!storeMode}
            className={`relative flex flex-col items-center gap-1.5 rounded-2xl border-2 p-3 text-center transition-all duration-300 ${
              !storeMode
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border bg-card hover:border-foreground/20"
            }`}
          >
            <span className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
              !storeMode ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
            }`}>
              <Zap className="h-4 w-4" strokeWidth={2.5} />
            </span>
            <span className="text-[13px] font-bold text-foreground">Direct</span>
            <span className="text-[10px] leading-tight text-muted-foreground">Live, peer-to-peer</span>
          </button>
          {/* Store temporarily (Path B) */}
          <button
            type="button"
            onClick={() => onToggleStoreMode(true)}
            aria-pressed={storeMode}
            className={`relative flex flex-col items-center gap-1.5 rounded-2xl border-2 p-3 text-center transition-all duration-300 ${
              storeMode
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border bg-card hover:border-foreground/20"
            }`}
          >
            <span className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
              storeMode ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
            }`}>
              <Clock className="h-4 w-4" strokeWidth={2.5} />
            </span>
            <span className="text-[13px] font-bold text-foreground">Store 5 min</span>
            <span className="text-[10px] leading-tight text-muted-foreground">If they're offline</span>
          </button>
        </div>
        <p className="mt-2 text-center text-[11px] leading-relaxed text-muted-foreground">
          {storeMode
            ? "Encrypted server storage. Auto-deletes within 5 min — or the moment they grab it."
            : "Files stream device-to-device. Nothing is ever stored anywhere."}
        </p>
      </div>
    </div>
  );
}

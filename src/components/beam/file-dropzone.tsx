"use client";

import * as React from "react";
import { UploadCloud, FilePlus2, Type, Send } from "lucide-react";
import { formatBytes } from "@/lib/format";

/**
 * FileDropzone — drag-and-drop + click-to-browse file selection, OR text-snippet
 * mode (paste a URL / code / note and send it as a .txt file). Used inside
 * BeamStage in the idle state.
 */
export function FileDropzone({
  onFiles,
  onPasteText,
}: {
  onFiles: (files: File[]) => void;
  onPasteText?: (text: string) => void;
}) {
  const [mode, setMode] = React.useState<"files" | "text">("files");
  const [text, setText] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  // Global paste-to-send: when in files mode and not focused on the textarea,
  // pasting text anywhere on the idle dropzone auto-switches to text mode.
  React.useEffect(() => {
    if (!onPasteText) return;
    const onPaste = (e: ClipboardEvent) => {
      // Only intercept when the user isn't typing in an input/textarea elsewhere.
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const text = e.clipboardData?.getData("text");
      if (text && text.trim().length > 0) {
        e.preventDefault();
        setMode("text");
        setText(text);
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
    // Fallback: build the File locally if no paste handler was supplied.
    let name = "snippet.txt";
    if (/^https?:\/\//i.test(value)) name = "link.txt";
    const file = new File([value], name, { type: "text/plain" });
    onFiles([file]);
  };

  return (
    <div className="flex flex-col">
      {/* Mode toggle */}
      <div className="flex items-center justify-center gap-1 pt-4">
        <div className="inline-flex items-center rounded-full border border-border bg-secondary/50 p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setMode("files")}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-medium transition-colors ${
              mode === "files"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            aria-pressed={mode === "files"}
          >
            <FilePlus2 className="h-3.5 w-3.5" strokeWidth={2} />
            Files
          </button>
          <button
            type="button"
            onClick={() => setMode("text")}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-medium transition-colors ${
              mode === "text"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
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
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          className={`flex flex-col items-center justify-center px-6 py-10 text-center transition-colors sm:py-12 ${
            dragging ? "bg-secondary/70" : ""
          }`}
        >
          <div
            className={`mb-4 flex h-14 w-14 items-center justify-center rounded-2xl transition-transform ${
              dragging ? "scale-110" : ""
            }`}
            style={{
              background: "var(--beam-gradient)",
              boxShadow: "0 8px 24px -8px color-mix(in srgb, var(--beam-from) 60%, transparent)",
            }}
          >
            <UploadCloud className="h-7 w-7 text-white" strokeWidth={1.75} />
          </div>
          <p className="text-[17px] font-medium text-foreground">
            {dragging ? "Drop to add" : "Drag files here, or tap to browse"}
          </p>
          <p className="mt-1 max-w-[28ch] text-sm text-muted-foreground">
            Any file type. Transferred directly to the other device — nothing uploaded.
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-transform active:scale-[0.97] hover:opacity-90"
          >
            <FilePlus2 className="h-4 w-4" strokeWidth={2} />
            Choose files
          </button>
          {onPasteText && (
            <p className="mt-3 text-xs text-muted-foreground/70">
              or paste text anywhere to send it as a snippet
            </p>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col px-5 py-5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste a link, a note, a code snippet…"
            rows={5}
            className="w-full resize-none rounded-2xl border border-border bg-background px-4 py-3 text-[15px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground/30"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                sendText();
              }
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
              className="inline-flex items-center gap-2 rounded-full bg-beam px-5 py-2.5 text-sm font-medium text-white transition-transform active:scale-[0.97] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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
    </div>
  );
}

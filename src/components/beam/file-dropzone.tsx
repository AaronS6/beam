"use client";

import * as React from "react";
import { UploadCloud, FilePlus2 } from "lucide-react";
import { formatBytes } from "@/lib/format";

/**
 * FileDropzone — drag-and-drop + click-to-browse file selection.
 * Used inside BeamStage in the idle state.
 */
export function FileDropzone({
  onFiles,
  selectedFiles,
  compact = false,
}: {
  onFiles: (files: File[]) => void;
  selectedFiles?: File[];
  compact?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  return (
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
      className={`flex flex-col items-center justify-center text-center transition-colors ${
        compact ? "p-5" : "px-6 py-12 sm:py-16"
      } ${dragging ? "bg-secondary/70" : ""}`}
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
      {selectedFiles && selectedFiles.length > 0 && (
        <div className="mt-4 w-full space-y-1 text-left">
          {selectedFiles.map((f, i) => (
            <div key={i} className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate pr-3">{f.name}</span>
              <span className="shrink-0 tabular-nums">{formatBytes(f.size)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

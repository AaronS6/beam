"use client";

import * as React from "react";
import { UploadCloud } from "lucide-react";

/**
 * DragOverlay — a full-window overlay that appears ONLY when the user is
 * actively dragging files over the page. Listens to window-level
 * dragenter/dragover/dragleave/drop. On drop, forwards the files to onFiles.
 * On drag leaving the window, hides itself.
 *
 * This is intentionally NOT an always-visible dropzone. The idle card stays
 * clean; the overlay only materializes the moment a user starts dragging files in.
 */
export function DragOverlay({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [active, setActive] = React.useState(false);
  // dragenter/dragleave fire per-element; we count depth so leaving a child
  // element doesn't prematurely hide the overlay.
  const depthRef = React.useRef(0);

  React.useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depthRef.current += 1;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // allow drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depthRef.current = 0;
      setActive(false);
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        onFiles(Array.from(e.dataTransfer.files));
      }
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFiles]);

  if (!active) return null;

  return (
    <div
      className="animate-beam-overlay fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{ background: "color-mix(in srgb, var(--brand) 55%, transparent)", backdropFilter: "blur(6px)" }}
      role="presentation"
      aria-hidden
    >
      <div className="relative flex flex-col items-center text-center">
        {/* Animated dashed ring */}
        <svg
          className="absolute -inset-10 h-[calc(100%+5rem)] w-[calc(100%+5rem)]"
          viewBox="0 0 200 200"
          fill="none"
          aria-hidden
        >
          <rect
            x="8" y="8" width="184" height="184" rx="28"
            stroke="white"
            strokeWidth="3"
            strokeDasharray="10 10"
            strokeLinecap="round"
            className="animate-beam-dash"
            style={{ strokeDashoffset: 0 }}
            opacity="0.85"
          />
        </svg>
        <div className="animate-beam-wiggle flex h-24 w-24 items-center justify-center rounded-3xl bg-white shadow-2xl">
          <UploadCloud className="h-12 w-12 text-primary" strokeWidth={1.75} />
        </div>
        <p className="mt-6 text-2xl font-bold text-white drop-shadow-sm">
          Drop them anywhere
        </p>
        <p className="mt-1 text-sm font-medium text-white/80">
          We'll grab them the moment you let go
        </p>
      </div>
    </div>
  );
}

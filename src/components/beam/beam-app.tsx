"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useBeamSession } from "@/hooks/use-beam-session";
import { Nav } from "@/components/beam/nav";
import { Footer } from "@/components/beam/footer";
import { HowItWorks, Privacy } from "@/components/beam/sections";
import { SenderPanel } from "@/components/beam/sender-panel";
import { ReceiverPanel } from "@/components/beam/receiver-panel";
import { BackgroundDecor } from "@/components/beam/background-decor";
import { DragOverlay } from "@/components/beam/drag-overlay";

export function BeamApp() {
  const params = useSearchParams();
  const sessionIdParam = params.get("r");
  const {
    state,
    beginSending,
    sendToNearby,
    reset,
    cancel,
    saveFile,
    shareImage,
    shareAll,
    copyAllText,
    copyLink,
    removeFile,
    addMoreFiles,
    reorderFiles,
    sendPastedText,
  } = useBeamSession(sessionIdParam);

  const isReceiver = state.mode === "receiver";

  const handleSaveAll = React.useCallback(() => {
    state.files.forEach((f) => {
      if (f.url) saveFile(f.url, f.name);
    });
  }, [state.files, saveFile]);

  // Global keyboard shortcuts: F/B browse, Esc reset.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      const typing = tag === "input" || tag === "textarea";
      if (typing) return;
      if ((e.key === "f" || e.key === "b") && state.phase === "idle") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('input[type="file"]')?.click();
      } else if (e.key === "Escape" && state.phase !== "idle") {
        e.preventDefault();
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.phase, reset]);

  if (isReceiver) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <BackgroundDecor />
        <Nav />
        <main className="relative z-10 flex flex-1 items-start justify-center px-5 py-12 sm:items-center sm:py-16">
          <div className="animate-beam-fade w-full max-w-[540px]">
            <ReceiverPanel
              state={state}
              onSave={(url, name) => saveFile(url, name)}
              onSaveAll={handleSaveAll}
              onShareImage={shareImage}
              onShareAll={shareAll}
              onCopyAllText={copyAllText}
              onReset={() => {
                if (typeof window !== "undefined") {
                  window.history.replaceState({}, "", "/");
                  window.location.reload();
                }
              }}
            />
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const showMarketing = state.phase === "idle" || state.phase === "waiting";

  return (
    <div className="relative flex min-h-screen flex-col">
      <BackgroundDecor />
      {/* Window-level drag overlay — ONLY appears while actively dragging files in.
          Inactive otherwise (the idle card stays clean). */}
      {(state.phase === "idle" || state.phase === "waiting") && (
        <DragOverlay onFiles={beginSending} />
      )}
      <Nav />
      <main className="relative z-10 flex-1">
        {/* Hero */}
        <section className="mx-auto w-full max-w-3xl px-5 pb-16 pt-10 text-center sm:px-8 sm:pb-20 sm:pt-14">
          <div className="animate-beam-pop">
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-semibold text-muted-foreground backdrop-blur-sm">
              <span className="h-1.5 w-1.5 animate-beam-breathe rounded-full bg-primary" />
              Files that go straight from you to them
            </p>
            <h1 className="font-display text-balance text-[42px] font-extrabold leading-[1.0] tracking-tight text-foreground sm:text-[58px] lg:text-[72px]">
              Just drop your files<br className="hidden sm:block" /> and{" "}
              <span className="text-beam-animate">scan.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-[46ch] text-[16px] leading-relaxed text-muted-foreground sm:text-[18px]">
              They go straight to the other device — peer-to-peer, encrypted, gone the moment they land. No app, no account, no servers in the middle.
            </p>
          </div>

          <div className="mt-9 flex justify-center sm:mt-12">
            <div className="animate-beam-pop w-full max-w-[460px]" style={{ animationDelay: "0.1s" }}>
              <SenderPanel
                state={state}
                onFiles={beginSending}
                onCancel={cancel}
                onReset={reset}
                onCopyLink={copyLink}
                onRemoveFile={removeFile}
                onAddMoreFiles={addMoreFiles}
                onReorderFiles={reorderFiles}
                onPasteText={sendPastedText}
                onPickNearby={sendToNearby}
              />
            </div>
          </div>
        </section>

        {showMarketing && (
          <>
            <HowItWorks />
            <Privacy />
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}

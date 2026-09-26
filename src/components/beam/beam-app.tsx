"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useBeamSession } from "@/hooks/use-beam-session";
import { Nav } from "@/components/beam/nav";
import { Footer } from "@/components/beam/footer";
import { HowItWorks, Privacy } from "@/components/beam/sections";
import { SenderPanel } from "@/components/beam/sender-panel";
import { ReceiverPanel } from "@/components/beam/receiver-panel";

export function BeamApp() {
  const params = useSearchParams();
  const sessionIdParam = params.get("r");
  const {
    state,
    beginSending,
    reset,
    cancel,
    saveFile,
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

  if (isReceiver) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Nav />
        <main className="flex flex-1 items-start justify-center px-5 py-12 sm:items-center sm:py-20">
          <div className="animate-beam-fade w-full max-w-[520px]">
            <ReceiverPanel
              state={state}
              onSave={saveFile}
              onSaveAll={handleSaveAll}
              onReset={() => {
                // Receiver "start over" → drop the ?r= param and become a sender.
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

  // Sender / landing view
  const showMarketing = state.phase === "idle" || state.phase === "waiting";

  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      {/* Ambient beam-tinted glow behind the hero — very subtle, never a full wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] overflow-hidden"
        style={{
          background:
            "radial-gradient(60% 80% at 50% 0%, color-mix(in srgb, var(--beam-from) 9%, transparent) 0%, transparent 70%)",
        }}
      />
      <Nav />
      <main className="relative flex-1">
        {/* Hero */}
        <section className="mx-auto w-full max-w-3xl px-5 pb-16 pt-14 text-center sm:px-8 sm:pb-24 sm:pt-20">
          <div className="animate-beam-fade">
            {/* Trust badge row */}
            <div className="mb-7 flex items-center justify-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-beam" aria-hidden />
                Peer-to-peer
              </span>
              <span className="hidden text-muted-foreground/40 sm:inline">·</span>
              <span className="hidden rounded-full px-2 py-1 text-xs font-medium text-muted-foreground sm:inline">
                Encrypted
              </span>
              <span className="hidden text-muted-foreground/40 sm:inline">·</span>
              <span className="hidden rounded-full px-2 py-1 text-xs font-medium text-muted-foreground sm:inline">
                No account
              </span>
            </div>
            <h1 className="text-balance text-[34px] font-semibold leading-[1.06] tracking-tight text-foreground sm:text-[48px] lg:text-[60px]">
              Send files without the cables.
            </h1>
            <p className="mx-auto mt-4 max-w-[52ch] text-[16px] leading-relaxed text-muted-foreground sm:mt-5 sm:text-[19px]">
              Open this page on any device, pick your files, and scan the QR code with a phone.
              They transfer directly between devices — no app to install, nothing uploaded.
            </p>
          </div>

          <div className="mt-10 flex justify-center sm:mt-14">
            <div className="animate-beam-fade w-full max-w-[460px]">
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

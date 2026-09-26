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

export function BeamApp() {
  const params = useSearchParams();
  const sessionIdParam = params.get("r");
  const {
    state,
    beginSending,
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
    setStoreMode,
    downloadStored,
  } = useBeamSession(sessionIdParam);

  const isReceiver = state.mode === "receiver";

  const handleSaveAll = React.useCallback(() => {
    state.files.forEach((f) => {
      if (state.storeMode) {
        // Path B: trigger one-time-use downloads sequentially.
        if (f.id) void downloadStored(f.id);
      } else if (f.url) {
        saveFile(f.url, f.name);
      }
    });
  }, [state.files, state.storeMode, saveFile, downloadStored]);

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
              onDownloadStored={downloadStored}
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
      <Nav />
      <main className="relative z-10 flex-1">
        {/* Hero */}
        <section className="mx-auto w-full max-w-3xl px-5 pb-16 pt-10 text-center sm:px-8 sm:pb-20 sm:pt-14">
          <div className="animate-beam-fade">
            <p className="mb-4 text-sm font-medium text-white/70">
              Files that go straight from you to them
            </p>
            <h1 className="text-balance text-[38px] font-bold leading-[1.04] tracking-tight text-white sm:text-[52px] lg:text-[64px]">
              Just drop your files and scan.
            </h1>
            <p className="mx-auto mt-4 max-w-[46ch] text-[17px] leading-relaxed text-white/80 sm:text-[19px]">
              They go directly to the other device — peer-to-peer, encrypted, gone the moment they land. No app, no account, no servers in the middle.
            </p>
          </div>

          <div className="mt-9 flex justify-center sm:mt-12">
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
                onToggleStoreMode={setStoreMode}
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

import { Suspense } from "react";
import { BeamApp } from "@/components/beam/beam-app";
import { BeamLogo } from "@/components/beam-logo";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
          <BeamLogo size={32} />
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-foreground" />
        </div>
      }
    >
      <BeamApp />
    </Suspense>
  );
}

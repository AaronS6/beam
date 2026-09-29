"use client";

import * as React from "react";

/**
 * BackgroundDecor, soft blue glows drifting behind the central card on the
 * dark charcoal-blue background. Atmospheric, not blob-y: a layered set of
 * diffuse radial pools + a faint dotted texture + an almost-invisible film
 * grain that reads as "premium camera grain" rather than "blurry shape".
 */
export function BackgroundDecor() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Soft blue glow top-left, the primary atmospheric pool */}
      <div
        className="animate-beam-drift absolute -left-40 -top-24 h-[26rem] w-[26rem] rounded-full opacity-25 blur-3xl"
        style={{ background: "radial-gradient(circle, #7AB8F0 0%, transparent 65%)" }}
      />
      {/* Lighter blue glow top-right */}
      <div
        className="animate-beam-drift absolute -right-40 top-24 h-[32rem] w-[32rem] rounded-full opacity-18 blur-3xl"
        style={{ background: "radial-gradient(circle, #9CCAF6 0%, transparent 65%)", animationDelay: "4s" }}
      />
      {/* Pale blue glow bottom-left, gives the footer area a quiet light source */}
      <div
        className="animate-beam-drift absolute bottom-[-6rem] left-1/4 h-80 w-80 rounded-full opacity-14 blur-3xl"
        style={{ background: "radial-gradient(circle, #B8DCF8 0%, transparent 65%)", animationDelay: "8s" }}
      />
      {/* A fourth, very faint glow center-bottom, pulls the eye toward the hero card */}
      <div
        className="animate-beam-drift absolute bottom-1/3 right-1/4 h-72 w-72 rounded-full opacity-10 blur-3xl"
        style={{ background: "radial-gradient(circle, #7AB8F0 0%, transparent 70%)", animationDelay: "12s" }}
      />

      {/* Subtle dotted texture overlay, a hint of structure on flat dark areas */}
      <div className="texture-dots absolute inset-0 opacity-[0.035]" />

      {/* Film grain, barely visible noise that breaks up flat dark surfaces */}
      <div className="texture-grain absolute inset-0 opacity-[0.025] mix-blend-soft-light" />

      {/* Top-edge vignette, pulls the eye toward the center hero */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 60% at 50% 0%, transparent 0%, color-mix(in srgb, #0A0D15 45%, transparent) 100%)",
        }}
      />
    </div>
  );
}

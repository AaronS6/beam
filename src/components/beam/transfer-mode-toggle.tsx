"use client";

import * as React from "react";
import { Wifi, Globe, Zap } from "lucide-react";
import { modeLabel, type TransferMode } from "@/lib/transfer-mode";

/**
 * TransferModeToggle, lets the user pick how files travel between devices.
 * Persisted in localStorage (see src/lib/transfer-mode.ts) so it sticks across
 * sessions until changed.
 *
 * • Auto              , try direct P2P first; fall back to the encrypted relay
 *                        if it can't connect (e.g. both phones on cellular
 *                        data). The smart default, works on any network.
 * • Same Wi-Fi        , direct peer-to-peer only. Fastest + most private.
 *                        Use when both phones are on the same Wi-Fi.
 * • Relay (cross-net) , encrypted server relay. Use when the phones are on
 *                        different networks (each on cellular data, or one on
 *                        Wi-Fi + one on data). Always works; the server only
 *                        ever holds ciphertext.
 *
 * Layout: a 3-column grid of stacked (icon + label) pills. Each pill is
 * equal-width and the labels are short so the whole control fits inside the
 * narrow BeamStage card (~300px content area) without overflowing, on any
 * phone width. The active pill is filled; inactive are outline.
 */
const MODES: { id: TransferMode; icon: typeof Wifi; short: string }[] = [
  { id: "auto", icon: Zap, short: "Auto" },
  { id: "p2p", icon: Wifi, short: "Same Wi-Fi" },
  { id: "relay", icon: Globe, short: "Relay" },
];

export function TransferModeToggle({
  value,
  onChange,
}: {
  value: TransferMode;
  onChange: (m: TransferMode) => void;
}) {
  return (
    <div
      className="grid w-full grid-cols-3 gap-1 rounded-full border border-border/60 bg-secondary/80 p-1 text-xs backdrop-blur-sm"
      role="radiogroup"
      aria-label="Transfer mode"
    >
      {MODES.map((m) => {
        const Icon = m.icon;
        const active = value === m.id;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(m.id)}
            title={modeLabel(m.id)}
            className={`group flex flex-col items-center justify-center gap-1 rounded-full px-1 py-1.5 font-semibold leading-tight transition-all duration-300 ${
              active
                ? "bg-card text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.4),0_0_18px_-6px_var(--brand)]"
                : "text-muted-foreground hover:bg-card/40 hover:text-foreground"
            }`}
          >
            <Icon
              className={`h-3.5 w-3.5 shrink-0 transition-transform duration-300 ${
                active ? "scale-110 text-primary" : "group-hover:scale-105"
              }`}
              strokeWidth={2.5}
            />
            <span className="text-center leading-[1.1]">{m.short}</span>
          </button>
        );
      })}
    </div>
  );
}

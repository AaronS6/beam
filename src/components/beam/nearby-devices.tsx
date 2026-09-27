"use client";

import * as React from "react";
import { Smartphone, Laptop, Monitor, Tablet, Users, Radio } from "lucide-react";

/**
 * NearbyDevices — ALWAYS shows the "send to someone nearby" section.
 * When devices are online, lists them as tappable chips.
 * When alone, shows a calm "waiting for others" state.
 */
function deviceIcon(short: string) {
  const s = short.toLowerCase();
  if (s.includes("ios") || s.includes("android")) return Smartphone;
  if (s.includes("ipad") || s.includes("tablet")) return Tablet;
  if (s.includes("macos") || s.includes("mac")) return Laptop;
  if (s.includes("windows") || s.includes("linux")) return Monitor;
  return Smartphone;
}

export function NearbyDevices({
  nearby,
  onPick,
}: {
  nearby: { socketId: string; label: string; short: string }[];
  onPick: (socketId: string, label: string) => void;
}) {
  return (
    <div className="animate-beam-up mx-auto mt-7 w-full max-w-sm">
      <div className="mb-2.5 flex items-center justify-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70">
        <Users className="h-3 w-3" strokeWidth={2.5} />
        Or send to someone nearby
      </div>
      {nearby.length > 0 ? (
        <div className="space-y-2">
          {nearby.map((d, i) => {
            const Icon = deviceIcon(d.short || d.label);
            return (
              <button
                key={d.socketId}
                type="button"
                onClick={() => onPick(d.socketId, d.label)}
                className="animate-beam-up group flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 active:scale-[0.98]"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <Icon className="h-5 w-5" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-foreground">{d.label}</span>
                  {d.short && <span className="block text-[11px] text-muted-foreground">{d.short}</span>}
                </span>
                <span className="flex items-center gap-1 text-[11px] font-bold text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  Send
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-2xl border border-dashed border-border bg-card/50 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
            <Radio className="h-4 w-4 animate-beam-breathe" strokeWidth={2} />
          </span>
          <span className="text-[13px] leading-relaxed text-muted-foreground">
            Looking for devices nearby… Open Beam on another device and it'll show up here.
          </span>
        </div>
      )}
    </div>
  );
}

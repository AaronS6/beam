"use client";

import * as React from "react";
import { ScanLine, Wifi, Check, ShieldCheck } from "lucide-react";

const STEPS = [
  {
    n: "1",
    icon: ScanLine,
    title: "Scan",
    body: "Pick files on your device, then point any phone camera at the QR code. No app to install — it opens straight in the browser.",
  },
  {
    n: "2",
    icon: Wifi,
    title: "Connect",
    body: "The two devices find a direct path to each other and open an encrypted channel. Your files never touch a server.",
  },
  {
    n: "3",
    icon: Check,
    title: "Done",
    body: "Files arrive with live progress. Tap to save them to the receiving device. The session closes itself when you're done.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-32">
      <div className="mb-12 sm:mb-16">
        <h2 className="text-[32px] font-semibold leading-tight tracking-tight text-foreground sm:text-[40px]">
          Three steps. No accounts.
        </h2>
        <p className="mt-3 max-w-[52ch] text-[17px] leading-relaxed text-muted-foreground">
          Beam works between any two devices with a browser and a camera — Android, iPhone, laptop,
          desktop, in any combination.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3 sm:gap-5">
        {STEPS.map((s) => (
          <div
            key={s.n}
            className="group rounded-2xl border border-border bg-card p-6 transition-all duration-300 hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-beam"
          >
            <div className="mb-5 flex items-center justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-beam text-white transition-transform duration-300 group-hover:scale-105">
                <s.icon className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <span className="text-sm font-medium tabular-nums text-muted-foreground/60">
                {s.n}
              </span>
            </div>
            <h3 className="text-xl font-semibold text-foreground">{s.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Privacy() {
  return (
    <section id="privacy" className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-32">
      <div className="grid gap-10 sm:grid-cols-[1fr_1.1fr] sm:gap-16">
        <div>
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-beam text-white">
            <ShieldCheck className="h-6 w-6" strokeWidth={1.75} />
          </div>
          <h2 className="text-[32px] font-semibold leading-tight tracking-tight text-foreground sm:text-[40px]">
            Your files don't travel through us.
          </h2>
          <p className="mt-4 max-w-[52ch] text-[17px] leading-relaxed text-muted-foreground">
            Once the two devices pair, they open a direct, encrypted connection and send the file
            bytes between themselves. The signaling server only helps them find each other — it
            carries connection setup, never your files.
          </p>
        </div>
        <ul className="space-y-5">
          {[
            {
              t: "Peer-to-peer by default",
              d: "Files flow directly from one device to the other over WebRTC, encrypted with DTLS end to end.",
            },
            {
              t: "Nothing is stored",
              d: "There's no upload bucket, no retention. Close the tab and the session is gone.",
            },
            {
              t: "Short-lived sessions",
              d: "Each pairing expires automatically after ten minutes of inactivity.",
            },
          ].map((item) => (
            <li key={item.t} className="flex gap-4">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-beam" aria-hidden />
              <div>
                <p className="text-[17px] font-medium text-foreground">{item.t}</p>
                <p className="mt-1 text-[15px] leading-relaxed text-muted-foreground">{item.d}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

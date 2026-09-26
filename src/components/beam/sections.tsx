"use client";

import * as React from "react";
import { ScanLine, Zap, Check, ShieldCheck, Clock, Lock } from "lucide-react";

const STEPS = [
  {
    n: "1",
    icon: ScanLine,
    title: "Drop & scan",
    body: "Toss your files into the card and point any phone camera at the QR. No app to install — it pops open in the browser.",
  },
  {
    n: "2",
    icon: Zap,
    title: "Straight across",
    body: "The two devices find a direct path and beam the bytes across — encrypted, peer-to-peer, never stored anywhere.",
  },
  {
    n: "3",
    icon: Check,
    title: "Done & gone",
    body: "Files land with live progress, you save them, and the link evaporates. Nothing left behind, by design.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
      <div className="mb-12 sm:mb-16">
        <h2 className="text-[30px] font-bold leading-tight tracking-tight text-white sm:text-[40px]">
          Three steps. No sign-up, no fuss.
        </h2>
        <p className="mt-3 max-w-[52ch] text-[17px] leading-relaxed text-white/80">
          Works between any two devices with a browser and a camera — Android, iPhone, laptop, desktop, any mix you like.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3 sm:gap-5">
        {STEPS.map((s) => (
          <div
            key={s.n}
            className="group rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:bg-white/15"
          >
            <div className="mb-5 flex items-center justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-primary shadow-sm transition-transform duration-300 group-hover:scale-105">
                <s.icon className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <span className="text-sm font-semibold tabular-nums text-white/50">{s.n}</span>
            </div>
            <h3 className="text-xl font-bold text-white">{s.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-white/80">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Privacy() {
  return (
    <section id="privacy" className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
      <div className="grid gap-10 sm:grid-cols-[1fr_1.1fr] sm:gap-16">
        <div>
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-sm">
            <ShieldCheck className="h-6 w-6 text-white" strokeWidth={1.75} />
          </div>
          <h2 className="text-[30px] font-bold leading-tight tracking-tight text-white sm:text-[40px]">
            Your files don't pass through us.
          </h2>
          <p className="mt-4 max-w-[52ch] text-[17px] leading-relaxed text-white/80">
            Once two devices pair, they open a direct encrypted connection and send the bytes between themselves. Our server only helps them find each other — it carries setup, never your files.
          </p>
        </div>
        <ul className="space-y-4">
          {[
            { icon: Zap, t: "Peer-to-peer by default", d: "Files flow directly from one device to the other over WebRTC, encrypted end to end with DTLS." },
            { icon: Lock, t: "Nothing is stored", d: "There's no upload bucket and no retention. Close the tab and the session is gone for good." },
            { icon: Clock, t: "Links expire fast", d: "A session self-destructs after 5 minutes if no one connects — or the instant the file is grabbed, whichever comes first." },
          ].map((item) => (
            <li key={item.t} className="flex items-start gap-4 rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-sm">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15">
                <item.icon className="h-5 w-5 text-white" strokeWidth={1.75} />
              </span>
              <div>
                <p className="text-[16px] font-semibold text-white">{item.t}</p>
                <p className="mt-0.5 text-[14px] leading-relaxed text-white/80">{item.d}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

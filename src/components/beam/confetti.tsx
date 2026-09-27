"use client";

import * as React from "react";

/**
 * Confetti — a lightweight CSS confetti burst. Renders N colored dots that
 * fly outward from the center, then fades. Pure CSS animation, no library.
 * Shows when `trigger` is true, auto-hides after 1.5s.
 */
export function Confetti({ trigger }: { trigger: boolean }) {
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    if (trigger) {
      setShow(true);
      const t = setTimeout(() => setShow(false), 1500);
      return () => clearTimeout(t);
    }
  }, [trigger]);

  if (!show) return null;

  const colors = ["#7AB8F0", "#9CCAF6", "#B8DCF8", "#FFD9CC", "#FFB59E"];
  const pieces = Array.from({ length: 24 }, (_, i) => {
    const angle = (i / 24) * Math.PI * 2;
    const distance = 60 + Math.random() * 40;
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;
    const color = colors[i % colors.length];
    const delay = Math.random() * 0.1;
    return (
      <span
        key={i}
        className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full"
        style={{
          background: color,
          animation: `confetti-fly 1.2s ${delay}s cubic-bezier(0.22, 1, 0.36, 1) forwards`,
          ["--tx" as string]: `${x}px`,
          ["--ty" as string]: `${y}px`,
        }}
      />
    );
  });

  return (
    <>
      <style>{`
        @keyframes confetti-fly {
          0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          100% { transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(0); opacity: 0; }
        }
      `}</style>
      <div className="pointer-events-none absolute inset-0 z-50 overflow-visible">{pieces}</div>
    </>
  );
}

"use client";

import * as React from "react";
import QRCode from "qrcode";

/**
 * BeamQR, renders a QR code (always on a white inset for maximum scanner
 * compatibility) via the `qrcode` package, fully client-side.
 */
export function BeamQR({
  value,
  size = 256,
  className,
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // High error correction so partial obscuring still scans. Dark modules on
    // transparent bg; the white inset behind provides the light modules.
    QRCode.toCanvas(
      canvas,
      value,
      {
        errorCorrectionLevel: "H",
        margin: 1,
        width: size,
        color: { dark: "#1D1D1F", light: "#FFFFFF00" },
      },
      (err) => {
        if (err) console.error("QR render error", err);
      },
    );
  }, [value, size]);

  return (
    <div
      className={`relative rounded-[20px] bg-white p-3 ${className ?? ""}`}
      role="img"
      aria-label="QR code to connect a device"
    >
      <canvas ref={canvasRef} width={size} height={size} className="block h-full w-full" />
    </div>
  );
}

import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { SWRegister } from "@/components/beam/sw-register";
import { InAppBrowserDetect } from "@/components/beam/in-app-browser-detect";

export const metadata: Metadata = {
  title: "Beam — Send files without the cables",
  description:
    "Send files between any two devices by scanning a QR code. Peer-to-peer, encrypted, and nothing is stored on any server. No app install required.",
  keywords: ["file transfer", "WebRTC", "QR code", "AirDrop", "peer-to-peer", "Beam"],
  authors: [{ name: "Beam" }],
  manifest: "/manifest.json",
  icons: {
    icon: [{ url: "/icon-32.png", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    title: "Beam — Send files without the cables",
    description:
      "Send files between any two devices by scanning a QR code. Peer-to-peer and encrypted.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Beam",
    description: "Send files between any two devices by scanning a QR code.",
  },
};

export const viewport: Viewport = {
  themeColor: "#131722",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" type="image/png" href="/icon-32.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.json" />
        {/* Google Fonts loaded via <link> (not next/font) so it works on
            Render/Vercel builds that can't fetch fonts at build time. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        {/* Inline loading screen — shows BEFORE the external CSS/JS loads so the
            receiver (who just scanned the QR) sees a spinner immediately instead
            of a black screen. Inline-styled (no Tailwind dependency). React
            replaces this on hydration (the children render on top). */}
        <style dangerouslySetInnerHTML={{ __html: `
          #beam-bootstrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:#131722;z-index:9999;transition:opacity .3s}
          #beam-bootstrap.hide{opacity:0;pointer-events:none}
          .beam-bs-spin{width:28px;height:28px;border:3px solid #2E3850;border-top-color:#7AB8F0;border-radius:50%;animation:beam-bs-rot .8s linear infinite}
          @keyframes beam-bs-rot{to{transform:rotate(360deg)}}
          .beam-bs-text{font-family:-apple-system,system-ui,sans-serif;font-size:13px;font-weight:600;color:#8E9AB0;letter-spacing:-0.01em}
        `}} />
        <div id="beam-bootstrap" dangerouslySetInnerHTML={{ __html: `
          <div class="beam-bs-spin"></div>
          <div class="beam-bs-text">Beam</div>
        `}} />
        <script dangerouslySetInnerHTML={{ __html: `
          // Hide the bootstrap loader when React actually renders content
          // (the <main> element appears). Poll every 200ms, max 10s.
          // (Hiding on DOMContentLoaded was too early — React hadn't hydrated
          // yet, so the user saw a dark screen with no content.)
          function hideBs(){var b=document.getElementById('beam-bootstrap');if(b){b.classList.add('hide');setTimeout(function(){b.remove()},400)}}
          var pc=0;var pi=setInterval(function(){if(document.querySelector('main')||pc>50){clearInterval(pi);hideBs()}pc++},200);
        `}} />
        <ThemeProvider>
          {children}
          <Toaster />
          <SWRegister />
          <InAppBrowserDetect />
        </ThemeProvider>
      </body>
    </html>
  );
}

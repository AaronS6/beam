import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { SWRegister } from "@/components/beam/sw-register";

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
        <ThemeProvider>
          {children}
          <Toaster />
          <SWRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}

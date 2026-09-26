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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAFAFA" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
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

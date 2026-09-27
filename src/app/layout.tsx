import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Inter, Bricolage_Grotesque } from "next/font/google";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { SWRegister } from "@/components/beam/sw-register";

// Inter — clean, premium body text (open-source, Inter-style humanist sans).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

// Bricolage Grotesque — a characterful display face for headlines. Warm,
// slightly quirky, very human — gives the hero personality without being
// cartoonish. Pairs beautifully with Inter.
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
  weight: ["600", "700", "800"],
});

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
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${bricolage.variable}`}>
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

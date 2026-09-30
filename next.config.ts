import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Allow the sandbox preview gateway origin to request /_next/* assets without
  // the dev-server cross-origin warning. Wildcards cover any preview subdomain.
  allowedDevOrigins: ["*.space-z.ai", "*.z.ai", "localhost"],
  // ---- Security headers (applied to every response in production) ----
  // Defense in depth: CSP (blocks injected scripts / XSS), frame blocking
  // (clickjacking), MIME sniffing blocking, referrer trimming, + feature
  // locks. These run on the deployed site (not the dev server).
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Content Security Policy: only allow scripts/styles/connects from
          // self + the explicit CDN origins Beam uses (Google Fonts for the
          // display font). 'unsafe-inline' is needed for styles because
          // Next.js inlines critical CSS; script-src has NO unsafe-inline
          // (uses nonces/hashes for any inline scripts via Next's built-in
          // nonce support in production builds).
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com data:",
              "img-src 'self' data: blob:",
              "connect-src 'self' https://*.cloudflarestorage.com https://*.backblazeb2.com https://*.s3.amazonaws.com wss: ws:",
              "media-src 'self' blob:",
              "worker-src 'self' blob:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          // Block clickjacking (no framing).
          { key: "X-Frame-Options", value: "DENY" },
          // Block MIME sniffing (prevents a text/plain response being treated
          // as a script).
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Trim the Referer to just the origin (no path/query/fragment) on
          // cross-origin navigations — so the AES relay key in the URL
          // fragment never leaks via Referer to a third party. (Fragments
          // aren't sent anyway, but this is defense in depth.)
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Lock down browser features Beam doesn't use.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          // Force HTTPS for 2 years (defeats SSL-strip downgrade attacks).
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
    ];
  },
};

export default nextConfig;

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
};

export default nextConfig;

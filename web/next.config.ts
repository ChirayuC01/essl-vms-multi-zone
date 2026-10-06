import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ship only Next's traced production runtime. The installer must never
  // contain the development tree or the complete frontend node_modules.
  output: "standalone",
  // This is Next's production default, kept explicit because enabling it
  // would embed the original TS/TSX in browser-accessible source maps.
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  // Dev server only (ignored by `next start`): lets a phone open the portal
  // through a temporary Cloudflare quick tunnel during testing. Without it
  // the dev server refuses the tunnel's address for its dev-only assets.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;

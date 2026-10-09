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
  // The visitor portal is the internet-facing part (Phase 9). Its URLs carry
  // the visitor's link token, so: never sent on as a Referer, never cached,
  // never framed by another site, never indexed. The camera is allowed for
  // this origin only (the selfie step).
  async headers() {
    const portal = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Cache-Control", value: "no-store" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
    ];
    return [
      { source: "/v/:path*", headers: portal },
      { source: "/public-api/:path*", headers: portal },
    ];
  },
};

export default nextConfig;

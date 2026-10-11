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
  // Extra hosts for a named test tunnel go in web/.env.local, comma-separated:
  // DEV_ALLOWED_ORIGINS=visit.example.com — never hard-coded here.
  allowedDevOrigins: ["*.trycloudflare.com", ...(process.env.DEV_ALLOWED_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean)],
  // The visitor portal is the internet-facing part (Phase 9). Its URLs carry
  // the visitor's link token, so: never sent on as a Referer (caching is
  // already off: Next marks these dynamic pages uncacheable itself, and
  // ignores a Cache-Control set here),
  // never framed by another site, never indexed. The camera is allowed for
  // this origin only (the selfie step).
  async headers() {
    const portal = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Content-Type-Options", value: "nosniff" },
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

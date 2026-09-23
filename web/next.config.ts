import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ship only Next's traced production runtime. The installer must never
  // contain the development tree or the complete frontend node_modules.
  output: "standalone",
  // This is Next's production default, kept explicit because enabling it
  // would embed the original TS/TSX in browser-accessible source maps.
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
};

export default nextConfig;

import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

// API_BASE_URL is installation configuration. Keep the root shell dynamic so
// Next cannot freeze the developer's local value into prerendered HTML.
export const dynamic = "force-dynamic";

// The product name is deliberately generic. This is a multi-client product
// from day one — no client name appears anywhere in the UI, and Phase 6
// branding comes from config.
export const metadata: Metadata = {
  title: "Visitor Management System",
  description: "Employee and visitor access management",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read at request time (this is a live Node process under `next start`,
  // not baked in at build time like NEXT_PUBLIC_*), so the installer can set
  // API_BASE_URL to whatever backend port the client chose without a
  // rebuild. Injected before hydration so web/src/lib/api.ts sees it on
  // first render. See docs/DEPLOYMENT_READINESS.md for why NEXT_PUBLIC_* is
  // build-time-baked and unusable for this.
  const apiBase = process.env.API_BASE_URL;
  const runtimeConfig = apiBase
    ? `window.__VMS_API_BASE__ = ${JSON.stringify(apiBase).replace(/</g, "\\u003c")};`
    : null;

  return (
    <html lang="en" className="h-full antialiased">
      <head>
        {runtimeConfig && (
          <script id="vms-api-base" dangerouslySetInnerHTML={{ __html: runtimeConfig }} />
        )}
      </head>
      {/* Fonts are system-stack (see globals.css): an on-premise install may
          have no internet, so fetching a webfont at runtime would be a
          visible failure on the machine that matters most. */}
      <body className="flex min-h-full flex-col">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

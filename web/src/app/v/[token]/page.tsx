"use client";

import { use } from "react";
import { VisitorFlow } from "@/components/visitor-flow";

// The visitor portal (two-zone rebuild, Phase 5). Reached from the link in the
// visitor's SMS or email, on their own phone. Talks only to /public-api on
// this same origin (proxied to the backend).
export default function VisitorPortal({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return (
    <main className="mx-auto w-full max-w-lg flex-1 p-4">
      <VisitorFlow endpoint={`/public-api/v/${token}`} />
    </main>
  );
}

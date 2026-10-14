"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { Card, Empty } from "@/components/ui";
import { ZonesCard } from "@/components/zones-card";

// Zones are the site's layout, not terminal settings, so they have their own
// page (owner, 14 Oct 2026). A terminal is still placed into a zone from its
// own card on the Devices page, beside its other settings.
export default function ZonesPage() {
  const { can } = useAuth();
  if (!can("zones:view")) return <Card title="Zones"><Empty>Your access does not include zones.</Empty></Card>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--text-muted)]">
        A zone inside another also opens its parent&apos;s gates. Place each terminal into its zone on the{" "}
        <Link href="/devices" className="text-[var(--brand)] hover:underline">Devices</Link> page.
      </p>
      <ZonesCard />
    </div>
  );
}

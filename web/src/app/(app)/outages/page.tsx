"use client";

import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { useApi } from "@/lib/swr";
import { Alert, Card, Empty, Table } from "@/components/ui";

// Outages (two-zone rebuild, Phase 7). While the system was down, staff let
// people out with the terminal's admin card and kept a manual register. On
// recovery the system released every single-entry visitor it still thought
// was inside; this list is what to reconcile that register against.

interface Outage {
  id: string;
  startedAt: string;
  endedAt: string;
  releasedCount: number;
  released: { id: string; inAt: string | null; person: { id: string; name: string; esslUserId: string; mobile: string | null } }[];
}

export default function OutagesPage() {
  const { data, error } = useApi<{ items: Outage[] }>("/api/outages");
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Outages</h1>
      <p className="text-sm text-[var(--text-muted)]">
        Each outage lists the single-entry visitors the system released automatically when it came back. Check them against the manual admin-card register.
      </p>
      {error && <Alert>{error.message}</Alert>}
      {data && data.items.length === 0 && <Empty>No outages recorded.</Empty>}
      {data?.items.map((o) => (
        <Card key={o.id} title={`${formatDateTime(o.startedAt)} – ${formatDateTime(o.endedAt)}`} action={<span className="text-sm">{o.releasedCount} released</span>}>
          {o.released.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Nobody needed releasing.</p>
          ) : (
            <Table head={["Visitor", "Terminal ID", "Mobile", "Came in"]}>
              {o.released.map((r) => (
                <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-2 py-2"><Link className="hover:underline" href={`/people/${r.person.id}`}>{r.person.name}</Link></td>
                  <td className="px-2 py-2 font-mono">{r.person.esslUserId}</td>
                  <td className="px-2 py-2">{r.person.mobile ?? "—"}</td>
                  <td className="px-2 py-2">{formatDateTime(r.inAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ))}
    </div>
  );
}

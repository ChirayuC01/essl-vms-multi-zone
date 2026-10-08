"use client";

import Link from "next/link";
import { useState } from "react";
import { getApiBase, getToken } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, requestTone } from "@/lib/format";
import { refresh, useApi } from "@/lib/swr";
import { Accordion, Alert, Badge, Button, Card, Empty, Table } from "@/components/ui";
import { VisitorFlow } from "@/components/visitor-flow";
import { VisitRequestForm } from "@/components/visit-request-form";

// The walk-in desk (two-zone rebuild, Phase 6). Security registers a visitor
// who arrived without a request: the visit, then the same steps the portal
// takes the visitor through — the code sent to their phone and typed here,
// the privacy notice shown to them, their details, a photo on this PC's
// camera. Whether the host must then Clear it is a site setting.

interface WalkIn {
  id: string;
  status: string;
  visitorName: string;
  visitorMobile: string;
  expectedAt: string;
  host: { name: string | null; email: string };
  passId: string | null;
  createdAt: string;
}

export default function WalkInPage() {
  const { can } = useAuth();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { data } = useApi<{ items: WalkIn[] }>("/api/walk-ins", { refreshInterval: 10_000 });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Walk-in</h1>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {activeId ? (
        <Card
          title="Visitor's details"
          action={<Button onClick={() => { setActiveId(null); setNotice(null); void refresh("/api/walk-ins"); }}>Done</Button>}
        >
          <div className="max-w-lg">
            <VisitorFlow key={activeId} desk endpoint={`${getApiBase()}/api/walk-ins/${activeId}`} headers={{ Authorization: `Bearer ${getToken() ?? ""}` }} />
          </div>
        </Card>
      ) : (
        <Accordion title="Register a walk-in" initiallyOpen>
          <VisitRequestForm walkIn onCreated={(id, message) => { setNotice(message); setActiveId(id); void refresh("/api/walk-ins"); }} />
        </Accordion>
      )}
      <Card title="Walk-ins in the last 24 hours">
        {data && data.items.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <Table head={["Visitor", "Host", "Registered", "Status", ""]}>
            {data?.items.map((w) => (
              <tr key={w.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2">{w.visitorName}<div className="text-xs text-[var(--text-muted)]">{w.visitorMobile}</div></td>
                <td className="px-2 py-2">{w.host.name ?? w.host.email}</td>
                <td className="px-2 py-2">{formatDateTime(w.createdAt)}</td>
                <td className="px-2 py-2"><Badge tone={requestTone(w.status)}>{w.status === "SENT" ? "in progress" : w.status.toLowerCase()}</Badge></td>
                <td className="px-2 py-2 text-right">
                  {w.status === "SENT" && <Button onClick={() => setActiveId(w.id)}>Continue</Button>}
                  {w.passId && can("passes:view") && <Link className="text-sm hover:underline" href={`/pass/${w.passId}`}>Pass</Link>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import type { Paged, VisitRequestRow, VisitRequestStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { entryModeLabel, formatDateTime, requestStatusLabel, requestTone as statusTone } from "@/lib/format";
import { refresh, useApi } from "@/lib/swr";
import { Accordion, Alert, Badge, Card, Empty, Select, Table } from "@/components/ui";
import { VisitRequestForm } from "@/components/visit-request-form";

// Visit requests (Phase 5). A host raises one; the visitor gets a link and
// completes their details on the portal. Clear / Query / Reject arrive in
// Phase 6.

const STATUSES: VisitRequestStatus[] = ["SENT", "SUBMITTED", "QUERIED", "CLEARED", "REJECTED", "CANCELLED", "EXPIRED"];

export default function RequestsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const url = `/api/visit-requests?pageSize=100${status ? `&status=${status}` : ""}`;
  const { data, error } = useApi<Paged<VisitRequestRow>>(url);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Visit requests</h1>
      <p className="text-sm text-[var(--text-muted)]">For a planned visit: you invite the visitor, they fill in their own details and selfie on their phone, and they are provisioned when you Clear it (or at once, if the pass type needs no Clear).</p>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {can("visit_requests:create") && (
        <Accordion title="New visit request">
          <VisitRequestForm onCreated={(_id, message) => { setNotice(message); void refresh("/api/visit-requests"); }} />
        </Accordion>
      )}
      <Card
        title="Requests"
        action={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{requestStatusLabel(s)}</option>)}
          </Select>
        }
      >
        {error && <Alert>{error.message}</Alert>}
        {data && data.items.length === 0 ? (
          <Empty>No visit requests.</Empty>
        ) : (
          <Table head={["Visitor", "Pass type", "Visit", "Host", "Status"]}>
            {data?.items.map((r) => (
              <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2">
                  <Link href={`/requests/${r.id}`} className="font-medium hover:underline">{r.visitorName}</Link>
                  <div className="text-xs text-[var(--text-muted)]">{r.visitorMobile}{r.companyName ? ` · ${r.companyName}` : ""}{r.returning ? " · returning" : ""}</div>
                </td>
                <td className="px-2 py-2">{r.passTypeName ?? "—"}<div className="text-xs text-[var(--text-muted)]">{entryModeLabel(r.entryMode)}</div></td>
                <td className="px-2 py-2">{formatDateTime(r.expectedAt)}</td>
                <td className="px-2 py-2">{r.host.name ?? r.host.email}</td>
                <td className="px-2 py-2"><Badge tone={statusTone(r.status)}>{requestStatusLabel(r.status)}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

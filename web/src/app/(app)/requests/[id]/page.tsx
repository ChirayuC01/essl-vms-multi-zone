"use client";

import Link from "next/link";
import { use, useState } from "react";
import { api, ApiError, getApiBase, getToken, type VisitRequestDetail } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatBytes, formatDateTime, requestTone } from "@/lib/format";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Badge, Button, Card, Field, Input, Table } from "@/components/ui";

const LABELS: Record<string, string> = {
  name: "Name",
  email: "Email",
  companyId: "Company",
  designation: "Designation",
  govtIdType: "Govt ID type",
  govtIdNumber: "Govt ID number",
  aadharNumber: "Aadhaar",
  panNumber: "PAN",
  vehicleNumber: "Vehicle number",
  policeClearance: "Police clearance",
  credentialNumber: "Credential number",
  credentialExpiresAt: "Credential expiry",
};
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));

export default function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const url = `/api/visit-requests/${id}`;
  const { data: r, error } = useApi<VisitRequestDetail>(url);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileUrl = (path: string) => `${getApiBase()}${url}${path}?token=${encodeURIComponent(getToken() ?? "")}`;

  async function act(action: "resend" | "cancel") {
    setBusy(action);
    setProblem(null);
    setNotice(null);
    try {
      await api(`${url}/${action}`, { method: "POST", body: action === "cancel" ? { reason } : {} });
      setNotice(action === "resend" ? "A new link was sent. The previous link no longer works." : "Request cancelled.");
      await refresh("/api/visit-requests");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "the action failed");
    } finally {
      setBusy(null);
    }
  }

  if (error) return <Alert>{error.message}</Alert>;
  if (!r) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  const open = r.status === "SENT" || r.status === "QUERIED";
  const cancellable = open || r.status === "SUBMITTED";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/requests" className="text-sm hover:underline">← Requests</Link>
        <h1 className="text-xl font-semibold">{r.visitorName}</h1>
        <Badge tone={requestTone(r.status)}>{r.status.toLowerCase()}</Badge>
        {r.personId && <Badge tone="info">returning visitor</Badge>}
      </div>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {problem && <Alert>{problem}</Alert>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Visit">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--text-muted)]">Mobile</dt><dd>{r.visitorMobile}{r.mobileVerifiedAt ? " · verified" : ""}</dd>
            <dt className="text-[var(--text-muted)]">Email</dt><dd>{show(r.visitorEmail)}</dd>
            <dt className="text-[var(--text-muted)]">Company</dt><dd>{show(r.companyName)}</dd>
            <dt className="text-[var(--text-muted)]">Type</dt><dd>{r.passType?.name ?? "—"} · {r.entryMode === "SINGLE_ENTRY" ? "single entry" : "multi entry"}</dd>
            <dt className="text-[var(--text-muted)]">Zones</dt><dd>{r.zones.map((z) => z.name).join(", ")}</dd>
            <dt className="text-[var(--text-muted)]">Visit</dt><dd>{formatDateTime(r.expectedAt)} – {formatDateTime(r.validUntil)}</dd>
            <dt className="text-[var(--text-muted)]">Purpose</dt><dd>{r.purpose}</dd>
            <dt className="text-[var(--text-muted)]">Host</dt><dd>{r.host.name ?? r.host.email}</dd>
            <dt className="text-[var(--text-muted)]">Link</dt>
            <dd>{r.link ? (r.link.revokedAt ? "withdrawn" : `valid until ${formatDateTime(r.link.expiresAt)}`) : "—"}</dd>
            <dt className="text-[var(--text-muted)]">Privacy notice</dt>
            <dd>{r.consents.length ? `accepted ${formatDateTime(r.consents.at(-1)!.acceptedAt)}` : "not yet accepted"}</dd>
          </dl>
        </Card>

        <Card title="Photo">
          {r.hasSelfie ? (
            // eslint-disable-next-line @next/next/no-img-element -- authenticated cross-origin image
            <img src={fileUrl("/selfie")} alt={`Photo of ${r.visitorName}`} className="max-h-72 rounded-[var(--radius)]" />
          ) : (
            <p className="text-sm text-[var(--text-muted)]">The visitor has not taken their photo yet.</p>
          )}
        </Card>
      </div>

      <Card title="Details from the visitor">
        {r.missing.length > 0 && <Alert tone="warn">Still needed: {r.missing.join(", ")}</Alert>}
        {r.details ? (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {Object.entries(LABELS).filter(([k]) => k in r.details!).map(([k, label]) => (
              <div key={k} className="contents"><dt className="text-[var(--text-muted)]">{label}</dt><dd>{show(r.details![k])}</dd></div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">Nothing submitted yet.</p>
        )}
      </Card>

      <Card title="Documents">
        {r.documents.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No documents.</p>
        ) : (
          <Table head={["Kind", "File", "Size", "Added"]}>
            {r.documents.map((d) => (
              <tr key={d.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2">{d.kind}</td>
                <td className="px-2 py-2"><a className="hover:underline" href={fileUrl(`/documents/${d.id}/file`)}>{d.fileName}</a></td>
                <td className="px-2 py-2">{formatBytes(d.sizeBytes)}</td>
                <td className="px-2 py-2">{formatDateTime(d.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="History">
        <ol className="space-y-1 text-sm">
          {r.events.map((e) => (
            <li key={e.id}>
              <span className="text-[var(--text-muted)]">{formatDateTime(e.createdAt)}</span> · {e.fromStatus ? `${e.fromStatus.toLowerCase()} → ` : ""}<strong>{e.toStatus.toLowerCase()}</strong>
              {" "}by {e.actorKind === "VISITOR" ? "the visitor" : e.actorName ?? e.actorKind.toLowerCase()}
              {e.note ? ` — ${e.note}` : ""}
            </li>
          ))}
        </ol>
      </Card>

      {can("visit_requests:create") && cancellable && (
        <Card title="Actions">
          <div className="space-y-3">
            {open && <Button loading={busy === "resend"} onClick={() => void act("resend")}>Send a new link</Button>}
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Reason for cancelling"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
              <Button variant="danger" disabled={reason.trim().length < 3} loading={busy === "cancel"} onClick={() => void act("cancel")}>Cancel request</Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

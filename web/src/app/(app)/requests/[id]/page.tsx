"use client";

import Link from "next/link";
import { use, useState } from "react";
import { api, ApiError, getApiBase, getToken, type VisitRequestDetail, type VisitRequestOptions } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatBytes, formatDateTime, requestTone } from "@/lib/format";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Badge, Button, Card, Field, Input, Select, Table } from "@/components/ui";

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
  const [queryText, setQueryText] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [companyPick, setCompanyPick] = useState<string | null>(null);
  const [widenTo, setWidenTo] = useState("");
  const { data: options } = useApi<VisitRequestOptions>(r?.canReview ? "/api/visit-requests/options" : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileUrl = (path: string) => `${getApiBase()}${url}${path}?token=${encodeURIComponent(getToken() ?? "")}`;

  const DONE: Record<string, string> = {
    resend: "A new link was sent. The previous link no longer works.",
    cancel: "Request cancelled.",
    clear: "Cleared. The pass is issued; the face loads on the gates shortly before the visit time.",
    query: "Query sent. The visitor has a new link showing your question.",
    reject: "Rejected. The visitor has been told.",
    widen: "Zone added: its terminals are loading.",
  };
  async function act(action: keyof typeof DONE, path = `${url}/${action}`, body: object = {}) {
    setBusy(action);
    setProblem(null);
    setNotice(null);
    try {
      await api(path, { method: "POST", body });
      setNotice(DONE[action]!);
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

      {r.pass && (
        <Card title="Pass">
          <div className="space-y-3 text-sm">
            <p>Terminal ID <span className="font-mono">{r.pass.person.esslUserId}</span> · <Badge tone={r.pass.state === "PROVISIONED" || r.pass.state === "INSIDE" ? "ok" : "neutral"}>{r.pass.state.toLowerCase().replace("_", " ")}</Badge></p>
            {r.canReview && can("zone_widen:update") && (r.pass.state === "PROVISIONED" || r.pass.state === "INSIDE") && (
              <div className="flex flex-wrap items-end gap-2">
                <Select className="max-w-xs" value={widenTo} onChange={(e) => setWidenTo(e.target.value)}>
                  <option value="">Add a zone…</option>
                  {options?.zones.filter((z) => !r.pass!.zoneIds.includes(z.id)).map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                </Select>
                <Button disabled={!widenTo} loading={busy === "widen"} onClick={() => void act("widen", `/api/entries/${r.pass!.id}/widen`, { zoneId: widenTo })}>Widen pass</Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {r.canReview && (r.status === "SUBMITTED" || open) && (
        <Card title="Decision">
          <div className="space-y-4">
            {r.status === "SUBMITTED" && (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Company" hint="From the Directory">
                    <Select value={companyPick ?? r.companyId ?? ""} onChange={(e) => setCompanyPick(e.target.value)}>
                      <option value="">—</option>
                      {options?.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </Select>
                  </Field>
                  {(options?.departments.length ?? 0) > 0 && (
                    <Field label="Department" hint="Only if the visitor type needs one">
                      <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                        <option value="">—</option>
                        {options?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </Select>
                    </Field>
                  )}
                  <Button variant="primary" loading={busy === "clear"} onClick={() => void act("clear", undefined, { ...(companyPick ? { companyId: companyPick } : {}), ...(departmentId ? { departmentId } : {}) })}>Clear — issue the pass</Button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Query: what should the visitor change?"><Input value={queryText} onChange={(e) => setQueryText(e.target.value)} maxLength={500} /></Field>
                  <Button disabled={queryText.trim().length < 3} loading={busy === "query"} onClick={() => void act("query", undefined, { text: queryText.trim() })}>Send query</Button>
                </div>
              </>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Reason for rejecting" hint="Kept internal; the visitor is only told it was not approved"><Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} maxLength={300} /></Field>
              <Button variant="danger" disabled={rejectReason.trim().length < 3} loading={busy === "reject"} onClick={() => void act("reject", undefined, { reason: rejectReason.trim() })}>Reject</Button>
            </div>
          </div>
        </Card>
      )}

      {can("visit_requests:create") && cancellable && (
        <Card title="Actions">
          <div className="space-y-3">
            {open && <Button loading={busy === "resend"} onClick={() => void act("resend")}>Send a new link</Button>}
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Reason for cancelling"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
              <Button variant="danger" disabled={reason.trim().length < 3} loading={busy === "cancel"} onClick={() => void act("cancel", undefined, { reason })}>Cancel request</Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

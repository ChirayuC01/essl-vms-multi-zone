"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { api, ApiError, type Paged, type VisitRequestOptions, type VisitRequestRow, type VisitRequestStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, requestTone as statusTone } from "@/lib/format";
import { refresh, useApi } from "@/lib/swr";
import { Accordion, Alert, Badge, Button, Card, Empty, Field, Input, Select, Table } from "@/components/ui";

// Visit requests (Phase 5). A host raises one; the visitor gets a link and
// completes their details on the portal. Clear / Query / Reject arrive in
// Phase 6.

const STATUSES: VisitRequestStatus[] = ["SENT", "SUBMITTED", "QUERIED", "CLEARED", "REJECTED", "CANCELLED", "EXPIRED"];

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function NewRequestForm({ onCreated }: { onCreated: (message: string) => void }) {
  const { data: options } = useApi<VisitRequestOptions>("/api/visit-requests/options");
  const [form, setForm] = useState({ visitorName: "", visitorMobile: "", visitorEmail: "", companyName: "", purpose: "" });
  const [passTypeId, setPassTypeId] = useState("");
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [codeZones, setCodeZones] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"SINGLE_ENTRY" | "MULTI_ENTRY">("SINGLE_ENTRY");
  const [from, setFrom] = useState(() => { const d = new Date(Date.now() + 3_600_000); d.setMinutes(0, 0, 0); return localInput(d); });
  const [until, setUntil] = useState(() => { const d = new Date(); d.setHours(23, 59, 0, 0); return localInput(d); });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const passType = options?.passTypes.find((t) => t.id === passTypeId);
  const modes = passType?.entryModes ?? ["SINGLE_ENTRY", "MULTI_ENTRY"];
  const covered = useMemo(() => {
    const byId = new Map((options?.zones ?? []).map((z) => [z.id, z]));
    const out = new Map<string, { id: string; name: string; exitCodeDefault: boolean }>();
    for (const id of zoneIds) for (let z = byId.get(id); z && !out.has(z.id); z = z.parentZoneId ? byId.get(z.parentZoneId) : undefined) out.set(z.id, z);
    return [...out.values()];
  }, [zoneIds, options]);
  const exitCodeZoneIds = codeZones ?? covered.filter((z) => z.exitCodeDefault).map((z) => z.id);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function create() {
    setBusy(true);
    setProblem(null);
    try {
      await api("/api/visit-requests", {
        method: "POST",
        body: {
          visitorName: form.visitorName,
          visitorMobile: form.visitorMobile,
          visitorEmail: form.visitorEmail.trim() || null,
          companyName: form.companyName,
          purpose: form.purpose,
          passTypeId,
          zoneIds,
          ...(mode === "SINGLE_ENTRY" ? { exitCodeZoneIds } : {}),
          entryMode: mode,
          expectedAt: new Date(from).toISOString(),
          validUntil: new Date(until).toISOString(),
        },
      });
      setForm({ visitorName: "", visitorMobile: "", visitorEmail: "", companyName: "", purpose: "" });
      setZoneIds([]);
      setCodeZones(null);
      onCreated(`Request sent. ${form.visitorName} will receive a link to complete their details.`);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "could not create the request");
    } finally {
      setBusy(false);
    }
  }

  const ready = form.visitorName.trim() && form.visitorMobile.trim() && form.purpose.trim() && passTypeId && zoneIds.length > 0;
  return (
    <div className="space-y-3">
      {problem && <Alert>{problem}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Visitor name"><Input value={form.visitorName} onChange={set("visitorName")} maxLength={100} /></Field>
        <Field label="Mobile" hint="The link and the verification code go here"><Input value={form.visitorMobile} onChange={set("visitorMobile")} inputMode="tel" maxLength={20} /></Field>
        <Field label="Email" hint="Optional — the link is emailed too"><Input type="email" value={form.visitorEmail} onChange={set("visitorEmail")} maxLength={200} /></Field>
        <Field label="Company" hint="Optional"><Input value={form.companyName} onChange={set("companyName")} maxLength={100} /></Field>
        <Field label="Visitor type">
          <Select value={passTypeId} onChange={(e) => setPassTypeId(e.target.value)}>
            <option value="">Select…</option>
            {options?.passTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Entry mode" hint={mode === "SINGLE_ENTRY" ? "One visit; the exit needs a code" : "Come and go until the pass ends"}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {modes.includes("SINGLE_ENTRY") && <option value="SINGLE_ENTRY">Single entry</option>}
            {modes.includes("MULTI_ENTRY") && <option value="MULTI_ENTRY">Multi entry</option>}
          </Select>
        </Field>
        <Field label="Visit time"><Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Valid until"><Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
      </div>
      <Field label="Zones" hint="A zone also opens the gates of every zone around it">
        <div className="flex flex-wrap gap-4">
          {options?.zones.map((z) => (
            <label key={z.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={zoneIds.includes(z.id)} onChange={() => { setCodeZones(null); setZoneIds((ids) => (ids.includes(z.id) ? ids.filter((x) => x !== z.id) : [...ids, z.id])); }} />
              {z.name}
            </label>
          ))}
        </div>
      </Field>
      {mode === "SINGLE_ENTRY" && covered.length > 0 && (
        <Field label="Exit code needed at">
          <div className="flex flex-wrap gap-4">
            {covered.map((z) => (
              <label key={z.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={exitCodeZoneIds.includes(z.id)} onChange={() => setCodeZones(exitCodeZoneIds.includes(z.id) ? exitCodeZoneIds.filter((x) => x !== z.id) : [...exitCodeZoneIds, z.id])} />
                {z.name} exit
              </label>
            ))}
          </div>
        </Field>
      )}
      <Field label="Purpose of visit"><Input value={form.purpose} onChange={set("purpose")} maxLength={300} /></Field>
      <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void create()}>Send request</Button>
    </div>
  );
}

export default function RequestsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const url = `/api/visit-requests?pageSize=100${status ? `&status=${status}` : ""}`;
  const { data, error } = useApi<Paged<VisitRequestRow>>(url);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Visit requests</h1>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {can("visit_requests:create") && (
        <Accordion title="New visit request">
          <NewRequestForm onCreated={(message) => { setNotice(message); void refresh("/api/visit-requests"); }} />
        </Accordion>
      )}
      <Card
        title="Requests"
        action={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </Select>
        }
      >
        {error && <Alert>{error.message}</Alert>}
        {data && data.items.length === 0 ? (
          <Empty>No visit requests.</Empty>
        ) : (
          <Table head={["Visitor", "Type", "Visit", "Host", "Status"]}>
            {data?.items.map((r) => (
              <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2">
                  <Link href={`/requests/${r.id}`} className="font-medium hover:underline">{r.visitorName}</Link>
                  <div className="text-xs text-[var(--text-muted)]">{r.visitorMobile}{r.companyName ? ` · ${r.companyName}` : ""}{r.returning ? " · returning" : ""}</div>
                </td>
                <td className="px-2 py-2">{r.passTypeName ?? "—"}<div className="text-xs text-[var(--text-muted)]">{r.entryMode === "SINGLE_ENTRY" ? "single entry" : "multi entry"}</div></td>
                <td className="px-2 py-2">{formatDateTime(r.expectedAt)}</td>
                <td className="px-2 py-2">{r.host.name ?? r.host.email}</td>
                <td className="px-2 py-2"><Badge tone={statusTone(r.status)}>{r.status.toLowerCase()}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

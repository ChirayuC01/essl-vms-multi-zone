"use client";

import { useMemo, useState } from "react";
import { api, ApiError, type VisitRequestOptions } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { Alert, Button, Field, Input, Select } from "@/components/ui";

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * The visit details a host enters for a planned visit, and Security enters
 * for a walk-in (which also names the host, and starts now).
 */
export function VisitRequestForm({ walkIn = false, onCreated }: { walkIn?: boolean; onCreated: (id: string, message: string) => void }) {
  const { data: options } = useApi<VisitRequestOptions>("/api/visit-requests/options");
  const [form, setForm] = useState({ visitorName: "", visitorMobile: "", visitorEmail: "", purpose: "" });
  const [companyId, setCompanyId] = useState("");
  const [passTypeId, setPassTypeId] = useState("");
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [codeZones, setCodeZones] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"SINGLE_ENTRY" | "MULTI_ENTRY">("SINGLE_ENTRY");
  const [hostId, setHostId] = useState("");
  const [from, setFrom] = useState(() => { if (walkIn) return localInput(new Date()); const d = new Date(Date.now() + 3_600_000); d.setMinutes(0, 0, 0); return localInput(d); });
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
      const created = await api<{ id: string }>(walkIn ? "/api/walk-ins" : "/api/visit-requests", {
        method: "POST",
        body: {
          ...(walkIn ? { hostId } : {}),
          visitorName: form.visitorName,
          visitorMobile: form.visitorMobile,
          visitorEmail: form.visitorEmail.trim() || null,
          companyId: companyId || null,
          purpose: form.purpose,
          passTypeId,
          zoneIds,
          ...(mode === "SINGLE_ENTRY" ? { exitCodeZoneIds } : {}),
          entryMode: mode,
          expectedAt: new Date(from).toISOString(),
          validUntil: new Date(until).toISOString(),
        },
      });
      setForm({ visitorName: "", visitorMobile: "", visitorEmail: "", purpose: "" });
      setCompanyId("");
      setZoneIds([]);
      setCodeZones(null);
      onCreated(created.id, walkIn ? `${form.visitorName} registered — continue with their details below.` : `Request sent. ${form.visitorName} will receive a link to complete their details.`);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "could not create the request");
    } finally {
      setBusy(false);
    }
  }

  const ready = form.visitorName.trim() && form.visitorMobile.trim() && form.purpose.trim() && passTypeId && zoneIds.length > 0 && (!walkIn || hostId);
  return (
    <div className="space-y-3">
      {problem && <Alert>{problem}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Visitor name"><Input value={form.visitorName} onChange={set("visitorName")} maxLength={100} /></Field>
        {walkIn && (
          <Field label="Host" hint="Who the visitor is meeting">
            <Select value={hostId} onChange={(e) => setHostId(e.target.value)}>
              <option value="">Select…</option>
              {options?.hosts.map((h) => <option key={h.id} value={h.id}>{h.name ?? h.email}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Mobile" hint={walkIn ? "The verification code goes here" : "The link and the verification code go here"}><Input value={form.visitorMobile} onChange={set("visitorMobile")} inputMode="tel" maxLength={20} /></Field>
        <Field label="Email" hint={walkIn ? "Optional" : "Optional — the link is emailed too"}><Input type="email" value={form.visitorEmail} onChange={set("visitorEmail")} maxLength={200} /></Field>
        <Field label="Company" hint="From the Directory. Not listed? Ask an Admin to add it, or choose at Clear.">
          <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">Not specified</option>
            {options?.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
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
      <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void create()}>{walkIn ? "Register walk-in" : "Send request"}</Button>
    </div>
  );
}

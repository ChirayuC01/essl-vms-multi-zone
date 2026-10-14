"use client";

import { useMemo, useState } from "react";
import { api, ApiError, type VisitRequestOptions } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { Alert, Button, Field, Input, SearchSelect, Select } from "@/components/ui";
import { addToDirectory } from "@/components/profile-fields";
import { useAuth } from "@/lib/auth";
import { localInput, ValidUntilField } from "@/components/valid-until-field";
import { ZonePicker } from "@/components/zone-picker";
import { endOfIstDay } from "@/lib/format";

/**
 * The visit details a host enters for a planned visit, and Security enters
 * for a walk-in (which also names the host, and starts now).
 */
export function VisitRequestForm({ walkIn = false, onCreated }: { walkIn?: boolean; onCreated: (id: string, message: string) => void }) {
  const { data: options } = useApi<VisitRequestOptions>("/api/visit-requests/options");
  const { can } = useAuth();
  const [form, setForm] = useState({ visitorName: "", visitorMobile: "", visitorEmail: "", purpose: "" });
  const [companyId, setCompanyId] = useState("");
  const [passTypeId, setPassTypeId] = useState("");
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [mode, setMode] = useState<"SINGLE_ENTRY" | "MULTI_ENTRY">("SINGLE_ENTRY");
  const [hostId, setHostId] = useState("");
  const [from, setFrom] = useState(() => { if (walkIn) return localInput(new Date()); const d = new Date(Date.now() + 3_600_000); d.setMinutes(0, 0, 0); return localInput(d); });
  const [until, setUntil] = useState(() => localInput(endOfIstDay(new Date())));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const passType = options?.passTypes.find((t) => t.id === passTypeId);
  const modes = passType?.entryModes ?? ["SINGLE_ENTRY", "MULTI_ENTRY"];
  // The chosen type may not allow the default mode.
  const entryMode = modes.includes(mode) ? mode : modes[0]!;
  const covered = useMemo(() => {
    const byId = new Map((options?.zones ?? []).map((z) => [z.id, z]));
    const out = new Map<string, { id: string; name: string }>();
    for (const id of zoneIds) for (let z = byId.get(id); z && !out.has(z.id); z = z.parentZoneId ? byId.get(z.parentZoneId) : undefined) out.set(z.id, z);
    return [...out.values()];
  }, [zoneIds, options]);
  // F1: the pass type decides; shown here, never chosen per request.
  const codeExits = passType?.exitCodeRequired ? covered.filter((z) => passType.exitCodeZoneIds.includes(z.id)) : [];
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
          entryMode,
          expectedAt: new Date(from).toISOString(),
          validUntil: new Date(until).toISOString(),
        },
      });
      setForm({ visitorName: "", visitorMobile: "", visitorEmail: "", purpose: "" });
      setCompanyId("");
      setZoneIds([]);
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
            <SearchSelect value={hostId} onChange={setHostId} options={(options?.hosts ?? []).map((h) => ({ value: h.id, label: h.name ?? h.email }))} placeholder="Type a name…" />
          </Field>
        )}
        <Field label="Mobile" hint={walkIn ? "The verification code goes here" : "The link and the verification code go here"}><Input value={form.visitorMobile} onChange={set("visitorMobile")} inputMode="tel" maxLength={20} /></Field>
        <Field label="Email" hint={walkIn ? "Optional" : "Optional — the link is emailed too"}><Input type="email" value={form.visitorEmail} onChange={set("visitorEmail")} maxLength={200} /></Field>
        <Field label="Company" hint={can("directory:create") ? "From the Directory; type a new name to add it." : "From the Directory. Not listed? Ask an Admin to add it, or choose at Clear."}>
          <SearchSelect
            value={companyId}
            onChange={setCompanyId}
            options={(options?.companies ?? []).map((c) => ({ value: c.id, label: c.name }))}
            emptyLabel="Not specified"
            onAdd={can("directory:create") ? (name) => addToDirectory("companies", name) : undefined}
          />
        </Field>
        <Field label="Pass type">
          <SearchSelect value={passTypeId} onChange={setPassTypeId} options={(options?.passTypes ?? []).map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
        <Field label="Entry mode" hint={entryMode === "SINGLE_ENTRY" ? "One visit" : "Come and go until the pass ends"}>
          <Select value={entryMode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {modes.includes("SINGLE_ENTRY") && <option value="SINGLE_ENTRY">Single entry</option>}
            {modes.includes("MULTI_ENTRY") && <option value="MULTI_ENTRY">Multi entry</option>}
          </Select>
        </Field>
        <Field label="Visit time"><Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <ValidUntilField from={from} until={until} onChange={setUntil} singleEntry={entryMode === "SINGLE_ENTRY"} maxDays={passType?.maxValidityDays} />
      </div>
      <Field label="Zones" hint="A zone also opens the gates of every zone around it">
        <ZonePicker zones={options?.zones ?? []} value={zoneIds} onChange={setZoneIds} />
      </Field>
      {entryMode === "SINGLE_ENTRY" && passType && covered.length > 0 && (
        <Field label="Exit code" hint="Set by the pass type">
          <p className="mt-2 text-sm">{codeExits.length ? `Needed at: ${codeExits.map((z) => `${z.name} exit`).join(", ")}` : "Not needed — the exits load with the pass"}</p>
        </Field>
      )}
      <Field label="Purpose of visit"><Input value={form.purpose} onChange={set("purpose")} maxLength={300} /></Field>
      <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void create()}>{walkIn ? "Register walk-in" : "Send request"}</Button>
    </div>
  );
}

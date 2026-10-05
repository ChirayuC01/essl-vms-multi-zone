"use client";

import { useMemo, useState } from "react";
import { api, ApiError, type DeviceList, type OperatorOptionList, type PassTypeList, type PersonDetail, type ZoneList } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { Alert, Button, Field, Input, Select } from "@/components/ui";

// Issue a pass. On a site with zones the operator picks zones (a zone also
// opens the gates of every zone around it) and, for single entry, which
// exits need the exit code. A site without zones yet falls back to every
// registered terminal, as before.

const pad = (n: number) => String(n).padStart(2, "0");
/** A datetime-local value for a Date, in the browser's local time. */
function localInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function endOfDay(d: Date, plusDays = 0): Date {
  const e = new Date(d);
  e.setDate(e.getDate() + plusDays);
  e.setHours(23, 59, 0, 0);
  return e;
}

export function IssuePassForm({ person, onIssued }: { person: PersonDetail; onIssued: (message: string) => void }) {
  const { data: zoneList } = useApi<ZoneList>("/api/zones");
  const { data: deviceList } = useApi<DeviceList>("/api/devices");
  const { data: passTypes } = useApi<PassTypeList>("/api/pass-types");
  const { data: operators } = useApi<OperatorOptionList>("/api/operators/active");

  const zones = (zoneList?.items ?? []).filter((z) => z.isActive && z.gates.IN + z.gates.BOTH > 0);
  const useZones = zones.length > 0;
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [codeZones, setCodeZones] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"MULTI_ENTRY" | "SINGLE_ENTRY">("MULTI_ENTRY");
  const [passTypeId, setPassTypeId] = useState(person.passTypeId ?? "");
  const [from, setFrom] = useState(() => localInput(new Date()));
  const [until, setUntil] = useState(() => localInput(endOfDay(new Date())));
  const [purpose, setPurpose] = useState("");
  const [personToMeetId, setPersonToMeetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Zones the pass covers (picked + their ancestors): the candidates for an exit code.
  const covered = useMemo(() => {
    const byId = new Map((zoneList?.items ?? []).map((z) => [z.id, z]));
    const out = new Set<string>();
    for (const id of zoneIds) for (let z = byId.get(id); z && !out.has(z.id); z = z.parentZoneId ? byId.get(z.parentZoneId) : undefined) out.add(z.id);
    return [...out].map((id) => byId.get(id)!).filter(Boolean);
  }, [zoneIds, zoneList]);
  const exitCodeZoneIds = codeZones ?? covered.filter((z) => z.exitCodeDefault).map((z) => z.id);
  const passType = passTypes?.items.find((t) => t.id === passTypeId);
  const modes = passType?.entryModes ?? ["MULTI_ENTRY", "SINGLE_ENTRY"];

  const preset = (days: number) => setUntil(localInput(endOfDay(new Date(from), days)));

  async function issue() {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/people/${person.id}/provision`, {
        method: "POST",
        body: {
          ...(useZones ? { zoneIds } : { deviceIds: (deviceList?.items ?? []).map((d) => d.id) }),
          ...(useZones && mode === "SINGLE_ENTRY" ? { exitCodeZoneIds } : {}),
          ...(passTypeId ? { passTypeId } : {}),
          entryMode: mode,
          retentionPolicy: "CUSTOM",
          expectedInAt: new Date(from).toISOString(),
          validUntil: new Date(until).toISOString(),
          purposeOfVisit: purpose.trim(),
          ...(personToMeetId ? { personToMeetId } : {}),
        },
      });
      setPurpose("");
      onIssued(`Pass issued for ${person.name}. Faces load on the terminals shortly before the visit time.`);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "could not issue the pass");
    } finally {
      setBusy(false);
    }
  }

  const ready = purpose.trim() !== "" && (!useZones || zoneIds.length > 0) && person.isActive && !person.blacklistedAt;
  return (
    <div className="space-y-3">
      {problem && <Alert>{problem}</Alert>}
      {person.blacklistedAt && <Alert>Blacklisted{person.blacklistReason ? `: ${person.blacklistReason}` : ""}. No pass can be issued until it is lifted.</Alert>}
      {useZones ? (
        <Field label="Zones" hint="A zone also opens the gates of every zone around it">
          <div className="flex flex-wrap gap-4">
            {zones.map((z) => (
              <label key={z.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={zoneIds.includes(z.id)} onChange={() => { setCodeZones(null); setZoneIds((ids) => (ids.includes(z.id) ? ids.filter((x) => x !== z.id) : [...ids, z.id])); }} />
                {z.name}
              </label>
            ))}
          </div>
        </Field>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">No zones are set up, so the pass loads onto every registered terminal.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {(passTypes?.items.length ?? 0) > 0 && (
          <Field label="Pass type">
            <Select value={passTypeId} onChange={(e) => setPassTypeId(e.target.value)}>
              <option value="">General</option>
              {passTypes?.items.filter((t) => t.isActive || t.id === passTypeId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Entry mode" hint={mode === "SINGLE_ENTRY" ? "One visit today; faces leave each terminal 10 min after use" : "Come and go freely until the pass ends"}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {modes.includes("MULTI_ENTRY") && <option value="MULTI_ENTRY">Multi entry</option>}
            {modes.includes("SINGLE_ENTRY") && <option value="SINGLE_ENTRY">Single entry</option>}
          </Select>
        </Field>
        <Field label="Visit time" hint="Faces load a few minutes before this">
          <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Valid until">
          <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          <div className="mt-1 flex flex-wrap gap-2 text-xs">
            <button type="button" className="underline" onClick={() => preset(0)}>today</button>
            {mode === "MULTI_ENTRY" && (
              <>
                <button type="button" className="underline" onClick={() => preset(6)}>1 week</button>
                <button type="button" className="underline" onClick={() => preset(29)}>1 month</button>
                <button type="button" className="underline" onClick={() => preset(89)}>3 months</button>
              </>
            )}
          </div>
        </Field>
      </div>
      {useZones && mode === "SINGLE_ENTRY" && covered.length > 0 && (
        <Field label="Exit code needed at" hint="Ticked exits load only after the exit code (or a Security override)">
          <div className="flex flex-wrap gap-4">
            {covered.map((z) => (
              <label key={z.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={exitCodeZoneIds.includes(z.id)}
                  onChange={() => setCodeZones(exitCodeZoneIds.includes(z.id) ? exitCodeZoneIds.filter((x) => x !== z.id) : [...exitCodeZoneIds, z.id])}
                />
                {z.name} exit
              </label>
            ))}
          </div>
        </Field>
      )}
      <Field label="Person to meet" hint="Optional">
        <Select value={personToMeetId} onChange={(e) => setPersonToMeetId(e.target.value)}>
          <option value="">Not specified</option>
          {operators?.items.map((o) => <option key={o.id} value={o.id}>{o.name ?? o.email}</option>)}
        </Select>
      </Field>
      <Field label="Purpose of visit" hint="Recorded permanently against this pass">
        <Input required maxLength={200} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Lift maintenance, Block C" />
      </Field>
      <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void issue()}>Issue pass</Button>
    </div>
  );
}

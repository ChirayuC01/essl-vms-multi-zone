"use client";

import { useMemo, useState } from "react";
import { api, ApiError, type DeviceList, type OperatorOptionList, type PassTypeList, type PersonDetail, type ZoneList } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { Alert, Button, Field, Input, SearchSelect, Select } from "@/components/ui";
import { localInput, ValidUntilField } from "@/components/valid-until-field";
import { ZonePicker } from "@/components/zone-picker";
import { endOfIstDay } from "@/lib/format";

// Issue a pass. On a site with zones the operator picks zones (a zone also
// opens the gates of every zone around it). The pass takes the person's own
// pass type (F2 #13): their details were checked against it, and it decides
// entry modes, how long the pass may run and the exit code. A site without
// zones yet falls back to every registered terminal, as before.

export function IssuePassForm({ person, onIssued }: { person: PersonDetail; onIssued: (message: string) => void }) {
  const { data: zoneList } = useApi<ZoneList>("/api/zones");
  const { data: deviceList } = useApi<DeviceList>("/api/devices");
  const { data: passTypes } = useApi<PassTypeList>("/api/pass-types");
  const { data: operators } = useApi<OperatorOptionList>("/api/operators/active");

  const zones = (zoneList?.items ?? []).filter((z) => z.isActive && z.gates.IN + z.gates.BOTH > 0);
  const useZones = zones.length > 0;
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [mode, setMode] = useState<"MULTI_ENTRY" | "SINGLE_ENTRY">("MULTI_ENTRY");
  const [from, setFrom] = useState(() => localInput(new Date()));
  const [until, setUntil] = useState(() => localInput(endOfIstDay(new Date())));
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
  const passType = passTypes?.items.find((t) => t.id === person.passTypeId);
  // F2 #10: the pass type names the code-gated zones; no type, no code.
  const codeExits = passType?.exitCodeRequired ? covered.filter((z) => passType.exitCodeZoneIds.includes(z.id)) : [];
  const modes = passType?.entryModes ?? ["MULTI_ENTRY", "SINGLE_ENTRY"];
  // The person's type may not allow the default mode.
  const entryMode = modes.includes(mode) ? mode : modes[0]!;

  async function issue() {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/people/${person.id}/provision`, {
        method: "POST",
        body: {
          ...(useZones ? { zoneIds } : { deviceIds: (deviceList?.items ?? []).map((d) => d.id) }),
          entryMode,
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
          <ZonePicker zones={zones} value={zoneIds} onChange={setZoneIds} />
        </Field>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">No zones are set up, so the pass loads onto every registered terminal.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {(passTypes?.items.length ?? 0) > 0 && (
          <Field label="Pass type" hint="The person's own; edit the person to change it">
            <p className="mt-2 text-sm">
              {passType ? passType.name : "General"}
              {passType?.maxValidityDays ? <span className="text-[var(--text-muted)]"> · at most {passType.maxValidityDays} day(s)</span> : null}
            </p>
          </Field>
        )}
        <Field label="Entry mode" hint={entryMode === "SINGLE_ENTRY" ? "One visit today; faces leave each terminal 10 min after use" : "Come and go freely until the pass ends"}>
          <Select value={entryMode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {modes.includes("MULTI_ENTRY") && <option value="MULTI_ENTRY">Multi entry</option>}
            {modes.includes("SINGLE_ENTRY") && <option value="SINGLE_ENTRY">Single entry</option>}
          </Select>
        </Field>
        <Field label="Visit time" hint="Faces load a few minutes before this">
          <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <ValidUntilField from={from} until={until} onChange={setUntil} singleEntry={entryMode === "SINGLE_ENTRY"} maxDays={passType?.maxValidityDays} />
      </div>
      {useZones && entryMode === "SINGLE_ENTRY" && covered.length > 0 && (
        <Field label="Exit code" hint="Set by the pass type">
          <p className="mt-2 text-sm">{codeExits.length ? `Needed at: ${codeExits.map((z) => `${z.name} exit`).join(", ")}` : "Not needed — the exits load with the pass"}</p>
        </Field>
      )}
      <Field label="Person to meet" hint="Optional">
        <SearchSelect value={personToMeetId} onChange={setPersonToMeetId} options={(operators?.items ?? []).map((o) => ({ value: o.id, label: o.name ?? o.email }))} emptyLabel="Not specified" />
      </Field>
      <Field label="Purpose of visit" hint="Recorded permanently against this pass">
        <Input required maxLength={200} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Lift maintenance, Block C" />
      </Field>
      <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void issue()}>Issue pass</Button>
    </div>
  );
}

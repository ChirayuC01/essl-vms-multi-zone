"use client";

import { useState } from "react";
import { api, type DeviceList, type ZoneList } from "@/lib/api";
import { ZonesCard } from "@/components/zones-card";
import { useAuth } from "@/lib/auth";
import { useApi, refresh } from "@/lib/swr";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Stat } from "@/components/ui";

// Device status. Every identifying field shown here — capacity, firmware,
// algorithm — comes from the device's own INFO response, never from a spec
// sheet or a label. Three printed claims have already proven wrong.

type ScanPlan =
  | { kind: "RANGE"; prefix: string; from: number; to: number; pad: number }
  | { kind: "LIST"; ids: string[] };

interface ScanState {
  deviceId: string;
  plan: ScanPlan;
  cursor: number;
  queried: number;
  skipped: number;
  startedAt: string;
}

function planSize(plan: ScanPlan): number {
  return plan.kind === "LIST" ? plan.ids.length : plan.to - plan.from + 1;
}

function describePlan(plan: ScanPlan): string {
  if (plan.kind === "LIST") return `${plan.ids.length} IDs from a list`;
  const pad = (n: number) => `${plan.prefix}${String(n).padStart(plan.pad, "0")}`;
  return `${pad(plan.from)}–${pad(plan.to)}`;
}

/** What the operator is typing into the scan card, before it becomes a plan. */
interface ScanDraft {
  mode: "RANGE" | "LIST";
  prefix: string;
  start: string;
  end: string;
  pad: string;
  ids: string;
  rejected: string[];
}

const EMPTY_DRAFT: ScanDraft = {
  mode: "RANGE",
  prefix: "",
  start: "",
  end: "",
  pad: "",
  ids: "",
  rejected: [],
};

export default function DevicesPage() {
  // Liveness and face counts change with no event of their own, so this view
  // polls. Everything else in the console is event-driven.
  const { data, error } = useApi<DeviceList>("/api/devices", { refreshInterval: 10_000 });
  const { can } = useAuth();
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [registering, setRegistering] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [reconciling, setReconciling] = useState(false);
  const [resettingBaseline, setResettingBaseline] = useState<string | null>(null);
  const [punchPeriodDrafts, setPunchPeriodDrafts] = useState<Record<string, string>>({});
  const [savingPunchPeriod, setSavingPunchPeriod] = useState<string | null>(null);
  const [patternDrafts, setPatternDrafts] = useState<Record<string, string>>({});
  const [savingPatterns, setSavingPatterns] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [savingZone, setSavingZone] = useState<string | null>(null);
  const { data: zones } = useApi<ZoneList>("/api/zones");
  const [timezoneDrafts, setTimezoneDrafts] = useState<Record<string, string>>({});
  const [savingTimezone, setSavingTimezone] = useState<string | null>(null);
  const [scanDrafts, setScanDrafts] = useState<Record<string, ScanDraft>>({});
  const [scanBusy, setScanBusy] = useState<string | null>(null);
  const [parsingFile, setParsingFile] = useState<string | null>(null);
  const draftFor = (id: string) => scanDrafts[id] ?? EMPTY_DRAFT;
  const setDraft = (id: string, patch: Partial<ScanDraft>) =>
    setScanDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_DRAFT), ...patch } }));

  // Only meaningful while a backfill is running, which is a one-off at
  // install time on a device that predates the VMS. Polled rather than
  // event-driven because progress advances on a one-minute job tick.
  const { data: scans } = useApi<{ items: ScanState[] }>("/api/devices/scans", {
    refreshInterval: 10_000,
  });
  const scanFor = (id: string) => scans?.items.find((s) => s.deviceId === id);

  async function refreshFromDevice(id: string) {
    setActionError(null);
    setNotice(null);
    setRefreshing(id);
    try {
      await api(`/api/devices/${id}/refresh`, { method: "POST" });
      setNotice(
        "INFO queued. Capacity, face count and firmware update when the device answers — usually within a few seconds.",
      );
      await refresh("/api/devices");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "refresh failed");
    } finally {
      setRefreshing(null);
    }
  }

  // Global roster check, not per-device — POST /api/devices/reconcile sweeps a
  // slice across every device. Surfaced here as a button rather than left as
  // "run this API call yourself", which is meaningless to a non-technical
  // operator at a client site.
  async function reconcileNow() {
    setActionError(null);
    setNotice(null);
    setReconciling(true);
    try {
      const result = await api<{ queried: number; devices: number }>("/api/devices/reconcile", {
        method: "POST",
      });
      setNotice(
        result.queried > 0
          ? `Reconciliation queued ${result.queried} roster check(s). Results land within a few seconds as devices answer.`
          : "Nothing new to check right now — every known person was checked recently.",
      );
      await refresh("/api/devices");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "reconcile failed");
    } finally {
      setReconciling(false);
    }
  }

  async function resetBaseline(id: string) {
    setActionError(null);
    setNotice(null);
    setResettingBaseline(id);
    try {
      await api(`/api/devices/${id}/punch-baseline`, { method: "POST" });
      setNotice("Punch baseline reset. Missing-punch detection now compares from this point forward.");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "reset failed");
    } finally {
      setResettingBaseline(null);
    }
  }

  async function savePunchPeriod(id: string) {
    const raw = punchPeriodDrafts[id];
    const minutes = raw === "" || raw === undefined ? null : Number(raw);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0)) {
      setActionError("duplicate punch period must be a whole number of minutes, 0 or more");
      return;
    }
    setActionError(null);
    setNotice(null);
    setSavingPunchPeriod(id);
    try {
      await api(`/api/devices/${id}`, { method: "PATCH", body: { duplicatePunchPeriodMinutes: minutes } });
      setNotice("Duplicate punch period saved.");
      await refresh("/api/devices");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSavingPunchPeriod(null);
    }
  }

  async function savePatterns(id: string, category: "employee" | "visitor") {
    const raw = patternDrafts[`${id}:${category}`] ?? "";
    const patterns = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (patterns.some((p) => !/^[A-Za-z0-9*]+$/.test(p))) {
      setActionError("patterns may contain letters, digits and * only — e.g. WCTPL*, YE*");
      return;
    }
    setActionError(null);
    setNotice(null);
    setSavingPatterns(id);
    try {
      await api(`/api/devices/${id}`, { method: "PATCH", body: { [`${category}IdPatterns`]: patterns } });
      setNotice(
        patterns.length === 0
          ? `Cleared — automatic ${category} classification is disabled.`
          : `Saved ${category} patterns: ${patterns.join(", ")}.`,
      );
      await refresh("/api/devices");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSavingPatterns(null);
    }
  }

  // A dedicated IN or OUT terminal is a physical fact about where the barrier
  // stands -- the direction resolver trusts this over anything a punch record
  // says (see resolveDirection). Getting it wrong on a two-gate site means
  // every entry is read backwards, so this needs to be a deliberate,
  // reviewable change, not a raw API call.
  async function saveRole(id: string, role: string) {
    setActionError(null);
    setNotice(null);
    setSavingRole(id);
    try {
      await api(`/api/devices/${id}`, { method: "PATCH", body: { role } });
      setNotice("Gate role saved. Direction resolution for this terminal's punches applies immediately.");
      await refresh("/api/devices");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSavingRole(null);
    }
  }

  // Which zone's gate this terminal is. Zone-based access only ever selects
  // placed terminals, so an unplaced one is invisible to zone grants.
  async function saveZone(id: string, zoneId: string) {
    setActionError(null);
    setNotice(null);
    setSavingZone(id);
    try {
      await api(`/api/devices/${id}`, { method: "PATCH", body: { zoneId: zoneId || null } });
      setNotice("Zone saved. Zone-based access granted from now on includes this terminal.");
      await Promise.all([refresh("/api/devices"), refresh("/api/zones")]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSavingZone(null);
    }
  }

  async function saveTimezone(id: string, current: number) {
    const offset = Number(timezoneDrafts[id] ?? current);
    if (!Number.isInteger(offset) || offset < -720 || offset > 840) {
      setActionError("timezone offset must be whole minutes between -720 and 840; IST is 330");
      return;
    }
    setActionError(null);
    setNotice(null);
    setSavingTimezone(id);
    try {
      await api(`/api/devices/${id}`, {
        method: "PATCH",
        body: { timezoneOffsetMinutes: offset },
      });
      setNotice("Device timezone saved. New punches will be normalized using this offset.");
      await refresh("/api/devices");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSavingTimezone(null);
    }
  }

  // Finding people already enrolled on a terminal before the VMS existed.
  // Nothing else can: this firmware has no command to list its users, so the
  // only way to find someone is to ask about their ID. IDs are text, and text
  // cannot be brute-forced — six characters of [0-9A-Z] is two billion
  // combinations — so a scan needs either the STRUCTURE of the site's IDs
  // (a prefix and a counter: WCTPL001..WCTPL999) or an explicit LIST.
  async function startScan(id: string) {
    const draft = draftFor(id);
    let body: Record<string, unknown>;
    if (draft.mode === "LIST") {
      const ids = draft.ids
        .split(/[\s,;]+/)
        .map((v) => v.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        setActionError("paste some IDs, or upload a file, before starting the scan");
        return;
      }
      body = { ids };
    } else {
      const startPin = Number(draft.start);
      const endPin = Number(draft.end);
      if (!Number.isInteger(startPin) || !Number.isInteger(endPin) || startPin < 1 || endPin < startPin) {
        setActionError("give a number range to scan, lowest first — whole numbers, starting at 1 or above");
        return;
      }
      body = {
        startPin,
        endPin,
        ...(draft.prefix.trim() ? { prefix: draft.prefix.trim() } : {}),
        ...(draft.pad.trim() ? { pad: Number(draft.pad.trim()) } : {}),
      };
    }
    setActionError(null);
    setNotice(null);
    setScanBusy(id);
    try {
      await api(`/api/devices/${id}/scan`, { method: "POST", body });
      setNotice(
        "Scan started. It runs in the background at about 50 PINs a minute and never delays a provision. " +
          "Anyone it finds with a face appears under unclaimed enrollments, ready to register.",
      );
      await refresh("/api/devices/scans");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "could not start the scan");
    } finally {
      setScanBusy(null);
    }
  }

  // Read the IDs out of a file the site already has - an export from whatever
  // software ran this terminal before. Parsed and shown BEFORE anything is
  // queued: a scan commits the device's command queue for a long time, and
  // "it found nobody" is a miserable way to learn the file was wrong.
  async function parseIdFile(id: string, file: File) {
    setActionError(null);
    setNotice(null);
    setParsingFile(id);
    try {
      const result = await api<{ ids: string[]; rejected: string[]; read: number }>(
        `/api/devices/scan/parse-ids?filename=${encodeURIComponent(file.name)}`,
        { method: "POST", blob: { data: file, contentType: "application/octet-stream" } },
      );
      setDraft(id, {
        mode: "LIST",
        ids: result.ids.join("\n"),
        rejected: result.rejected,
      });
      setNotice(
        `Read ${result.ids.length} usable ID${result.ids.length === 1 ? "" : "s"} from ${file.name}` +
          (result.rejected.length > 0
            ? ` — ${result.rejected.length} row${result.rejected.length === 1 ? "" : "s"} ignored.`
            : ". Check them below, then start the scan."),
      );
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "could not read that file");
    } finally {
      setParsingFile(null);
    }
  }

  async function stopScan(id: string) {
    setActionError(null);
    setNotice(null);
    setScanBusy(id);
    try {
      await api(`/api/devices/${id}/scan`, { method: "DELETE" });
      setNotice("Scan stopped. Questions already sent to the device will still be answered.");
      await refresh("/api/devices/scans");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "could not stop the scan");
    } finally {
      setScanBusy(null);
    }
  }

  async function registerDevice(serialNo: string) {
    setActionError(null);
    setNotice(null);
    setRegistering(serialNo);
    try {
      const name = names[serialNo]?.trim();
      await api("/api/devices", { method: "POST", body: { serialNo, ...(name ? { name } : {}) } });
      setNotice(`${serialNo} registered. Access groups default to 1 / 100 — adjust below if this device differs.`);
      await refresh("/api/devices");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "registration failed");
    } finally {
      setRegistering(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert>{error instanceof Error ? error.message : "failed to load devices"}</Alert>}
      {actionError && <Alert>{actionError}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}

      {!data ? (
        <Empty>Loading…</Empty>
      ) : (
        <>
          {data.items.length > 0 && can("maintenance:run") && (
            <div className="flex items-center justify-between">
              <h1 className="text-lg font-semibold">Devices</h1>
              <Button loading={reconciling} onClick={reconcileNow}>
                Reconcile now
              </Button>
            </div>
          )}

          <ZonesCard />

          {data.items.length === 0 && (
            <Card title="Devices">
              <Empty>No device registered.</Empty>
            </Card>
          )}

          {data.items.map((device) => (
            <Card
              key={device.id}
              title={
                <span className="flex items-center gap-2">
                  {device.name ?? device.serialNo}
                  <Badge tone={device.online ? "ok" : "danger"}>
                    {device.online ? "online" : "offline"}
                  </Badge>
                </span>
              }
              action={
                <Button
                  loading={refreshing === device.id}
                  onClick={() => refreshFromDevice(device.id)}
                >
                  Refresh from device
                </Button>
              }
            >
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                <Stat
                  label="Serial"
                  value={<span className="font-mono text-sm">{device.serialNo}</span>}
                />
                <Stat label="IP" value={device.ip ?? "—"} />
                {can("device:configure") ? (
                  <Stat
                    label="Role"
                    value={
                      <Select
                        className="mt-1 py-1 text-sm"
                        value={device.role}
                        disabled={savingRole === device.id}
                        onChange={(e) => saveRole(device.id, e.target.value)}
                      >
                        <option value="BOTH">Both (single gate)</option>
                        <option value="IN">In only</option>
                        <option value="OUT">Out only</option>
                      </Select>
                    }
                    sub="a two-gate site sets one device In, the other Out"
                  />
                ) : (
                  <Stat label="Role" value={device.role} />
                )}
                {can("device:configure") ? (
                  <Stat
                    label="Zone"
                    value={
                      <Select
                        className="mt-1 py-1 text-sm"
                        value={device.zoneId ?? ""}
                        disabled={savingZone === device.id}
                        onChange={(e) => saveZone(device.id, e.target.value)}
                      >
                        <option value="">Not placed</option>
                        {zones?.items.filter((z) => z.isActive || z.id === device.zoneId).map((z) => (
                          <option key={z.id} value={z.id}>{z.name}</option>
                        ))}
                      </Select>
                    }
                    sub="the zone whose gate this terminal is"
                  />
                ) : (
                  <Stat label="Zone" value={zones?.items.find((z) => z.id === device.zoneId)?.name ?? "Not placed"} />
                )}
                {can("device:configure") ? (
                  <Stat
                    label="Timezone"
                    value={
                      <div className="mt-1 flex items-center gap-2">
                        <Input
                          className="w-24 py-1 text-sm"
                          type="number"
                          min={-720}
                          max={840}
                          value={timezoneDrafts[device.id] ?? String(device.timezoneOffsetMinutes)}
                          onChange={(e) =>
                            setTimezoneDrafts((prev) => ({ ...prev, [device.id]: e.target.value }))
                          }
                        />
                        <Button
                          loading={savingTimezone === device.id}
                          onClick={() => saveTimezone(device.id, device.timezoneOffsetMinutes)}
                        >
                          Save
                        </Button>
                      </div>
                    }
                    sub={`${formatOffset(device.timezoneOffsetMinutes)} · IST is +330 minutes`}
                  />
                ) : (
                  <Stat
                    label="Timezone"
                    value={formatOffset(device.timezoneOffsetMinutes)}
                    sub="punches normalised on ingest"
                  />
                )}
                <Stat
                  label="Face capacity"
                  value={`${device.facesUsed}${device.maxFaces ? ` / ${device.maxFaces}` : ""}`}
                  sub={device.maxFaces ? `${device.maxFaces - device.facesUsed} free` : "unknown"}
                />
                <Stat label="Firmware" value={device.firmwareVersion ?? "—"} />
                <Stat label="Face algorithm" value={device.algorithmVersion ?? "—"} />
                <Stat
                  label="Last seen"
                  value={formatRelative(device.lastSeenAt)}
                  sub={formatDateTime(device.lastSeenAt)}
                />
                <Stat
                  label="Access groups"
                  value={`${device.normalGroupId} / ${device.blockedGroupId}`}
                  sub="normal / blocked"
                />
              </div>

              <div className="mt-4 flex flex-wrap gap-1">
                <Badge>{device.queue.pending} pending</Badge>
                <Badge tone="info">{device.queue.sent} in flight</Badge>
                <Badge tone="warn">{device.queue.retry} retry</Badge>
                <Badge tone={device.queue.failed > 0 ? "danger" : "neutral"}>
                  {device.queue.failed} failed
                </Badge>
              </div>

              {device.duplicatePunchWarning && (
                <div className="mt-4">
                  <Alert tone="warn">{device.duplicatePunchWarning}</Alert>
                </div>
              )}

              {(can("device:configure") || can("maintenance:run")) && (
                <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-[var(--border)] pt-4">
                  {can("device:configure") && (
                    <>
                      <Field
                        label="Duplicate punch period (minutes)"
                        hint="What Menu > System > Attendance > Duplicate Punch Period(m) is actually set to on the terminal"
                      >
                        <Input
                          type="number"
                          min={0}
                          max={1440}
                          className="w-40"
                          placeholder={device.duplicatePunchPeriodMinutes?.toString() ?? "not recorded"}
                          value={punchPeriodDrafts[device.id] ?? ""}
                          onChange={(e) =>
                            setPunchPeriodDrafts((prev) => ({ ...prev, [device.id]: e.target.value }))
                          }
                        />
                      </Field>
                      <Button
                        loading={savingPunchPeriod === device.id}
                        onClick={() => savePunchPeriod(device.id)}
                      >
                        Save
                      </Button>
                      <Field label="Employee ID patterns" hint="Comma-separated globs; * matches anything. Empty disables automatic Employee classification.">
                        <Input
                          className="w-64"
                          placeholder={
                            device.employeeIdPatterns.length > 0
                              ? device.employeeIdPatterns.join(", ")
                              : "e.g. EMP*, WCTPL*"
                          }
                          value={patternDrafts[`${device.id}:employee`] ?? ""}
                          onChange={(e) =>
                            setPatternDrafts((prev) => ({ ...prev, [`${device.id}:employee`]: e.target.value }))
                          }
                        />
                      </Field>
                      <Button
                        loading={savingPatterns === device.id}
                        onClick={() => savePatterns(device.id, "employee")}
                      >
                        Save employee patterns
                      </Button>
                      <Field label="Visitor ID patterns" hint="Must not overlap Employee patterns. Unmatched IDs remain untouched for review.">
                        <Input className="w-64" placeholder={device.visitorIdPatterns.length > 0 ? device.visitorIdPatterns.join(", ") : "e.g. VIS*, 9*"} value={patternDrafts[`${device.id}:visitor`] ?? ""} onChange={(e) => setPatternDrafts((prev) => ({ ...prev, [`${device.id}:visitor`]: e.target.value }))} />
                      </Field>
                      <Button loading={savingPatterns === device.id} onClick={() => savePatterns(device.id, "visitor")}>Save visitor patterns</Button>
                    </>
                  )}
                  {can("maintenance:run") && (
                    <Button
                      loading={resettingBaseline === device.id}
                      onClick={() => resetBaseline(device.id)}
                    >
                      Reset baseline
                    </Button>
                  )}
                </div>
              )}

              {can("maintenance:run") &&
                (() => {
                  const scan = scanFor(device.id);
                  if (scan) {
                    const total = planSize(scan.plan);
                    const done = Math.min(scan.cursor, total);
                    return (
                      <div className="mt-4 border-t border-[var(--border)] pt-4">
                        <div className="flex flex-wrap items-center gap-3 text-sm">
                          <Badge tone="info">scanning</Badge>
                          <span>
                            {describePlan(scan.plan)} · {done} of {total} checked (
                            {Math.floor((done / total) * 100)}%) · {scan.queried} asked,{" "}
                            {scan.skipped} already known
                          </span>
                          <Button
                            loading={scanBusy === device.id}
                            onClick={() => stopScan(device.id)}
                          >
                            Stop scan
                          </Button>
                        </div>
                      </div>
                    );
                  }
                  const draft = draftFor(device.id);
                  return (
                    <div className="mt-4 border-t border-[var(--border)] pt-4">
                      <p className="mb-3 text-sm text-[var(--text-muted)]">
                        Was this terminal already in use before the VMS was installed? People
                        enrolled on it are invisible until they are found — the device cannot list
                        its own users, so each ID has to be asked about individually. Anyone found
                        with a face photo appears under unclaimed enrollments, ready to register.
                        Runs in the background at about 50 IDs a minute and never delays live work.
                      </p>

                      <div className="mb-3 flex flex-wrap gap-2">
                        <Button
                          variant={draft.mode === "RANGE" ? "primary" : undefined}
                          onClick={() => setDraft(device.id, { mode: "RANGE" })}
                        >
                          A numbered range
                        </Button>
                        <Button
                          variant={draft.mode === "LIST" ? "primary" : undefined}
                          onClick={() => setDraft(device.id, { mode: "LIST" })}
                        >
                          A list of IDs
                        </Button>
                      </div>

                      {draft.mode === "RANGE" ? (
                        <>
                          <p className="mb-3 text-xs text-[var(--text-muted)]">
                            For IDs that are a fixed prefix and a counter. Leave the prefix empty
                            for plain numbers. <strong>Padding</strong> is how many digits the
                            number is written with — <code>WCTPL070</code> is prefix{" "}
                            <code>WCTPL</code>, padding <code>3</code>. Getting it wrong asks the
                            terminal about IDs that do not exist and finds nobody.
                          </p>
                          <div className="flex flex-wrap items-end gap-3">
                            <Field label="Prefix">
                              <Input
                                className="w-28"
                                placeholder="WCTPL"
                                value={draft.prefix}
                                onChange={(e) =>
                                  setDraft(device.id, {
                                    prefix: e.target.value.replace(/[^A-Za-z0-9]/g, ""),
                                  })
                                }
                              />
                            </Field>
                            <Field label="From">
                              <Input
                                type="number"
                                min={1}
                                className="w-24"
                                placeholder="1"
                                value={draft.start}
                                onChange={(e) => setDraft(device.id, { start: e.target.value })}
                              />
                            </Field>
                            <Field label="To">
                              <Input
                                type="number"
                                min={1}
                                className="w-24"
                                placeholder="999"
                                value={draft.end}
                                onChange={(e) => setDraft(device.id, { end: e.target.value })}
                              />
                            </Field>
                            <Field label="Padding">
                              <Input
                                type="number"
                                min={0}
                                max={12}
                                className="w-24"
                                placeholder="3"
                                value={draft.pad}
                                onChange={(e) => setDraft(device.id, { pad: e.target.value })}
                              />
                            </Field>
                            <Button
                              loading={scanBusy === device.id}
                              onClick={() => startScan(device.id)}
                            >
                              Scan for existing users
                            </Button>
                          </div>
                          {draft.start !== "" && (
                            <p className="mt-2 text-xs text-[var(--text-muted)]">
                              First ID it will ask about:{" "}
                              <span className="font-mono">
                                {draft.prefix}
                                {draft.start.padStart(Number(draft.pad) || 0, "0")}
                              </span>
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          <p className="mb-3 text-xs text-[var(--text-muted)]">
                            Paste the IDs, or upload the list the site already has — the export
                            from whatever software ran this terminal before. CSV, TXT or XLSX;
                            first column, one ID per row. That export is the most reliable source
                            there is: it is complete, and it needs no guessing about numbering.
                          </p>
                          <Field label="IDs">
                            <textarea
                              className="h-28 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-xs"
                              placeholder={"WCTPL070\nWCTPL071\nye01"}
                              value={draft.ids}
                              onChange={(e) => setDraft(device.id, { ids: e.target.value })}
                            />
                          </Field>
                          {draft.rejected.length > 0 && (
                            <p className="mt-2 text-xs text-[var(--text-muted)]">
                              Ignored from the file (not letters-and-digits IDs):{" "}
                              <span className="font-mono">{draft.rejected.join(", ")}</span>
                            </p>
                          )}
                          <div className="mt-3 flex flex-wrap items-end gap-3">
                            <Field label="Or upload a file">
                              <Input
                                type="file"
                                accept=".csv,.txt,.xlsx"
                                disabled={parsingFile === device.id}
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) void parseIdFile(device.id, file);
                                }}
                              />
                            </Field>
                            <Button
                              loading={scanBusy === device.id}
                              onClick={() => startScan(device.id)}
                            >
                              Scan for these IDs
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })()}
            </Card>
          ))}

          {data.unregistered.length > 0 && (
            <Card title="Unregistered devices seen on the network">
              <Alert tone="warn">
                These serials are checking in but no device record claims them. They are never
                adopted automatically — one owner per device roster, or two masters cause mystery
                deletions. Register one below to bring it under management.
              </Alert>
              <ul className="mt-3 space-y-2 text-sm">
                {data.unregistered.map((u) => (
                  <li key={u.serialNo} className="flex flex-wrap items-center gap-3">
                    <span className="font-mono">{u.serialNo}</span>
                    <span className="text-[var(--text-muted)]">
                      {u.requests} requests · first seen {formatDateTime(u.firstSeenAt)}
                    </span>
                    <Input
                      placeholder="Name (optional)"
                      className="w-40"
                      value={names[u.serialNo] ?? ""}
                      onChange={(e) => setNames((prev) => ({ ...prev, [u.serialNo]: e.target.value }))}
                    />
                    <Button
                      loading={registering === u.serialNo}
                      onClick={() => registerDevice(u.serialNo)}
                    >
                      Register
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0");
  const mm = String(Math.abs(minutes) % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

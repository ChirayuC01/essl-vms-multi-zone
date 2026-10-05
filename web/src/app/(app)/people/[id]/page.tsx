"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  api,
  getApiBase,
  getToken,
  type Command,
  type Device,
  type DeviceList,
  type DirectoryList,
  type Entry,
  type OperatorOptionList,
  type Paged,
  type PersonDetail,
  type ZoneList,
} from "@/lib/api";
import { useEventStream } from "@/lib/events";
import { useApi, refresh } from "@/lib/swr";
import { useAuth } from "@/lib/auth";
import { formatBytes, formatDateTime, titleCase } from "@/lib/format";
import { PersonHistory } from "@/components/person-history";
import { WebcamCapture } from "@/components/webcam-capture";
import { normalizePhotoFile } from "@/lib/photo";
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Select,
  Stat,
  Table,
  commandTone,
  entryTone,
} from "@/components/ui";

// Person detail — where every manual device operation is performed.
//
// Nothing here is synchronous. The server queues a command and the terminal
// collects it on its next poll, so each action reports what was queued and
// the page then updates itself from the live stream.

const ACTIVE_STATES = ["PENDING_PROVISION", "PROVISIONED", "INSIDE", "PENDING_DEPROVISION"];

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [photoVersion, setPhotoVersion] = useState(0);

  const [chosenDeviceIds, setChosenDeviceIds] = useState<string[] | null>(null);
  const [accessDeviceIds, setAccessDeviceIds] = useState<string[]>([]);
  const [accessZoneIds, setAccessZoneIds] = useState<string[]>([]);
  const [retentionPolicy, setRetentionPolicy] = useState("ONE_DAY");
  const [customEndDate, setCustomEndDate] = useState("");
  const [entryMode, setEntryMode] = useState("MULTI_ENTRY");
  const [purposeOfVisit, setPurposeOfVisit] = useState("");
  const [personToMeetId, setPersonToMeetId] = useState("");
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState({ name: "", mobile: "", companyId: "", departmentId: "", category: "VISITOR", aadharNumber: "", panNumber: "" });
  const { can } = useAuth();

  const { data: person, error: loadError } = useApi<PersonDetail>(`/api/people/${id}`);
  const { data: deviceList } = useApi<DeviceList>("/api/devices");
  const { data: zoneList } = useApi<ZoneList>("/api/zones");
  const { data: companies } = useApi<DirectoryList>("/api/companies");
  const { data: departments } = useApi<DirectoryList>("/api/departments");
  const { data: operators } = useApi<OperatorOptionList>("/api/operators/active");
  const { data: commandList } = useApi<Paged<Command>>(`/api/commands?personId=${id}&pageSize=25`);

  const devices: Device[] = deviceList?.items ?? [];
  const commands: Command[] = commandList?.items ?? [];
  const employeeAccess = person?.employeeAccess ?? [];
  // Defaults to every registered device -- a person authorized at a
  // two-terminal site (an IN gate and an OUT gate) needs to be on both, and
  // that should be the ordinary case, not something an operator has to
  // remember to select. With exactly one device this is that one device and
  // no picker is shown at all -- identical to how a single-device site has
  // always worked.
  const deviceIds = chosenDeviceIds ?? devices.map((d) => d.id);
  const unregisteredCount = deviceList?.unregistered.length ?? 0;
  const queryDeviceId = deviceIds[0] ?? devices[0]?.id ?? "";

  function toggleDevice(id: string) {
    setChosenDeviceIds((prev) => {
      const current = prev ?? devices.map((d) => d.id);
      return current.includes(id) ? current.filter((d) => d !== id) : [...current, id];
    });
  }

  // Refresh everything this page shows. A provision touches the person, its
  // entries, the command queue and the device's face count at once.
  const reload = () => refresh("/api/");

  // Any command or entry event touching this person refreshes the page, so the
  // operator watches the device confirm rather than clicking reload.
  useEventStream({
    onCommand: (c) => {
      if (c.personId === id) void reload();
    },
    onEntry: (e) => {
      if (e.personId === id) void reload();
    },
  });

  const activeEntry = person?.entries.find((e) => ACTIVE_STATES.includes(e.state)) ?? null;

  // Per-device provisioning state for the active authorization, derived from
  // the commands the page already has. One row per terminal the entry was
  // provisioned onto -- so "on the IN gate, still pending at the OUT gate" is
  // readable rather than hidden behind a single entry-level badge.
  const entryDeviceStatus = (() => {
    if (!activeEntry) return [];
    const byDevice = new Map<string, { id: string; deviceLabel: string; statuses: string[] }>();
    for (const c of commands) {
      if (c.entryId !== activeEntry.id) continue;
      if (c.type !== "PROVISION" && c.type !== "PUSH_PHOTO") continue;
      const key = c.device.id;
      const row = byDevice.get(key) ?? {
        id: key,
        deviceLabel: c.device.name ?? c.device.serialNo ?? key,
        statuses: [],
      };
      row.statuses.push(c.status);
      byDevice.set(key, row);
    }
    return [...byDevice.values()].map((row) => {
      if (row.statuses.includes("FAILED")) {
        return { ...row, label: "failed — never reached this terminal", tone: "danger" as const };
      }
      // Both halves have to land: the user must exist before the photo can
      // attach to it, and a user with no face opens nothing.
      const done = row.statuses.filter((st) => st === "SUCCESS").length;
      return done >= 2
        ? { ...row, label: "loaded", tone: "ok" as const }
        : { ...row, label: `waiting for the terminal (${done}/2 confirmed)`, tone: "warn" as const };
    });
  })();

  async function run(label: string, action: () => Promise<unknown>, message: string) {
    setError(null);
    setNotice(null);
    setBusy(label);
    try {
      await action();
      setNotice(message);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  async function uploadPhoto(file: File) {
    await run(
      "photo",
      () =>
        api(`/api/people/${id}/photo`, {
          method: "POST",
          blob: { data: file, contentType: "image/jpeg" },
        }),
      "Photo uploaded.",
    );
    setPhotoVersion((v) => v + 1);
  }

  async function saveProfile() {
    if (!person) return;
    await run("profile", () => api(`/api/people/${id}`, { method: "PATCH", body: {
      name: profile.name,
      mobile: profile.mobile,
      companyId: profile.companyId,
      departmentId: profile.departmentId,
      category: profile.category,
      ...(profile.aadharNumber ? { aadharNumber: profile.aadharNumber } : {}),
      ...(profile.panNumber ? { panNumber: profile.panNumber } : {}),
      ...(person.category !== "EMPLOYEE" && profile.category === "EMPLOYEE" ? { deviceIds } : {}),
    } }), "Profile saved.");
    setEditing(false);
  }

  if (!person) {
    if (loadError) {
      return <Alert>{loadError instanceof Error ? loadError.message : "failed to load person"}</Alert>;
    }
    return error ? <Alert>{error}</Alert> : <Empty>Loading…</Empty>;
  }

  const photoControls = (
    <div className="mt-3 grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Upload photo</span>
        <input
          type="file"
          accept="image/jpeg"
          disabled={busy === "photo"}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void normalizePhotoFile(file).then(uploadPhoto);
          }}
          className="w-full text-sm"
        />
      </label>
      <div>
        <span className="mb-1 block text-sm font-medium">Take photo</span>
        <WebcamCapture
          disabled={busy === "photo"}
          onCapture={(file) => void uploadPhoto(file)}
        />
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{person.name}</h1>
            {person.aadharNumber && <Badge tone="ok">Aadhaar verified</Badge>}
            {person.panNumber && <Badge tone="ok">PAN verified</Badge>}
            {person.resignedAt && <Badge tone="warn">Resigned</Badge>}
          </div>
          <p className="text-sm text-[var(--text-muted)]">
            {person.company?.name ?? "no company"} · {person.department?.name ?? "no department"} · {person.category} · ID{" "}
            <span className="font-mono">{person.esslUserId}</span>
            {/* Absent only on people registered before it was mandatory —
                said plainly, because it is the field somebody is checking. */}
            {" · Aadhaar/PAN "}
            <span className="font-mono">{person.aadharNumber ?? person.panNumber ?? "not recorded"}</span>
            {!person.isActive && " · deactivated"}
          </p>
        </div>
        <Link href="/people">
          <Button>Back to people</Button>
        </Link>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}

      <Card title="Profile" action={<Button onClick={() => {
        if (editing) return setEditing(false);
        setProfile({ name: person.name, mobile: person.mobile ?? "", companyId: person.companyId ?? "", departmentId: person.departmentId ?? "", category: person.category, aadharNumber: person.aadharNumber ?? "", panNumber: person.panNumber ?? "" });
        setEditing(true);
      }}>{editing ? "Cancel" : "Edit"}</Button>}>
        {!person.profileComplete && <Alert tone="warn">Complete every listed field before this visitor can be provisioned.</Alert>}
        {editing && <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label={person.category === "VISITOR" ? "Visitor ID" : "Employee ID"}><Input value={person.esslUserId} disabled /></Field>
          <Field label="Name"><Input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></Field>
          <Field label="Mobile"><Input value={profile.mobile} onChange={(e) => setProfile({ ...profile, mobile: e.target.value })} /></Field>
          <Field label="Company"><Select value={profile.companyId} onChange={(e) => setProfile({ ...profile, companyId: e.target.value })}><option value="">Select</option>{companies?.items.filter((x) => x.isActive || x.id === profile.companyId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label="Department"><Select value={profile.departmentId} onChange={(e) => setProfile({ ...profile, departmentId: e.target.value })}><option value="">Select</option>{departments?.items.filter((x) => x.isActive || x.id === profile.departmentId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label="Category"><Select disabled={!can("person_category:update")} value={profile.category} onChange={(e) => setProfile({ ...profile, category: e.target.value })}><option value="VISITOR">Visitor</option><option value="EMPLOYEE">Employee</option></Select></Field>
          <Field label="Aadhaar"><Input maxLength={12} value={profile.aadharNumber} onChange={(e) => setProfile({ ...profile, aadharNumber: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="PAN"><Input maxLength={10} value={profile.panNumber} onChange={(e) => setProfile({ ...profile, panNumber: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} /></Field>
          {person.category !== "EMPLOYEE" && profile.category === "EMPLOYEE" && <Field label="Devices"><div>{devices.map((device) => <label key={device.id} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={deviceIds.includes(device.id)} onChange={() => toggleDevice(device.id)} />{device.name ?? device.serialNo}</label>)}</div></Field>}
          <div className="flex items-end"><Button variant="primary" loading={busy === "profile"} onClick={saveProfile}>Save profile</Button></div>
        </div>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Enrollment photo">
          {person.biometric ? (
            <div className="space-y-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- the API
                  serves the JPEG behind a bearer token from another origin;
                  next/image cannot carry the auth header. */}
              <img
                src={`${getApiBase()}/api/people/${person.id}/photo?v=${photoVersion}&token=${encodeURIComponent(getToken() ?? "")}`}
                alt={`Enrollment photo for ${person.name}`}
                className="w-full rounded-[var(--radius)] border border-[var(--border)] object-cover"
              />
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Stat label="Size" value={formatBytes(person.biometric.photoSizeBytes)} />
                <Stat label="Captured" value={formatDateTime(person.biometric.capturedAt)} />
              </div>
              <Link
                href={`/people/${person.id}/card`}
                className="block text-xs text-[var(--brand)] hover:underline"
              >
                Print person card (permanent — carries their PIN)
              </Link>
              <p className="text-xs text-[var(--text-muted)]">
                The photo is the durable artifact. The face template is
                {person.biometric.hasCachedTemplate ? " cached" : " not cached"} and is bound to one
                algorithm — never treated as portable.
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                Replace the photo if the terminal rejects it (command queue shows{" "}
                <code>Return=-1001</code>), then retry the failed PUSH_PHOTO commands.
              </p>
              {photoControls}
            </div>
          ) : (
            <>
              <Alert tone="warn">
                No enrollment photo. This person cannot be provisioned until one is attached.
              </Alert>
              {photoControls}
            </>
          )}
        </Card>

        <Card title="Device authorization" className="lg:col-span-2">
          {person.category === "EMPLOYEE" ? (
            <div className="space-y-4">
              {person.resignedAt ? (
                <div className="space-y-3">
                  <Alert tone="warn">Resigned {formatDateTime(person.resignedAt)}{person.resignedReason ? ` · ${person.resignedReason}` : ""}. Device removal commands remain visible below.</Alert>
                  {can("employee_access:create") && <div>
                    <Field label="Zones" hint="a zone also includes the gates of every zone it sits inside"><div className="flex flex-wrap gap-3">{(zoneList?.items ?? []).filter((zone) => zone.isActive).map((zone) => <label key={zone.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={accessZoneIds.includes(zone.id)} onChange={() => setAccessZoneIds((current) => current.includes(zone.id) ? current.filter((value) => value !== zone.id) : [...current, zone.id])} />{zone.name}</label>)}</div></Field><Field label="Rehire on devices"><div className="flex flex-wrap gap-3">{devices.map((device) => <label key={device.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={accessDeviceIds.includes(device.id)} onChange={() => setAccessDeviceIds((current) => current.includes(device.id) ? current.filter((value) => value !== device.id) : [...current, device.id])} />{device.name ?? device.serialNo}</label>)}</div></Field>
                    <Button className="mt-2" variant="primary" loading={busy === "rehire"} disabled={accessDeviceIds.length + accessZoneIds.length === 0} onClick={() => run("rehire", async () => { await api(`/api/people/${id}/rehire`, { method: "POST", body: { deviceIds: accessDeviceIds, zoneIds: accessZoneIds } }); setAccessDeviceIds([]); setAccessZoneIds([]); }, "Employee rehired; permanent access queued for the selected devices.")}>Rehire</Button>
                  </div>}
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Alert tone="info">Employees remain on selected devices until an administrator removes their access.</Alert>
                  {can("employee_access:delete") && <Button variant="danger" loading={busy === "resign"} onClick={() => {
                    const reason = window.prompt("Optional resignation reason");
                    if (reason === null || !window.confirm(`Resign ${person.name} and remove access from every assigned device?`)) return;
                    void run("resign", () => api(`/api/people/${id}/resign`, { method: "POST", body: { reason } }), "Employee resigned; removal queued for every assigned device.");
                  }}>Resign</Button>}
                </div>
              )}
              <Table head={["Device", "Desired", "Provisioned", "Reason", "Action"]}>
                {employeeAccess.map((access) => <tr key={access.id} className="border-b border-[var(--border)]">
                  <td className="px-2 py-2">{access.device.name ?? access.device.serialNo}</td>
                  <td className="px-2 py-2"><Badge tone={access.desiredAccess ? "ok" : "warn"}>{access.desiredAccess ? "yes" : "removed"}</Badge></td>
                  <td className="px-2 py-2">{access.provisioned ? "yes" : "pending/no"}</td>
                  <td className="px-2 py-2 text-xs">{access.removalReason ?? "—"}</td>
                  <td className="px-2 py-2">{!person.resignedAt && (access.desiredAccess ? can("employee_access:delete") && <Button variant="danger" onClick={() => { const reason = window.prompt("Optional removal reason") ?? undefined; void run("access", () => api(`/api/people/${id}/device-access/${access.device.id}`, { method: "DELETE", body: { reason } }), "Employee access removal queued."); }}>Remove</Button> : can("employee_access:create") && <Button onClick={() => run("access", () => api(`/api/people/${id}/device-access/${access.device.id}/restore`, { method: "POST" }), "Employee access restore queued.")}>Restore</Button>)}</td>
                </tr>)}
              </Table>
              {can("employee_access:create") && !person.resignedAt && <div><Field label="Zones" hint="a zone also includes the gates of every zone it sits inside"><div className="flex flex-wrap gap-3">{(zoneList?.items ?? []).filter((zone) => zone.isActive).map((zone) => <label key={zone.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={accessZoneIds.includes(zone.id)} onChange={() => setAccessZoneIds((current) => current.includes(zone.id) ? current.filter((value) => value !== zone.id) : [...current, zone.id])} />{zone.name}</label>)}</div></Field><Field label="Add devices"><div className="flex flex-wrap gap-3">{devices.filter((device) => !employeeAccess.some((a) => a.device.id === device.id && a.desiredAccess)).map((device) => <label key={device.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={accessDeviceIds.includes(device.id)} onChange={() => setAccessDeviceIds((current) => current.includes(device.id) ? current.filter((value) => value !== device.id) : [...current, device.id])} />{device.name ?? device.serialNo}</label>)}</div></Field><Button className="mt-2" disabled={accessDeviceIds.length + accessZoneIds.length === 0} onClick={() => run("access", async () => { await api(`/api/people/${id}/device-access`, { method: "POST", body: { deviceIds: accessDeviceIds, zoneIds: accessZoneIds } }); setAccessDeviceIds([]); setAccessZoneIds([]); }, "Employee access queued.")}>Assign selected</Button></div>}
            </div>
          ) : activeEntry ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={entryTone(activeEntry.state)}>{activeEntry.state}</Badge>
                {activeEntry.dayBlocked && <Badge tone="danger">blocked at barrier</Badge>}
                <span className="text-xs text-[var(--text-muted)]">
                  authorized {formatDateTime(activeEntry.createdAt)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Retention" value={titleCase(activeEntry.retentionPolicy)} />
                <Stat label="Entry mode" value={titleCase(activeEntry.entryMode)} />
                <Stat label="Window ends" value={formatDateTime(activeEntry.retentionExpiresAt)} />
                <Stat label="Purpose" value={activeEntry.purposeOfVisit ?? "not recorded"} />
                <Stat label="Person to meet" value={activeEntry.personToMeet?.name ?? activeEntry.personToMeet?.email ?? "not specified"} />
              </div>

              {/* WHICH terminals this person is actually loaded on, per device,
                  read from the entry's own commands.
                  "PROVISIONED" is a single word covering any number of
                  rosters, so on a two-gate site it cannot answer the question
                  that matters: a person confirmed at the IN gate and pending at
                  the OUT gate can enter and not leave, and the state badge
                  looks identical either way. */}
              <div className="rounded-[var(--radius)] bg-[var(--surface-muted)] p-3">
                <p className="mb-2 text-xs font-medium">Loaded on</p>
                {entryDeviceStatus.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">
                    No provisioning commands recorded for this authorization.
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {entryDeviceStatus.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center gap-2">
                        <span>{d.deviceLabel}</span>
                        <Badge tone={d.tone}>{d.label}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {activeEntry.dayBlocked ? (
                  <Button
                    variant="primary"
                    loading={busy === "unblock"}
                    onClick={() =>
                      run(
                        "unblock",
                        () => api(`/api/entries/${activeEntry.id}/unblock`, { method: "POST" }),
                        "Unblock queued — the device restores access on its next poll.",
                      )
                    }
                  >
                    Unblock
                  </Button>
                ) : (
                  <Button
                    loading={busy === "block"}
                    disabled={activeEntry.state === "PENDING_PROVISION"}
                    onClick={() =>
                      run(
                        "block",
                        () => api(`/api/entries/${activeEntry.id}/block`, { method: "POST" }),
                        "Block queued — the device will deny with “Invalid time period”.",
                      )
                    }
                  >
                    Block
                  </Button>
                )}

                {/* Sits with the live-entry actions rather than in the history
                    table below: a pass is something you print for the visit
                    happening now, and buried in a row of closed entries it was
                    simply not findable. */}
                {(activeEntry.state === "PROVISIONED" || activeEntry.state === "INSIDE") && (
                  <Link href={`/pass/${activeEntry.id}`}>
                    <Button>Visitor pass</Button>
                  </Link>
                )}

                <Button
                  variant="danger"
                  loading={busy === "deprovision"}
                  disabled={activeEntry.state === "INSIDE"}
                  title={
                    activeEntry.state === "INSIDE"
                      ? "This person is inside. De-provisioning is deferred until they punch OUT."
                      : undefined
                  }
                  onClick={() =>
                    run(
                      "deprovision",
                      () => api(`/api/entries/${activeEntry.id}/deprovision`, { method: "POST" }),
                      "De-provision queued — removed from the device only; the record and photo are kept.",
                    )
                  }
                >
                  De-provision
                </Button>

                <Button
                  loading={busy === "query"}
                  onClick={() =>
                    run(
                      "query",
                      () =>
                        api(`/api/people/${id}/query-device`, {
                          method: "POST",
                          body: queryDeviceId ? { deviceId: queryDeviceId } : {},
                        }),
                      "Query queued — the device will push back its own view of this PIN.",
                    )
                  }
                >
                  Query device
                </Button>
              </div>

              {activeEntry.state === "INSIDE" && (
                <Alert tone="warn">
                  This person is currently inside. De-provisioning is refused until they punch OUT —
                  removing their credential now would strand them at the exit barrier.
                </Alert>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {person.adoptedFromDevice ? (
                <Alert tone="warn">
                  Enrolled on the terminal, but not under management. This person&apos;s face is
                  already on the device — someone enrolled them there directly — so they can enter
                  right now, with no retention window and no expiry. Provision them to bring them
                  under one. Until then nothing will remove them, and nothing will time them out.
                </Alert>
              ) : (
                <p className="text-sm text-[var(--text-muted)]">
                  Not currently loaded on any device. Provisioning creates the user and pushes the
                  stored photo — the device rebuilds the face template from it, so a returning
                  person never re-enrolls.
                </p>
              )}

              {/* A terminal that is checking in but was never registered gets
                  NOTHING — it is not in this list, so it is not provisioned
                  onto, and with only one registered device there is no picker
                  here to hint that anything is missing. On a two-gate site
                  that means a person loaded on the IN gate and unknown at the
                  OUT gate: they walk in, and then cannot get out. Said here,
                  where the provisioning decision is actually made, rather than
                  only on the Devices page. */}
              {unregisteredCount > 0 && (
                <Alert tone="warn">
                  {unregisteredCount === 1
                    ? "A terminal is checking in that has not been registered"
                    : `${unregisteredCount} terminals are checking in that have not been registered`}
                  , so provisioning cannot load this person onto{" "}
                  {unregisteredCount === 1 ? "it" : "them"}. On a two-gate site that leaves someone
                  able to enter and not to leave.{" "}
                  <Link href="/devices" className="underline">
                    Register {unregisteredCount === 1 ? "it" : "them"} first
                  </Link>
                  .
                </Alert>
              )}

              {/* Only shown once a second device exists. A single-device site
                  never sees this -- provisioning still targets its one device
                  automatically, exactly as it always has. */}
              {devices.length > 1 && (
                <Field label="Devices" hint="Provisions the person onto every device checked here">
                  <div className="flex flex-wrap gap-3">
                    {devices.map((d) => (
                      <label key={d.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={deviceIds.includes(d.id)}
                          onChange={() => toggleDevice(d.id)}
                        />
                        {d.name ?? d.serialNo}
                        {d.role !== "BOTH" && ` (${d.role})`}
                        {d.online ? "" : " (offline)"}
                      </label>
                    ))}
                  </div>
                </Field>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Retention window">
                  <Select
                    value={retentionPolicy}
                    onChange={(e) => setRetentionPolicy(e.target.value)}
                  >
                    <option value="ONE_DAY">One day</option>
                    <option value="ONE_WEEK">One week</option>
                    <option value="ONE_MONTH">One month</option>
                    <option value="QUARTERLY">Quarterly</option>
                    <option value="CUSTOM">Custom end date</option>
                  </Select>
                </Field>
                <Field label="Entry mode">
                  <Select value={entryMode} onChange={(e) => setEntryMode(e.target.value)}>
                    <option value="MULTI_ENTRY">Multi entry</option>
                    <option value="SINGLE_ENTRY">Single entry</option>
                  </Select>
                </Field>
              </div>

              {retentionPolicy === "CUSTOM" && (
                <Field label="Custom end date" hint="Valid through 11:59 PM IST on this date.">
                  <Input
                    type="date"
                    required
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                  />
                </Field>
              )}

              <Field label="Person to meet" hint="Optional">
                <Select value={personToMeetId} onChange={(e) => setPersonToMeetId(e.target.value)}>
                  <option value="">Not specified</option>
                  {operators?.items.map((operator) => (
                    <option key={operator.id} value={operator.id}>
                      {operator.name ?? operator.email}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Purpose of visit"
                hint="Why they are being let in, in your own words. Recorded against this authorization permanently — it is what an incident review reads."
              >
                <Input
                  required
                  maxLength={200}
                  value={purposeOfVisit}
                  onChange={(e) => setPurposeOfVisit(e.target.value)}
                  placeholder="e.g. Lift maintenance, Block C"
                />
              </Field>

              <Button
                variant="primary"
                loading={busy === "provision"}
                disabled={
                  !person.biometric ||
                  !person.isActive ||
                  deviceIds.length === 0 ||
                  purposeOfVisit.trim() === "" ||
                  (retentionPolicy === "CUSTOM" && !customEndDate)
                }
                onClick={() =>
                  run(
                    "provision",
                    () =>
                      api(`/api/people/${id}/provision`, {
                        method: "POST",
                        body: {
                          deviceIds,
                          retentionPolicy,
                          ...(retentionPolicy === "CUSTOM"
                            ? { retentionExpiresAt: customEndDate }
                            : {}),
                          entryMode,
                          ...(personToMeetId ? { personToMeetId } : {}),
                          purposeOfVisit: purposeOfVisit.trim(),
                        },
                      }),
                    devices.length > 1
                      ? "Provision queued — each device collects it on its next poll (1–3 s after activity)."
                      : "Provision queued — the device collects it on its next poll (1–3 s after activity).",
                  )
                }
              >
                {devices.length > 1 ? "Provision to devices" : "Provision to device"}
              </Button>

              {/* Named explicitly, even with one device. "Provision to device"
                  is a claim about which rosters this lands on, and an operator
                  should be able to read it back rather than infer it. */}
              <p className="text-xs text-[var(--text-muted)]">
                Will be loaded onto:{" "}
                {deviceIds.length === 0
                  ? "no device selected"
                  : devices
                      .filter((d) => deviceIds.includes(d.id))
                      .map((d) => `${d.name ?? d.serialNo}${d.role === "BOTH" ? "" : ` (${d.role})`}`)
                      .join(", ")}
              </p>

              <p className="text-xs text-[var(--text-muted)]">
                The terminal enforces neither of these itself — the expiry sweeper removes a lapsed
                person and the daily reset releases a single-entry one, both server-side jobs.
              </p>
            </div>
          )}
        </Card>
      </div>

      <Card title="Recent commands">
        {commands.length === 0 ? (
          <Empty>No device commands for this person yet.</Empty>
        ) : (
          <Table head={["Type", "Status", "Wire ID", "Attempts", "Created", "Error"]}>
            {commands.map((c) => (
              <tr key={c.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2 font-medium">{c.type}</td>
                <td className="px-2 py-2">
                  <Badge tone={commandTone(c.status)}>{c.status}</Badge>
                </td>
                <td className="px-2 py-2 font-mono text-xs">{c.deviceCmdId ?? "—"}</td>
                <td className="px-2 py-2 text-xs">{c.attempts}</td>
                <td className="px-2 py-2 text-xs text-[var(--text-muted)]">
                  {formatDateTime(c.createdAt)}
                </td>
                <td className="px-2 py-2 text-xs text-[var(--danger)]">{c.lastError ?? ""}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Authorization history">
        {person.entries.length === 0 ? (
          <Empty>Never provisioned.</Empty>
        ) : (
          <Table head={["State", "Retention", "Mode", "Blocked", "Created", "Pass"]}>
            {person.entries.map((entry: Entry) => (
              <tr key={entry.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2">
                  <Badge tone={entryTone(entry.state)}>{entry.state}</Badge>
                </td>
                <td className="px-2 py-2 text-xs">{titleCase(entry.retentionPolicy)}</td>
                <td className="px-2 py-2 text-xs">{titleCase(entry.entryMode)}</td>
                <td className="px-2 py-2 text-xs">{entry.dayBlocked ? "yes" : "no"}</td>
                <td className="px-2 py-2 text-xs text-[var(--text-muted)]">
                  {formatDateTime(entry.createdAt)}
                </td>
                <td className="px-2 py-2 text-right">
                  {/* Only for a live authorization: a pass for a closed entry
                      would state a validity window that has already ended. */}
                  {(entry.state === "PROVISIONED" || entry.state === "INSIDE") && (
                    <Link
                      href={`/pass/${entry.id}`}
                      className="text-xs text-[var(--brand)] hover:underline"
                    >
                      Visitor pass
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <PersonHistory personId={person.id} />
    </div>
  );
}

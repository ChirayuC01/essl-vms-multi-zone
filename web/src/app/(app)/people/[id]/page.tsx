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
  type Paged,
  type PersonDetail,
  type ZoneList,
  type PassTypeList,
} from "@/lib/api";
import { DocumentsCard } from "@/components/documents-card";
import { PersonMovement } from "@/components/person-movement";
import { PersonReports } from "@/components/person-reports";
import { IssuePassForm } from "@/components/issue-pass-form";
import { ZonePicker } from "@/components/zone-picker";
import { PassGates } from "@/components/pass-gates";
import { BlacklistControl } from "@/components/blacklist-control";
import { EMPTY_PROFILE, ProfileFields, draftFromPerson, profilePayload } from "@/components/profile-fields";
import { useEventStream } from "@/lib/events";
import { useApi, refresh } from "@/lib/swr";
import { useAuth } from "@/lib/auth";
import { categoryLabel, commandStatusLabel, commandTypeLabel, entryModeLabel, formatBytes, formatDateTime, passStateLabel } from "@/lib/format";
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
  SearchSelect,
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
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState({ name: "", category: "VISITOR", passTypeId: "" });
  const [draft, setDraft] = useState(EMPTY_PROFILE);
  const { can } = useAuth();

  const { data: person, error: loadError } = useApi<PersonDetail>(`/api/people/${id}`);
  const { data: deviceList } = useApi<DeviceList>("/api/devices");
  const { data: zoneList } = useApi<ZoneList>("/api/zones");
  const { data: companies } = useApi<DirectoryList>("/api/companies");
  const { data: departments } = useApi<DirectoryList>("/api/departments");
  const { data: passTypes } = useApi<PassTypeList>("/api/pass-types");
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
      category: profile.category,
      ...(profile.category === "VISITOR" ? { passTypeId: profile.passTypeId || null } : {}),
      ...profilePayload(draft, true),
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
            {person.erasedAt && <Badge tone="danger">Erased</Badge>}
          </div>
          <p className="text-sm text-[var(--text-muted)]">
            {person.company?.name ?? "no company"} · {person.department?.name ?? "no department"} · {categoryLabel(person.category)} · ID{" "}
            <span className="font-mono">{person.esslUserId}</span>
            {/* Absent only on people registered before it was mandatory —
                said plainly, because it is the field somebody is checking. */}
            {" · Aadhaar/PAN "}
            <span className="font-mono">{person.aadharNumber ?? person.panNumber ?? "not recorded"}</span>
            {!person.isActive && " · deactivated"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* F2 #1a: visitors are deactivated here; employees through Resign. */}
          {!person.erasedAt && person.category === "VISITOR" && can("people:delete") && (
            person.isActive ? (
              <Button
                loading={busy === "deactivate"}
                onClick={() => {
                  if (!window.confirm(`Deactivate ${person.name}? They are hidden from lists and can't be given a pass until reactivated. Their record and history are kept.`)) return;
                  void run("deactivate", () => api(`/api/people/${id}`, { method: "DELETE" }), "Deactivated. Their record and history are kept.");
                }}
              >
                Deactivate
              </Button>
            ) : (
              <Button loading={busy === "reactivate"} onClick={() => void run("reactivate", () => api(`/api/people/${id}/reactivate`, { method: "POST" }), "Reactivated.")}>
                Reactivate
              </Button>
            )
          )}
          {/* F2 #1b: erasure on request, Administrator only by default. */}
          {!person.erasedAt && can("people_erasure:delete") && (
            <Button
              variant="danger"
              loading={busy === "erase"}
              onClick={() => {
                const reason = window.prompt(
                  `ERASE ${person.name}?\n\nTheir name, contact details, ID numbers, photo and documents are permanently deleted. Visit history stays, anonymised. This cannot be undone.\n\nReason (required, e.g. the erasure request reference):`,
                );
                if (!reason?.trim()) return;
                void run("erase", () => api(`/api/people/${id}/erase`, { method: "POST", body: { reason: reason.trim() } }), "Erased. Identity, photo and documents are gone; the visit history remains.");
              }}
            >
              Erase data
            </Button>
          )}
          <Link href="/people">
            <Button>Back to people</Button>
          </Link>
        </div>
      </div>
      {person.erasedAt && <Alert tone="warn">This person&apos;s data was erased on request on {formatDateTime(person.erasedAt)}. Only the anonymised history remains; register them again if they return.</Alert>}

      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}

      <Card title="Profile" action={<Button onClick={() => {
        if (editing) return setEditing(false);
        setProfile({ name: person.name, category: person.category, passTypeId: person.passTypeId ?? "" });
        setDraft(draftFromPerson(person));
        setEditing(true);
      }}>{editing ? "Cancel" : "Edit"}</Button>}>
        {!person.profileComplete && <Alert tone="warn">Complete every required field before this visitor can be provisioned.</Alert>}
        {!editing && (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {([
              ["Pass type", person.category === "VISITOR" ? passTypes?.items.find((t) => t.id === person.passTypeId)?.name ?? "General" : null],
              ["Mobile", person.mobile],
              ["Email", person.email],
              ["Designation", person.designation],
              ["Govt ID", person.govtIdNumber ? `${person.govtIdType ?? "ID"} ${person.govtIdNumber}` : null],
              ["Aadhaar", person.aadharNumber],
              ["PAN", person.panNumber],
              ["Vehicle", person.vehicleNumber],
              ["Police clearance", person.policeClearance === null ? null : person.policeClearance ? "Yes" : "No"],
              ["Credential", person.credentialNumber ? `${person.credentialNumber}${person.credentialExpiresAt ? ` · until ${person.credentialExpiresAt.slice(0, 10)}` : ""}` : null],
            ] as const).filter(([, v]) => v).map(([k, v]) => (
              <div key={k}><dt className="text-xs text-[var(--text-muted)]">{k}</dt><dd className="font-mono text-sm">{v}</dd></div>
            ))}
          </dl>
        )}
        {editing && <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label={person.category === "VISITOR" ? "Visitor ID" : "Employee ID"}><Input value={person.esslUserId} disabled /></Field>
          <Field label="Name"><Input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></Field>
          <Field label="Category"><Select disabled={!can("person_category:update")} value={profile.category} onChange={(e) => setProfile({ ...profile, category: e.target.value })}><option value="VISITOR">Visitor</option><option value="EMPLOYEE">Employee</option></Select></Field>
          {profile.category === "VISITOR" && (
            <Field label="Pass type" hint="decides which details are required">
              <SearchSelect
                value={profile.passTypeId}
                onChange={(v) => setProfile({ ...profile, passTypeId: v })}
                options={(passTypes?.items ?? []).filter((t) => t.isActive || t.id === profile.passTypeId).map((t) => ({ value: t.id, label: t.name }))}
                emptyLabel="General"
              />
            </Field>
          )}
          <div className="sm:col-span-2">
            <ProfileFields
              draft={draft}
              onChange={setDraft}
              category={profile.category}
              passType={profile.category === "VISITOR" ? passTypes?.items.find((t) => t.id === profile.passTypeId) ?? null : null}
              companies={companies}
              departments={departments}
              onFile={{ aadharNumber: person.aadharNumber, panNumber: person.panNumber, govtIdNumber: person.govtIdNumber, credentialNumber: person.credentialNumber }}
            />
          </div>
          {person.category !== "EMPLOYEE" && profile.category === "EMPLOYEE" && <Field label="Devices"><div>{devices.map((device) => <label key={device.id} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={deviceIds.includes(device.id)} onChange={() => toggleDevice(device.id)} />{device.name ?? device.serialNo}</label>)}</div></Field>}
          <div className="flex items-end"><Button variant="primary" loading={busy === "profile"} onClick={saveProfile}>Save profile</Button></div>
        </div>}
      </Card>

      {can("documents:view") && <DocumentsCard personId={id} />}
      <BlacklistControl person={person} onChanged={() => void refresh(`/api/people/${id}`)} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Photo">
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
                Print ID card
              </Link>
              <p className="text-xs text-[var(--text-muted)]">
                Face not recognised at the gate, or a device refused the photo? Take a clearer one
                here; devices that already hold this person get the new photo automatically.
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

        <Card title={person.category === "EMPLOYEE" ? "Device access" : "Provisioning"} className="lg:col-span-2">
          {person.category !== "EMPLOYEE" && <p className="mb-3 text-sm text-[var(--text-muted)]">Provision this registered visitor directly, for example for a stay of several days. Planned visits normally go through Requests.</p>}
          {person.category === "EMPLOYEE" ? (
            <div className="space-y-4">
              {person.resignedAt ? (
                <div className="space-y-3">
                  <Alert tone="warn">Resigned {formatDateTime(person.resignedAt)}{person.resignedReason ? ` · ${person.resignedReason}` : ""}. Device removal commands remain visible below.</Alert>
                  {can("employee_access:create") && <div>
                    <Field label="Zones" hint="a zone also includes the gates of every zone it sits inside"><ZonePicker zones={(zoneList?.items ?? []).filter((zone) => zone.isActive)} value={accessZoneIds} onChange={setAccessZoneIds} /></Field><Field label="Rehire on devices"><div className="flex flex-wrap gap-3">{devices.map((device) => <label key={device.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={accessDeviceIds.includes(device.id)} onChange={() => setAccessDeviceIds((current) => current.includes(device.id) ? current.filter((value) => value !== device.id) : [...current, device.id])} />{device.name ?? device.serialNo}</label>)}</div></Field>
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
              <Table head={["Device", "Access", "On device", "Removal reason", ""]}>
                {employeeAccess.map((access) => <tr key={access.id} className="border-b border-[var(--border)]">
                  <td className="px-2 py-2">{access.device.name ?? access.device.serialNo}</td>
                  <td className="px-2 py-2"><Badge tone={access.desiredAccess ? "ok" : "warn"}>{access.desiredAccess ? "Granted" : "Removed"}</Badge></td>
                  <td className="px-2 py-2">{access.provisioned ? "Loaded" : "Not yet"}</td>
                  <td className="px-2 py-2 text-xs">{access.removalReason ?? "—"}</td>
                  <td className="px-2 py-2">{!person.resignedAt && (access.desiredAccess ? can("employee_access:delete") && <Button variant="danger" onClick={() => { const reason = window.prompt("Optional removal reason") ?? undefined; void run("access", () => api(`/api/people/${id}/device-access/${access.device.id}`, { method: "DELETE", body: { reason } }), "Employee access removal queued."); }}>Remove</Button> : can("employee_access:create") && <Button onClick={() => run("access", () => api(`/api/people/${id}/device-access/${access.device.id}/restore`, { method: "POST" }), "Employee access restore queued.")}>Restore</Button>)}</td>
                </tr>)}
              </Table>
              {can("employee_access:create") && !person.resignedAt && <div><Field label="Zones" hint="a zone also includes the gates of every zone it sits inside"><ZonePicker zones={(zoneList?.items ?? []).filter((zone) => zone.isActive)} value={accessZoneIds} onChange={setAccessZoneIds} /></Field><Field label="Add devices"><div className="flex flex-wrap gap-3">{devices.filter((device) => !employeeAccess.some((a) => a.device.id === device.id && a.desiredAccess)).map((device) => <label key={device.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={accessDeviceIds.includes(device.id)} onChange={() => setAccessDeviceIds((current) => current.includes(device.id) ? current.filter((value) => value !== device.id) : [...current, device.id])} />{device.name ?? device.serialNo}</label>)}</div></Field><Button className="mt-2" disabled={accessDeviceIds.length + accessZoneIds.length === 0} onClick={() => run("access", async () => { await api(`/api/people/${id}/device-access`, { method: "POST", body: { deviceIds: accessDeviceIds, zoneIds: accessZoneIds } }); setAccessDeviceIds([]); setAccessZoneIds([]); }, "Employee access queued.")}>Assign selected</Button></div>}
            </div>
          ) : activeEntry ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={entryTone(activeEntry.state)}>{passStateLabel(activeEntry.state)}</Badge>
                {activeEntry.dayBlocked && <Badge tone="danger">Blocked</Badge>}
                <span className="text-xs text-[var(--text-muted)]">
                  provisioned {formatDateTime(activeEntry.createdAt)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Entry mode" value={entryModeLabel(activeEntry.entryMode)} />
                <Stat label="Valid until" value={formatDateTime(activeEntry.retentionExpiresAt)} />
                <Stat label="Purpose" value={activeEntry.purposeOfVisit ?? "not recorded"} />
                <Stat label="Person to meet" value={activeEntry.personToMeet?.name ?? activeEntry.personToMeet?.email ?? "not specified"} />
              </div>

              <PassGates entryId={activeEntry.id} />

              <div className="flex flex-wrap gap-2">
                {activeEntry.dayBlocked ? (
                  <Button
                    variant="primary"
                    loading={busy === "unblock"}
                    onClick={() =>
                      run(
                        "unblock",
                        () => api(`/api/entries/${activeEntry.id}/unblock`, { method: "POST" }),
                        "Unblocked: access returns within a few seconds.",
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
                        "Blocked: the device still recognises them but refuses entry until unblocked.",
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
                    <Button>Print visitor pass</Button>
                  </Link>
                )}

                <Button
                  variant="danger"
                  loading={busy === "deprovision"}
                  disabled={activeEntry.state === "INSIDE"}
                  title={
                    activeEntry.state === "INSIDE"
                      ? "They are inside: de-provision once they go out."
                      : undefined
                  }
                  onClick={() =>
                    run(
                      "deprovision",
                      () => api(`/api/entries/${activeEntry.id}/deprovision`, { method: "POST" }),
                      "De-provisioning: their face is being removed from the devices. The record and photo are kept.",
                    )
                  }
                >
                  De-provision
                </Button>

                {/* F3 F-a: someone marked inside who left without punching out. */}
                {activeEntry.state === "INSIDE" && can("passes_force_end:update") && (
                  <Button
                    variant="danger"
                    loading={busy === "force"}
                    onClick={() => {
                      const reason = window.prompt(
                        "De-provision this person although they are marked inside?\n\nThe devices stop recognising them at once. If they are actually still on site, they must be let out by hand (admin card).\n\nReason (required):",
                      );
                      if (!reason?.trim()) return;
                      void run(
                        "force",
                        () => api(`/api/entries/${activeEntry.id}/deprovision`, { method: "POST", body: { force: true, reason: reason.trim() } }),
                        "De-provisioning although inside: the devices are being cleared.",
                      );
                    }}
                  >
                    De-provision (still inside)
                  </Button>
                )}

              </div>

              {activeEntry.state === "INSIDE" && (
                <Alert tone="warn">
                  They are inside. De-provision becomes available once they punch out, so nobody is
                  stranded at the exit.
                </Alert>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {person.adoptedFromDevice ? (
                <Alert tone="warn">
                  Enrolled directly on a device, outside this system: their face is already on it, so
                  they can enter now with no end date. Provision them to give their access an end
                  date; until then nothing removes them.
                </Alert>
              ) : (
                <p className="text-sm text-[var(--text-muted)]">
                  Not provisioned. Provisioning loads their stored photo onto the devices — no new
                  enrolment needed.
                </p>
              )}

              <IssuePassForm person={person} onIssued={(message) => { setNotice(message); void refresh(`/api/people/${id}`); }} />
            </div>
          )}
        </Card>
      </div>

      {can("commands:view") && <Card title="Recent device commands">
        {commands.length === 0 ? (
          <Empty>No device commands for this person yet.</Empty>
        ) : (
          <Table head={["Action", "Device", "Status", "Created", "Error"]}>
            {commands.map((c) => (
              <tr key={c.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2 font-medium" title={c.type}>{commandTypeLabel(c.type)}</td>
                <td className="px-2 py-2 text-xs">{c.device?.name ?? c.device?.serialNo ?? "—"}</td>
                <td className="px-2 py-2">
                  <Badge tone={commandTone(c.status)}>{commandStatusLabel(c.status)}</Badge>
                </td>
                <td className="px-2 py-2 text-xs text-[var(--text-muted)]">
                  {formatDateTime(c.createdAt)}
                </td>
                <td className="px-2 py-2 text-xs text-[var(--danger)]">{c.lastError ?? ""}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>}

      <Card title="Provisioning history">
        {person.entries.length === 0 ? (
          <Empty>Never provisioned.</Empty>
        ) : (
          <Table head={["State", "Entry", "Blocked", "Provisioned", "Valid until"]}>
            {person.entries.map((entry: Entry) => (
              <tr key={entry.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2">
                  <Badge tone={entryTone(entry.state)}>{passStateLabel(entry.state)}</Badge>
                </td>
                <td className="px-2 py-2 text-xs">{entryModeLabel(entry.entryMode)}</td>
                <td className="px-2 py-2 text-xs">{entry.dayBlocked ? "Yes" : "No"}</td>
                <td className="px-2 py-2 text-xs text-[var(--text-muted)]">
                  {formatDateTime(entry.createdAt)}
                </td>
                <td className="px-2 py-2 text-xs text-[var(--text-muted)]">
                  {formatDateTime(entry.retentionExpiresAt)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* F3 F-g: this person's ins and outs, and their reports. */}
      {can("reports:view") && can("punches:view") && <PersonMovement personId={person.id} />}
      {can("reports:view") && <PersonReports personId={person.id} employee={person.category === "EMPLOYEE"} />}
      <PersonHistory personId={person.id} />
    </div>
  );
}

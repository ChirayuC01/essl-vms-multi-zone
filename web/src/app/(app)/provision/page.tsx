"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiError, getApiBase, getToken, type DeviceList, type OperatorOptionList, type PersonDetail } from "@/lib/api";
import { refresh, useApi } from "@/lib/swr";
import { formatDateTime, titleCase } from "@/lib/format";
import { Alert, Button, Card, Field, Input, Select, Stat } from "@/components/ui";

// Quick provision by PIN (returning visitors).
//
// The flow this exists for: a person who has been here before walks up, reads
// the number off their card, and is on the device in seconds — no searching by
// a name that might be spelled three ways.
//
// **The PIN is a lookup key, not a credential.** Anyone can say "1001". What
// authorizes the provision is the operator looking at the stored photo and at
// the person in front of them — which is why the photo is the largest thing on
// this screen and the confirm button sits underneath it. Reversing that, so
// the PIN alone triggered the provision, would turn a spoken number into
// access to the site.

const ACTIVE = ["PENDING_PROVISION", "PROVISIONED", "INSIDE", "PENDING_DEPROVISION"];

export default function QuickProvisionPage() {
  const [pin, setPin] = useState("");
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState("ONE_DAY");
  const [customEndDate, setCustomEndDate] = useState("");
  const [mode, setMode] = useState("MULTI_ENTRY");
  const [purpose, setPurpose] = useState("");
  const [personToMeetId, setPersonToMeetId] = useState("");

  // No device picker on this screen, deliberately -- the whole point is
  // speed at the gate desk. On a multi-device site (an IN gate and an OUT
  // gate) this authorizes onto every registered device automatically; with
  // one device it behaves exactly as it always has.
  const { data: deviceList } = useApi<DeviceList>("/api/devices");
  const { data: operators } = useApi<OperatorOptionList>("/api/operators/active");
  const deviceIds = (deviceList?.items ?? []).map((d) => d.id);
  // A terminal checking in but never registered is not in that list, so this
  // screen cannot load anybody onto it. On a two-gate site that is somebody
  // who can enter and not leave, so it is said here rather than only on the
  // Devices page.
  const unregisteredCount = deviceList?.unregistered.length ?? 0;

  const lookup = async (value: string) => {
    setProblem(null);
    setDone(null);
    setPerson(null);
    // Cleared per lookup: a purpose left over from the previous visitor would
    // otherwise be silently attached to this one, and it is the field an
    // incident review trusts.
    setPurpose("");
    setPersonToMeetId("");
    if (!value.trim()) return;
    setBusy(true);
    try {
      setPerson(await api<PersonDetail>(`/api/people/by-pin/${encodeURIComponent(value.trim())}`));
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "lookup failed");
    } finally {
      setBusy(false);
    }
  };

  const provision = async () => {
    if (!person) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/people/${person.id}/provision`, {
        method: "POST",
        body: {
          ...(deviceIds.length > 0 ? { deviceIds } : {}),
          retentionPolicy: policy,
          ...(policy === "CUSTOM" ? { retentionExpiresAt: customEndDate } : {}),
          entryMode: mode,
          ...(personToMeetId ? { personToMeetId } : {}),
          purposeOfVisit: purpose.trim(),
        },
      });
      setDone(
        `${person.name} is queued for the barrier. The device loads them on its next poll — usually within seconds.`,
      );
      setPerson(await api<PersonDetail>(`/api/people/by-pin/${person.esslUserId}`));
      await refresh("/api/entries");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "provision failed");
    } finally {
      setBusy(false);
    }
  };

  const active = person?.entries.find((e) => ACTIVE.includes(e.state));

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card title="Provision a returning visitor">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void lookup(pin);
          }}
        >
          <Field label="ID from their card">
            <Input
              value={pin}
              // Letters and digits: a terminal's IDs may look like WCTPL070,
              // and a numeric-only keypad here would make those people
              // unfindable at the desk. Case does not matter for the lookup.
              onChange={(e) => setPin(e.target.value.replace(/[^A-Za-z0-9]/g, ""))}
              maxLength={20}
              autoFocus
              placeholder="1001 or WCTPL070"
              className="text-lg"
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Looking up…" : "Find"}
          </Button>
        </form>
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          The PIN only finds the record. Check the photo against the person in front of you before
          provisioning — that check is the authorization.
        </p>
      </Card>

      {problem && <Alert>{problem}</Alert>}
      {done && <Alert tone="ok">{done}</Alert>}

      {person && (
        <Card title="Is this them?">
          <div className="flex flex-col gap-4 sm:flex-row">
            {person.biometric ? (
              /* eslint-disable-next-line @next/next/no-img-element -- the API
                 serves the JPEG behind a bearer token from another origin;
                 next/image cannot carry the auth header. */
              <img
                src={`${getApiBase()}/api/people/${person.id}/photo?token=${encodeURIComponent(getToken() ?? "")}`}
                alt={person.name}
                className="h-56 w-56 shrink-0 rounded-[var(--radius)] border border-[var(--border)] object-cover"
              />
            ) : (
              <div className="flex h-56 w-56 shrink-0 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--border)] text-sm text-[var(--text-muted)]">
                no photo on file
              </div>
            )}

            <div className="flex-1 space-y-3">
              <div>
                <h2 className="text-xl font-semibold">{person.name}</h2>
                {person.company && (
                  <p className="text-sm text-[var(--text-muted)]">{person.company.name}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Device ID" value={person.esslUserId} />
                <Stat label="Mobile" value={person.mobile ?? "—"} />
                <Stat label="Registered" value={formatDateTime(person.createdAt)} />
                <Stat label="Visits on record" value={person.entries.length} />
              </div>
              <Link
                href={`/people/${person.id}`}
                className="inline-block text-xs text-[var(--brand)] hover:underline"
              >
                Open full record
              </Link>
            </div>
          </div>

          {!person.isActive && (
            <div className="mt-4">
              <Alert>This person is deactivated and cannot be provisioned.</Alert>
            </div>
          )}

          {active ? (
            <div className="mt-4">
              <Alert tone="info">
                Already authorized — currently <strong>{titleCase(active.state)}</strong>
                {active.retentionExpiresAt
                  ? `, until ${formatDateTime(active.retentionExpiresAt)}`
                  : ""}
                . Nothing to do; they can walk up to the barrier.
              </Alert>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/pass/${active.id}`}>
                  <Button>Visitor pass</Button>
                </Link>
                <Link href={`/people/${person.id}/card`}>
                  <Button>Reprint their card</Button>
                </Link>
              </div>
            </div>
          ) : (
            person.isActive && (
              <div className="mt-4 border-t border-[var(--border)] pt-4">
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Keep on device for">
                    <Select value={policy} onChange={(e) => setPolicy(e.target.value)}>
                      <option value="ONE_DAY">One day</option>
                      <option value="ONE_WEEK">One week</option>
                      <option value="ONE_MONTH">One month</option>
                      <option value="QUARTERLY">Three months</option>
                      <option value="CUSTOM">Custom end date</option>
                    </Select>
                  </Field>
                  {policy === "CUSTOM" && (
                    <Field label="Custom end date" hint="Valid through 11:59 PM IST on this date.">
                      <Input
                        type="date"
                        required
                        value={customEndDate}
                        onChange={(e) => setCustomEndDate(e.target.value)}
                      />
                    </Field>
                  )}
                  <Field label="Entry mode">
                    <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                      <option value="MULTI_ENTRY">Come and go freely</option>
                      <option value="SINGLE_ENTRY">One visit today</option>
                    </Select>
                  </Field>
                </div>
                {/* Full width and below the two pickers: it is the one field
                    here that has to be typed, and a gate desk will type it
                    dozens of times a day. */}
                <div className="mt-3">
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
                </div>
                <div className="mt-3">
                  <Field label="Purpose of visit">
                    <Input
                      required
                      maxLength={200}
                      value={purpose}
                      onChange={(e) => setPurpose(e.target.value)}
                      placeholder="e.g. Lift maintenance, Block C"
                    />
                  </Field>
                </div>
                <div className="mt-3">
                  <Button
                    variant="primary"
                    disabled={busy || purpose.trim() === "" || (policy === "CUSTOM" && !customEndDate)}
                    onClick={() => void provision()}
                  >
                    {busy ? "Provisioning…" : "Yes — provision now"}
                  </Button>
                </div>
                {unregisteredCount > 0 && (
                  <div className="mt-3">
                    <Alert tone="warn">
                      {unregisteredCount === 1
                        ? "A terminal is checking in that has not been registered"
                        : `${unregisteredCount} terminals are checking in that have not been registered`}
                      , and this authorizes onto registered terminals only.{" "}
                      <Link href="/devices" className="underline">
                        Register {unregisteredCount === 1 ? "it" : "them"}
                      </Link>{" "}
                      before provisioning, or this person may be able to enter and not to leave.
                    </Alert>
                  </div>
                )}
                <p className="mt-3 text-xs text-[var(--text-muted)]">
                  Authorizes onto{" "}
                  {deviceIds.length === 1
                    ? "the registered terminal"
                    : `all ${deviceIds.length} registered terminals`}
                  . No re-enrollment: the stored photo is pushed back and the terminal rebuilds the
                  face template from it.
                </p>
              </div>
            )
          )}
        </Card>
      )}

      {!person && !problem && (
        <Card title="Never visited before?">
          <p className="text-sm text-[var(--text-muted)]">
            First-time visitors have to be registered once — after that they keep the same PIN
            forever and can be provisioned from this screen on every return.
          </p>
          <div className="mt-3 flex gap-2">
            <Link href="/people/new">
              <Button>Register a new person</Button>
            </Link>
            <Link href="/people">
              <Button>Search by name instead</Button>
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}

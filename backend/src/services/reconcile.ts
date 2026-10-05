import { CommandStatus, CommandType, EntryState, GateState, PersonCategory, type Device } from "@prisma/client";
import { buildSetGroup } from "../adms/commands.js";
import { enqueue } from "../adms/queue.js";
import type { UserRecord } from "../adms/parsers.js";
import { config } from "../config/index.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { classifyDeviceId } from "../user-id.js";
import { ACTIVE_ENTRY_STATES } from "./entries.js";

// Reconciliation and self-heal (Phase 3 Milestone 12).
//
// The database's belief about who is loaded on a terminal is the ONLY record
// of who can open a barrier — Phase 0 established the device has no native
// expiry and will happily admit someone whose window closed months ago. So
// drift between the two is not an inconsistency to tidy up later; it is the
// security control failing quietly (PRD §16 Risk #4).
//
// The two directions of drift are not equally dangerous:
//
//   - A person MISSING from the device gets turned away. Someone notices.
//   - A person still ON the device who should not be walks straight in, the
//     barrier opens, and nothing looks wrong anywhere.
//
// The second is what this file exists for.
//
// It works from observations rather than from an authoritative device dump,
// because no "list every user" command has been established on this firmware
// (see PHASE_3_PLAN.md). Every USER record the device sends — on enrollment,
// or in reply to DATA QUERY USERINFO — is one free observation, and the sweep
// below manufactures more of them at a controlled rate.

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export type DriftKind =
  | "SHOULD_NOT_BE_ON_DEVICE"
  | "WRONG_ACCESS_GROUP"
  | "UNKNOWN_PERSON_PIN"
  | "FOREIGN_PIN"
  | "UNCLAIMED_DEVICE_ID"
  | "IN_SYNC";

export interface Observation {
  pin: string;
  drift: DriftKind;
  healed: boolean;
  detail?: string;
}

/**
 * Does this ID look like one this terminal issues to people?
 *
 * NOT the same question as "is this ours". The patterns are a *hint about
 * unclaimed IDs* — `POST /api/people` accepts any ID, because the
 * device-first flow has to take whatever the terminal already used. A person
 * legitimately registered at `1001` on a terminal whose patterns say `WCTPL*`
 * is completely normal, which is why the person lookup comes first.
 *
 * So this only decides what to do with an ID that **no person claims**:
 * matching the device's person ID patterns it is an orphan worth reporting,
 * otherwise it belongs to somebody else's system and is none of our business
 * (CLAUDE.md #7).
 *
 * Using ownership-by-range as the test was a real bug: it silently excluded
 * every person registered outside the range from reconciliation - the security
 * control skipping exactly the records it was meant to cover, with no sign
 * anywhere that it had. The patterns that replaced the range have the same
 * job and the same restriction: they decide what to do with an UNCLAIMED id,
 * never whether a person of ours is reconciled.
 */

/**
 * Compare one USER record the device reported against what we believe, and
 * correct it where the correction is unambiguous.
 *
 * Deliberately conservative. It will remove a user it can prove is a stale
 * person of ours, and fix an access group it owns — but it will never delete
 * a PIN it cannot identify. On a shared terminal that could be an employee,
 * and deleting someone else's record is a worse outcome than reporting an
 * anomaly and letting a person decide.
 */
export async function reconcileUserRecord(
  device: Device,
  user: UserRecord,
  log: Logger,
): Promise<Observation> {
  // Ownership is decided by whether a person record claims this PIN, never by
  // the allocation range. Looked up first for exactly that reason.
  const person = await prisma.person.findFirst({
    where: { esslUserId: { equals: user.pin, mode: "insensitive" } },
    include: {
      entries: {
        where: { state: { in: [...ACTIVE_ENTRY_STATES] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        // Whether THIS terminal should hold them: a pass can be active while
        // its face is meant to be gone from one terminal (a single-entry
        // entry gate already used, an exit gate still waiting for the code).
        include: { gates: { where: { deviceId: device.id }, take: 1 } },
      },
      employeeAccess: { where: { deviceId: device.id }, take: 1 },
    },
  });

  if (!person) {
    // Nobody claims it. An unmatched ID must remain available for admin review,
    // but it is never pulled, changed, or deleted: it may belong to another
    // roster on a shared terminal.
    if (classifyDeviceId(user.pin, device.employeeIdPatterns, device.visitorIdPatterns) === null) {
      await prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.RECONCILE_DRIFT_FOUND,
          entityType: "device",
          entityId: device.id,
          detail: { pin: user.pin, drift: "UNCLAIMED_DEVICE_ID", deviceName: user.name },
        }),
      });
      return { pin: user.pin, drift: "UNCLAIMED_DEVICE_ID", healed: false };
    }

    // Ours by pattern but unclaimed: a person deleted from the database by
    // hand, or someone enrolled at the terminal we have not registered yet.
    // Reported, never auto-removed: we cannot prove what it is.
    log.warn(
      { pin: user.pin, device: device.serialNo, name: user.name },
      "device holds an ID matching this device's person patterns that no person claims — investigate; not removed automatically",
    );
    await prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.RECONCILE_DRIFT_FOUND,
        entityType: "device",
        entityId: device.id,
        detail: { pin: user.pin, drift: "UNKNOWN_PERSON_PIN", deviceName: user.name },
      }),
    });
    return { pin: user.pin, drift: "UNKNOWN_PERSON_PIN", healed: false };
  }

  const entry = person.entries[0];
  const employeeAccess = person.employeeAccess[0];

  // A command already in flight for this entry means the device and database
  // are *expected* to disagree right now. Correcting mid-flight would fight
  // the queue and could produce a delete racing a create.
  if (entry) {
    const inFlight = await prisma.syncCommand.count({
      where: {
        entryId: entry.id,
        status: { in: [CommandStatus.PENDING, CommandStatus.SENT, CommandStatus.RETRY] },
      },
    });
    if (inFlight > 0) return { pin: user.pin, drift: "IN_SYNC", healed: false };
  }
  const employeeInFlight = await prisma.syncCommand.count({
    where: {
      personId: person.id,
      targetDeviceId: device.id,
      entryId: null,
      status: { in: [CommandStatus.PENDING, CommandStatus.SENT, CommandStatus.RETRY] },
    },
  });
  if (employeeInFlight > 0) return { pin: user.pin, drift: "IN_SYNC", healed: false };

  if (person.category === PersonCategory.EMPLOYEE && employeeAccess?.desiredAccess) {
    if (user.grp !== null && user.grp !== device.normalGroupId) {
      await enqueue({
        type: CommandType.UNBLOCK,
        targetDeviceId: device.id,
        personId: person.id,
        payload: { pin: user.pin, grp: device.normalGroupId },
        idempotencyKey: `employee-reconcile-group:${person.id}:${device.id}:${Date.now()}`,
      });
      return { pin: user.pin, drift: "WRONG_ACCESS_GROUP", healed: true };
    }
    if (!employeeAccess.provisioned) {
      await prisma.employeeDeviceAccess.update({ where: { id: employeeAccess.id }, data: { provisioned: true } });
    }
    return { pin: user.pin, drift: "IN_SYNC", healed: false };
  }

  // No active entry, or an active pass that should not be on this terminal
  // right now, yet the device still has them. This is the dangerous case:
  // working access at a barrier nothing authorizes.
  const gate = entry?.gates[0];
  const meantToBeHere = gate !== undefined && (gate.state === GateState.LOADING || gate.state === GateState.LOADED);
  if (!entry || entry.state === EntryState.REGISTERED || !meantToBeHere) {
    // ...unless we never put them there.
    //
    // A person adopted from an unclaimed enrollment is on the device because
    // somebody stood at the terminal and enrolled them, possibly long before
    // this installation existed. Removing that face is destroying a client's
    // own enrollment on the strength of an entry record that was never
    // supposed to exist yet — and the trigger would be innocuous: any USER
    // record, from a menu edit or a roster backfill scan, arriving after
    // registration but before an operator gets round to provisioning.
    //
    // This function removes only what it can prove is a stale record of
    // ours. Here the proof runs the other way, so it reports and stops.
    // Provisioning them clears the flag and restores the full self-heal.
    if (person.adoptedFromDevice) {
      log.warn(
        { pin: user.pin, device: device.serialNo },
        "device holds a person enrolled at the terminal and never provisioned by us — " +
          "reported, not removed; provision them to bring them under a retention window",
      );
      await prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.RECONCILE_DRIFT_FOUND,
          entityType: "person",
          entityId: person.id,
          detail: { pin: user.pin, drift: "SHOULD_NOT_BE_ON_DEVICE", adoptedFromDevice: true },
        }),
      });
      return {
        pin: user.pin,
        drift: "SHOULD_NOT_BE_ON_DEVICE",
        healed: false,
        detail: "enrolled on the device, never provisioned by us — not removed automatically",
      };
    }

    // Suppress only while a removal is ACTUALLY IN FLIGHT — never because one
    // succeeded earlier.
    //
    // This was originally keyed on an hourly bucket, which was wrong in a way
    // that made the whole control useless: once a removal completed, every
    // further observation in that hour collapsed onto the finished command and
    // queued nothing. If the user came back — which is precisely the drift
    // being defended against — the log still said "removing" and the device
    // kept them. Seen on hardware: a successful DEPROVISION, then a re-added
    // user that was never touched again.
    const alreadyGoing = await prisma.syncCommand.count({
      where: {
        personId: person.id,
        targetDeviceId: device.id,
        type: CommandType.DEPROVISION,
        status: { in: [CommandStatus.PENDING, CommandStatus.SENT, CommandStatus.RETRY] },
      },
    });
    if (alreadyGoing > 0) {
      return { pin: user.pin, drift: "SHOULD_NOT_BE_ON_DEVICE", healed: false, detail: "removal already in flight" };
    }

    await enqueue({
      type: CommandType.DEPROVISION,
      targetDeviceId: device.id,
      // countedOnDevice false: our records already show them off the device,
      // so the face count was given back when the entry closed. Decrementing
      // again here would drive it below the truth.
      payload: { pin: user.pin, countedOnDevice: false },
      // Unique per observation. Each sighting of a user who should not be
      // there is its own event deserving its own removal; the in-flight check
      // above is what prevents duplicates, not the key.
      idempotencyKey: `reconcile-remove:${device.id}:${user.pin}:${Date.now()}`,
      personId: person.id,
      // No initiatedById: omitted means system-initiated, which is what a
      // self-heal is. Nobody decided this; the system noticed.
    });

    // Logged AFTER the command exists, so the line reports what happened
    // rather than what was intended. The earlier version printed first and
    // was therefore capable of announcing a removal it never queued.
    log.warn(
      { pin: user.pin, device: device.serialNo },
      "device holds a person with no active authorization — removal queued (reconciliation)",
    );
    await prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.RECONCILE_HEALED,
        entityType: "person",
        entityId: person.id,
        detail: { pin: user.pin, drift: "SHOULD_NOT_BE_ON_DEVICE", action: "DEPROVISION" },
      }),
    });
    return { pin: user.pin, drift: "SHOULD_NOT_BE_ON_DEVICE", healed: true };
  }

  // Present and authorized — is their access group what it should be?
  const expectedGrp = entry.dayBlocked ? device.blockedGroupId : device.normalGroupId;
  if (user.grp !== null && user.grp !== expectedGrp) {
    buildSetGroup({ pin: user.pin, grp: expectedGrp }); // validate before queueing
    // Unique per observation, for the same reason as the removal above: a
    // group that drifts back after a correction must be corrected again, and
    // the in-flight check earlier in this function is what stops duplicates.
    await enqueue({
      type: entry.dayBlocked ? CommandType.BLOCK : CommandType.UNBLOCK,
      targetDeviceId: device.id,
      payload: { pin: user.pin, grp: expectedGrp },
      idempotencyKey: `reconcile-grp:${entry.id}:${device.id}:${expectedGrp}:${Date.now()}`,
      entryId: entry.id,
      personId: person.id,
    });
    log.warn(
      { pin: user.pin, onDevice: user.grp, expected: expectedGrp },
      "person was in the wrong access group on the device — correction queued (reconciliation)",
    );
    await prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.RECONCILE_HEALED,
        entityType: "entry",
        entityId: entry.id,
        detail: {
          pin: user.pin,
          drift: "WRONG_ACCESS_GROUP",
          onDevice: user.grp,
          expected: expectedGrp,
        },
      }),
    });
    return {
      pin: user.pin,
      drift: "WRONG_ACCESS_GROUP",
      healed: true,
      detail: `${user.grp} → ${expectedGrp}`,
    };
  }

  return { pin: user.pin, drift: "IN_SYNC", healed: false };
}

// ---------------------------------------------------------------------------
// Face-count drift
// ---------------------------------------------------------------------------

export interface FaceCountDrift {
  deviceId: string;
  serialNo: string;
  name: string | null;
  onDevice: number;
  expected: number;
  /** Positive = the device holds faces we did not put there. */
  excess: number;
}

/**
 * Compare the device's own face count against how many people we believe are
 * loaded on it.
 *
 * This is the only signal available for "something is on the device that we
 * do not know about" without a way to enumerate the roster. It cannot say
 * *who*, but it can say *that* — and a count that is quietly wrong is exactly
 * the condition nobody would otherwise notice.
 *
 * `facesUsed` is only meaningful straight after an `INFO`, which is where the
 * device reports it.
 */
export async function faceCountDrift(): Promise<FaceCountDrift[]> {
  const devices = await prisma.device.findMany({
    select: { id: true, serialNo: true, name: true, facesUsed: true },
  });
  if (devices.length === 0) return [];

  // One grouped query for every device rather than a count each. A gate
  // counts from its load acknowledgement until its removal acknowledgement,
  // exactly when facesUsed moves.
  const loaded = await prisma.passGate.groupBy({
    by: ["deviceId"],
    where: { state: { in: [GateState.LOADED, GateState.UNLOADING] } },
    _count: { _all: true },
  });
  const expectedBy = new Map(loaded.map((r) => [r.deviceId, r._count._all]));
  const employees = await prisma.employeeDeviceAccess.groupBy({
    by: ["deviceId"],
    where: { desiredAccess: true, provisioned: true },
    _count: { _all: true },
  });
  for (const row of employees) expectedBy.set(row.deviceId, (expectedBy.get(row.deviceId) ?? 0) + row._count._all);

  return devices
    .map((d) => {
      const expected = expectedBy.get(d.id) ?? 0;
      return {
        deviceId: d.id,
        serialNo: d.serialNo,
        name: d.name,
        onDevice: d.facesUsed,
        expected,
        excess: d.facesUsed - expected,
      };
    })
    .filter((d) => d.excess !== 0);
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  queried: number;
  devices: number;
}

/**
 * Ask the device about a slice of the people we believe it holds.
 *
 * Rate-limited on purpose. Every query is a command the device collects on a
 * poll, so reconciling a whole roster at once would fill the queue and starve
 * real work behind it. A slice per run, oldest-checked first, covers the
 * roster over time without ever competing with a provision an operator is
 * waiting on.
 *
 * Recently closed entries are included: those are the ones whose removal
 * might have been missed, and they are precisely the dangerous direction.
 */
export async function reconcileSweep(
  log: Logger,
  limit = 25,
): Promise<ReconcileResult> {
  const devices = await prisma.device.findMany({ select: { id: true, serialNo: true } });
  if (devices.length === 0) return { queried: 0, devices: 0 };

  // One row per (person, device): an entry can span more than one device (an
  // IN terminal and an OUT terminal), and reconciliation has to check the
  // person's presence on EVERY device it was provisioned onto, not just
  // whichever device happened to receive the latest PROVISION command.
  const candidates = await prisma.$queryRaw<
    { personId: string; esslUserId: string; targetDeviceId: string }[]
  >`
    SELECT DISTINCT ON (q."esslUserId", q."targetDeviceId") *
      FROM (
        SELECT v."id" AS "personId", v."essl_user_id" AS "esslUserId",
               sc."target_device_id" AS "targetDeviceId", e."created_at" AS changed_at
          FROM "entry" e
          JOIN "person" v ON v."id" = e."person_id"
          JOIN "sync_command" sc ON sc."entry_id" = e."id" AND sc."type" = 'PROVISION'::"CommandType"
         WHERE e."state" IN ('PROVISIONED'::"EntryState", 'INSIDE'::"EntryState", 'REGISTERED'::"EntryState")
        UNION ALL
        SELECT v."id", v."essl_user_id", a."device_id", a."updated_at"
          FROM "employee_device_access" a
          JOIN "person" v ON v."id" = a."person_id"
         WHERE a."desired_access" = true
      ) q
     ORDER BY q."esslUserId", q."targetDeviceId", q.changed_at DESC
     LIMIT ${limit}
  `;

  let queried = 0;
  const bucket = Math.floor(Date.now() / 3_600_000);
  for (const c of candidates) {
    const command = await enqueue({
      type: CommandType.QUERY_USER,
      targetDeviceId: c.targetDeviceId,
      payload: { pin: c.esslUserId },
      // Hourly bucket: a sweep that runs often must not queue the same
      // question repeatedly, and the answer does not change minute to minute.
      idempotencyKey: `reconcile-query:${c.targetDeviceId}:${c.esslUserId}:${bucket}`,
      personId: c.personId,
    });
    if (command.status === CommandStatus.PENDING) queried += 1;
  }

  // This firmware cannot answer "missing" for a QUERY_USER reliably. Re-send
  // the desired employee state once per hour: UPDATE is idempotent and repairs
  // a device purge without putting VMS in the barrier path.
  const permanent = await prisma.employeeDeviceAccess.findMany({
    where: { desiredAccess: true, person: { isActive: true, biometric: { isNot: null } } },
    include: { person: { include: { biometric: true } }, device: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  for (const access of permanent) {
    const photo = access.person.biometric;
    if (!photo) continue;
    await enqueue({
      type: CommandType.PROVISION,
      targetDeviceId: access.deviceId,
      personId: access.personId,
      payload: { pin: access.person.esslUserId, name: access.person.name, grp: access.device.normalGroupId },
      idempotencyKey: `employee-self-heal:${access.id}:${bucket}`,
    });
    await enqueue({
      type: CommandType.PUSH_PHOTO,
      targetDeviceId: access.deviceId,
      personId: access.personId,
      payload: { pin: access.person.esslUserId, photoPath: photo.photoPath },
      idempotencyKey: `employee-self-heal-photo:${access.id}:${bucket}`,
    });
  }

  if (queried > 0) {
    log.info({ queried, devices: devices.length }, "reconciliation sweep queued roster checks");
  }
  return { queried, devices: devices.length };
}

// ---------------------------------------------------------------------------
// Punch-loss detection
// ---------------------------------------------------------------------------

export interface PunchGap {
  deviceId: string;
  serialNo: string;
  name: string | null;
  baselineAt: Date;
  deviceGained: number;
  weStored: number;
  /** Records the device logged that never reached us. */
  missing: number;
}

/**
 * Have we lost punches?
 *
 * `INFO` reports `TransactionCount`, the number of attendance records the
 * device holds. Comparing that to our row count directly is meaningless — the
 * device's log outlives everything, including the master database being
 * wiped, so it counts history this installation never saw. What is meaningful
 * is that from a fixed baseline the two must GROW together.
 *
 * Known limits, stated rather than papered over:
 *   - The device log wraps at capacity. Once it does, its count stops rising
 *     and this measure silently under-reports. Capacity is ~150,000 records,
 *     so at 1,500 movements a day that is months, not days — but it is not
 *     never, and re-baselining is the answer.
 *   - Clearing the device log invalidates the baseline. So does restoring the
 *     database from a backup, which is the very event this is meant to catch;
 *     the baseline must be re-taken afterwards, deliberately.
 *   - It counts records, not identities. It says punches were lost, never
 *     whose.
 *
 * Requires a recent `INFO` — the count is only as fresh as the last refresh.
 */
/**
 * How many punches this installation has ever accounted for on a device.
 *
 * Deliberately NOT `punch_event` rows. Retention summarises old punches and
 * deletes the raw rows, so a row count falls over time — and the gap detector
 * read that fall as punches never delivered. A live system reported six
 * missing the day after a retention pass, with nothing actually lost.
 *
 * Counting stored rows plus summarised ones makes the measure durable across
 * pruning, which it has to be: the two jobs otherwise fight, and the one that
 * loses is the alarm.
 */
async function accountedFor(deviceId: string): Promise<number> {
  const [rows, rolled] = await Promise.all([
    prisma.punchEvent.count({ where: { deviceId } }),
    prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COALESCE(SUM(COALESCE(("device_punch_counts" ->> ${deviceId})::int, 0)), 0)::bigint AS total
        FROM "attendance_day_summary"
    `,
  ]);
  return rows + Number(rolled[0]?.total ?? 0n);
}

export async function punchGaps(): Promise<PunchGap[]> {
  const devices = await prisma.device.findMany({
    where: { punchBaselineAt: { not: null } },
    select: {
      id: true,
      serialNo: true,
      name: true,
      lastInfo: true,
      punchBaselineAt: true,
      punchBaselineDeviceCount: true,
      punchBaselineLocalCount: true,
    },
  });
  if (devices.length === 0) return [];

  const gaps: PunchGap[] = [];
  for (const d of devices) {
    const reported = Number((d.lastInfo as Record<string, string> | null)?.["TransactionCount"]);
    if (!Number.isInteger(reported)) continue;

    const deviceGained = reported - (d.punchBaselineDeviceCount ?? 0);
    const weStored = (await accountedFor(d.id)) - (d.punchBaselineLocalCount ?? 0);
    // Negative means the device log was cleared or wrapped; that is a
    // re-baseline situation, not a loss, and reporting it as one would be
    // worse than saying nothing.
    if (deviceGained <= 0) continue;
    const missing = deviceGained - weStored;
    if (missing <= 0) continue;

    gaps.push({
      deviceId: d.id,
      serialNo: d.serialNo,
      name: d.name,
      baselineAt: d.punchBaselineAt as Date,
      deviceGained,
      weStored,
      missing,
    });
  }
  return gaps;
}

/**
 * Fix the point from which punch growth is compared.
 *
 * Taken automatically the first time a device reports a `TransactionCount`,
 * and re-takeable by hand — which is required after clearing the device log
 * or restoring the database, because both make the old baseline a lie.
 */
export async function setPunchBaseline(deviceId: string): Promise<PunchGap | null> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { id: true, serialNo: true, name: true, lastInfo: true },
  });
  if (!device) return null;
  const reported = Number((device.lastInfo as Record<string, string> | null)?.["TransactionCount"]);
  if (!Number.isInteger(reported)) return null;

  const local = await accountedFor(deviceId);
  const now = new Date();
  await prisma.device.update({
    where: { id: deviceId },
    data: {
      punchBaselineAt: now,
      punchBaselineDeviceCount: reported,
      punchBaselineLocalCount: local,
    },
  });
  return {
    deviceId: device.id,
    serialNo: device.serialNo,
    name: device.name,
    baselineAt: now,
    deviceGained: 0,
    weStored: 0,
    missing: 0,
  };
}

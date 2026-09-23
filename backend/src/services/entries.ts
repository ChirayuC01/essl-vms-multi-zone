import { open } from "node:fs/promises";
import {
  CommandStatus,
  CommandType,
  EntryMode,
  EntryState,
  PersonCategory,
  RetentionPolicy,
  type Device,
  type Entry,
  type SyncCommand,
} from "@prisma/client";
import {
  CommandValidationError,
  buildCreateUser,
  buildDeleteUser,
  buildSetGroup,
} from "../adms/commands.js";
import { enqueue, enqueueIn } from "../adms/queue.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { publish } from "../events/bus.js";
import { assertSingleEntrySupported } from "./entry-modes.js";
import { ServiceError } from "./errors.js";

// The authorization lifecycle (Phase 1 Milestone 4).
//
// Every rule that protects the barrier lives here rather than in a route
// handler, because Phase 2's expiry sweeper and daily-reset jobs must obey
// exactly the same ones:
//
//   - provisioning a person IS the authorization decision (CLAUDE.md #9)
//   - a person who is INSIDE is never de-provisioned — defer to their OUT
//   - every device write goes through the command queue (#8)
//   - commands are validated before they can exist (#10): the device answers
//     Return=0 to nonsense, so nothing unvalidated may reach it
//
// Device state changes only when the *device* confirms it. Requesting a block
// does not mark the entry blocked; the acknowledgement does. The window
// between the two is visible in the command queue, which is the point.

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/** States in which a person is loaded on, or moving to/from, a device. */
export const ACTIVE_ENTRY_STATES = [
  EntryState.PENDING_PROVISION,
  EntryState.PROVISIONED,
  EntryState.INSIDE,
  EntryState.PENDING_DEPROVISION,
] as const;

// ---------------------------------------------------------------------------
// Retention windows
// ---------------------------------------------------------------------------

const RETENTION_DAYS: Record<RetentionPolicy, number | null> = {
  ONE_DAY: 1,
  ONE_WEEK: 7,
  ONE_MONTH: 30,
  QUARTERLY: 90,
  CUSTOM: null,
};

const IST_OFFSET_MS = 330 * 60_000;

/** End of an IST calendar date, returned as the UTC instant stored by Prisma. */
function endOfIstDay(date: Date, inclusiveDays = 1): Date {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + inclusiveDays) -
      IST_OFFSET_MS -
      1,
  );
}

/**
 * Resolve the retention window's end.
 *
 * There is no device-native expiry — Phase 0 proved `EndDatetime` is stored
 * and ignored — so this value is enforced entirely by the sweeper in
 * `jobs/expiry.ts`, which is the only thing that removes a lapsed person from
 * a terminal.
 */
export function resolveRetentionExpiry(
  policy: RetentionPolicy,
  explicit: Date | undefined,
  now: Date = new Date(),
): Date {
  if (policy === RetentionPolicy.CUSTOM) {
    if (!explicit) {
      throw new ServiceError(400, "retentionExpiresAt is required when retentionPolicy is CUSTOM");
    }
    const expiry = endOfIstDay(explicit);
    if (expiry.getTime() <= now.getTime()) {
      throw new ServiceError(400, "custom retention end date must be today or later in IST");
    }
    return expiry;
  }
  if (explicit) {
    throw new ServiceError(
      400,
      "retentionExpiresAt is only accepted with retentionPolicy CUSTOM",
    );
  }
  const days = RETENTION_DAYS[policy];
  if (days === null) throw new ServiceError(400, `unsupported retention policy: ${policy}`);
  return endOfIstDay(now, days);
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

/**
 * Pick the single device a diagnostic action targets (e.g. "ask this device
 * what it thinks it has"). With a single registered device the caller may
 * omit it, otherwise it is required — guessing which barrier is meant is not
 * acceptable.
 */
export async function resolveTargetDevice(deviceId: string | undefined): Promise<Device> {
  if (deviceId) {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new ServiceError(404, "device not found");
    return device;
  }
  const devices = await prisma.device.findMany({ take: 2, orderBy: { createdAt: "asc" } });
  if (devices.length === 0) {
    throw new ServiceError(409, "no device is registered — adopt a device before provisioning");
  }
  if (devices.length > 1) {
    throw new ServiceError(400, "deviceId is required when more than one device is registered");
  }
  return devices[0] as Device;
}

/**
 * Pick the devices an authorization acts on. An entry can span more than one
 * device — an IN terminal and an OUT terminal covering one logical entrance —
 * so this is a set, not a single pick. With exactly one device registered the
 * caller may omit the list entirely and it behaves exactly as a single-device
 * site always has; with more than one, an explicit list is required —
 * guessing which barriers a person is authorized at is not acceptable.
 */
export async function resolveTargetDevices(deviceIds: string[] | undefined): Promise<Device[]> {
  if (deviceIds && deviceIds.length > 0) {
    const unique = [...new Set(deviceIds)];
    const devices = await prisma.device.findMany({ where: { id: { in: unique } } });
    if (devices.length !== unique.length) {
      throw new ServiceError(404, "one or more devices not found");
    }
    return devices;
  }
  const devices = await prisma.device.findMany({ orderBy: { createdAt: "asc" } });
  if (devices.length === 0) {
    throw new ServiceError(409, "no device is registered — adopt a device before provisioning");
  }
  if (devices.length > 1) {
    throw new ServiceError(400, "deviceIds is required when more than one device is registered");
  }
  return devices;
}

/**
 * Every device an entry is loaded on, taken from its PROVISION commands.
 * Deliberately derived rather than stored on the entry: an entry can span
 * several devices (an IN terminal and an OUT terminal), and a single
 * device_id column could not represent that.
 */
async function devicesForEntry(entryId: string): Promise<Device[]> {
  const commands = await prisma.syncCommand.findMany({
    where: { entryId, type: CommandType.PROVISION },
    orderBy: { seq: "asc" },
    include: { device: true },
  });
  if (commands.length === 0) {
    throw new ServiceError(409, "entry has no provisioning command — cannot determine its device(s)");
  }
  const seen = new Map<string, Device>();
  for (const c of commands) if (!seen.has(c.device.id)) seen.set(c.device.id, c.device);
  return [...seen.values()];
}

/**
 * The enrollment photo must be present and readable *now*, not at send time.
 * Left to the queue, a missing or corrupt file becomes a FAILED command
 * minutes later; caught here the operator is told while they are still
 * looking at the person.
 */
async function assertPhotoUsable(photoPath: string): Promise<void> {
  let handle;
  try {
    handle = await open(photoPath, "r");
  } catch {
    throw new ServiceError(409, `enrollment photo is missing from disk (${photoPath})`);
  }
  try {
    const magic = Buffer.alloc(2);
    const { bytesRead } = await handle.read(magic, 0, 2, 0);
    if (bytesRead < 2 || magic[0] !== 0xff || magic[1] !== 0xd8) {
      throw new ServiceError(422, "enrollment photo on disk is not a JPEG — re-upload it");
    }
  } finally {
    await handle.close();
  }
}

/**
 * Announce an entry's current state on the live feed. Always called *after*
 * the transaction commits and re-read from the database, so the feed can
 * never describe a change that rolled back.
 */
async function publishEntryById(entryId: string): Promise<void> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, personId: true, state: true, dayBlocked: true },
  });
  if (entry) publish("entry", entry);
}

/** Turn a builder's refusal into a 400 the operator can read. */
function validateWire(build: () => string, what: string): void {
  try {
    build();
  } catch (err) {
    if (err instanceof CommandValidationError) {
      throw new ServiceError(400, `cannot ${what}: ${err.message}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Provision
// ---------------------------------------------------------------------------

export interface ProvisionInput {
  personId: string;
  deviceIds?: string[] | undefined;
  retentionPolicy: RetentionPolicy;
  retentionExpiresAt?: Date | undefined;
  entryMode: EntryMode;
  /** Why this visit was authorized. Required — see the API schema. */
  purposeOfVisit: string;
  /** Optional active operator the visitor is coming to meet. */
  personToMeetId?: string | undefined;
  expectedInAt?: Date | undefined;
  actorId?: string | undefined;
}

export interface ProvisionResult {
  entry: Entry;
  devices: Device[];
  commands: SyncCommand[];
}

/**
 * Authorize a person onto one or more devices: create the entry, then queue
 * a user create followed by a photo push for each device. Order is
 * load-bearing within a device — the user must exist there before a photo can
 * attach to it — and is guaranteed by the queue's seq ordering, not by
 * timing. Across devices there is no ordering requirement: an IN terminal and
 * an OUT terminal are independent rosters that happen to share one person.
 */
export async function provisionPerson(input: ProvisionInput): Promise<ProvisionResult> {
  // Pure request validation first: a malformed retention window should be
  // answered as the 400 it is, not masked by whichever state check happens
  // to fail first.
  const retentionExpiresAt = resolveRetentionExpiry(
    input.retentionPolicy,
    input.retentionExpiresAt,
  );

  const person = await prisma.person.findUnique({
    where: { id: input.personId },
    include: { biometric: true },
  });
  if (!person) throw new ServiceError(404, "person not found");
  if (!person.isActive) {
    throw new ServiceError(409, "person is deactivated — reactivate before provisioning");
  }
  if (person.category !== PersonCategory.VISITOR) {
    throw new ServiceError(409, "employees use permanent device access, not visitor entries");
  }
  if (!person.mobile || !person.companyId || !person.departmentId || (!person.aadharNumber && !person.panNumber)) {
    throw new ServiceError(409, "complete the visitor profile before provisioning");
  }
  if (!person.biometric) {
    throw new ServiceError(
      409,
      "person has no enrollment photo — upload one or enroll them on the device first",
    );
  }
  await assertPhotoUsable(person.biometric.photoPath);

  if (
    input.personToMeetId &&
    !(await prisma.appUser.findFirst({ where: { id: input.personToMeetId, isActive: true } }))
  ) {
    throw new ServiceError(400, "person to meet must be an active operator");
  }

  const active = await prisma.entry.findFirst({
    where: { personId: person.id, state: { in: [...ACTIVE_ENTRY_STATES] } },
    orderBy: { createdAt: "desc" },
  });
  if (active) {
    throw new ServiceError(
      409,
      `person already has an active entry (${active.state}) — de-provision it first`,
    );
  }

  const devices = await resolveTargetDevices(input.deviceIds);

  // Every device is checked before anything is written. A person should
  // never land on two of three intended devices because the third failed a
  // check after the first two were already queued — that is a half-done
  // authorization nobody asked for and no operator would notice mid-click.
  for (const device of devices) {
    // Refused before anything is written: a SINGLE_ENTRY authorization on a
    // terminal that can swallow the OUT punch would enforce nothing, and
    // would do so silently. Better to fail here, where an operator is
    // looking at it, than to hand out an entry mode that quietly does not
    // apply.
    await assertSingleEntrySupported(device, input.entryMode);

    if (device.maxFaces !== null && device.facesUsed >= device.maxFaces) {
      throw new ServiceError(
        409,
        `device ${device.serialNo} is at face capacity (${device.facesUsed}/${device.maxFaces})`,
      );
    }

    // Validate before anything is written, let alone sent (CLAUDE.md #10).
    // The access group is per-device, so this must run for each one.
    validateWire(
      () =>
        buildCreateUser({ pin: person.esslUserId, name: person.name, grp: device.normalGroupId }),
      "provision this person",
    );
  }

  const photoPath = person.biometric.photoPath;

  return prisma.$transaction(async (tx) => {
    const entry = await tx.entry.create({
      data: {
        personId: person.id,
        state: EntryState.PENDING_PROVISION,
        retentionPolicy: input.retentionPolicy,
        retentionExpiresAt,
        entryMode: input.entryMode,
        purposeOfVisit: input.purposeOfVisit,
        personToMeetId: input.personToMeetId ?? null,
        expectedInAt: input.expectedInAt ?? null,
        authorizedById: input.actorId ?? null,
      },
    });

    // Taking ownership. However this person's face first got onto a terminal,
    // from here it is loaded because we said so — which is what restores
    // reconciliation's licence to remove them when this entry ends.
    if (person.adoptedFromDevice) {
      await tx.person.update({
        where: { id: person.id },
        data: { adoptedFromDevice: false },
      });
    }

    const commands: SyncCommand[] = [];
    for (const device of devices) {
      commands.push(
        await enqueueIn(tx, {
          type: CommandType.PROVISION,
          targetDeviceId: device.id,
          payload: { pin: person.esslUserId, name: person.name, grp: device.normalGroupId },
          // Scoped per device: the same entry gets one PROVISION per device it
          // spans, and each needs its own idempotency key or the second
          // device's command would collide with the first's.
          idempotencyKey: `provision:${entry.id}:${device.id}`,
          entryId: entry.id,
          personId: person.id,
          initiatedById: input.actorId,
        }),
      );
      commands.push(
        await enqueueIn(tx, {
          type: CommandType.PUSH_PHOTO,
          targetDeviceId: device.id,
          // The JPEG is read from disk at send time, never carried in the
          // row — the photo stays the artifact on disk, the DB stays lean.
          payload: { pin: person.esslUserId, photoPath },
          idempotencyKey: `push-photo:${entry.id}:${device.id}`,
          entryId: entry.id,
          personId: person.id,
          initiatedById: input.actorId,
        }),
      );
    }

    await tx.auditLog.create({
      data: auditRow({
        action: AuditAction.ENTRY_PROVISION_REQUESTED,
        entityType: "entry",
        entityId: entry.id,
        detail: {
          personId: person.id,
          esslUserId: person.esslUserId,
          deviceIds: devices.map((d) => d.id),
          deviceSerialNos: devices.map((d) => d.serialNo),
          retentionPolicy: input.retentionPolicy,
          retentionExpiresAt: retentionExpiresAt.toISOString(),
          entryMode: input.entryMode,
          personToMeetId: input.personToMeetId ?? null,
        },
        actorId: input.actorId ?? null,
      }),
    });

    return { entry, devices, commands };
  });
}

// ---------------------------------------------------------------------------
// Block / unblock — a pure authorization change; the biometric is untouched
// ---------------------------------------------------------------------------

export async function setEntryBlocked(
  entryId: string,
  blocked: boolean,
  actorId?: string,
): Promise<{ entry: Entry; devices: Device[]; commands: SyncCommand[] }> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { person: true },
  });
  if (!entry) throw new ServiceError(404, "entry not found");
  if (entry.state !== EntryState.PROVISIONED && entry.state !== EntryState.INSIDE) {
    throw new ServiceError(
      409,
      `entry is ${entry.state} — block/unblock applies only to a person loaded on the device`,
    );
  }
  if (entry.dayBlocked === blocked) {
    throw new ServiceError(409, blocked ? "entry is already blocked" : "entry is not blocked");
  }

  const inFlight = await prisma.syncCommand.count({
    where: {
      entryId,
      type: { in: [CommandType.BLOCK, CommandType.UNBLOCK] },
      status: { in: [CommandStatus.PENDING, CommandStatus.SENT, CommandStatus.RETRY] },
    },
  });
  if (inFlight > 0) {
    throw new ServiceError(409, "a block/unblock is already in flight for this entry");
  }

  const devices = await devicesForEntry(entryId);
  for (const device of devices) {
    const grp = blocked ? device.blockedGroupId : device.normalGroupId;
    validateWire(
      () => buildSetGroup({ pin: entry.person.esslUserId, grp }),
      blocked ? "block this person" : "unblock this person",
    );
  }

  const commands: SyncCommand[] = [];
  for (const device of devices) {
    const grp = blocked ? device.blockedGroupId : device.normalGroupId;
    commands.push(
      await enqueue({
        type: blocked ? CommandType.BLOCK : CommandType.UNBLOCK,
        targetDeviceId: device.id,
        payload: { pin: entry.person.esslUserId, grp },
        // Unique per request and per device: an entry is legitimately
        // blocked and unblocked many times over its life (the daily reset
        // does exactly that), and a two-device entry needs one command per
        // device, not one shared between them. The in-flight check above is
        // what stops a double click, not this key.
        idempotencyKey: `${blocked ? "block" : "unblock"}:${entryId}:${device.id}:${Date.now()}`,
        entryId,
        personId: entry.personId,
        initiatedById: actorId,
      }),
    );
  }

  await prisma.auditLog.create({
    data: auditRow({
      action: blocked ? AuditAction.ENTRY_BLOCK_REQUESTED : AuditAction.ENTRY_UNBLOCK_REQUESTED,
      entityType: "entry",
      entityId: entryId,
      detail: { esslUserId: entry.person.esslUserId, deviceIds: devices.map((d) => d.id) },
      actorId: actorId ?? null,
    }),
  });

  return { entry, devices, commands };
}

// ---------------------------------------------------------------------------
// De-provision — removes from the device only; the DB record lives forever
// ---------------------------------------------------------------------------

export async function deprovisionEntry(
  entryId: string,
  actorId?: string,
): Promise<{ entry: Entry; devices: Device[]; commands: SyncCommand[] }> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { person: true },
  });
  if (!entry) throw new ServiceError(404, "entry not found");

  // The rule that must never be bypassed: removing a person's credential
  // while they are inside the site strands them at the exit barrier.
  if (entry.state === EntryState.INSIDE) {
    throw new ServiceError(
      409,
      "person is INSIDE — de-provisioning is deferred until they punch OUT",
    );
  }
  if (entry.state === EntryState.PENDING_DEPROVISION) {
    throw new ServiceError(409, "entry is already de-provisioning");
  }
  if (entry.state === EntryState.REGISTERED) {
    throw new ServiceError(409, "entry is already closed — the person is not on any device");
  }

  const devices = await devicesForEntry(entryId);
  validateWire(
    () => buildDeleteUser({ pin: entry.person.esslUserId }),
    "de-provision this person",
  );

  // Only a completed provision was counted against the device's face
  // capacity, so only that one is given back. Cancelling a still-pending
  // provision must not decrement a count it never incremented. Entry-wide,
  // not per device: PENDING_PROVISION/PROVISIONED describes how far the
  // whole authorization got, not any one device's progress.
  const countedOnDevice = entry.state === EntryState.PROVISIONED;
  const fromState = entry.state;

  return prisma.$transaction(async (tx) => {
    const moved = await tx.entry.updateMany({
      where: { id: entryId, state: fromState },
      data: { state: EntryState.PENDING_DEPROVISION },
    });
    if (moved.count !== 1) {
      throw new ServiceError(409, "entry changed state concurrently — retry");
    }

    const commands: SyncCommand[] = [];
    for (const device of devices) {
      commands.push(
        await enqueueIn(tx, {
          type: CommandType.DEPROVISION,
          targetDeviceId: device.id,
          payload: { pin: entry.person.esslUserId, countedOnDevice },
          idempotencyKey: `deprovision:${entryId}:${device.id}`,
          entryId,
          personId: entry.personId,
          initiatedById: actorId,
        }),
      );
    }

    await tx.auditLog.create({
      data: auditRow({
        action: AuditAction.ENTRY_DEPROVISION_REQUESTED,
        entityType: "entry",
        entityId: entryId,
        detail: {
          esslUserId: entry.person.esslUserId,
          deviceIds: devices.map((d) => d.id),
          fromState,
          countedOnDevice,
        },
        actorId: actorId ?? null,
      }),
    });

    return { entry: { ...entry, state: EntryState.PENDING_DEPROVISION }, devices, commands };
  });
}

// ---------------------------------------------------------------------------
// Query the device's own view of a person (4.4) — the seed of reconciliation
// ---------------------------------------------------------------------------

export async function queryPersonOnDevice(
  personId: string,
  deviceId: string | undefined,
  actorId?: string,
): Promise<{ device: Device; command: SyncCommand }> {
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) throw new ServiceError(404, "person not found");
  const device = await resolveTargetDevice(deviceId);

  const command = await enqueue({
    type: CommandType.QUERY_USER,
    targetDeviceId: device.id,
    payload: { pin: person.esslUserId },
    // Bucketed to a minute so an impatient operator clicking refresh does not
    // queue a dozen identical reads.
    idempotencyKey: `query-user:${device.id}:${person.esslUserId}:${Math.floor(Date.now() / 60_000)}`,
    personId: person.id,
    initiatedById: actorId,
  });

  await prisma.auditLog.create({
    data: auditRow({
      action: AuditAction.DEVICE_QUERY_REQUESTED,
      entityType: "person",
      entityId: person.id,
      detail: { esslUserId: person.esslUserId, deviceId: device.id },
      actorId: actorId ?? null,
    }),
  });

  return { device, command };
}

// ---------------------------------------------------------------------------
// Completion — device acknowledgements drive every state change
// ---------------------------------------------------------------------------

/**
 * Advance the lifecycle from a resolved command.
 *
 * Return=0 means "processed", not "correct" — so this records delivery, and
 * reconciliation (Phase 3) remains the check on whether the device's roster
 * actually matches. Every transition is a guarded conditional update, so a
 * replayed or duplicated acknowledgement cannot apply twice.
 */
export async function onCommandResolved(command: SyncCommand, log: Logger): Promise<void> {
  if (command.status !== CommandStatus.SUCCESS) {
    log.warn(
      { commandId: command.id, type: command.type, error: command.lastError },
      "device command failed — entry left in place for the operator to retry",
    );
    return;
  }
  switch (command.type) {
    case CommandType.PROVISION:
    case CommandType.PUSH_PHOTO:
      await completeProvisionIfReady(command, log);
      break;
    case CommandType.BLOCK:
      await applyBlockState(command, true, log);
      break;
    case CommandType.UNBLOCK:
      await applyBlockState(command, false, log);
      break;
    case CommandType.DEPROVISION:
      await completeDeprovision(command, log);
      break;
    default:
      break; // QUERY_USER / DEVICE_INFO carry their result as pushed data
  }
}

async function completeProvisionIfReady(command: SyncCommand, log: Logger): Promise<void> {
  const entryId = command.entryId;
  if (!entryId) {
    if (command.type !== CommandType.PUSH_PHOTO || !command.personId) return;
    const changed = await prisma.employeeDeviceAccess.updateMany({
      where: {
        personId: command.personId,
        deviceId: command.targetDeviceId,
        desiredAccess: true,
        provisioned: false,
      },
      data: { provisioned: true },
    });
    if (changed.count === 1) {
      await prisma.device.update({
        where: { id: command.targetDeviceId },
        data: { facesUsed: { increment: 1 } },
      });
    }
    return;
  }

  // Both halves must land: a user with no photo cannot be recognised, and a
  // photo with no user has nothing to attach to.
  const outstanding = await prisma.syncCommand.count({
    where: {
      entryId,
      type: { in: [CommandType.PROVISION, CommandType.PUSH_PHOTO] },
      status: { not: CommandStatus.SUCCESS },
    },
  });
  if (outstanding > 0) return;

  // Every device this entry was provisioned onto gets its face count
  // incremented here, not just the device belonging to whichever command
  // happened to be the last to resolve — otherwise a two-device entry would
  // only ever credit one of its two devices.
  const provisionCommands = await prisma.syncCommand.findMany({
    where: { entryId, type: CommandType.PROVISION },
    select: { targetDeviceId: true },
  });
  const deviceIds = [...new Set(provisionCommands.map((c) => c.targetDeviceId))];

  const changed = await prisma.$transaction(async (tx) => {
    const advanced = await tx.entry.updateMany({
      where: { id: entryId, state: EntryState.PENDING_PROVISION },
      data: { state: EntryState.PROVISIONED },
    });
    if (advanced.count !== 1) return false; // already advanced — replayed ack
    await tx.device.updateMany({
      where: { id: { in: deviceIds } },
      data: { facesUsed: { increment: 1 } },
    });
    await tx.auditLog.create({
      data: auditRow({
        action: AuditAction.ENTRY_PROVISIONED,
        entityType: "entry",
        entityId: entryId,
        detail: { deviceIds },
      }),
    });
    log.info({ entryId, deviceIds }, "entry PROVISIONED on every device");
    return true;
  });
  if (changed) await publishEntryById(entryId);
}

async function applyBlockState(
  command: SyncCommand,
  blocked: boolean,
  log: Logger,
): Promise<void> {
  const entryId = command.entryId;
  if (!entryId) return;
  const changed = await prisma.$transaction(async (tx) => {
    const updated = await tx.entry.updateMany({
      where: {
        id: entryId,
        state: { in: [EntryState.PROVISIONED, EntryState.INSIDE] },
        dayBlocked: !blocked,
      },
      data: { dayBlocked: blocked },
    });
    if (updated.count !== 1) return false;
    await tx.auditLog.create({
      data: auditRow({
        action: blocked ? AuditAction.ENTRY_BLOCKED : AuditAction.ENTRY_UNBLOCKED,
        entityType: "entry",
        entityId: entryId,
        detail: { deviceId: command.targetDeviceId },
      }),
    });
    log.info({ entryId, blocked }, "device confirmed access-group change");
    return true;
  });
  if (changed) await publishEntryById(entryId);
}

async function completeDeprovision(command: SyncCommand, log: Logger): Promise<void> {
  const entryId = command.entryId;
  const payload = command.payload as { countedOnDevice?: boolean } | null;

  // This device's own bookkeeping happens as soon as ITS removal is
  // confirmed, independent of any other device the person was also loaded
  // on — the face really is gone from this one now.
  if (payload?.countedOnDevice) {
    await prisma.device.updateMany({
      where: { id: command.targetDeviceId, facesUsed: { gt: 0 } },
      data: { facesUsed: { decrement: 1 } },
    });
  }
  if (!entryId) {
    if (command.personId) {
      await prisma.employeeDeviceAccess.updateMany({
        where: { personId: command.personId, deviceId: command.targetDeviceId },
        data: { provisioned: false },
      });
    }
    return;
  }
  await prisma.auditLog.create({
    data: auditRow({
      action: AuditAction.ENTRY_DEPROVISIONED,
      entityType: "entry",
      entityId: entryId,
      detail: { deviceId: command.targetDeviceId },
    }),
  });
  log.info(
    { entryId, deviceId: command.targetDeviceId },
    "removed from device",
  );

  // The entry itself only closes once EVERY device it was loaded on confirms
  // removal — an entry can span more than one device, and closing on the
  // first ack would mark the person fully de-provisioned while a face still
  // sits on a second device with nothing left to say so.
  const outstanding = await prisma.syncCommand.count({
    where: { entryId, type: CommandType.DEPROVISION, status: { not: CommandStatus.SUCCESS } },
  });
  if (outstanding > 0) return;

  const closed = await prisma.entry.updateMany({
    where: { id: entryId, state: EntryState.PENDING_DEPROVISION },
    // The cycle ends where it began. The person's record, photo and history
    // are untouched — only the device's working set changed.
    data: { state: EntryState.REGISTERED, dayBlocked: false },
  });
  if (closed.count === 1) {
    log.info({ entryId }, "entry de-provisioned from every device — record retained");
    await publishEntryById(entryId);
  }
}

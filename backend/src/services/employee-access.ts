import { CommandType, PersonCategory, type Device } from "@prisma/client";
import { enqueueIn, publishCommand } from "../adms/queue.js";
import { prisma } from "../db/index.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { userIdKey } from "../user-id.js";
import { ServiceError } from "./errors.js";

async function loadEmployee(personId: string) {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: { biometric: true },
  });
  if (!person) throw new ServiceError(404, "person not found");
  if (person.category !== PersonCategory.EMPLOYEE) {
    throw new ServiceError(409, "permanent device access is only available to employees");
  }
  return person;
}

export async function assignEmployeeDevices(
  personId: string,
  deviceIds: string[],
  assignedById?: string,
  allowIncomplete = false,
) {
  const person = await loadEmployee(personId);
  if (person.resignedAt) throw new ServiceError(409, "a resigned employee cannot be assigned device access");
  if (!allowIncomplete && (!person.mobile || !person.companyId || !person.departmentId || (!person.aadharNumber && !person.panNumber))) {
    throw new ServiceError(409, "complete the employee profile before assigning device access");
  }
  const uniqueIds = [...new Set(deviceIds)];
  if (uniqueIds.length === 0) throw new ServiceError(400, "select at least one device");
  const devices = await prisma.device.findMany({ where: { id: { in: uniqueIds } } });
  if (devices.length !== uniqueIds.length) throw new ServiceError(404, "one or more devices were not found");
  const cycle = new Date();

  return prisma.$transaction(async (tx) => {
    for (const device of devices) {
      await tx.employeeDeviceAccess.upsert({
        where: { personId_deviceId: { personId, deviceId: device.id } },
        create: { personId, deviceId: device.id, assignedById: assignedById ?? null, assignedAt: cycle },
        update: {
          desiredAccess: true,
          assignedById: assignedById ?? null,
          assignedAt: cycle,
          removedAt: null,
          removedById: null,
          removalReason: null,
        },
      });
      if (!person.biometric) continue;
      const suffix = `${personId}:${device.id}:${cycle.getTime()}`;
      await enqueueIn(tx, {
        type: CommandType.PROVISION,
        targetDeviceId: device.id,
        personId,
        initiatedById: assignedById,
        payload: { pin: person.esslUserId, name: person.name, grp: device.normalGroupId },
        idempotencyKey: `employee-provision:${suffix}`,
      });
      await enqueueIn(tx, {
        type: CommandType.PUSH_PHOTO,
        targetDeviceId: device.id,
        personId,
        initiatedById: assignedById,
        payload: { pin: person.esslUserId, photoPath: person.biometric.photoPath },
        idempotencyKey: `employee-photo:${suffix}`,
      });
    }
    await tx.person.update({ where: { id: personId }, data: { adoptedFromDevice: false } });
    await tx.auditLog.create({
      data: {
        action: "EMPLOYEE_ACCESS_ASSIGNED",
        entityType: "person",
        entityId: personId,
        detail: { deviceIds: devices.map((d) => d.id) },
        actorId: assignedById ?? null,
      },
    });
    return tx.employeeDeviceAccess.findMany({ where: { personId }, include: { device: true } });
  });
}

export async function removeEmployeeDevice(
  personId: string,
  deviceId: string,
  removedById?: string,
  removalReason?: string,
) {
  const person = await loadEmployee(personId);
  const access = await prisma.employeeDeviceAccess.findUnique({
    where: { personId_deviceId: { personId, deviceId } },
  });
  if (!access) throw new ServiceError(404, "employee device assignment not found");
  if (!access.desiredAccess) throw new ServiceError(409, "employee access is already removed");
  const removedAt = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.employeeDeviceAccess.update({
      where: { id: access.id },
      data: {
        desiredAccess: false,
        removedAt,
        removedById: removedById ?? null,
        removalReason: removalReason?.trim() || null,
      },
      include: { device: true },
    });
    await enqueueIn(tx, {
      type: CommandType.DEPROVISION,
      targetDeviceId: deviceId,
      personId,
      initiatedById: removedById,
      payload: { pin: person.esslUserId, countedOnDevice: access.provisioned },
      idempotencyKey: `employee-remove:${access.id}:${removedAt.getTime()}`,
    });
    await tx.auditLog.create({
      data: {
        action: "EMPLOYEE_ACCESS_REMOVED",
        entityType: "person",
        entityId: personId,
        detail: { deviceId, reason: removalReason?.trim() || null },
        actorId: removedById ?? null,
      },
    });
    return updated;
  });
}

export async function listEmployeeDevices(personId: string) {
  await loadEmployee(personId);
  return prisma.employeeDeviceAccess.findMany({
    where: { personId },
    include: { device: true },
    orderBy: { assignedAt: "asc" },
  });
}

export async function resignEmployee(personId: string, resignedById?: string, reason?: string) {
  const person = await loadEmployee(personId);
  if (person.resignedAt) throw new ServiceError(409, "employee is already resigned");
  // Every terminal they could be on, not only the ones VMS assigned: any
  // access row (already-removed ones too, since a removal can fail) plus any
  // terminal that has seen them punch, which proves they were enrolled there.
  // Field incident (0.4.19): removed from IN, kept punching at OUT.
  const [accesses, punchedOn] = await Promise.all([
    prisma.employeeDeviceAccess.findMany({ where: { personId } }),
    prisma.$queryRaw<{ deviceId: string }[]>`
      SELECT DISTINCT "device_id" AS "deviceId" FROM "punch_event"
       WHERE UPPER("essl_user_id") = UPPER(${person.esslUserId})
    `,
  ]);
  const known = new Set(accesses.map((access) => access.deviceId));
  const unassigned = [...new Set(punchedOn.map((row) => row.deviceId))].filter((id) => !known.has(id));
  const resignedAt = new Date();
  const resignedReason = reason?.trim() || null;
  const removal = {
    desiredAccess: false,
    removedAt: resignedAt,
    removedById: resignedById ?? null,
    removalReason: resignedReason ?? "Employee resigned",
  };
  const targets = [
    ...accesses.map((access) => ({ deviceId: access.deviceId, countedOnDevice: access.provisioned })),
    ...unassigned.map((deviceId) => ({ deviceId, countedOnDevice: false })),
  ];

  return prisma.$transaction(async (tx) => {
    const active = accesses.filter((access) => access.desiredAccess);
    if (active.length > 0) {
      await tx.employeeDeviceAccess.updateMany({ where: { id: { in: active.map((access) => access.id) } }, data: removal });
    }
    if (unassigned.length > 0) {
      // Rows, so the reconciliation sweep keeps following up on these terminals.
      await tx.employeeDeviceAccess.createMany({
        data: unassigned.map((deviceId) => ({ personId, deviceId, provisioned: false, ...removal })),
        skipDuplicates: true,
      });
    }
    if (targets.length > 0) {
      await tx.syncCommand.createMany({
        data: targets.map((target) => ({
          type: CommandType.DEPROVISION,
          targetDeviceId: target.deviceId,
          personId,
          initiatedById: resignedById ?? null,
          payload: { pin: person.esslUserId, countedOnDevice: target.countedOnDevice },
          idempotencyKey: `employee-resign:${personId}:${target.deviceId}:${resignedAt.getTime()}`,
        })),
      });
    }
    const updated = await tx.person.update({
      where: { id: personId },
      data: {
        isActive: false,
        resignedAt,
        resignedReason,
        resignedById: resignedById ?? null,
      },
    });
    await tx.auditLog.create({
      data: auditRow({
        action: AuditAction.EMPLOYEE_RESIGNED,
        entityType: "person",
        entityId: personId,
        detail: { deviceIds: targets.map((target) => target.deviceId), reason: resignedReason },
        actorId: resignedById,
      }),
    });
    return { person: updated, removedDeviceCount: targets.length };
  });
}

export async function rehireEmployee(personId: string, deviceIds: string[], rehiredById?: string) {
  const person = await loadEmployee(personId);
  if (!person.resignedAt) throw new ServiceError(409, "employee is not resigned");
  const previousResignedAt = person.resignedAt;
  if (!person.mobile || !person.companyId || !person.departmentId || (!person.aadharNumber && !person.panNumber)) {
    throw new ServiceError(409, "complete the employee profile before rehiring");
  }
  const uniqueIds = [...new Set(deviceIds)];
  if (uniqueIds.length === 0) throw new ServiceError(400, "select at least one device");
  const devices = await prisma.device.findMany({ where: { id: { in: uniqueIds } } });
  if (devices.length !== uniqueIds.length) throw new ServiceError(404, "one or more devices were not found");
  const rehiredAt = new Date();

  return prisma.$transaction(async (tx) => {
    const updated = await tx.person.update({
      where: { id: personId },
      data: { isActive: true, resignedAt: null, resignedReason: null, resignedById: null },
    });
    for (const device of devices) {
      const access = await tx.employeeDeviceAccess.upsert({
        where: { personId_deviceId: { personId, deviceId: device.id } },
        create: { personId, deviceId: device.id, assignedById: rehiredById ?? null, assignedAt: rehiredAt },
        update: {
          desiredAccess: true,
          assignedById: rehiredById ?? null,
          assignedAt: rehiredAt,
          removedAt: null,
          removedById: null,
          removalReason: null,
        },
      });
      if (!person.biometric) continue;
      const suffix = `${access.id}:${rehiredAt.getTime()}`;
      await enqueueIn(tx, {
        type: CommandType.PROVISION,
        targetDeviceId: device.id,
        personId,
        initiatedById: rehiredById,
        payload: { pin: person.esslUserId, name: person.name, grp: device.normalGroupId },
        idempotencyKey: `employee-rehire-provision:${suffix}`,
      });
      await enqueueIn(tx, {
        type: CommandType.PUSH_PHOTO,
        targetDeviceId: device.id,
        personId,
        initiatedById: rehiredById,
        payload: { pin: person.esslUserId, photoPath: person.biometric.photoPath },
        idempotencyKey: `employee-rehire-photo:${suffix}`,
      });
    }
    await tx.auditLog.create({
      data: auditRow({
        action: AuditAction.EMPLOYEE_REHIRED,
        entityType: "person",
        entityId: personId,
        detail: {
          deviceIds: devices.map((device) => device.id),
          previousResignedAt: previousResignedAt.toISOString(),
          previousResignedReason: person.resignedReason,
        },
        actorId: rehiredById,
      }),
    });
    return { person: updated, assignedDeviceCount: devices.length };
  });
}

/**
 * Device-originated employee adoption deliberately bypasses profile completion.
 * A resigned Employee seen on a terminal is recorded as present but NOT
 * desired, so reconciliation removes them instead of keeping them.
 */
export async function adoptEmployeeOnDevice(personId: string, deviceId: string, resignedAt: Date | null) {
  const now = new Date();
  return prisma.employeeDeviceAccess.upsert({
    where: { personId_deviceId: { personId, deviceId } },
    create: resignedAt
      ? { personId, deviceId, desiredAccess: false, provisioned: true, assignedAt: now, removedAt: now, removalReason: "Employee resigned" }
      : { personId, deviceId, desiredAccess: true, provisioned: true, assignedAt: now },
    // A terminal observation must never undo an Admin's deliberate removal.
    // Existing desiredAccess=false stays false; reconciliation will delete the
    // unexpected roster entry again. Only a genuinely new assignment adopts it.
    update: { provisioned: true },
  });
}

export interface RevokedPunchCandidate {
  personId: string;
  key: string;
  esslUserId: string;
  /** Resignation, or removal of this terminal's access — whichever applies. */
  revokedAt: Date;
  hasAccessRow: boolean;
  removalInFlight: boolean;
}

/**
 * Which revoked Employees does this batch of punches prove are still on the
 * terminal? Only a punch made AFTER the revocation counts: a terminal that was
 * offline uploads old punches late, and those prove nothing about now.
 */
export function revokedPunchTargets(
  candidates: readonly RevokedPunchCandidate[],
  latestPunchByKey: ReadonlyMap<string, Date>,
): RevokedPunchCandidate[] {
  return candidates.filter((c) => {
    const latest = latestPunchByKey.get(c.key);
    return !c.removalInFlight && latest !== undefined && latest > c.revokedAt;
  });
}

/**
 * A punch proves the person is enrolled on that terminal. A resigned
 * Employee, or one whose access to THIS terminal was removed, punching here
 * means a removal failed or was undone: queue it again, audit it, and let the
 * alert panel show it. The punch itself is already stored; nothing is dropped.
 *
 * A non-resigned Employee with no row for this terminal is left alone: that
 * is a face the site enrolled, and removing it would be destructive.
 *
 * Fixed query count per batch (CLAUDE.md #4): one read, three bulk writes.
 */
export async function removeRevokedEmployeesFromPunches(
  device: Device,
  punches: readonly { esslUserId: string; punchedAtUtc: Date }[],
  log: { warn: (obj: object, msg: string) => void },
): Promise<number> {
  const latestPunchByKey = new Map<string, Date>();
  for (const punch of punches) {
    const key = userIdKey(punch.esslUserId);
    const seen = latestPunchByKey.get(key);
    if (!seen || punch.punchedAtUtc > seen) latestPunchByKey.set(key, punch.punchedAtUtc);
  }
  if (latestPunchByKey.size === 0) return 0;
  const candidates = await prisma.$queryRaw<RevokedPunchCandidate[]>`
    SELECT p."id" AS "personId", UPPER(p."essl_user_id") AS key, p."essl_user_id" AS "esslUserId",
           COALESCE(p."resigned_at", a."removed_at", a."updated_at") AS "revokedAt",
           (a."id" IS NOT NULL) AS "hasAccessRow",
           EXISTS (
             SELECT 1 FROM "sync_command" sc
              WHERE sc."person_id" = p."id" AND sc."target_device_id" = ${device.id}
                AND sc."type" = 'DEPROVISION'::"CommandType"
                AND sc."status" IN ('PENDING'::"CommandStatus", 'SENT'::"CommandStatus", 'RETRY'::"CommandStatus")
           ) AS "removalInFlight"
      FROM "person" p
      LEFT JOIN "employee_device_access" a ON a."person_id" = p."id" AND a."device_id" = ${device.id}
     WHERE UPPER(p."essl_user_id") = ANY(${[...latestPunchByKey.keys()]}::text[])
       AND p."category" = 'EMPLOYEE'::"PersonCategory"
       AND (p."resigned_at" IS NOT NULL OR a."desired_access" = false)
  `;
  const targets = revokedPunchTargets(candidates, latestPunchByKey);
  if (targets.length === 0) return 0;

  const now = new Date();
  const missingRows = targets.filter((t) => !t.hasAccessRow);
  if (missingRows.length > 0) {
    // So the reconciliation sweep keeps following up on this terminal.
    await prisma.employeeDeviceAccess.createMany({
      data: missingRows.map((t) => ({
        personId: t.personId,
        deviceId: device.id,
        desiredAccess: false,
        provisioned: true,
        removedAt: now,
        removalReason: "Employee resigned",
      })),
      skipDuplicates: true,
    });
  }
  const commands = await prisma.syncCommand.createManyAndReturn({
    data: targets.map((t) => ({
      type: CommandType.DEPROVISION,
      targetDeviceId: device.id,
      personId: t.personId,
      // false: our records already treat them as off this terminal.
      payload: { pin: t.esslUserId, countedOnDevice: false },
      // Keyed on the punch, so a replayed body cannot queue it twice.
      idempotencyKey: `revoked-punch-remove:${device.id}:${t.personId}:${latestPunchByKey.get(t.key)!.getTime()}`,
    })),
    skipDuplicates: true,
  });
  for (const command of commands) publishCommand(command);
  await prisma.auditLog.createMany({
    data: targets.map((t) =>
      auditRow({
        action: AuditAction.RECONCILE_HEALED,
        entityType: "person",
        entityId: t.personId,
        detail: {
          pin: t.esslUserId,
          deviceId: device.id,
          drift: "REVOKED_EMPLOYEE_PUNCHED",
          action: "DEPROVISION",
          punchedAtUtc: latestPunchByKey.get(t.key)!.toISOString(),
        },
      }),
    ),
  });
  log.warn(
    { device: device.serialNo, pins: targets.map((t) => t.esslUserId) },
    "revoked employee punched on this terminal — still enrolled; removal queued",
  );
  return targets.length;
}

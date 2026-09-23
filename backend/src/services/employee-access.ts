import { CommandType, PersonCategory } from "@prisma/client";
import { enqueueIn } from "../adms/queue.js";
import { prisma } from "../db/index.js";
import { AuditAction, auditRow } from "../db/audit.js";
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
  const accesses = await prisma.employeeDeviceAccess.findMany({
    where: { personId, desiredAccess: true },
  });
  const resignedAt = new Date();
  const resignedReason = reason?.trim() || null;

  return prisma.$transaction(async (tx) => {
    if (accesses.length > 0) {
      await tx.employeeDeviceAccess.updateMany({
        where: { id: { in: accesses.map((access) => access.id) } },
        data: {
          desiredAccess: false,
          removedAt: resignedAt,
          removedById: resignedById ?? null,
          removalReason: resignedReason ?? "Employee resigned",
        },
      });
      for (const access of accesses) {
        await enqueueIn(tx, {
          type: CommandType.DEPROVISION,
          targetDeviceId: access.deviceId,
          personId,
          initiatedById: resignedById,
          payload: { pin: person.esslUserId, countedOnDevice: access.provisioned },
          idempotencyKey: `employee-resign:${access.id}:${resignedAt.getTime()}`,
        });
      }
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
        detail: { deviceIds: accesses.map((access) => access.deviceId), reason: resignedReason },
        actorId: resignedById,
      }),
    });
    return { person: updated, removedDeviceCount: accesses.length };
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

/** Device-originated employee adoption deliberately bypasses profile completion. */
export async function adoptEmployeeOnDevice(personId: string, deviceId: string) {
  const now = new Date();
  return prisma.employeeDeviceAccess.upsert({
    where: { personId_deviceId: { personId, deviceId } },
    create: { personId, deviceId, desiredAccess: true, provisioned: true, assignedAt: now },
    // A terminal observation must never undo an Admin's deliberate removal.
    // Existing desiredAccess=false stays false; reconciliation will delete the
    // unexpected roster entry again. Only a genuinely new assignment adopts it.
    update: { provisioned: true },
  });
}

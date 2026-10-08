import { writeFile } from "node:fs/promises";
import { CommandType, DeviceRole, EntryMode, EntryState, GateReason, GateState, PersonCategory } from "@prisma/client";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { photoPathFor } from "../user-id.js";
import { ServiceError } from "./errors.js";
import { gateTick, planGates } from "./gates.js";
import { zoneDevices } from "./zones.js";

// Security operations on a pass (two-zone rebuild, Phase 4). Each one only
// edits gate rows; the gate engine does the device work. All audited.

const silentLog = { info: () => undefined, warn: () => undefined };
const OPEN = [EntryState.PROVISIONED, EntryState.INSIDE] as const;

async function openEntry(entryId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { person: true, gates: true } });
  if (!entry) throw new ServiceError(404, "pass not found");
  if (!(OPEN as readonly EntryState[]).includes(entry.state)) {
    throw new ServiceError(409, `pass is ${entry.state} — only a loaded pass can be changed`);
  }
  return entry;
}

/**
 * Load the code-gated exit terminals of a single-entry pass. Used by the
 * Security override (Phase 4) and, from Phase 7, by a verified exit code.
 * The gate leaves on the holder's exit punch (or at pass end if they are
 * outside), so no removal time is set here.
 */
export async function loadExitGates(entryId: string, reason: GateReason, actorId: string | undefined, detail: Record<string, unknown>) {
  const entry = await openEntry(entryId);
  if (entry.entryMode !== EntryMode.SINGLE_ENTRY || entry.exitCodeZoneIds.length === 0) {
    throw new ServiceError(409, "this pass has no code-gated exit — its exit terminals load with the pass");
  }
  const gated = new Set(entry.exitCodeZoneIds);
  const have = new Set(entry.gates.map((g) => g.deviceId));
  const exits = (await zoneDevices(entry.exitCodeZoneIds)).filter(
    (d) => d.role === DeviceRole.OUT && d.zoneId !== null && gated.has(d.zoneId) && !have.has(d.id),
  );
  if (exits.length === 0) throw new ServiceError(409, "the exit terminals are already loaded for this pass");
  const now = new Date();
  await prisma.$transaction([
    prisma.passGate.createMany({ data: exits.map((d) => ({ entryId, deviceId: d.id, reason, loadAt: now, unloadAt: null })) }),
    prisma.auditLog.create({
      data: auditRow({
        action: reason === GateReason.OVERRIDE ? AuditAction.EXIT_OVERRIDE : AuditAction.GATE_LOAD_QUEUED,
        entityType: "entry",
        entityId: entryId,
        detail: { personId: entry.personId, esslUserId: entry.person.esslUserId, deviceIds: exits.map((d) => d.id), ...detail },
        actorId,
      }),
    }),
  ]);
  await gateTick(silentLog, now);
  return { deviceIds: exits.map((d) => d.id) };
}

/** Security releases a single-entry visitor at the exit when the code route fails. */
export async function exitOverride(entryId: string, reason: string, actorId?: string) {
  if (!reason.trim()) throw new ServiceError(400, "a reason is required for an exit override");
  return loadExitGates(entryId, GateReason.OVERRIDE, actorId, { reason: reason.trim() });
}

/** Add a zone to a loaded pass (e.g. give a visitor Yard access mid-visit). */
export async function widenZone(entryId: string, zoneId: string, actorId?: string) {
  const entry = await openEntry(entryId);
  if (entry.zoneIds.includes(zoneId)) throw new ServiceError(409, "the pass already includes that zone");
  const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
  if (!zone || !zone.isActive) throw new ServiceError(400, "select an active zone");
  const have = new Set(entry.gates.map((g) => g.deviceId));
  const devices = (await zoneDevices([zoneId])).filter((d) => !have.has(d.id));
  const exitCodeZoneIds = entry.entryMode === EntryMode.SINGLE_ENTRY && zone.exitCodeDefault ? [...entry.exitCodeZoneIds, zoneId] : entry.exitCodeZoneIds;
  const now = new Date();
  const planned = planGates(devices, {
    entryMode: entry.entryMode,
    exitCodeZoneIds: new Set(exitCodeZoneIds),
    loadAt: now,
    unloadAt: entry.retentionExpiresAt,
    reason: GateReason.WIDEN,
  });
  await prisma.$transaction([
    prisma.entry.update({ where: { id: entryId }, data: { zoneIds: [...entry.zoneIds, zoneId], exitCodeZoneIds } }),
    prisma.passGate.createMany({ data: planned.map((g) => ({ ...g, entryId })) }),
    prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.ZONE_WIDENED,
        entityType: "entry",
        entityId: entryId,
        detail: { personId: entry.personId, zoneId, zoneName: zone.name, deviceIds: planned.map((g) => g.deviceId) },
        actorId,
      }),
    }),
  ]);
  await gateTick(silentLog, now);
  return { deviceIds: planned.map((g) => g.deviceId) };
}

/**
 * Blacklist: every pass ends now (removing the visitor from every terminal,
 * except an exit they still need to leave by) and no new pass is issued
 * until it is lifted. Employees are not blacklisted here: their
 * access is removed by an Admin (access removal or resignation).
 */
export async function blacklistPerson(personId: string, reason: string, actorId?: string) {
  if (!reason.trim()) throw new ServiceError(400, "a reason is required to blacklist");
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) throw new ServiceError(404, "person not found");
  if (person.category !== PersonCategory.VISITOR) throw new ServiceError(409, "employees are removed through access removal or resignation, not the blacklist");
  if (person.blacklistedAt) throw new ServiceError(409, "already blacklisted");
  const now = new Date();
  const entries = await prisma.entry.findMany({
    where: { personId, state: { in: [EntryState.PENDING_PROVISION, EntryState.PROVISIONED, EntryState.INSIDE] } },
    select: { id: true },
  });
  const ids = entries.map((e) => e.id);
  // A blacklist ends every pass now. The engine then does what it does for
  // any ended pass: someone outside is removed from every terminal; someone
  // still inside keeps the exit they need to leave and is listed as
  // overstayed for Security (CLAUDE.md #9: never strand anyone).
  await prisma.$transaction(async (tx) => {
    await tx.person.update({ where: { id: personId }, data: { blacklistedAt: now, blacklistedById: actorId ?? null, blacklistReason: reason.trim() } });
    if (ids.length) await tx.entry.updateMany({ where: { id: { in: ids } }, data: { retentionExpiresAt: now } });
    await tx.auditLog.create({
      data: auditRow({ action: AuditAction.BLACKLISTED, entityType: "person", entityId: personId, detail: { reason: reason.trim(), endedPasses: ids }, actorId }),
    });
  });
  await gateTick(silentLog, now);
  return { closedPasses: ids.length };
}

export async function liftBlacklist(personId: string, reason: string | undefined, actorId?: string) {
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) throw new ServiceError(404, "person not found");
  if (!person.blacklistedAt) throw new ServiceError(409, "not blacklisted");
  await prisma.$transaction([
    prisma.person.update({ where: { id: personId }, data: { blacklistedAt: null, blacklistedById: null, blacklistReason: null } }),
    prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.BLACKLIST_LIFTED,
        entityType: "person",
        entityId: personId,
        detail: { reason: reason?.trim() || null, wasReason: person.blacklistReason, since: person.blacklistedAt.toISOString() },
        actorId,
      }),
    }),
  ]);
}

/**
 * Security replaces a poor photo on a live pass (Phase 6). The file is
 * overwritten in place, so loads still queued send the new one; terminals that
 * already hold the face get it pushed again. The caller has checked it is a
 * normalised 480x640 JPEG (CLAUDE.md #5).
 */
export async function retakePassPhoto(entryId: string, jpeg: Buffer, actorId?: string) {
  const entry = await openEntry(entryId);
  const photoPath = photoPathFor(entry.person.esslUserId);
  await writeFile(photoPath, jpeg);
  const loaded = entry.gates.filter((g) => g.state === GateState.LOADED);
  const stamp = Date.now();
  await prisma.$transaction([
    prisma.personBiometric.upsert({
      where: { personId: entry.personId },
      create: { personId: entry.personId, photoPath, photoSizeBytes: jpeg.length, biometricType: 9 },
      update: { photoPath, photoSizeBytes: jpeg.length, faceTemplate: null, capturedAt: new Date() },
    }),
    prisma.syncCommand.createMany({
      data: loaded.map((g) => ({
        type: CommandType.PUSH_PHOTO,
        targetDeviceId: g.deviceId,
        payload: { pin: entry.person.esslUserId, photoPath },
        idempotencyKey: `gate-retake:${g.id}:${stamp}`,
        entryId,
        personId: entry.personId,
        initiatedById: actorId ?? null,
      })),
    }),
    prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.PHOTO_UPDATED,
        entityType: "person_biometric",
        entityId: entry.personId,
        detail: { source: "SECURITY_RETAKE", entryId, photoSizeBytes: jpeg.length, repushedTo: loaded.map((g) => g.deviceId) },
        actorId,
      }),
    }),
  ]);
  return { repushedTo: loaded.map((g) => g.deviceId) };
}

/** Gates of a pass, for the console. */
export async function passGates(entryId: string) {
  return prisma.passGate.findMany({
    where: { entryId },
    include: { device: { select: { id: true, name: true, serialNo: true, role: true, zoneId: true } } },
    orderBy: [{ createdAt: "asc" }],
  });
}



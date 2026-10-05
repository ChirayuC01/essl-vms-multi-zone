import {
  CommandType,
  DeviceRole,
  EntryMode,
  EntryState,
  GateReason,
  GateState,
  Prisma,
  type Device,
} from "@prisma/client";
import { CommandValidationError, buildCreateUser } from "../adms/commands.js";
import { publishCommand } from "../adms/queue.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { publish } from "../events/bus.js";

// The gate engine (two-zone rebuild, Phase 4).
//
// One pass_gate row per (pass, terminal) is the single answer to "should this
// person's face be on this terminal now". Everything that changes access —
// issuing a pass, a punch, the pass ending, an exit override, widening a
// zone, a blacklist — only edits rows (when to load, when to unload). The
// tick below turns due rows into queued commands; the terminal's
// acknowledgements advance them (services/entries.ts onCommandResolved).
//
// The terminal enforces nothing on its own (no native expiry: CLAUDE.md), so
// this tick is a security control: it is the only thing that removes a face
// when a pass ends or a single-entry gate has been used. Fixed query count per
// tick whatever the volume (CLAUDE.md #4).

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/** Gate states in which the face is on, or on its way to, the terminal. */
export const LIVE_GATE_STATES = [GateState.PENDING, GateState.LOADING, GateState.LOADED] as const;
const OPEN_ENTRY_STATES = [EntryState.PENDING_PROVISION, EntryState.PROVISIONED, EntryState.INSIDE] as const;
const BATCH = 500;

// ---------------------------------------------------------------------------
// Rules (pure)
// ---------------------------------------------------------------------------

export interface GateDevice {
  id: string;
  role: DeviceRole;
  zoneId: string | null;
}

export interface PlannedGate {
  deviceId: string;
  reason: GateReason;
  loadAt: Date;
  unloadAt: Date | null;
}

/**
 * Which terminals a pass loads, and when. Entry (and two-way) terminals load
 * on schedule. Exit terminals load with them, except, for SINGLE entry, the
 * exits of zones whose exit is code-gated: those wait for the exit code or a
 * Security override.
 */
export function planGates(
  devices: readonly GateDevice[],
  opts: { entryMode: EntryMode; exitCodeZoneIds: ReadonlySet<string>; loadAt: Date; unloadAt: Date | null; reason: GateReason },
): PlannedGate[] {
  return devices
    .filter(
      (d) =>
        !(
          d.role === DeviceRole.OUT &&
          opts.entryMode === EntryMode.SINGLE_ENTRY &&
          d.zoneId !== null &&
          opts.exitCodeZoneIds.has(d.zoneId)
        ),
    )
    .map((d) => ({ deviceId: d.id, reason: opts.reason, loadAt: opts.loadAt, unloadAt: opts.unloadAt }));
}

/**
 * SINGLE entry: does this punch use up this terminal? An entry terminal is
 * used by passing in, an exit (or two-way) terminal by passing out. MULTI
 * entry never uses a terminal up.
 */
export function usedUpByPunch(entryMode: EntryMode, role: DeviceRole, direction: "IN" | "OUT"): boolean {
  if (entryMode !== EntryMode.SINGLE_ENTRY) return false;
  return role === DeviceRole.IN ? direction === "IN" : direction === "OUT";
}

/**
 * Where the holder is after a punch. Passing in puts them in the terminal's
 * zone; passing out puts them in the zone around it (null = outside). A
 * terminal not placed in a zone cannot say, so it leaves the location alone
 * on the way in and clears it on the way out.
 */
export function locationAfter(
  direction: "IN" | "OUT",
  deviceZoneId: string | null,
  current: string | null,
  parentOf: (zoneId: string) => string | null,
): string | null {
  if (direction === "IN") return deviceZoneId ?? current;
  return deviceZoneId ? parentOf(deviceZoneId) : null;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface TickResult {
  loadsQueued: number;
  unloadsQueued: number;
  passesEnded: number;
  /** Holders still inside after their pass ended. */
  overstayed: number;
  closed: number;
}

const utc = (d: Date) => Prisma.sql`${d.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;

/**
 * One pass of the engine. Idempotent: every transition is guarded on the
 * state it expects and every command has a per-gate idempotency key, so a
 * second concurrent tick changes nothing.
 */
export async function gateTick(log: Logger, now: Date = new Date()): Promise<TickResult> {
  // 1. Passes that have ended. Their gates are scheduled out now, except an
  //    exit gate of someone still inside: removing it would strand them, so
  //    it stays until they leave (and they are listed as overstayed).
  await prisma.$executeRaw`
    UPDATE "pass_gate" g SET "unload_at" = ${utc(now)}, "updated_at" = ${utc(now)}
      FROM "entry" e, "device" d
     WHERE g."entry_id" = e."id" AND d."id" = g."device_id"
       AND g."state" IN ('PENDING', 'LOADING', 'LOADED')
       AND (g."unload_at" IS NULL OR g."unload_at" > ${utc(now)})
       AND e."state" IN ('PENDING_PROVISION', 'PROVISIONED', 'INSIDE')
       AND e."retention_expires_at" <= ${utc(now)}
       AND NOT (e."state" = 'INSIDE' AND d."role" = 'OUT')
  `;
  const ended = await prisma.$queryRaw<{ id: string; personId: string }[]>`
    UPDATE "entry" SET "state" = 'PENDING_DEPROVISION'
     WHERE "state" IN ('PENDING_PROVISION', 'PROVISIONED')
       AND "retention_expires_at" <= ${utc(now)}
    RETURNING "id", "person_id" AS "personId"
  `;
  if (ended.length) {
    await prisma.auditLog.createMany({
      data: ended.map((e) =>
        auditRow({ action: AuditAction.ENTRY_DEPROVISION_REQUESTED, entityType: "entry", entityId: e.id, detail: { reason: "PASS_ENDED" } }),
      ) as Prisma.AuditLogCreateManyInput[],
    });
    for (const e of ended) publish("entry", { id: e.id, personId: e.personId, state: EntryState.PENDING_DEPROVISION, dayBlocked: false });
  }

  // 2. Scheduled gates whose time to leave came before they ever loaded.
  await prisma.passGate.updateMany({
    where: { state: GateState.PENDING, unloadAt: { lte: now } },
    data: { state: GateState.DONE, doneAt: now },
  });

  // 3. Loads due.
  const toLoad = await prisma.passGate.findMany({
    where: {
      state: GateState.PENDING,
      loadAt: { lte: now },
      entry: { state: { in: [...OPEN_ENTRY_STATES] }, person: { blacklistedAt: null } },
    },
    include: { device: true, entry: { include: { person: { include: { biometric: true } } } } },
    orderBy: { loadAt: "asc" },
    take: BATCH,
  });
  const loadable = toLoad.filter((g) => {
    const person = g.entry.person;
    if (!person.biometric) return false;
    try {
      buildCreateUser({ pin: person.esslUserId, name: person.name, grp: g.device.normalGroupId });
      return true;
    } catch (err) {
      if (err instanceof CommandValidationError) {
        log.warn({ gateId: g.id, error: err.message }, "gate cannot be loaded: invalid command — left pending");
        return false;
      }
      throw err;
    }
  });

  // 4. Unloads due.
  const toUnload = await prisma.passGate.findMany({
    where: { state: GateState.LOADED, unloadAt: { lte: now } },
    include: { entry: { include: { person: true } } },
    orderBy: { unloadAt: "asc" },
    take: BATCH,
  });

  const queued = await prisma.$transaction(async (tx) => {
    const loadIds = loadable.map((g) => g.id);
    const unloadIds = toUnload.map((g) => g.id);
    const movedLoads = new Set(
      loadIds.length
        ? (
            await tx.passGate.updateManyAndReturn({
              where: { id: { in: loadIds }, state: GateState.PENDING },
              data: { state: GateState.LOADING },
              select: { id: true },
            })
          ).map((r) => r.id)
        : [],
    );
    const movedUnloads = new Set(
      unloadIds.length
        ? (
            await tx.passGate.updateManyAndReturn({
              where: { id: { in: unloadIds }, state: GateState.LOADED },
              data: { state: GateState.UNLOADING },
              select: { id: true },
            })
          ).map((r) => r.id)
        : [],
    );
    const loads = loadable.filter((g) => movedLoads.has(g.id));
    const unloads = toUnload.filter((g) => movedUnloads.has(g.id));

    // Within a terminal the user must exist before a photo can attach to it:
    // each PROVISION precedes its PUSH_PHOTO in the insert, so it gets the
    // lower `seq` and is dispatched first.
    const commandRows: Prisma.SyncCommandCreateManyInput[] = [];
    for (const g of loads) {
      const p = g.entry.person;
      commandRows.push(
        {
          type: CommandType.PROVISION,
          targetDeviceId: g.deviceId,
          payload: { pin: p.esslUserId, name: p.name, grp: g.device.normalGroupId },
          idempotencyKey: `gate-load:${g.id}`,
          entryId: g.entryId,
          personId: p.id,
        },
        {
          type: CommandType.PUSH_PHOTO,
          targetDeviceId: g.deviceId,
          payload: { pin: p.esslUserId, photoPath: p.biometric!.photoPath },
          idempotencyKey: `gate-photo:${g.id}`,
          entryId: g.entryId,
          personId: p.id,
        },
      );
    }
    for (const g of unloads) {
      commandRows.push({
        type: CommandType.DEPROVISION,
        targetDeviceId: g.deviceId,
        payload: { pin: g.entry.person.esslUserId, countedOnDevice: true },
        idempotencyKey: `gate-unload:${g.id}`,
        entryId: g.entryId,
        personId: g.entry.personId,
      });
    }
    const commands = commandRows.length ? await tx.syncCommand.createManyAndReturn({ data: commandRows, skipDuplicates: true }) : [];
    const audits = [
      ...loads.map((g) => auditRow({ action: AuditAction.GATE_LOAD_QUEUED, entityType: "entry", entityId: g.entryId, detail: { gateId: g.id, deviceId: g.deviceId } })),
      ...unloads.map((g) => auditRow({ action: AuditAction.GATE_UNLOAD_QUEUED, entityType: "entry", entityId: g.entryId, detail: { gateId: g.id, deviceId: g.deviceId } })),
    ];
    if (audits.length) await tx.auditLog.createMany({ data: audits as Prisma.AuditLogCreateManyInput[] });
    return { loads: loads.length, unloads: unloads.length, commands };
  });
  for (const c of queued.commands) publishCommand(c);

  // 5. Close passes whose every gate is done.
  const closed = await closeFinishedEntries();

  const overstayed = await prisma.entry.count({ where: { state: EntryState.INSIDE, retentionExpiresAt: { lte: now } } });
  if (queued.loads || queued.unloads || ended.length) {
    log.info({ loads: queued.loads, unloads: queued.unloads, passesEnded: ended.length, closed }, "gate engine tick");
  }
  return { loadsQueued: queued.loads, unloadsQueued: queued.unloads, passesEnded: ended.length, overstayed, closed };
}

/** PENDING_DEPROVISION passes with no gate left to remove become closed (REGISTERED). */
export async function closeFinishedEntries(): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string; personId: string }[]>`
    UPDATE "entry" e SET "state" = 'REGISTERED', "day_blocked" = false
     WHERE e."state" = 'PENDING_DEPROVISION'
       AND NOT EXISTS (SELECT 1 FROM "pass_gate" g WHERE g."entry_id" = e."id" AND g."state" <> 'DONE')
       AND NOT EXISTS (
         SELECT 1 FROM "sync_command" sc
          WHERE sc."entry_id" = e."id" AND sc."type" = 'DEPROVISION'
            AND sc."status" IN ('PENDING', 'SENT', 'RETRY'))
    RETURNING e."id", e."person_id" AS "personId"
  `;
  for (const r of rows) publish("entry", { id: r.id, personId: r.personId, state: EntryState.REGISTERED, dayBlocked: false });
  return rows.length;
}

/**
 * Schedule every live gate of these passes out now. A gate that never loaded
 * is simply done; the tick queues removal for the rest.
 */
export async function unloadAllGates(entryIds: readonly string[], now: Date, tx: Prisma.TransactionClient = prisma): Promise<void> {
  if (!entryIds.length) return;
  await tx.passGate.updateMany({ where: { entryId: { in: [...entryIds] }, state: GateState.PENDING }, data: { state: GateState.DONE, doneAt: now } });
  await tx.passGate.updateMany({
    where: { entryId: { in: [...entryIds] }, state: { in: [GateState.LOADING, GateState.LOADED] }, OR: [{ unloadAt: null }, { unloadAt: { gt: now } }] },
    data: { unloadAt: now },
  });
}

/** The devices an entry's gates are on, for callers that report them. */
export async function gateDevices(entryId: string): Promise<Device[]> {
  return (await prisma.passGate.findMany({ where: { entryId }, include: { device: true }, orderBy: { createdAt: "asc" } })).map((g) => g.device);
}

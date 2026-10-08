import { EntryMode, EntryState, type Prisma } from "@prisma/client";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { unloadAllGates } from "./gates.js";
import { getSettings } from "./settings.js";

// Outage recovery (two-zone rebuild, Phase 7; CLAUDE.md rule #9 as amended).
//
// While the system is down nobody can be released through it: a single-entry
// visitor's code-gated exit cannot load. Site staff let people out with the
// terminal's admin card and note them in a manual register. When the system
// comes back, every single-entry pass still marked inside that was live during
// the gap is released — taken off the terminals and closed — and listed per
// outage, so the register can be reconciled against it. Multi-entry passes
// need no release (their exits were loaded all along) and are left alone.
//
// The engine tick writes a heartbeat every minute; a gap longer than the
// outageGapMinutes setting is an outage.

const HEARTBEAT = "engine_heartbeat";

interface Logger {
  info: (obj: object, msg: string) => void;
}

/** Find a heartbeat gap, release what it affected, then beat. Called first on every engine tick. */
export async function outageCheck(log?: Logger, now = new Date()) {
  const [row, settings] = await Promise.all([prisma.appConfig.findUnique({ where: { key: HEARTBEAT } }), getSettings()]);
  const last = typeof row?.value === "string" ? new Date(row.value) : null;
  const outage = last && now.getTime() - last.getTime() > settings.outageGapMinutes * 60_000 ? await recordOutage(last, now) : null;
  await prisma.appConfig.upsert({ where: { key: HEARTBEAT }, create: { key: HEARTBEAT, value: now.toISOString() }, update: { value: now.toISOString() } });
  if (outage) log?.info({ outageId: outage.id, startedAt: outage.startedAt, released: outage.releasedCount }, "outage detected — single-entry passes released");
  return outage;
}

async function recordOutage(startedAt: Date, endedAt: Date) {
  const affected = await prisma.entry.findMany({
    where: { state: EntryState.INSIDE, entryMode: EntryMode.SINGLE_ENTRY, createdAt: { lt: endedAt }, retentionExpiresAt: { gt: startedAt } },
    select: { id: true, personId: true },
  });
  const ids = affected.map((e) => e.id);
  return prisma.$transaction(async (tx) => {
    const outage = await tx.outage.create({ data: { startedAt, endedAt, releasedCount: ids.length } });
    if (ids.length) {
      // Same path as any closed pass: off every terminal, then closed by the tick.
      await tx.entry.updateMany({
        where: { id: { in: ids }, state: EntryState.INSIDE },
        data: { state: EntryState.PENDING_DEPROVISION, locationZoneId: null, releasedByOutageId: outage.id },
      });
      await unloadAllGates(ids, endedAt, tx);
    }
    await tx.auditLog.createMany({
      data: [
        auditRow({ action: AuditAction.OUTAGE_DETECTED, entityType: "outage", entityId: outage.id, detail: { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), released: ids.length } }),
        ...affected.map((e) => auditRow({ action: AuditAction.OUTAGE_RELEASE, entityType: "entry", entityId: e.id, detail: { outageId: outage.id, personId: e.personId } })),
      ] as Prisma.AuditLogCreateManyInput[],
    });
    return outage;
  });
}

/** Outages, newest first, with the people each one released. */
export async function listOutages(take = 50) {
  return prisma.outage.findMany({
    orderBy: { startedAt: "desc" },
    take,
    include: { released: { select: { id: true, inAt: true, person: { select: { id: true, name: true, esslUserId: true, mobile: true } } } } },
  });
}

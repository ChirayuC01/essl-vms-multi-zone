import { CommandStatus, CommandType, EntryState, Prisma } from "@prisma/client";
import { publishCommand } from "../adms/queue.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { publish } from "../events/bus.js";

// The expiry sweeper (Phase 2 Milestone 8).
//
// This is the ONLY thing that removes a lapsed person from a device. Phase 0
// established that the device stores StartDatetime/EndDatetime and ignores
// them — a user whose window closed months earlier was still admitted. There
// is no device-native expiry to fall back on, so this job is a security
// control rather than housekeeping (CLAUDE.md, PRD §16 Risk #4).
//
// Two rules it may never break:
//
//   - A person who is INSIDE is never de-provisioned. Removing their
//     credential mid-visit strands them at the exit barrier. Their window
//     lapsing marks them; their OUT punch is what actually removes them.
//   - Cost is fixed, not per-entry. One read and three writes however many
//     windows lapse at once (CLAUDE.md #4) — a shift change can expire
//     hundreds together, and a remote database makes a per-row loop fatal.

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface SweepResult {
  /** Entries moved to PENDING_DEPROVISION with a DEPROVISION queued. */
  deprovisioned: number;
  /** Lapsed but INSIDE — deliberately left alone until they punch out. */
  deferredInside: number;
}

interface Candidate {
  id: string;
  personId: string;
  esslUserId: string;
  targetDeviceId: string;
}

/**
 * Expired entries, with the device(s) each was provisioned to and the PIN to
 * delete, in one query. One row per (entry, device) — an entry can span more
 * than one device (an IN terminal and an OUT terminal), and expiry has to
 * remove the person from every one of them, not just whichever device
 * happened to receive the latest PROVISION command.
 *
 * The device comes from the entry's own PROVISION commands rather than a
 * column on the entry, because those commands are the record of where the
 * person was actually loaded.
 *
 * ---------------------------------------------------------------------------
 * `${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'` is not decoration.
 *
 * `retention_expires_at` is `TIMESTAMP(3)` — no time zone — and Prisma both
 * writes and reads those columns as UTC. Interpolating a JS `Date` directly
 * makes the driver send a tz-aware value, which Postgres then casts to the
 * naive column type *through the session time zone*. On a +05:30 server that
 * puts `now` five and a half hours into the future, and every window closing
 * inside that span is swept early — people de-provisioned before their
 * authorization actually ended.
 *
 * Caught by the verification harness on the first run of this job. It is the
 * same trap that made `sync_command.sent_at` land in the future (see
 * `adms/queue.ts`), and it will keep recurring: raw SQL and a naive timestamp
 * column need the conversion spelled out. Prisma's own query builder handles
 * this correctly — only hand-written SQL has to be careful.
 * ---------------------------------------------------------------------------
 */
async function findExpired(now: Date, state: EntryState, limit: number): Promise<Candidate[]> {
  return prisma.$queryRaw<Candidate[]>`
    SELECT DISTINCT
           e."id",
           e."person_id"        AS "personId",
           v."essl_user_id"     AS "esslUserId",
           sc."target_device_id" AS "targetDeviceId",
           -- Returned only because it is ordered on: SELECT DISTINCT cannot
           -- ORDER BY a column it does not select, and Postgres rejects the
           -- whole query rather than ignoring the clause. The DISTINCT arrived
           -- with multi-device provisioning; the ORDER BY predates it.
           e."retention_expires_at" AS "retentionExpiresAt"
      FROM "entry" e
      JOIN "person" v ON v."id" = e."person_id"
      JOIN "sync_command" sc ON sc."entry_id" = e."id" AND sc."type" = 'PROVISION'::"CommandType"
     WHERE e."state" = ${state}::"EntryState"
       AND e."retention_expires_at" IS NOT NULL
       AND e."retention_expires_at" <= ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'
     ORDER BY e."retention_expires_at" ASC
     LIMIT ${limit}
  `;
}

/**
 * De-provision a set of entries as one batch.
 *
 * Exported because the punch path needs exactly this when someone walks out
 * after their window has already closed — the sweeper marked nothing at the
 * time because they were INSIDE, and the OUT punch is the moment it becomes
 * safe.
 *
 * The state change is a guarded `UPDATE ... RETURNING`, so only entries that
 * genuinely moved from the expected state get a command. An operator
 * de-provisioning by hand in the same second cannot produce a double removal.
 */
export async function deprovisionBatch(
  candidates: Candidate[],
  fromState: EntryState,
  log: Logger,
): Promise<number> {
  if (candidates.length === 0) return 0;

  // An entry spanning two devices appears twice here, once per device,
  // sharing the same id — the state transition below must happen once per
  // entry, not once per row.
  const ids = [...new Set(candidates.map((c) => c.id))];

  const result = await prisma.$transaction(async (tx) => {
    const moved = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "entry"
         SET "state" = ${EntryState.PENDING_DEPROVISION}::"EntryState"
       WHERE "id" = ANY(${ids}::text[])
         AND "state" = ${fromState}::"EntryState"
      RETURNING "id"
    `;
    if (moved.length === 0) return { entryCount: 0, commands: [] };

    // Every device row for an entry that actually transitioned — a
    // two-device entry needs one DEPROVISION per device, not one shared
    // between them (that dropped the second device's removal entirely,
    // since a Map keyed by entry id can only hold one row per entry).
    const movedIds = new Set(moved.map((m) => m.id));
    const rows = candidates.filter((c) => movedIds.has(c.id));

    const commands = await tx.syncCommand.createManyAndReturn({
      data: rows.map((c) => ({
        type: CommandType.DEPROVISION,
        targetDeviceId: c.targetDeviceId,
        // Only a completed provision was counted against the device's face
        // capacity, so only that one gives a slot back.
        payload: {
          pin: c.esslUserId,
          countedOnDevice: fromState === EntryState.PROVISIONED,
        } as Prisma.InputJsonValue,
        // Same key shape the operator-initiated path uses (entry + device),
        // so a manual request and a sweep for the same entry/device collapse
        // onto one command rather than racing to delete the same user twice.
        idempotencyKey: `deprovision:${c.id}:${c.targetDeviceId}`,
        entryId: c.id,
        personId: c.personId,
        // Null actor = system-initiated. That distinction is the whole point
        // of the column: an expiry is not somebody's decision.
        initiatedById: null,
      })),
      skipDuplicates: true,
    });

    await tx.auditLog.createMany({
      data: rows.map((c) =>
        auditRow({
          action: AuditAction.ENTRY_DEPROVISION_REQUESTED,
          entityType: "entry",
          entityId: c.id,
          detail: {
            esslUserId: c.esslUserId,
            deviceId: c.targetDeviceId,
            fromState,
            reason: "RETENTION_WINDOW_EXPIRED",
          },
        }),
      ) as Prisma.AuditLogCreateManyInput[],
    });

    // One publish per entry, not per device row — the entry itself only
    // transitioned once regardless of how many devices it spans.
    const published = new Set<string>();
    for (const c of rows) {
      if (published.has(c.id)) continue;
      published.add(c.id);
      publish("entry", {
        id: c.id,
        personId: c.personId,
        state: EntryState.PENDING_DEPROVISION,
        dayBlocked: false,
      });
    }
    return { entryCount: movedIds.size, commands };
  });

  for (const command of result.commands) publishCommand(command);
  if (result.entryCount > 0) {
    log.info(
      { entries: result.entryCount, commands: result.commands.length, fromState },
      "retention window expired — de-provision queued",
    );
  }
  return result.entryCount;
}

/**
 * One sweep. Idempotent: an entry already moving to PENDING_DEPROVISION is
 * not a candidate, and the idempotency key catches anything that slips past
 * that, so running this twice concurrently is harmless.
 */
export async function sweepExpiredEntries(
  log: Logger,
  now: Date = new Date(),
  limit = 500,
): Promise<SweepResult> {
  const expired = await findExpired(now, EntryState.PROVISIONED, limit);
  const deprovisioned = await deprovisionBatch(expired, EntryState.PROVISIONED, log);

  // Lapsed but still inside. Not an error and not actionable here — but it
  // must never be silent, because "deferred" and "forgotten" look identical
  // from the outside, and a person who never punches out would otherwise sit
  // on the device indefinitely with nothing saying so.
  const stuck = await findExpired(now, EntryState.INSIDE, limit);
  if (stuck.length > 0) {
    log.warn(
      { count: stuck.length, esslUserIds: stuck.slice(0, 20).map((s) => s.esslUserId) },
      "people are INSIDE past their retention window — de-provision deferred until they punch out",
    );
  }

  return { deprovisioned, deferredInside: stuck.length };
}

/**
 * De-provision on the way out, for a window that closed while the person was
 * still inside. Called from the punch path with the entries that just went
 * INSIDE → PROVISIONED.
 */
export async function deprovisionLapsedOnExit(
  entryIds: string[],
  log: Logger,
  now: Date = new Date(),
): Promise<number> {
  if (entryIds.length === 0) return 0;
  const expired = await prisma.$queryRaw<Candidate[]>`
    SELECT DISTINCT
           e."id",
           e."person_id"        AS "personId",
           v."essl_user_id"     AS "esslUserId",
           sc."target_device_id" AS "targetDeviceId"
      FROM "entry" e
      JOIN "person" v ON v."id" = e."person_id"
      JOIN "sync_command" sc ON sc."entry_id" = e."id" AND sc."type" = 'PROVISION'::"CommandType"
     WHERE e."id" = ANY(${entryIds}::text[])
       AND e."state" = 'PROVISIONED'::"EntryState"
       AND e."retention_expires_at" IS NOT NULL
       AND e."retention_expires_at" <= ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'
  `;
  return deprovisionBatch(expired, EntryState.PROVISIONED, log);
}

/** Entries whose window closed while the person is still on site. */
export async function overdueInside(limit = 200) {
  return prisma.entry.findMany({
    where: {
      state: EntryState.INSIDE,
      retentionExpiresAt: { not: null, lte: new Date() },
    },
    orderBy: { retentionExpiresAt: "asc" },
    take: limit,
    select: {
      id: true,
      state: true,
      inAt: true,
      retentionExpiresAt: true,
      person: { select: { id: true, name: true, company: true, esslUserId: true } },
    },
  });
}

/** Commands this job queued that the device has not confirmed yet. */
export async function pendingDeprovisionCount(): Promise<number> {
  return prisma.syncCommand.count({
    where: {
      type: CommandType.DEPROVISION,
      status: { in: [CommandStatus.PENDING, CommandStatus.SENT, CommandStatus.RETRY] },
    },
  });
}

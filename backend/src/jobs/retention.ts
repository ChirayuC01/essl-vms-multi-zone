import { readdir, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CommandStatus, EntryState, Prisma, type DeviceRole } from "@prisma/client";
import { config } from "../config/index.js";
import { prisma } from "../db/index.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { photoPathFor, userIdFromPhotoFile, userIdKey } from "../user-id.js";
import { summarizeAttendance } from "../services/attendance.js";

// Retention and log rotation (Phase 3 Milestone 14).
//
// At 1,200–1,500 movements a day, punch_event gains roughly half a million
// rows a year, and sync_command several per person per authorization cycle.
// On a bundled on-premise PostgreSQL nobody is watching, unbounded growth is
// how an installation dies quietly two years after handover.
//
// The rule this file follows: **summarise before deleting.** Pruning raw
// punches outright would make "was this person on site last March"
// unanswerable, which is precisely the question asked after an incident. A
// day summary keeps the fact and drops the granularity. That trade is what
// makes a retention policy defensible; deleting the history is not the same
// thing as rotating it.
//
// Everything here deletes in bounded batches. A single DELETE over a year of
// rows takes a long lock, and on a client-supplied database that is somebody
// else's outage.

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface RetentionResult {
  punchesSummarised: number;
  punchesDeleted: number;
  commandsDeleted: number;
  auditDeleted: number;
  unclaimedPhotosDeleted: number;
}

/**
 * Delete enrollment photos nobody claimed.
 *
 * The one deletion in this product that loses nothing: the terminal still
 * holds the photo, so anyone who turns out to be a person later is re-pullable
 * with a single QUERY_USER. What it bounds is a terminal shared with the
 * client's own employees quietly accumulating hundreds of staff photographs
 * here (docs/DPDP_SHARED_TERMINAL_RISK.md), and an unclaimed-enrollments panel
 * that grows until nobody reads it.
 *
 * A photo whose person exists is never touched by this - that one is the
 * durable artifact, and the whole product rests on keeping it forever.
 */
async function pruneUnclaimedPhotos(cutoff: Date, log: Logger): Promise<number> {
  let files: string[];
  try {
    files = await readdir(config.photoStoragePath);
  } catch {
    return 0; // no photo directory yet is an ordinary empty state
  }
  const ids = files
    .map((name) => userIdFromPhotoFile(name))
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return 0;

  // One query for the whole directory, never one per file. Case-insensitive,
  // so `WCTPL070.jpg` is claimed by a person stored as `wctpl070`.
  const claimed = await prisma.$queryRaw<{ key: string }[]>`
    SELECT UPPER("essl_user_id") AS key
      FROM "person"
     WHERE UPPER("essl_user_id") = ANY(${ids.map(userIdKey)}::text[])
  `;
  const claimedKeys = new Set(claimed.map((c) => c.key));

  let deleted = 0;
  for (const id of ids) {
    if (claimedKeys.has(userIdKey(id))) continue;
    const filePath = photoPathFor(id);
    const info = await stat(filePath).catch(() => null);
    if (!info || info.mtime >= cutoff) continue;
    await unlink(filePath).catch(() => undefined);
    deleted += 1;
  }
  if (deleted > 0) {
    log.info(
      { deleted, cutoff: cutoff.toISOString() },
      "unclaimed enrollment photos deleted — the device still holds them, so any of these is re-pullable",
    );
  }
  return deleted;
}

/**
 * Roll one batch of expired punches into day summaries, then delete them.
 *
 * Summary and deletion happen in ONE transaction. Reversed or split, a crash
 * between them either loses movements outright or double-counts them on the
 * next run — and a summary that silently drifts is worse than no summary,
 * because it still looks authoritative.
 *
 * `in_count` / `out_count` are resolved against each device's own status-code
 * maps, so the summary carries direction even though the raw codes are going
 * away. Punches whose entry is still active are never touched, however old:
 * an open authorization is live state, not history.
 */
async function summariseAndDeletePunches(cutoff: Date, batch: number): Promise<{
  summarised: number;
  deleted: number;
}> {
  return prisma.$transaction(async (tx) => {
    // NOTE the explicit UTC cast. `punched_at_utc` is TIMESTAMP (no zone) and
    // a bare JS Date would be converted through the session zone — the trap
    // that has already produced a five-and-a-half-hour skew twice in this
    // codebase (see jobs/expiry.ts).
    const doomed = await tx.$queryRaw<{
      id: string; esslUserId: string; personId: string | null; deviceId: string;
      localDate: string; punchedAtUtc: Date; statusCode: number | null;
      direction: "IN" | "OUT" | null;
      role: DeviceRole; inStatusCodes: number[]; outStatusCodes: number[];
    }[]>`
      WITH candidate_days AS (
        SELECT UPPER(p."essl_user_id") AS person_key,
               to_char(p."punched_at_device", 'YYYY-MM-DD') AS local_date
          FROM "punch_event" p
          LEFT JOIN "entry" e ON e."id" = p."entry_id"
         GROUP BY UPPER(p."essl_user_id"), local_date
        HAVING MAX(p."punched_at_utc") < ${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC'
           AND COUNT(*) FILTER (WHERE e."id" IS NOT NULL AND e."state" <> 'REGISTERED'::"EntryState") = 0
         ORDER BY MIN(p."punched_at_utc")
         LIMIT ${Math.max(1, Math.floor(batch / 10))}
      )
      SELECT p."id", p."essl_user_id" AS "esslUserId", v."id" AS "personId",
             p."device_id" AS "deviceId", c.local_date AS "localDate",
             p."punched_at_utc" AS "punchedAtUtc", p."status_code" AS "statusCode", p."direction",
             d."role", d."in_status_codes" AS "inStatusCodes", d."out_status_codes" AS "outStatusCodes"
        FROM candidate_days c
        JOIN "punch_event" p ON UPPER(p."essl_user_id") = c.person_key
          AND to_char(p."punched_at_device", 'YYYY-MM-DD') = c.local_date
        JOIN "device" d ON d."id" = p."device_id"
        LEFT JOIN "person" v ON UPPER(v."essl_user_id") = UPPER(p."essl_user_id")
       ORDER BY c.local_date, c.person_key, p."punched_at_utc", p."id"
    `;
    if (doomed.length === 0) return { summarised: 0, deleted: 0 };
    const ids = doomed.map((d) => d.id);
    const groups = new Map<string, typeof doomed>();
    for (const row of doomed) {
      const key = `${userIdKey(row.esslUserId)}:${row.localDate}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const values = [...groups.values()].map((rows) => {
      const summary = summarizeAttendance(rows);
      const first = rows[0]!;
      const deviceIds = Prisma.join(summary.deviceIds.map((id) => Prisma.sql`${id}`));
      return Prisma.sql`(
        ${randomUUID()}, ${first.esslUserId}, ${first.personId}, ${first.localDate},
        ARRAY[${deviceIds}]::text[], ${JSON.stringify(summary.devicePunchCounts)}::jsonb,
        ${summary.firstInUtc}, ${summary.lastOutUtc},
        ${summary.workedSeconds}, ${summary.punchCount}, ${summary.inCount}, ${summary.outCount},
        ${summary.unmatchedIn}, ${summary.unmatchedOut}, 'EXACT'::"AttendanceQuality",
        (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC')
      )`;
    });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "attendance_day_summary"
        ("id","essl_user_id","person_id","local_date","device_ids","device_punch_counts","first_in_utc","last_out_utc",
         "worked_seconds","punch_count","in_count","out_count","unmatched_in","unmatched_out",
         "quality","created_at","updated_at")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("essl_user_id","local_date") DO UPDATE SET
        "device_ids" = ARRAY(SELECT DISTINCT unnest("attendance_day_summary"."device_ids" || EXCLUDED."device_ids")),
        "device_punch_counts" = (
          SELECT jsonb_object_agg(counts.key, counts.total)
            FROM (
              SELECT values.key, SUM(values.value::int)::int AS total
                FROM (
                  SELECT * FROM jsonb_each_text("attendance_day_summary"."device_punch_counts")
                  UNION ALL
                  SELECT * FROM jsonb_each_text(EXCLUDED."device_punch_counts")
                ) values
               GROUP BY values.key
            ) counts
        ),
        "first_in_utc" = LEAST("attendance_day_summary"."first_in_utc", EXCLUDED."first_in_utc"),
        "last_out_utc" = GREATEST("attendance_day_summary"."last_out_utc", EXCLUDED."last_out_utc"),
        "worked_seconds" = "attendance_day_summary"."worked_seconds" + EXCLUDED."worked_seconds",
        "punch_count" = "attendance_day_summary"."punch_count" + EXCLUDED."punch_count",
        "in_count" = "attendance_day_summary"."in_count" + EXCLUDED."in_count",
        "out_count" = "attendance_day_summary"."out_count" + EXCLUDED."out_count",
        "unmatched_in" = "attendance_day_summary"."unmatched_in" + EXCLUDED."unmatched_in",
        "unmatched_out" = "attendance_day_summary"."unmatched_out" + EXCLUDED."unmatched_out",
        "quality" = 'LEGACY_COUNTS_ONLY'::"AttendanceQuality",
        "updated_at" = (NOW() AT TIME ZONE 'UTC')
    `);

    const removed = await tx.punchEvent.deleteMany({ where: { id: { in: ids } } });
    return { summarised: groups.size, deleted: removed.count };
  });
}

/**
 * Drop finished commands.
 *
 * Only SUCCESS rows, and only old ones. A FAILED command is evidence that
 * something did not reach a barrier, and deleting it on a timer would erase
 * the trail leading to whatever went wrong — so failures are kept until
 * somebody deals with them. Anything still PENDING, SENT or RETRY is live
 * work and is never a candidate.
 *
 * **Commands belonging to a still-active entry are never pruned either**, and
 * that guard is load-bearing rather than tidy. A completed `PROVISION` row is
 * not just history: it is the record of WHICH DEVICE(S) a person was loaded
 * onto. `devicesForEntry` reads these rows to know where to send a removal,
 * and the roster-drift check counts them to know how many faces we authorized.
 * Pruning one out from under a live entry makes that person impossible to
 * de-provision and makes the device look like it holds faces nobody asked for.
 *
 * Found by the interaction tests: an entry whose PROVISION had been cleaned
 * up reported "the device holds 1 face we did not authorize" on a system that
 * was entirely consistent. Retention quietly breaking reconciliation, and the
 * alarm being the thing that failed — the same shape as retention breaking
 * the punch-gap baseline.
 */
async function pruneCommands(cutoff: Date, batch: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c."id" FROM "sync_command" c
      LEFT JOIN "entry" e ON e."id" = c."entry_id"
     WHERE c."status" = 'SUCCESS'::"CommandStatus"
       AND c."completed_at" IS NOT NULL
       AND c."completed_at" < ${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC'
       AND (e."id" IS NULL OR e."state" = 'REGISTERED'::"EntryState")
     ORDER BY c."completed_at" ASC
     LIMIT ${batch}
  `;
  if (rows.length === 0) return 0;
  const deleted = await prisma.syncCommand.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  return deleted.count;
}

/**
 * Trim the audit log.
 *
 * Off by default, and deliberately so. This is the record of who authorized
 * whom to enter a site, which is the one thing an investigation needs and the
 * last thing that should quietly disappear on a timer. But DPDP also says
 * personal data must not be kept longer than necessary, and that tension is a
 * client's policy decision, not a default someone else picks for them. Set
 * AUDIT_RETENTION_DAYS to opt in.
 */
async function pruneAudit(cutoff: Date, batch: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "audit_log"
     WHERE "created_at" < ${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC'
     ORDER BY "created_at" ASC
     LIMIT ${batch}
  `;
  if (rows.length === 0) return 0;
  const deleted = await prisma.auditLog.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  return deleted.count;
}

const daysAgo = (days: number, now: Date): Date =>
  new Date(now.getTime() - days * 86_400_000);

/**
 * One retention pass.
 *
 * Bounded on purpose: it prunes at most a few batches per run rather than
 * everything due. A year of accumulated backlog cleared in one pass would
 * hold locks for minutes on a database that may not be ours; spread over
 * successive runs it is invisible. The work still converges, just politely.
 */
export async function runRetention(
  log: Logger,
  now: Date = new Date(),
  actorId?: string,
): Promise<RetentionResult> {
  const result: RetentionResult = {
    punchesSummarised: 0,
    punchesDeleted: 0,
    commandsDeleted: 0,
    auditDeleted: 0,
    unclaimedPhotosDeleted: 0,
  };

  const punchCutoff = daysAgo(config.punchRetentionDays, now);
  for (let i = 0; i < config.retentionPassesPerRun; i++) {
    const { summarised, deleted } = await summariseAndDeletePunches(
      punchCutoff,
      config.retentionBatch,
    );
    result.punchesSummarised += summarised;
    result.punchesDeleted += deleted;
    if (deleted < config.retentionBatch) break;
  }

  const commandCutoff = daysAgo(config.commandRetentionDays, now);
  for (let i = 0; i < config.retentionPassesPerRun; i++) {
    const n = await pruneCommands(commandCutoff, config.retentionBatch);
    result.commandsDeleted += n;
    if (n < config.retentionBatch) break;
  }

  if (config.auditRetentionDays !== null) {
    const auditCutoff = daysAgo(config.auditRetentionDays, now);
    for (let i = 0; i < config.retentionPassesPerRun; i++) {
      const n = await pruneAudit(auditCutoff, config.retentionBatch);
      result.auditDeleted += n;
      if (n < config.retentionBatch) break;
    }
  }

  if (config.unclaimedPhotoRetentionDays > 0) {
    result.unclaimedPhotosDeleted = await pruneUnclaimedPhotos(
      daysAgo(config.unclaimedPhotoRetentionDays, now),
      log,
    );
  }

  const didWork = Object.values(result).some((n) => n > 0);
  if (didWork) log.info({ ...result }, "retention pass complete — punches summarised before deletion");
  // Deleting is a state change: recorded whenever anything went, and for every
  // run an operator started (even an empty one), with who.
  if (didWork || actorId) {
    await prisma.auditLog.create({ data: auditRow({ action: AuditAction.RETENTION_RUN, entityType: "retention", entityId: "retention", detail: { ...result }, actorId }) });
  }
  return result;
}

/** Row counts and what is currently due, for the operator view. */
export async function retentionStatus(now: Date = new Date()) {
  const punchCutoff = daysAgo(config.punchRetentionDays, now);
  const commandCutoff = daysAgo(config.commandRetentionDays, now);

  const [punches, punchesDue, summaries, commands, commandsDue, audits] = await prisma.$transaction([
    prisma.punchEvent.count(),
    prisma.punchEvent.count({ where: { punchedAtUtc: { lt: punchCutoff } } }),
    prisma.attendanceDaySummary.count(),
    prisma.syncCommand.count(),
    prisma.syncCommand.count({
      where: {
        status: CommandStatus.SUCCESS,
        completedAt: { lt: commandCutoff },
        // Mirrors the prune's own guard, so "due" never overstates what will
        // actually happen. A status view that disagrees with the job is worse
        // than no status view.
        OR: [{ entryId: null }, { entry: { state: EntryState.REGISTERED } }],
      },
    }),
    prisma.auditLog.count(),
  ]);

  return {
    policy: {
      punchRetentionDays: config.punchRetentionDays,
      commandRetentionDays: config.commandRetentionDays,
      auditRetentionDays: config.auditRetentionDays,
      note:
        config.auditRetentionDays === null
          ? "Audit log is never pruned. It records who authorized whom; set AUDIT_RETENTION_DAYS only as a deliberate policy decision."
          : "Audit log pruning is enabled.",
    },
    punchEvent: { rows: punches, dueForSummary: punchesDue },
    attendanceDaySummary: { rows: summaries },
    syncCommand: { rows: commands, dueForDeletion: commandsDue },
    auditLog: { rows: audits },
  };
}

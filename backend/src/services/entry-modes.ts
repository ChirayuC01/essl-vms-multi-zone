import { CommandStatus, CommandType, EntryMode, EntryState, Prisma } from "@prisma/client";
import { publishCommand } from "../adms/queue.js";
import { config } from "../config/index.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { publish } from "../events/bus.js";
import { ServiceError } from "./errors.js";

// Entry modes (Phase 2 Milestone 9).
//
// MULTI_ENTRY people come and go freely for the life of their window.
// SINGLE_ENTRY people get one visit per day: the OUT punch moves them into
// the device's blocked group, and a daily reset moves them back.
//
// The enforcement point is the OUT punch, and that is a deliberate choice
// with a known weakness. The device drops repeat punches by the same user
// inside `Duplicate Punch Period(m)` — per user, regardless of punch state
// (VMS_PROJECT_CONTEXT.md §4.10) — so a person who leaves shortly after
// arriving can produce no OUT record at all, and the block never fires.
//
// Blocking on the IN punch instead would be immune to that, and is rejected:
// on a single bidirectional terminal a blocked person is denied at the very
// barrier they need to leave through. Trapping someone inside a site is a
// worse failure than a re-entry that should not have been allowed.
//
// Instead the unsafe configuration is refused up front — see
// `assertSingleEntrySupported`. A silent security degradation becomes a loud
// error at authorization time, which is the trade this design is built on.

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

const IST_OFFSET_MINUTES = 330;

/** An entry with everything needed to address its person on its device. */
interface EntryTarget {
  id: string;
  personId: string;
  esslUserId: string;
  targetDeviceId: string;
  normalGroupId: number;
  blockedGroupId: number;
}

/**
 * Resolve entries to their person's PIN and the device(s) they are loaded on.
 *
 * One row per (entry, device) — an entry can span more than one device (an
 * IN terminal and an OUT terminal covering one logical entrance), and a
 * group change must reach every roster the person actually sits in, not just
 * whichever device happened to receive the latest PROVISION command.
 *
 * The device comes from the entry's own PROVISION commands, not from
 * wherever a punch happened to arrive: on a multi-barrier site those differ,
 * and a block must reach the roster the person actually sits in.
 *
 * See the note in `jobs/expiry.ts` about `::timestamptz AT TIME ZONE 'UTC'`
 * — no timestamp is compared here, which is why none appears.
 */
async function entryTargets(where: Prisma.Sql): Promise<EntryTarget[]> {
  return prisma.$queryRaw<EntryTarget[]>`
    SELECT DISTINCT
           e."id",
           e."person_id"     AS "personId",
           v."essl_user_id"  AS "esslUserId",
           d."id"            AS "targetDeviceId",
           d."normal_group_id"  AS "normalGroupId",
           d."blocked_group_id" AS "blockedGroupId"
      FROM "entry" e
      JOIN "person" v ON v."id" = e."person_id"
      JOIN "sync_command" sc ON sc."entry_id" = e."id" AND sc."type" = 'PROVISION'::"CommandType"
      JOIN "device" d ON d."id" = sc."target_device_id"
     WHERE ${where}
  `;
}

/**
 * Queue a group change for a batch of entries.
 *
 * `dayBlocked` is NOT set here. It flips only when the device acknowledges
 * the command (`applyBlockState` in `services/entries.ts`), because until
 * then the person's access on the terminal is unchanged and claiming
 * otherwise would make the UI lie about who can open a barrier.
 */
async function queueGroupChange(
  targets: EntryTarget[],
  blocked: boolean,
  keySuffix: string,
  log: Logger,
): Promise<number> {
  if (targets.length === 0) return 0;

  const commands = await prisma.$transaction(async (tx) => {
    const created = await tx.syncCommand.createManyAndReturn({
      data: targets.map((t) => ({
        type: blocked ? CommandType.BLOCK : CommandType.UNBLOCK,
        targetDeviceId: t.targetDeviceId,
        payload: {
          pin: t.esslUserId,
          grp: blocked ? t.blockedGroupId : t.normalGroupId,
        } as Prisma.InputJsonValue,
        // Scoped to the day rather than to a timestamp: re-running a reset,
        // or reprocessing a punch batch, must not queue a second identical
        // group change. This is the opposite of the operator path, where
        // every deliberate click is its own command. Also scoped to the
        // device: an entry spanning two devices produces two target rows
        // here, and without the device in the key the second would collide
        // with the first as a false "duplicate" and never get queued.
        idempotencyKey: `${blocked ? "day-block" : "day-unblock"}:${t.id}:${t.targetDeviceId}:${keySuffix}`,
        entryId: t.id,
        personId: t.personId,
        initiatedById: null, // system-initiated: an entry mode, not a decision
      })),
      skipDuplicates: true,
    });

    await tx.auditLog.createMany({
      data: created.map((c) =>
        auditRow({
          action: blocked
            ? AuditAction.ENTRY_BLOCK_REQUESTED
            : AuditAction.ENTRY_UNBLOCK_REQUESTED,
          entityType: "entry",
          entityId: c.entryId as string,
          detail: { deviceId: c.targetDeviceId, reason: blocked ? "SINGLE_ENTRY_EXIT" : "DAILY_RESET" },
        }),
      ) as Prisma.AuditLogCreateManyInput[],
    });
    return created;
  });

  for (const c of commands) publishCommand(c);
  if (commands.length > 0) {
    log.info({ count: commands.length, blocked }, blocked ? "SINGLE_ENTRY exit — block queued" : "daily reset — unblock queued");
  }
  return commands.length;
}

// ---------------------------------------------------------------------------
// Provision-time guard
// ---------------------------------------------------------------------------

/**
 * Refuse a SINGLE_ENTRY authorization the device cannot actually enforce.
 *
 * On a bidirectional terminal, a non-zero duplicate-punch window can swallow
 * the OUT punch this mode depends on, and single-entry silently becomes
 * multi-entry with nothing logged anywhere. An unrecorded window is treated
 * the same as a bad one: "nobody has checked" is not evidence of safety for a
 * control that decides who can re-enter a site.
 *
 * A dedicated IN or OUT gate is unaffected — the two halves of a visit land
 * on different terminals, so neither sees a repeat by the same user.
 */
export async function assertSingleEntrySupported(
  device: {
    role: string;
    serialNo: string;
    duplicatePunchPeriodMinutes: number | null;
  },
  entryMode: EntryMode,
): Promise<void> {
  if (entryMode !== EntryMode.SINGLE_ENTRY) return;
  if (device.role !== "BOTH") return;

  const window = device.duplicatePunchPeriodMinutes;
  if (window === 0) return;

  const state =
    window === null
      ? "has no recorded duplicate-punch window"
      : `has a duplicate-punch window of ${window} minute(s)`;
  throw new ServiceError(
    409,
    `device ${device.serialNo} reports both directions and ${state}. SINGLE_ENTRY is enforced ` +
      `on the OUT punch, and the terminal drops repeat punches by the same user inside that ` +
      `window before sending them — so the OUT can be lost and the person would keep re-entering. ` +
      `Set Menu > System > Attendance > Duplicate Punch Period(m) to 0 on the terminal, then record ` +
      `that on the Devices page (Duplicate punch period field) so this device is cleared for it. ` +
      `Use MULTI_ENTRY if single-entry enforcement is not required.`,
  );
}

// ---------------------------------------------------------------------------
// Block on exit
// ---------------------------------------------------------------------------

/**
 * Block SINGLE_ENTRY people who just punched out. Called from the punch path
 * with the entries that transitioned INSIDE → PROVISIONED.
 */
export async function blockSingleEntryOnExit(
  entryIds: string[],
  log: Logger,
  now: Date = new Date(),
): Promise<number> {
  if (entryIds.length === 0) return 0;
  const targets = await entryTargets(
    Prisma.sql`e."id" = ANY(${entryIds}::text[])
               AND e."entry_mode" = ${EntryMode.SINGLE_ENTRY}::"EntryMode"
               AND e."state" = ${EntryState.PROVISIONED}::"EntryState"
               AND e."day_blocked" = FALSE`,
  );
  return queueGroupChange(targets, true, localDate(now, IST_OFFSET_MINUTES), log);
}

// ---------------------------------------------------------------------------
// Daily reset
// ---------------------------------------------------------------------------

/** The device's own calendar date, as YYYY-MM-DD. */
export function localDate(now: Date, offsetMinutes: number): string {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** The device's own hour, 0-23. */
export function localHour(now: Date, offsetMinutes: number): number {
  return new Date(now.getTime() + offsetMinutes * 60_000).getUTCHours();
}

export interface ResetResult {
  devicesReset: number;
  unblocked: number;
}

/**
 * Has this device rolled into a local day it has not been reset for yet?
 *
 * Extracted so the decision can be tested directly. Inside `runDailyReset` it
 * is invisible to a test whenever `DAILY_RESET_HOUR` is 0 — the hour gate is
 * then always satisfied and only the date comparison does any work, which is
 * exactly the shape that hides an off-by-one until a client sets a non-zero
 * hour in production.
 */
export function isResetDue(
  device: { timezoneOffsetMinutes: number; lastDayResetOn: string | null },
  now: Date,
  resetHour: number,
): boolean {
  if (localDate(now, device.timezoneOffsetMinutes) === device.lastDayResetOn) return false;
  return localHour(now, device.timezoneOffsetMinutes) >= resetHour;
}

/**
 * Un-block SINGLE_ENTRY people for a new day.
 *
 * Driven by each device's own local date rather than by the schedule firing:
 * the job asks "has this device rolled into a day I have not reset yet?", so
 * a service that was down at midnight still catches up on its next run, and
 * a job that runs twice does nothing the second time. Running frequently is
 * therefore cheap and safe — the cadence only affects promptness.
 */
export async function runDailyReset(
  log: Logger,
  now: Date = new Date(),
): Promise<ResetResult> {
  const devices = await prisma.device.findMany({
    select: { id: true, serialNo: true, timezoneOffsetMinutes: true, lastDayResetOn: true },
  });

  const due = devices.filter((d) => isResetDue(d, now, config.dailyResetHour));
  if (due.length === 0) return { devicesReset: 0, unblocked: 0 };

  const targets = await entryTargets(
    Prisma.sql`d."id" = ANY(${due.map((d) => d.id)}::text[])
               AND e."day_blocked" = TRUE
               AND e."state" IN (${EntryState.PROVISIONED}::"EntryState", ${EntryState.INSIDE}::"EntryState")
               AND (e."retention_expires_at" IS NULL
                    OR e."retention_expires_at" > ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`,
  );

  // A person whose window has already closed is deliberately NOT un-blocked.
  // The expiry sweeper is about to remove them; restoring their access first
  // would hand a lapsed authorization a few minutes of working entry.
  const unblocked = await queueGroupChange(
    targets,
    false,
    localDate(now, IST_OFFSET_MINUTES),
    log,
  );

  // Marked per device only after its unblocks are queued, so a failure part
  // way through leaves the day unreset and the next run retries it.
  await prisma.$transaction(
    due.map((d) =>
      prisma.device.update({
        where: { id: d.id },
        data: { lastDayResetOn: localDate(now, d.timezoneOffsetMinutes) },
      }),
    ),
  );

  log.info(
    { devices: due.map((d) => d.serialNo), unblocked },
    "daily reset — SINGLE_ENTRY people released for a new day",
  );
  return { devicesReset: due.length, unblocked };
}

/** Entries currently day-blocked, for the operator view. */
export async function dayBlockedEntries(limit = 200) {
  return prisma.entry.findMany({
    where: { dayBlocked: true, state: { in: [EntryState.PROVISIONED, EntryState.INSIDE] } },
    orderBy: { outAt: "desc" },
    take: limit,
    select: {
      id: true,
      state: true,
      entryMode: true,
      inAt: true,
      outAt: true,
      retentionExpiresAt: true,
      person: { select: { id: true, name: true, company: true, esslUserId: true } },
    },
  });
}

/** Block/unblock commands the device has not confirmed yet. */
export async function pendingGroupChanges(): Promise<number> {
  return prisma.syncCommand.count({
    where: {
      type: { in: [CommandType.BLOCK, CommandType.UNBLOCK] },
      status: { in: [CommandStatus.PENDING, CommandStatus.SENT, CommandStatus.RETRY] },
    },
  });
}

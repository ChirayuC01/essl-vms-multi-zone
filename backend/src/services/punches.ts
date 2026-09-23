import { EntryState, type Device, type PunchEvent } from "@prisma/client";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { userIdKey } from "../user-id.js";
import { publish } from "../events/bus.js";
import { deprovisionLapsedOnExit } from "../jobs/expiry.js";
import { blockSingleEntryOnExit } from "./entry-modes.js";

// Punch → entry state machine (Phase 2 Milestone 7).
//
// Two facts from the hardware shape everything here:
//
//   1. ATTLOG field 3 is the device's attendance state, and it is per-punch
//      (VMS_PROJECT_CONTEXT.md §4.9). Direction is therefore data, not an
//      assumption about which box reported it.
//   2. The device suppresses repeat punches by the same user inside
//      `Duplicate Punch Period(m)` — per user, NOT per punch state (§4.10).
//      A movement can therefore produce no record at all.
//
// Fact 2 is why nothing in this file treats punches as a complete account of
// physical movement. Every transition is guarded on the state it expects, so
// a missing OUT leaves an entry visibly INSIDE rather than corrupting it, and
// a replayed punch changes nothing.

export type PunchDirection = "IN" | "OUT";

/** How a direction was decided — carried into logs so surprises are legible. */
export type DirectionSource = "DEVICE_ROLE" | "STATUS_CODE" | "ALTERNATION";

export interface DirectionResult {
  direction: PunchDirection;
  source: DirectionSource;
  /**
   * The device's role and the punch's status code disagree. The role wins —
   * it is the physical gate — but this is a misconfiguration signal: a
   * terminal wired as the IN gate is stamping Check-Out on its records.
   */
  conflict: boolean;
}

type DirectionConfig = Pick<Device, "role" | "inStatusCodes" | "outStatusCodes">;

function codeDirection(device: DirectionConfig, statusCode: number | null): PunchDirection | null {
  if (statusCode === null) return null;
  if (device.inStatusCodes.includes(statusCode)) return "IN";
  if (device.outStatusCodes.includes(statusCode)) return "OUT";
  return null;
}

/**
 * Decide which way a punch went.
 *
 * A dedicated gate (role IN/OUT) is authoritative — it is a physical fact
 * about where the barrier stands, and no field in a record outranks it.
 *
 * A bidirectional terminal (role BOTH) has only the status code, and that
 * code can be missing or unmapped: in Manual Mode the operator selects the
 * state with F1/F2 *before* presenting their face, and forgetting to press
 * anything is an ordinary human event, not an exception. Falling back to
 * alternation from the entry's current state keeps a real movement from being
 * discarded because of a missed keypress.
 */
export function resolveDirection(
  device: DirectionConfig,
  statusCode: number | null,
  entryState: EntryState | null,
): DirectionResult {
  const fromCode = codeDirection(device, statusCode);

  if (device.role === "IN" || device.role === "OUT") {
    const direction: PunchDirection = device.role === "IN" ? "IN" : "OUT";
    return { direction, source: "DEVICE_ROLE", conflict: fromCode !== null && fromCode !== direction };
  }

  if (fromCode) return { direction: fromCode, source: "STATUS_CODE", conflict: false };

  return {
    direction: entryState === EntryState.INSIDE ? "OUT" : "IN",
    source: "ALTERNATION",
    conflict: false,
  };
}

// ---------------------------------------------------------------------------
// Applying punches to entries
// ---------------------------------------------------------------------------

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/** Entry states in which a punch is a meaningful movement. */
const OPEN_STATES = [
  EntryState.PROVISIONED,
  EntryState.INSIDE,
  EntryState.PENDING_DEPROVISION,
] as const;

type PunchRow = Pick<PunchEvent, "id" | "esslUserId" | "statusCode" | "punchedAtUtc">;

interface WorkingEntry {
  id: string;
  personId: string;
  state: EntryState;
  dayBlocked: boolean;
  inAt: Date | null;
  outAt: Date | null;
  touched: boolean;
}

export interface ProcessResult {
  processed: number;
  transitions: number;
  unmatched: number;
}

/**
 * Apply a batch of punches to their entries.
 *
 * Query shape is fixed regardless of batch size: two reads to load the
 * people and their open entries, then one transaction carrying the writes.
 * No lookup happens inside the per-punch loop (CLAUDE.md #4) — the loop walks
 * an in-memory model and the results are flushed once, so a person who
 * punches IN and OUT within the same batch is folded into a single update.
 */
export async function processPunches(
  device: Device,
  punches: PunchRow[],
  log: Logger,
): Promise<ProcessResult> {
  if (punches.length === 0) return { processed: 0, transitions: 0, unmatched: 0 };

  // Case-INSENSITIVE, and raw SQL because Prisma has no case-insensitive `in`.
  // This is the join that decides whether a punch reaches its entry at all: a
  // terminal reporting `wctpl070` for a person stored as `WCTPL070` would
  // otherwise resolve to nobody, the movement would be recorded as unmatched,
  // and the person would sit PROVISIONED forever while walking in and out.
  // Still ONE query for the batch, on the functional unique index.
  const keys = [...new Set(punches.map((p) => userIdKey(p.esslUserId)))];
  const people = await prisma.$queryRaw<{ id: string; key: string }[]>`
    SELECT "id", UPPER("essl_user_id") AS key
      FROM "person"
     WHERE UPPER("essl_user_id") = ANY(${keys}::text[])
  `;
  const personIdByPin = new Map(people.map((v) => [v.key, v.id]));

  // Oldest first: an entry's state has to evolve in the order the movements
  // actually happened, and a batch can carry a whole IN/OUT cycle.
  const openEntries = await prisma.entry.findMany({
    where: { personId: { in: people.map((v) => v.id) }, state: { in: [...OPEN_STATES] } },
    select: { id: true, personId: true, state: true, dayBlocked: true, inAt: true, outAt: true },
    orderBy: { createdAt: "desc" },
  });
  const entryByPerson = new Map<string, WorkingEntry>();
  for (const e of openEntries) {
    // Newest first, so the first row seen for a person is their current
    // authorization cycle; older open entries are left alone.
    if (!entryByPerson.has(e.personId)) entryByPerson.set(e.personId, { ...e, touched: false });
  }

  const linked = new Map<string, string[]>(); // entryId -> punch ids
  const unlinked: string[] = [];
  const directionIds: Record<PunchDirection, string[]> = { IN: [], OUT: [] };
  const audits = [];
  let transitions = 0;

  const ordered = [...punches].sort(
    (a, b) => a.punchedAtUtc.getTime() - b.punchedAtUtc.getTime(),
  );

  for (const punch of ordered) {
    const personId = personIdByPin.get(userIdKey(punch.esslUserId));
    const entry = personId ? entryByPerson.get(personId) : undefined;
    const { direction, source, conflict } = resolveDirection(device, punch.statusCode, entry?.state ?? null);
    directionIds[direction].push(punch.id);

    if (!entry) {
      // Expected and benign on a shared terminal: employees punch on the same
      // device and own no entry here. Recorded, never dropped — punch_event
      // keeps the row so a PIN that should have matched is still visible.
      unlinked.push(punch.id);
      continue;
    }

    const forEntry = linked.get(entry.id);
    if (forEntry) forEntry.push(punch.id);
    else linked.set(entry.id, [punch.id]);

    if (conflict) {
      log.warn(
        { punchId: punch.id, pin: punch.esslUserId, role: device.role, statusCode: punch.statusCode },
        "punch status code disagrees with the device's gate role — role wins, check device config",
      );
      audits.push(
        auditRow({
          action: AuditAction.PUNCH_DIRECTION_CONFLICT,
          entityType: "punch_event",
          entityId: punch.id,
          detail: {
            deviceId: device.id,
            role: device.role,
            statusCode: punch.statusCode,
            appliedDirection: direction,
          },
        }),
      );
    }

    if (direction === "IN" && entry.state === EntryState.PROVISIONED) {
      entry.state = EntryState.INSIDE;
      entry.inAt = punch.punchedAtUtc;
      entry.touched = true;
      transitions += 1;
    } else if (direction === "OUT" && entry.state === EntryState.INSIDE) {
      entry.state = EntryState.PROVISIONED;
      entry.outAt = punch.punchedAtUtc;
      entry.touched = true;
      transitions += 1;
    } else {
      // Not an error. A second IN while already INSIDE is what a missing OUT
      // looks like from here (§4.10), and a punch during PENDING_DEPROVISION
      // means the delete has not reached the device yet. Both are real events
      // worth seeing; neither may move the state machine sideways.
      log.info(
        {
          punchId: punch.id,
          pin: punch.esslUserId,
          direction,
          source,
          state: entry.state,
        },
        "punch recorded against entry without a state change",
      );
    }
  }

  await prisma.$transaction([
    ...[...entryByPerson.values()]
      .filter((e) => e.touched)
      .map((e) =>
        prisma.entry.update({
          where: { id: e.id },
          // inAt/outAt are the MOST RECENT crossing in each direction, so the
          // inside-now board can render "inside since" straight off the row.
          // The complete movement history is punch_event, which is why these
          // two can be overwritten without losing anything.
          data: { state: e.state, inAt: e.inAt, outAt: e.outAt },
        }),
      ),
    ...[...linked.entries()].map(([entryId, ids]) =>
      prisma.punchEvent.updateMany({
        where: { id: { in: ids } },
        data: { processed: true, entryId },
      }),
    ),
    ...(unlinked.length > 0
      ? [
          prisma.punchEvent.updateMany({
            where: { id: { in: unlinked } },
            data: { processed: true },
          }),
        ]
      : []),
    ...(["IN", "OUT"] as const)
      .filter((direction) => directionIds[direction].length > 0)
      .map((direction) =>
        prisma.punchEvent.updateMany({
          where: { id: { in: directionIds[direction] } },
          data: { direction },
        }),
      ),
    ...audits.map((data) => prisma.auditLog.create({ data })),
  ]);

  for (const e of entryByPerson.values()) {
    if (e.touched) {
      publish("entry", {
        id: e.id,
        personId: e.personId,
        state: e.state,
        dayBlocked: e.dayBlocked,
      });
    }
  }

  // Someone whose window closed while they were still on site. The sweeper
  // skipped them by design — de-provisioning a person who is INSIDE strands
  // them at the exit barrier — so walking out is the moment it becomes safe,
  // and doing it here means they leave with the right access rather than
  // waiting up to a full sweep interval.
  const exited = [...entryByPerson.values()]
    .filter((e) => e.touched && e.state === EntryState.PROVISIONED)
    .map((e) => e.id);
  const removed = await deprovisionLapsedOnExit(exited, log);
  if (removed > 0) {
    log.info({ count: removed }, "person left after their window had lapsed — de-provisioned on exit");
  }

  // SINGLE_ENTRY: leaving consumes the day. Ordered after the expiry check on
  // purpose — a person being removed from the device entirely does not also
  // need blocking, and `blockSingleEntryOnExit` skips anything no longer
  // PROVISIONED, so the de-provision above takes precedence naturally.
  const blocked = await blockSingleEntryOnExit(exited, log);
  if (blocked > 0) {
    log.info({ count: blocked }, "SINGLE_ENTRY person punched out — blocked until the daily reset");
  }

  return { processed: punches.length, transitions, unmatched: unlinked.length };
}

import { CommandStatus, CommandType } from "@prisma/client";
import { photoOnDisk } from "../adms/ingest.js";
import { enqueue } from "../adms/queue.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { parseUserId } from "../user-id.js";
import { ServiceError } from "./errors.js";

// Roster backfill — adopting a device that was already populated before the
// VMS existed.
//
// Every other path in this system learns about a PIN because something
// happened to it: an enrollment pushes a USER record, a menu edit pushes an
// OPLOG line, reconciliation asks about people we already know. A device
// carrying two years of pre-existing enrollments generates none of those, and
// this firmware has no "list every user" command (see reconcile.ts), so those
// people are invisible forever. The only way to find them is to ask about
// each PIN individually and see what comes back.
//
// That makes this a brute-force scan, and the cost is entirely in the command
// queue: getrequest hands the device ONE command per poll, ordered by seq. So
// a scan that dumps its whole range in at once puts every operator provision
// behind tens of thousands of queries — the person standing at the barrier
// waits for a backfill. Instead the scan keeps a small window in flight and
// refills it on a tick, so real work is never more than a window behind.
//
// Nothing is created from a scan. The answers flow through the ordinary
// ingest path: USER records reconcile, BIOPHOTOs land on disk, and the
// unclaimed-enrollments panel is where a person decides who is a person.
//
// THREE WAYS TO SAY WHICH IDS TO ASK ABOUT, because a real roster is not a
// plain numeric range:
//
//   RANGE  1..5000                  - the original, for numeric rosters
//   RANGE  WCTPL001..WCTPL999       - a prefix and a zero-padded counter,
//                                     which is what field rosters actually
//                                     look like (`WCTPL070`, `ye01`)
//   LIST   [ids]                    - pasted, or read out of a CSV/XLSX
//                                     export from the site's old system
//
// A pattern scan matters because alphanumeric IDs cannot be brute-forced:
// six characters of [0-9A-Z] is two billion combinations, and at one command
// per device poll that scan never finishes. Structure is what makes the
// search space walkable, and a list is what covers whatever has no structure.

/** In-flight scan queries per device. Also the per-tick ceiling. */
const WINDOW = 50;

/**
 * The widest range one scan may cover. At one command per device poll a scan
 * moves at roughly device-poll speed, so this is a bound on how long an
 * operator can commit the queue for — not a statement about PIN layout.
 */
const MAX_SPAN = 50_000;

const KEY_PREFIX = "device-scan:";

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/**
 * What a scan will ask about, held as a description rather than a
 * materialised list: a 50,000-ID range would otherwise be a 400 KB JSON blob
 * rewritten on every tick, for a sequence that is entirely computable from
 * four numbers.
 */
export type ScanPlan =
  /** `prefix` + a zero-padded counter. Plain numbers are prefix "" and pad 0. */
  | { kind: "RANGE"; prefix: string; from: number; to: number; pad: number }
  /** Explicit IDs - pasted, or read from an uploaded file. */
  | { kind: "LIST"; ids: string[] };

export interface ScanState {
  deviceId: string;
  plan: ScanPlan;
  /** Index of the next ID to enqueue. At `planSize` the plan is fully queued. */
  cursor: number;
  /** IDs actually asked about; skipped ones are not counted. */
  queried: number;
  /** IDs passed over because a photo for them was already on disk. */
  skipped: number;
  startedAt: string;
  requestedBy: string | null;
}

/** How many IDs a plan covers. */
export function planSize(plan: ScanPlan): number {
  return plan.kind === "LIST" ? plan.ids.length : plan.to - plan.from + 1;
}

/** The i-th ID of a plan, or null past the end. */
export function idAt(plan: ScanPlan, i: number): string | null {
  if (i < 0 || i >= planSize(plan)) return null;
  if (plan.kind === "LIST") return plan.ids[i] ?? null;
  return `${plan.prefix}${String(plan.from + i).padStart(plan.pad, "0")}`;
}

function keyFor(deviceId: string): string {
  return `${KEY_PREFIX}${deviceId}`;
}

/**
 * Commands belonging to one scan run, never to the device generally — the
 * window must not be held open by an operator's provisions, and a later scan
 * of the same range must be able to re-ask questions an earlier one asked.
 */
function commandKeyPrefix(state: ScanState): string {
  return `device-scan:${state.deviceId}:${state.startedAt}:`;
}

/**
 * How much of the range to queue next.
 *
 * Pure so the window arithmetic can be pinned by tests: the failure that
 * matters here is a slice that keeps re-queueing the same PIN (a scan that
 * never ends) or one that steps past a PIN (a person never found), and
 * neither is visible from looking at it.
 */
export function planSlice(
  state: Pick<ScanState, "plan" | "cursor">,
  inFlight: number,
  window = WINDOW,
): { pins: string[]; cursor: number } {
  const room = Math.min(window - inFlight, planSize(state.plan) - state.cursor);
  if (room <= 0) return { pins: [], cursor: state.cursor };
  const pins: string[] = [];
  for (let i = 0; i < room; i++) {
    const id = idAt(state.plan, state.cursor + i);
    if (id !== null) pins.push(id);
  }
  return { pins, cursor: state.cursor + room };
}

async function readState(deviceId: string): Promise<ScanState | null> {
  const row = await prisma.appConfig.findUnique({ where: { key: keyFor(deviceId) } });
  return row ? migrateState(row.value as unknown as Record<string, unknown>) : null;
}

/**
 * A scan running across the upgrade to alphanumeric IDs still has the old
 * {startPin,endPin,nextPin} shape in app_config. Convert it rather than
 * dropping it: a scan is hours of queue time and losing it silently would
 * look exactly like a scan that finished.
 */
function migrateState(value: Record<string, unknown>): ScanState {
  if (value.plan) return value as unknown as ScanState;
  const from = Number(value.startPin ?? 1);
  const to = Number(value.endPin ?? 0);
  const next = Number(value.nextPin ?? from);
  return {
    deviceId: String(value.deviceId),
    plan: { kind: "RANGE", prefix: "", from, to, pad: 0 },
    cursor: Math.max(0, next - from),
    queried: Number(value.queried ?? 0),
    skipped: Number(value.skipped ?? 0),
    startedAt: String(value.startedAt ?? new Date().toISOString()),
    requestedBy: (value.requestedBy as string | null) ?? null,
  };
}

async function writeState(state: ScanState): Promise<void> {
  await prisma.appConfig.upsert({
    where: { key: keyFor(state.deviceId) },
    update: { value: state as unknown as object },
    create: { key: keyFor(state.deviceId), value: state as unknown as object },
  });
}

/** Begin a scan. One per device — a second would double the queue pressure. */
export async function startScan(
  deviceId: string,
  plan: ScanPlan,
  requestedBy: string | null,
): Promise<ScanState> {
  const size = planSize(plan);
  if (size <= 0) {
    throw new ServiceError(400, "that scan covers no IDs at all");
  }
  if (size > MAX_SPAN) {
    throw new ServiceError(
      400,
      `that scan covers ${size} IDs; ${MAX_SPAN} is the most one scan may cover. ` +
        "Scan the range the terminal actually uses, or run it in parts.",
    );
  }
  // Every generated ID has to be one the device could actually hold, checked
  // here rather than at send time: a plan that produces a single invalid ID
  // would otherwise fail thousands of commands into the run.
  for (const sample of [idAt(plan, 0), idAt(plan, size - 1)]) {
    if (sample === null || parseUserId(sample) === null) {
      throw new ServiceError(
        400,
        `this scan would ask about "${sample ?? ""}", which is not a valid user ID ` +
          "(letters and digits only)",
      );
    }
  }

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw new ServiceError(404, "device not found");
  if (await readState(deviceId)) {
    throw new ServiceError(409, "a scan is already running on this device — stop it first");
  }

  const state: ScanState = {
    deviceId,
    plan,
    cursor: 0,
    queried: 0,
    skipped: 0,
    startedAt: new Date().toISOString(),
    requestedBy,
  };
  await writeState(state);
  await prisma.auditLog.create({
    data: auditRow({
      action: AuditAction.DEVICE_SCAN_STARTED,
      entityType: "device",
      entityId: deviceId,
      detail: { serialNo: device.serialNo, plan: plan as unknown as object, size },
      actorId: requestedBy ?? undefined,
    }),
  });
  return state;
}

/**
 * Stop a scan. Queries already handed to the queue are left to drain rather
 * than cancelled — they are read-only questions, and cancelling them would
 * mean deleting rows the device may already be answering.
 */
export async function stopScan(deviceId: string): Promise<boolean> {
  const { count } = await prisma.appConfig.deleteMany({ where: { key: keyFor(deviceId) } });
  return count > 0;
}

export async function listScans(): Promise<ScanState[]> {
  const rows = await prisma.appConfig.findMany({ where: { key: { startsWith: KEY_PREFIX } } });
  return rows.map((r) => r.value as unknown as ScanState);
}

export interface ScanTickResult {
  scans: number;
  queued: number;
  finished: number;
}

/**
 * Advance every running scan by at most one window. Called on a schedule;
 * doing nothing is the normal outcome once the window is full.
 */
export async function scanTick(log: Logger): Promise<ScanTickResult> {
  const states = await listScans();
  let queued = 0;
  let finished = 0;

  for (const state of states) {
    const inFlight = await prisma.syncCommand.count({
      where: {
        targetDeviceId: state.deviceId,
        status: { in: [CommandStatus.PENDING, CommandStatus.RETRY, CommandStatus.SENT] },
        idempotencyKey: { startsWith: commandKeyPrefix(state) },
      },
    });

    // Done only once the plan is exhausted AND the last answers are back,
    // so the final IDs are not dropped by the state disappearing early.
    if (state.cursor >= planSize(state.plan)) {
      if (inFlight === 0) {
        await stopScan(state.deviceId);
        finished += 1;
        log.info(
          { deviceId: state.deviceId, queried: state.queried, skipped: state.skipped },
          "device roster scan complete — check unclaimed enrollments for what it found",
        );
      }
      continue;
    }

    const slice = planSlice(state, inFlight);
    for (const pin of slice.pins) {
      // A PIN whose photo is already on disk has nothing left to learn, so
      // re-running a scan over ground already covered costs a stat() rather
      // than hours of queue time.
      if (await photoOnDisk(pin)) {
        state.skipped += 1;
        continue;
      }
      await enqueue({
        type: CommandType.QUERY_USER,
        targetDeviceId: state.deviceId,
        payload: { pin },
        idempotencyKey: `${commandKeyPrefix(state)}${pin}`,
      });
      state.queried += 1;
      queued += 1;
    }
    state.cursor = slice.cursor;
    await writeState(state);
  }

  return { scans: states.length, queued, finished };
}

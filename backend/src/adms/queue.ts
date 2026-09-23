import { readFile } from "node:fs/promises";
import { CommandStatus, CommandType, Prisma, type SyncCommand } from "@prisma/client";
import { prisma } from "../db/index.js";
import { publish } from "../events/bus.js";
import {
  buildCreateUser,
  buildDeleteUser,
  buildDeviceInfo,
  buildPushPhoto,
  buildQueryUser,
  buildSetGroup,
} from "./commands.js";

// DB-backed command queue over sync_command. Rules (CLAUDE.md #8, PRD §10):
// every device write goes through here; idempotent, retried, status-tracked;
// and the getrequest hot path claims a command in ONE database round trip —
// it fires every 1–3 s per device and must stay fast on a remote database.

const MAX_ATTEMPTS = 5;
const SENT_TIMEOUT_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

// Typed payload shapes stored in sync_command.payload (JSONB).
export type CommandPayload =
  | { pin: string; name: string; grp: number } // PROVISION
  | { pin: string; photoPath: string } // PUSH_PHOTO
  | { pin: string; countedOnDevice: boolean } // DEPROVISION
  | { pin: string } // QUERY_USER
  | { pin: string; grp: number } // BLOCK / UNBLOCK
  | Record<string, never>; // DEVICE_INFO

export interface EnqueueOptions {
  type: CommandType;
  targetDeviceId: string;
  payload: CommandPayload;
  idempotencyKey: string;
  entryId?: string | undefined;
  personId?: string | undefined;
  /** Operator who triggered this; omit for system-initiated (jobs). */
  initiatedById?: string | undefined;
}

/** Put a command on the live feed so the queue view updates without polling. */
export function publishCommand(command: SyncCommand): void {
  publish("command", {
    id: command.id,
    type: command.type,
    status: command.status,
    targetDeviceId: command.targetDeviceId,
    deviceCmdId: command.deviceCmdId,
    personId: command.personId,
    entryId: command.entryId,
    lastError: command.lastError,
  });
}

function commandData(opts: EnqueueOptions): Prisma.SyncCommandUncheckedCreateInput {
  return {
    type: opts.type,
    targetDeviceId: opts.targetDeviceId,
    payload: opts.payload as Prisma.InputJsonValue,
    idempotencyKey: opts.idempotencyKey,
    entryId: opts.entryId ?? null,
    personId: opts.personId ?? null,
    initiatedById: opts.initiatedById ?? null,
  };
}

/**
 * Enqueue a command. Re-enqueueing the same idempotency key is a no-op that
 * returns the existing row, so callers can retry blindly.
 */
export async function enqueue(opts: EnqueueOptions): Promise<SyncCommand> {
  try {
    const created = await prisma.syncCommand.create({ data: commandData(opts) });
    publishCommand(created);
    return created;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.syncCommand.findUnique({
        where: { idempotencyKey: opts.idempotencyKey },
      });
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Enqueue inside a caller's transaction, so a command and the state change
 * that justifies it commit together or not at all.
 *
 * No idempotency fallback here, deliberately: recovering from a duplicate key
 * needs a SELECT, and in Postgres the failed INSERT has already aborted the
 * transaction by then. Callers must supply a key that cannot collide (one
 * derived from the row they just created). A collision surfaces as P2002 and
 * rolls the whole operation back — the honest outcome.
 */
export async function enqueueIn(
  client: Prisma.TransactionClient,
  opts: EnqueueOptions,
): Promise<SyncCommand> {
  return client.syncCommand.create({ data: commandData(opts) });
}

/**
 * Put a FAILED command back in the queue (the operator's retry action).
 * The attempt counter resets so the timeout sweep gives it a full budget
 * again, and the stale wire id is cleared — a new one is drawn at claim.
 */
export async function requeueCommand(commandId: string): Promise<SyncCommand> {
  const requeued = await prisma.syncCommand.update({
    where: { id: commandId },
    data: {
      status: CommandStatus.PENDING,
      attempts: 0,
      lastError: null,
      deviceCmdId: null,
      sentAt: null,
      completedAt: null,
    },
  });
  publishCommand(requeued);
  return requeued;
}

interface ClaimedRow {
  id: string;
  type: CommandType;
  payload: CommandPayload | null;
  deviceCmdId: number;
}

/**
 * Claim the oldest PENDING/RETRY command for a device — one round trip.
 * FOR UPDATE SKIP LOCKED keeps concurrent polls (two devices, or a device
 * retrying quickly) from handing out the same row twice. A fresh wire id is
 * drawn per claim so late replies to earlier attempts can't mis-correlate.
 *
 * Ordering is by `seq`, never created_at: commands enqueued in one
 * transaction share a created_at and would tie. PROVISION must reach the
 * device before the PUSH_PHOTO that attaches to it.
 *
 * `AT TIME ZONE 'UTC'` on sent_at is load-bearing, not decoration. The column
 * is `timestamp without time zone` and Prisma reads every such column as UTC,
 * but bare `NOW()` is a timestamptz that Postgres converts to the *session's*
 * zone on assignment. On any server east of UTC the value therefore lands in
 * the future, and `sweepTimeouts` — which compares against a JS UTC cutoff —
 * silently never fires, leaving a stranded command stuck as SENT forever.
 */
async function claimNext(deviceId: string): Promise<ClaimedRow | null> {
  const rows = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "sync_command" SET
      "status" = 'SENT'::"CommandStatus",
      "device_cmd_id" = nextval('sync_command_wire_id_seq')::int,
      "sent_at" = (NOW() AT TIME ZONE 'UTC'),
      "attempts" = "attempts" + 1
    WHERE "id" = (
      SELECT "id" FROM "sync_command"
      WHERE "target_device_id" = ${deviceId}
        AND "status" IN ('PENDING'::"CommandStatus", 'RETRY'::"CommandStatus")
      ORDER BY "seq" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "type", "payload", "device_cmd_id" AS "deviceCmdId"
  `;
  return rows[0] ?? null;
}

/** Render a claimed row into wire text. PUSH_PHOTO reads the JPEG from disk. */
async function buildWireText(type: CommandType, payload: CommandPayload | null): Promise<string> {
  const p = (payload ?? {}) as Record<string, unknown>;
  // `pin` was a JSON number until user IDs became text, and a row queued
  // before that upgrade is still holding one when this runs. String() covers
  // both for as long as any such row can still be in flight.
  const pin = String(p.pin);
  switch (type) {
    case CommandType.PROVISION:
      return buildCreateUser({ pin, name: p.name as string, grp: p.grp as number });
    case CommandType.PUSH_PHOTO: {
      const jpeg = await readFile(p.photoPath as string);
      return buildPushPhoto({ pin, jpeg });
    }
    case CommandType.DEPROVISION:
      return buildDeleteUser({ pin });
    case CommandType.BLOCK:
    case CommandType.UNBLOCK:
      return buildSetGroup({ pin, grp: p.grp as number });
    case CommandType.QUERY_USER:
      return buildQueryUser({ pin });
    case CommandType.DEVICE_INFO:
      return buildDeviceInfo();
    case CommandType.CLEAR_LOGS:
      // Raw-protocol syntax not yet verified on this firmware (Phase 0 open
      // item). Refuse to guess — the device accepts nonsense with Return=0.
      throw new Error("CLEAR_LOGS wire syntax not verified on this firmware yet");
    default:
      throw new Error(`unknown command type: ${type as string}`);
  }
}

export interface WireCommand {
  /** Full response body for getrequest: C:<id>:<command> */
  body: string;
  deviceCmdId: number;
  commandId: string;
  type: CommandType;
}

/**
 * The getrequest entry point: claim, render, return wire text.
 * If rendering fails (e.g. photo file missing), the command is marked FAILED
 * and null is returned so the device gets a plain OK.
 */
export async function nextWireCommand(deviceId: string): Promise<WireCommand | null> {
  const claimed = await claimNext(deviceId);
  if (!claimed) return null;
  try {
    const text = await buildWireText(claimed.type, claimed.payload);
    publish("command", {
      id: claimed.id,
      type: claimed.type,
      status: CommandStatus.SENT,
      targetDeviceId: deviceId,
      deviceCmdId: claimed.deviceCmdId,
      personId: null,
      entryId: null,
      lastError: null,
    });
    return {
      body: `C:${claimed.deviceCmdId}:${text}`,
      deviceCmdId: claimed.deviceCmdId,
      commandId: claimed.id,
      type: claimed.type,
    };
  } catch (err) {
    await prisma.syncCommand.update({
      where: { id: claimed.id },
      data: {
        status: CommandStatus.FAILED,
        lastError: `build failed: ${err instanceof Error ? err.message : String(err)}`,
        completedAt: new Date(),
      },
    });
    return null;
  }
}

export interface ResolvedReply {
  command: SyncCommand | null;
}

/**
 * Handle a devicecmd acknowledgement. Return=0 means "processed", NOT
 * "valid" — SUCCESS here is delivery-level truth only; semantic verification
 * is reconciliation's job (Phase 3).
 */
export async function resolveDeviceReply(
  deviceId: string,
  wireId: number,
  returnCode: number | null,
): Promise<ResolvedReply> {
  const command = await prisma.syncCommand.findFirst({
    where: { targetDeviceId: deviceId, deviceCmdId: wireId, status: CommandStatus.SENT },
  });
  if (!command) return { command: null };

  const ok = returnCode === 0;
  const updated = await prisma.syncCommand.update({
    where: { id: command.id },
    data: {
      status: ok ? CommandStatus.SUCCESS : CommandStatus.FAILED,
      lastError: ok ? null : `device Return=${returnCode ?? "(none)"}`,
      completedAt: new Date(),
    },
  });
  publishCommand(updated);
  return { command: updated };
}

/**
 * Requeue SENT commands whose reply never arrived; give up after
 * MAX_ATTEMPTS. Runs on an interval (a pg-boss job from Phase 3).
 */
export async function sweepTimeouts(): Promise<{ retried: number; failed: number }> {
  const cutoff = new Date(Date.now() - SENT_TIMEOUT_MS);
  const [retried, failed] = await prisma.$transaction([
    prisma.syncCommand.updateMany({
      where: { status: CommandStatus.SENT, sentAt: { lt: cutoff }, attempts: { lt: MAX_ATTEMPTS } },
      data: { status: CommandStatus.RETRY },
    }),
    prisma.syncCommand.updateMany({
      where: { status: CommandStatus.SENT, sentAt: { lt: cutoff }, attempts: { gte: MAX_ATTEMPTS } },
      data: {
        status: CommandStatus.FAILED,
        lastError: `no device reply after ${MAX_ATTEMPTS} attempts`,
        completedAt: new Date(),
      },
    }),
  ]);
  return { retried: retried.count, failed: failed.count };
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startQueueMaintenance(onError: (err: unknown) => void): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepTimeouts().catch(onError);
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopQueueMaintenance(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

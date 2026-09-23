import type { Device } from "@prisma/client";
import { prisma } from "../db/index.js";
import { parseDeviceInfoKv } from "./parsers.js";

// Device registry: serial-number lookup cache + last-seen tracking.
//
// The getrequest hot path fires every 1–3 s per device. Its single allowed
// DB round trip belongs to the command claim (queue.ts), so device lookup is
// served from this cache and last-seen writes are throttled rather than
// per-poll.

const DEVICE_CACHE_TTL_MS = 60_000;
const LAST_SEEN_WRITE_INTERVAL_MS = 20_000;
const UNKNOWN_LOG_INTERVAL_MS = 60_000;

interface CacheEntry {
  device: Device;
  fetchedAt: number;
  lastSeenWrittenAt: number;
}

const cache = new Map<string, CacheEntry>();

// Unknown serials checking in — kept for the UI (Phase 1 M5 shows these as
// unadopted devices) and to keep the logs honest without spamming them.
export interface UnknownDevice {
  serialNo: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  requests: number;
}
const unknownDevices = new Map<string, UnknownDevice & { lastLoggedAt: number }>();

export function listUnknownDevices(): UnknownDevice[] {
  return [...unknownDevices.values()].map(({ lastLoggedAt: _drop, ...rest }) => rest);
}

/** Called once a serial is adopted into a real Device row, so it stops showing as unregistered. */
export function dropUnknownDevice(serialNo: string): void {
  unknownDevices.delete(serialNo);
}

/**
 * Resolve a device by serial. Cached; a miss falls through to the DB. An
 * unknown serial is recorded and reported (never silently accepted, never
 * auto-adopted — the VMS must be the deliberate owner of a device roster).
 */
export async function getDeviceBySn(
  serialNo: string,
  log: { warn: (obj: object, msg: string) => void },
): Promise<Device | null> {
  const now = Date.now();
  const hit = cache.get(serialNo);
  if (hit && now - hit.fetchedAt < DEVICE_CACHE_TTL_MS) return hit.device;

  const device = await prisma.device.findUnique({ where: { serialNo } });
  if (device) {
    cache.set(serialNo, {
      device,
      fetchedAt: now,
      lastSeenWrittenAt: hit?.lastSeenWrittenAt ?? 0,
    });
    return device;
  }

  const u = unknownDevices.get(serialNo) ?? {
    serialNo,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    requests: 0,
    lastLoggedAt: 0,
  };
  u.lastSeenAt = new Date();
  u.requests += 1;
  unknownDevices.set(serialNo, u);
  if (now - u.lastLoggedAt > UNKNOWN_LOG_INTERVAL_MS) {
    u.lastLoggedAt = now;
    log.warn(
      { serialNo, requests: u.requests, firstSeenAt: u.firstSeenAt },
      "unregistered device checking in — adopt it before it can be managed",
    );
  }
  return null;
}

/**
 * Record device liveness. Fire-and-forget and throttled: at a 1–3 s poll
 * rate, writing last_seen_at on every poll would waste the hot path's budget
 * for zero operational value.
 */
export function markSeen(device: Device, onError: (err: unknown) => void): void {
  const entry = cache.get(device.serialNo);
  const now = Date.now();
  if (entry && now - entry.lastSeenWrittenAt < LAST_SEEN_WRITE_INTERVAL_MS) return;
  if (entry) entry.lastSeenWrittenAt = now;

  prisma.device
    .update({
      where: { id: device.id },
      data: { lastSeenAt: new Date(), online: true },
    })
    .catch(onError);
}

/** Force the next lookup to hit the DB (after INFO updates, adoption, etc.). */
export function invalidateDevice(serialNo: string): void {
  cache.delete(serialNo);
}

/**
 * Apply an INFO response to the device record. Only keys the device actually
 * sent are written — identity comes from the hardware, never from a label.
 */
export async function updateDeviceFromInfo(
  device: Device,
  body: string,
): Promise<Record<string, string>> {
  const kv = parseDeviceInfoKv(body);
  const data: Record<string, unknown> = {};

  if (kv["FWVersion"]) data.firmwareVersion = kv["FWVersion"];
  const faceCount = kv["FaceCount"];
  if (faceCount !== undefined && Number.isInteger(Number(faceCount))) {
    data.facesUsed = Number(faceCount);
  }
  const maxFaces = kv["~MaxFaceCount"] ?? kv["MaxFaceCount"];
  if (maxFaces !== undefined && Number.isInteger(Number(maxFaces))) {
    data.maxFaces = Number(maxFaces);
  }

  // The whole reply is kept, not just the keys we act on. The device is the
  // only authority on what it can report, and a question about a key we do
  // not currently read should be answerable by looking rather than by
  // guessing at its name and shipping a command to find out.
  data.lastInfo = kv;
  data.lastInfoAt = new Date();

  // First time the device tells us how many records it holds, fix that as the
  // baseline for punch-loss detection. Only ever set here when absent: the
  // whole measure is growth from a FIXED point, and quietly moving it forward
  // would erase exactly the discrepancy it exists to show.
  const reported = Number(kv["TransactionCount"]);
  if (device.punchBaselineAt === null && Number.isInteger(reported)) {
    data.punchBaselineAt = new Date();
    data.punchBaselineDeviceCount = reported;
    // Rows plus already-summarised punches: retention deletes raw rows, so a
    // bare row count would make the baseline shift under the measure.
    const [rows, rolled] = await Promise.all([
      prisma.punchEvent.count({ where: { deviceId: device.id } }),
      prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(SUM(COALESCE(("device_punch_counts" ->> ${device.id})::int, 0)), 0)::bigint AS total
          FROM "attendance_day_summary"
      `,
    ]);
    data.punchBaselineLocalCount = rows + Number(rolled[0]?.total ?? 0n);
  }

  await prisma.device.update({ where: { id: device.id }, data });
  invalidateDevice(device.serialNo);
  return kv;
}

/** Persist the device's incremental-sync markers (Stamp / OpStamp). */
export async function updateStamps(
  device: Device,
  stamp: string | undefined,
  opStamp: string | undefined,
): Promise<void> {
  const data: Record<string, string> = {};
  if (stamp) data.lastStamp = stamp;
  if (opStamp) data.lastOpStamp = opStamp;
  if (Object.keys(data).length === 0) return;
  await prisma.device.update({ where: { id: device.id }, data });
  invalidateDevice(device.serialNo);
}

import { EntryState, type DeviceRole, type PunchDirection } from "@prisma/client";
import { resolveDirection } from "./punches.js";

export interface AttendancePunch {
  id: string;
  esslUserId: string;
  deviceId: string;
  punchedAtUtc: Date;
  statusCode: number | null;
  direction?: PunchDirection | null;
  role: DeviceRole;
  inStatusCodes: number[];
  outStatusCodes: number[];
}

export interface AttendanceSummary {
  esslUserId: string;
  deviceIds: string[];
  devicePunchCounts: Record<string, number>;
  firstInUtc: Date | null;
  lastOutUtc: Date | null;
  workedSeconds: number;
  punchCount: number;
  inCount: number;
  outCount: number;
  unmatchedIn: number;
  unmatchedOut: number;
}

export function summarizeAttendance(punches: AttendancePunch[]): AttendanceSummary {
  const ordered = [...punches].sort((a, b) =>
    a.punchedAtUtc.getTime() - b.punchedAtUtc.getTime() || a.id.localeCompare(b.id),
  );
  let openIn: Date | null = null;
  let firstInUtc: Date | null = null;
  let lastOutUtc: Date | null = null;
  let workedSeconds = 0;
  let inCount = 0;
  let outCount = 0;
  let unmatchedIn = 0;
  let unmatchedOut = 0;

  for (const punch of ordered) {
    const direction = punch.direction ?? resolveDirection(
      punch,
      punch.statusCode,
      openIn ? EntryState.INSIDE : EntryState.PROVISIONED,
    ).direction;
    if (direction === "IN") {
      inCount += 1;
      firstInUtc ??= punch.punchedAtUtc;
      if (openIn) unmatchedIn += 1;
      else openIn = punch.punchedAtUtc;
      continue;
    }
    outCount += 1;
    lastOutUtc = punch.punchedAtUtc;
    if (!openIn) {
      unmatchedOut += 1;
      continue;
    }
    workedSeconds += Math.max(0, Math.floor((punch.punchedAtUtc.getTime() - openIn.getTime()) / 1000));
    openIn = null;
  }
  if (openIn) unmatchedIn += 1;

  return {
    esslUserId: ordered[0]?.esslUserId ?? "",
    deviceIds: [...new Set(ordered.map((p) => p.deviceId))],
    devicePunchCounts: ordered.reduce<Record<string, number>>((counts, punch) => {
      counts[punch.deviceId] = (counts[punch.deviceId] ?? 0) + 1;
      return counts;
    }, {}),
    firstInUtc,
    lastOutUtc,
    workedSeconds,
    punchCount: ordered.length,
    inCount,
    outCount,
    unmatchedIn,
    unmatchedOut,
  };
}

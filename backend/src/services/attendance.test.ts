import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceRole, PunchDirection } from "@prisma/client";
import { summarizeAttendance, type AttendancePunch } from "./attendance.js";

function punch(id: string, at: string, direction: PunchDirection, deviceId = "gate-in"): AttendancePunch {
  return {
    id,
    esslUserId: "EMP007",
    deviceId,
    punchedAtUtc: new Date(at),
    statusCode: null,
    direction,
    role: DeviceRole.BOTH,
    inStatusCodes: [],
    outStatusCodes: [],
  };
}

test("attendance pairs IN with the next OUT across devices", () => {
  const summary = summarizeAttendance([
    punch("3", "2026-08-27T08:30:00Z", PunchDirection.IN),
    punch("1", "2026-08-27T12:00:00Z", PunchDirection.OUT, "gate-out"),
    punch("4", "2026-08-27T13:00:00Z", PunchDirection.IN),
    punch("2", "2026-08-27T17:30:00Z", PunchDirection.OUT, "gate-out"),
  ]);
  assert.equal(summary.workedSeconds, 8 * 60 * 60);
  assert.equal(summary.inCount, 2);
  assert.equal(summary.outCount, 2);
  assert.equal(summary.unmatchedIn, 0);
  assert.equal(summary.unmatchedOut, 0);
  assert.deepEqual(summary.devicePunchCounts, { "gate-in": 2, "gate-out": 2 });
});

test("consecutive and unclosed punches are flagged and excluded", () => {
  const summary = summarizeAttendance([
    punch("1", "2026-08-27T08:00:00Z", PunchDirection.OUT),
    punch("2", "2026-08-27T09:00:00Z", PunchDirection.IN),
    punch("3", "2026-08-27T09:10:00Z", PunchDirection.IN),
  ]);
  assert.equal(summary.workedSeconds, 0);
  assert.equal(summary.unmatchedOut, 1);
  assert.equal(summary.unmatchedIn, 2);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { revokedPunchTargets, type RevokedPunchCandidate } from "./employee-access.js";

// Which punches prove a revoked Employee is still enrolled. A wrong "yes"
// deletes a face; a wrong "no" leaves a resigned person opening the barrier.

const revokedAt = new Date("2026-10-01T10:00:00Z");
const candidate = (over: Partial<RevokedPunchCandidate> = {}): RevokedPunchCandidate => ({
  personId: "p1",
  key: "EMP1",
  esslUserId: "emp1",
  revokedAt,
  hasAccessRow: false,
  removalInFlight: false,
  ...over,
});

test("a punch after revocation targets the person", () => {
  const latest = new Map([["EMP1", new Date("2026-10-02T09:00:00Z")]]);
  assert.deepEqual(revokedPunchTargets([candidate()], latest).map((c) => c.personId), ["p1"]);
});

test("a late upload of a punch made before revocation proves nothing", () => {
  const latest = new Map([["EMP1", new Date("2026-10-01T09:59:59Z")]]);
  assert.deepEqual(revokedPunchTargets([candidate()], latest), []);
});

test("a removal already in flight is not queued twice", () => {
  const latest = new Map([["EMP1", new Date("2026-10-02T09:00:00Z")]]);
  assert.deepEqual(revokedPunchTargets([candidate({ removalInFlight: true })], latest), []);
});

test("a candidate with no punch in this batch is ignored", () => {
  assert.deepEqual(revokedPunchTargets([candidate()], new Map()), []);
});

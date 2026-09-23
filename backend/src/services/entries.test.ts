import assert from "node:assert/strict";
import { test } from "node:test";
import { RetentionPolicy } from "@prisma/client";
import { resolveRetentionExpiry } from "./entries.js";
import { ServiceError } from "./errors.js";

// Retention windows are computed here and enforced by the Phase 2 sweeper.
// Getting the arithmetic wrong now would silently write wrong history until
// then, so it is pinned by tests rather than by inspection.

const NOW = new Date("2026-08-03T10:00:00.000Z"); // 03 Aug, 15:30 IST
const DAY_MS = 86_400_000;

test("standard policies end at 23:59:59.999 IST on their inclusive final day", () => {
  const cases: [RetentionPolicy, string][] = [
    [RetentionPolicy.ONE_DAY, "2026-08-03T18:29:59.999Z"],
    [RetentionPolicy.ONE_WEEK, "2026-08-09T18:29:59.999Z"],
    [RetentionPolicy.ONE_MONTH, "2026-09-01T18:29:59.999Z"],
    [RetentionPolicy.QUARTERLY, "2026-10-31T18:29:59.999Z"],
  ];
  for (const [policy, expected] of cases) {
    const expiry = resolveRetentionExpiry(policy, undefined, NOW);
    assert.equal(expiry.toISOString(), expected, policy);
  }
});

test("CUSTOM requires a date that has not ended in IST and expires at its IST day-end", () => {
  assert.throws(
    () => resolveRetentionExpiry(RetentionPolicy.CUSTOM, undefined, NOW),
    (err: unknown) => err instanceof ServiceError && err.statusCode === 400,
  );
  assert.throws(
    () => resolveRetentionExpiry(RetentionPolicy.CUSTOM, new Date(NOW.getTime() - DAY_MS), NOW),
    (err: unknown) => err instanceof ServiceError && err.statusCode === 400,
  );
  const explicit = new Date("2026-08-08T00:00:00.000Z");
  assert.equal(
    resolveRetentionExpiry(RetentionPolicy.CUSTOM, explicit, NOW).toISOString(),
    "2026-08-08T18:29:59.999Z",
  );
});

test("ONE_DAY follows the IST date across the UTC boundary", () => {
  const justAfterMidnightIst = new Date("2026-08-03T18:30:00.000Z");
  assert.equal(
    resolveRetentionExpiry(RetentionPolicy.ONE_DAY, undefined, justAfterMidnightIst).toISOString(),
    "2026-08-04T18:29:59.999Z",
  );
});

test("an explicit expiry is refused with a standard policy rather than silently ignored", () => {
  assert.throws(
    () =>
      resolveRetentionExpiry(RetentionPolicy.ONE_DAY, new Date(NOW.getTime() + DAY_MS * 9), NOW),
    (err: unknown) => err instanceof ServiceError && err.statusCode === 400,
  );
});

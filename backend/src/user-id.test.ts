import { test } from "node:test";
import assert from "node:assert/strict";
import { PersonCategory } from "@prisma/client";
import { automaticQueryKey } from "./adms/ingest.js";
import { classifyDeviceId, patternsOverlap, punchQueryCandidates } from "./user-id.js";

test("unknown-person discovery cannot dedupe the later missing-photo pull", () => {
  const discovery = automaticQueryKey(false, "DEVICE1", "9005", 123);
  const photoPull = automaticQueryKey(true, "DEVICE1", "9005", 123);
  assert.notEqual(discovery, photoPull);
});

test("empty category patterns leave an unknown device ID unclaimed", () => {
  assert.equal(classifyDeviceId("EMP001", [], []), null);
});

test("an ID is classified only when exactly one category matches", () => {
  assert.equal(classifyDeviceId("EMP001", ["EMP*"], ["VIS*"]), PersonCategory.EMPLOYEE);
  assert.equal(classifyDeviceId("vis09", ["EMP*"], ["VIS*"]), PersonCategory.VISITOR);
  assert.equal(classifyDeviceId("OTHER1", ["EMP*"], ["VIS*"]), null);
  assert.equal(classifyDeviceId("A12", ["A*"], ["*12"]), null);
});

test("overlap detection handles prefix, suffix, exact, and disjoint globs", () => {
  assert.equal(patternsOverlap(["EMP*"], ["*001"]), true);
  assert.equal(patternsOverlap(["ABC"], ["ABC"]), true);
  assert.equal(patternsOverlap(["EMP*"], ["VIS*"]), false);
  assert.equal(patternsOverlap([], ["*"]), false);
});

test("punches discover classified unknown IDs and retry claimed IDs whose photo is missing", () => {
  assert.deepEqual(
    punchQueryCandidates(
      ["EMP001A", "emp001a", "VIS002", "OTHER3", "KNOWN1", "NOPHOTO1", "nophoto1"],
      ["EMP*"],
      ["VIS*"],
      new Map([
        ["KNOWN1", true],
        ["NOPHOTO1", false],
      ]),
    ),
    { discovery: ["EMP001A", "VIS002"], missingPhotos: ["NOPHOTO1"] },
  );
});

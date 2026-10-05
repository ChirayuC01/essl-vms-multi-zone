import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceRole, EntryMode, GateReason } from "@prisma/client";
import { locationAfter, planGates, usedUpByPunch } from "./gates.js";

// Four terminals: outer gate on the premise, inner gate on the yard.
const outerIn = { id: "oi", role: DeviceRole.IN, zoneId: "premise" };
const outerOut = { id: "oo", role: DeviceRole.OUT, zoneId: "premise" };
const yardIn = { id: "yi", role: DeviceRole.IN, zoneId: "yard" };
const yardOut = { id: "yo", role: DeviceRole.OUT, zoneId: "yard" };
const all = [outerIn, outerOut, yardIn, yardOut];
const at = new Date("2026-10-05T10:00:00Z");
const plan = (entryMode: EntryMode, codeZones: string[]) =>
  planGates(all, { entryMode, exitCodeZoneIds: new Set(codeZones), loadAt: at, unloadAt: null, reason: GateReason.SCHEDULE })
    .map((g) => g.deviceId)
    .sort();

test("multi entry loads every terminal, exits included, with no exit code", () => {
  assert.deepEqual(plan(EntryMode.MULTI_ENTRY, ["premise", "yard"]), ["oi", "oo", "yi", "yo"]);
});

test("single entry holds back the exits of code-gated zones only", () => {
  // Office exit gated (the default), yard exit not ticked: yard exit loads now.
  assert.deepEqual(plan(EntryMode.SINGLE_ENTRY, ["premise"]), ["oi", "yi", "yo"]);
  // Both ticked: no exit loads until the code or an override.
  assert.deepEqual(plan(EntryMode.SINGLE_ENTRY, ["premise", "yard"]), ["oi", "yi"]);
});

test("a two-way terminal is never held back by the exit code", () => {
  const both = { id: "b", role: DeviceRole.BOTH, zoneId: "premise" };
  assert.deepEqual(
    planGates([both], { entryMode: EntryMode.SINGLE_ENTRY, exitCodeZoneIds: new Set(["premise"]), loadAt: at, unloadAt: null, reason: GateReason.SCHEDULE }).length,
    1,
  );
});

test("single entry uses an entry terminal by going in and an exit or two-way terminal by going out", () => {
  assert.equal(usedUpByPunch(EntryMode.SINGLE_ENTRY, DeviceRole.IN, "IN"), true);
  assert.equal(usedUpByPunch(EntryMode.SINGLE_ENTRY, DeviceRole.OUT, "OUT"), true);
  assert.equal(usedUpByPunch(EntryMode.SINGLE_ENTRY, DeviceRole.BOTH, "OUT"), true);
  assert.equal(usedUpByPunch(EntryMode.SINGLE_ENTRY, DeviceRole.BOTH, "IN"), false);
});

test("multi entry never uses a terminal up", () => {
  for (const role of [DeviceRole.IN, DeviceRole.OUT, DeviceRole.BOTH]) {
    for (const dir of ["IN", "OUT"] as const) assert.equal(usedUpByPunch(EntryMode.MULTI_ENTRY, role, dir), false);
  }
});

test("location follows the zone tree: in puts you in the gate's zone, out puts you in the zone around it", () => {
  const parentOf = (z: string) => (z === "yard" ? "premise" : null);
  assert.equal(locationAfter("IN", "premise", null, parentOf), "premise");
  assert.equal(locationAfter("IN", "yard", "premise", parentOf), "yard");
  assert.equal(locationAfter("OUT", "yard", "yard", parentOf), "premise");
  assert.equal(locationAfter("OUT", "premise", "premise", parentOf), null);
  // A terminal in no zone keeps the location going in and clears it going out.
  assert.equal(locationAfter("IN", null, "premise", parentOf), "premise");
  assert.equal(locationAfter("OUT", null, "premise", parentOf), null);
});

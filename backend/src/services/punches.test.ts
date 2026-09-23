import assert from "node:assert/strict";
import { test } from "node:test";
import { EntryState } from "@prisma/client";
import { resolveDirection } from "./punches.js";

// Direction resolution is pure, and it is the one piece of Phase 2 that
// encodes a hardware fact (VMS_PROJECT_CONTEXT.md §4.9: Check-In = 0,
// Check-Out = 1, observed 5 Aug 2026). Worth pinning down here so a later
// refactor cannot quietly invert a barrier.

const gate = (role: "IN" | "OUT" | "BOTH") => ({
  role,
  inStatusCodes: [0],
  outStatusCodes: [1],
});

test("a dedicated gate decides direction by role", () => {
  assert.equal(resolveDirection(gate("IN"), 0, EntryState.PROVISIONED).direction, "IN");
  assert.equal(resolveDirection(gate("OUT"), 1, EntryState.INSIDE).direction, "OUT");
  assert.equal(resolveDirection(gate("IN"), null, null).source, "DEVICE_ROLE");
});

test("role wins over a contradicting status code, and the conflict is reported", () => {
  // An IN gate stamping Check-Out is a misconfigured terminal. The physical
  // gate is the truth; the disagreement must still be visible.
  const r = resolveDirection(gate("IN"), 1, EntryState.PROVISIONED);
  assert.equal(r.direction, "IN");
  assert.equal(r.conflict, true);
});

test("a matching status code on a dedicated gate is not a conflict", () => {
  assert.equal(resolveDirection(gate("IN"), 0, EntryState.PROVISIONED).conflict, false);
  assert.equal(resolveDirection(gate("OUT"), 1, EntryState.INSIDE).conflict, false);
  // Unmapped codes (Break-Out and friends) are not disagreement either.
  assert.equal(resolveDirection(gate("IN"), 3, EntryState.PROVISIONED).conflict, false);
});

test("a bidirectional terminal reads the status code", () => {
  const inward = resolveDirection(gate("BOTH"), 0, EntryState.PROVISIONED);
  assert.deepEqual([inward.direction, inward.source], ["IN", "STATUS_CODE"]);

  const outward = resolveDirection(gate("BOTH"), 1, EntryState.INSIDE);
  assert.deepEqual([outward.direction, outward.source], ["OUT", "STATUS_CODE"]);
});

test("the status code outranks the entry state on a bidirectional terminal", () => {
  // A second Check-In while already INSIDE is what a suppressed OUT looks
  // like (§4.10). Report it as an IN; the caller decides it changes nothing.
  const r = resolveDirection(gate("BOTH"), 0, EntryState.INSIDE);
  assert.deepEqual([r.direction, r.source], ["IN", "STATUS_CODE"]);
});

test("255 (Undefined) alternates — it is a missing answer, not a direction", () => {
  // Observed in the field. 255 = 0xFF = the `Undefined` punch state, which is
  // what Manual Mode reports when no F-key was pressed or the selection timed
  // out before the face matched. It must never be mapped to IN or OUT: the
  // device is saying it does not know, and guessing IN would walk a departing
  // person back inside.
  const insideCase = resolveDirection(gate("BOTH"), 255, EntryState.INSIDE);
  assert.deepEqual([insideCase.direction, insideCase.source], ["OUT", "ALTERNATION"]);

  const outsideCase = resolveDirection(gate("BOTH"), 255, EntryState.PROVISIONED);
  assert.deepEqual([outsideCase.direction, outsideCase.source], ["IN", "ALTERNATION"]);

  // On a dedicated gate it is simply absent information, not a disagreement.
  assert.equal(resolveDirection(gate("IN"), 255, EntryState.PROVISIONED).conflict, false);
});

test("a missed F-key falls back to alternating from the entry state", () => {
  // Manual Mode: the operator selects the state before presenting their face.
  // Forgetting is ordinary, and must not discard a real movement.
  const first = resolveDirection(gate("BOTH"), null, EntryState.PROVISIONED);
  assert.deepEqual([first.direction, first.source], ["IN", "ALTERNATION"]);

  const second = resolveDirection(gate("BOTH"), null, EntryState.INSIDE);
  assert.deepEqual([second.direction, second.source], ["OUT", "ALTERNATION"]);

  // An unmapped code alternates too — Break-Out is not a gate crossing.
  assert.equal(resolveDirection(gate("BOTH"), 2, EntryState.INSIDE).direction, "OUT");
});

test("status code maps are per-device, not constants", () => {
  // Firmware numbering may differ; nothing may hardcode 0/1.
  const inverted = { role: "BOTH" as const, inStatusCodes: [7], outStatusCodes: [9] };
  assert.equal(resolveDirection(inverted, 7, null).direction, "IN");
  assert.equal(resolveDirection(inverted, 9, null).direction, "OUT");
  // A code meaningful on the default device means nothing on this one.
  assert.equal(resolveDirection(inverted, 0, EntryState.PROVISIONED).source, "ALTERNATION");
});

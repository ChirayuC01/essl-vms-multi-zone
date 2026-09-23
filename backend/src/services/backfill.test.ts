import assert from "node:assert/strict";
import { test } from "node:test";
import { idAt, planSize, planSlice, type ScanPlan } from "./backfill.js";

// The scan's window arithmetic and ID generation. Every way of getting these
// wrong is invisible from reading the code and expensive in the field:
// re-issuing an ID means a scan that never terminates and never stops
// occupying the queue; stepping past one means a person the backfill silently
// never finds; and a mis-padded ID means asking the device about `WCTPL70`
// when the roster says `WCTPL070` - a scan that finds nobody and looks like a
// firmware problem.

const range = (from: number, to: number): ScanPlan => ({
  kind: "RANGE",
  prefix: "",
  from,
  to,
  pad: 0,
});

test("a slice fills the window and advances exactly past what it queued", () => {
  const { pins, cursor } = planSlice({ plan: range(100, 10_000), cursor: 0 }, 0, 50);
  assert.equal(pins.length, 50);
  assert.equal(pins[0], "100");
  assert.equal(pins.at(-1), "149");
  assert.equal(cursor, 50, "next slice must start where this one ended, with no gap or overlap");
});

test("in-flight commands take up window room", () => {
  const { pins, cursor } = planSlice({ plan: range(100, 10_000), cursor: 0 }, 45, 50);
  assert.deepEqual(pins, ["100", "101", "102", "103", "104"]);
  assert.equal(cursor, 5);
});

test("a full window queues nothing and does not move the cursor", () => {
  const { pins, cursor } = planSlice({ plan: range(100, 10_000), cursor: 0 }, 50, 50);
  assert.deepEqual(pins, []);
  assert.equal(cursor, 0);
});

test("the last slice stops at the end rather than overrunning it", () => {
  const { pins, cursor } = planSlice({ plan: range(98, 100), cursor: 0 }, 0, 50);
  assert.deepEqual(pins, ["98", "99", "100"], "the end of the range is inclusive");
  assert.equal(cursor, 3, "a cursor at planSize is what marks the plan fully queued");
});

test("an exhausted range yields nothing forever", () => {
  const { pins, cursor } = planSlice({ plan: range(100, 100), cursor: 1 }, 0, 50);
  assert.deepEqual(pins, []);
  assert.equal(cursor, 1);
});

test("a single-ID range is queued once", () => {
  const plan = range(7, 7);
  const first = planSlice({ plan, cursor: 0 }, 0, 50);
  assert.deepEqual(first.pins, ["7"]);
  const second = planSlice({ plan, cursor: first.cursor }, 0, 50);
  assert.deepEqual(second.pins, [], "re-running after the plan is done must not re-ask");
});

test("a prefixed range generates the zero-padded IDs a real roster uses", () => {
  const plan: ScanPlan = { kind: "RANGE", prefix: "WCTPL", from: 69, to: 71, pad: 3 };
  assert.equal(planSize(plan), 3);
  assert.deepEqual(planSlice({ plan, cursor: 0 }, 0, 50).pins, [
    "WCTPL069",
    "WCTPL070",
    "WCTPL071",
  ]);
});

test("padding shorter than the number does not truncate it", () => {
  const plan: ScanPlan = { kind: "RANGE", prefix: "YE", from: 100, to: 100, pad: 2 };
  assert.equal(idAt(plan, 0), "YE100");
});

test("an explicit list is walked in order and exactly once", () => {
  const plan: ScanPlan = { kind: "LIST", ids: ["WCTPL070", "ye01", "1001"] };
  assert.equal(planSize(plan), 3);
  const first = planSlice({ plan, cursor: 0 }, 0, 2);
  assert.deepEqual(first.pins, ["WCTPL070", "ye01"]);
  const second = planSlice({ plan, cursor: first.cursor }, 0, 2);
  assert.deepEqual(second.pins, ["1001"]);
  assert.deepEqual(planSlice({ plan, cursor: second.cursor }, 0, 2).pins, []);
});

test("idAt refuses to invent an ID past the end", () => {
  assert.equal(idAt(range(1, 2), 2), null);
  assert.equal(idAt({ kind: "LIST", ids: ["A1"] }, 1), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDay, daysBetween, totals, type Punch } from "./monthly-status.js";

// Monthly Status without shifts (F3 F-f): what counts as present and how much
// time a day holds. A wrong answer here is a wrong salary sheet.

const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00Z`);
const p = (day: string, hhmm: string, direction: "IN" | "OUT"): Punch => ({ at: at(day, hhmm), direction });
const TODAY = "2026-10-31";

test("paired IN/OUT cycles add up; first IN and last OUT are reported", () => {
  const d = computeDay("2026-10-05", [p("2026-10-05", "09:00", "IN"), p("2026-10-05", "13:00", "OUT"), p("2026-10-05", "14:00", "IN"), p("2026-10-05", "18:30", "OUT")], TODAY);
  assert.equal(d.status, "P");
  assert.equal(d.workedMinutes, 8 * 60 + 30);
  assert.equal(d.inAt, at("2026-10-05", "09:00"));
  assert.equal(d.outAt, at("2026-10-05", "18:30"));
});

test("an IN never closed counts no time, but the person was present", () => {
  const d = computeDay("2026-10-06", [p("2026-10-06", "09:00", "IN")], TODAY);
  assert.equal(d.status, "P");
  assert.equal(d.workedMinutes, 0);
});

test("no punches is absent; a future day is blank", () => {
  assert.equal(computeDay("2026-10-07", [], TODAY).status, "A");
  assert.equal(computeDay("2026-11-02", [], TODAY).status, "");
});

test("punches on other days are ignored", () => {
  const d = computeDay("2026-10-08", [p("2026-10-07", "09:00", "IN"), p("2026-10-09", "17:00", "OUT")], TODAY);
  assert.equal(d.status, "A");
});

test("a day rolled up by retention falls back to its summary", () => {
  const d = computeDay("2026-10-09", [], TODAY, { firstIn: at("2026-10-09", "08:00"), lastOut: at("2026-10-09", "16:00"), workedMinutes: 480 });
  assert.equal(d.status, "P");
  assert.equal(d.workedMinutes, 480);
});

test("totals: present, absent, work and average over present days", () => {
  const t = totals([
    { status: "P", inAt: 1, outAt: 2, workedMinutes: 480 },
    { status: "P", inAt: 1, outAt: null, workedMinutes: 0 },
    { status: "A", inAt: null, outAt: null, workedMinutes: 0 },
    { status: "", inAt: null, outAt: null, workedMinutes: 0 },
  ]);
  assert.deepEqual(t, { workMinutes: 480, present: 2, absent: 1, averageMinutes: 240 });
});

test("daysBetween is inclusive", () => {
  assert.deepEqual(daysBetween("2026-10-30", "2026-11-01"), ["2026-10-30", "2026-10-31", "2026-11-01"]);
});

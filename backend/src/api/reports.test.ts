import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "./reports.js";

const { looksLikeFormula, csvField, reportValue, reportRows } = __test;

// CSV export correctness. These files are opened in Excel on a Windows
// machine by someone answering a compliance question — both the quoting and
// the formula handling are load-bearing there, not cosmetic.

test("a spreadsheet formula is neutralised", () => {
  // Opening a CSV should never execute anything. = and @ always start one.
  for (const payload of [
    "=1+1",
    "=HYPERLINK(\"http://x\",\"click\")",
    "@SUM(A1:A9)",
    "+HYPERLINK(\"http://x\")",
    "-cmd|' /C calc'!A0",
  ]) {
    assert.equal(looksLikeFormula(payload), true, payload);
    assert.ok(csvField(payload).startsWith("\"'"), payload);
  }
});

test("a phone number is left alone", () => {
  // The naive rule (escape any leading + or -) put an apostrophe in front of
  // every mobile number in the person register, visible in the cell. A
  // dangerous payload needs a function name after the sign; a phone number
  // has no letters.
  for (const phone of ["+919325474337", "+1 (555) 123-4567", "-42", "+44 20 7946 0958"]) {
    assert.equal(looksLikeFormula(phone), false, phone);
    assert.equal(csvField(phone), `"${phone}"`, phone);
  }
});

test("separators and quotes cannot break the row", () => {
  // A person called "Smith, J" would otherwise shift every column after it.
  assert.equal(csvField("Smith, J"), '"Smith, J"');
  assert.equal(csvField('He said "no"'), '"He said ""no"""');
  assert.equal(csvField("line one\nline two"), '"line one\nline two"');
});

test("empty and structured values render predictably", () => {
  assert.equal(csvField(null), "");
  assert.equal(csvField(undefined), "");
  assert.equal(csvField(0), '"0"');
  assert.equal(csvField(false), '"false"');
  assert.equal(csvField(new Date("2026-08-05T10:00:00.000Z")), '"05/08/2026, 03:30:00 pm IST"');
  assert.equal(csvField("2026-08-05T10:00:00.000Z"), '"05/08/2026, 03:30:00 pm IST"');
  assert.equal(csvField("2026-08-05 10:00:00.000"), '"05/08/2026, 03:30:00 pm IST"');
  // Audit details are JSON columns; they must land in one cell, not spill.
  assert.equal(csvField({ pin: 1001 }), '"{""pin"":1001}"');
});

test("every report timestamp is serialized in explicit IST", () => {
  assert.equal(reportValue("2026-08-05T10:00:00.000Z", "created_at"), "05/08/2026, 03:30:00 pm IST");
  assert.equal(reportValue("2026-08-05T10:00:00.000", "created_at"), "05/08/2026, 03:30:00 pm IST");
  assert.equal(reportValue("2026-08-05 10:00:00.000", "created_at"), "05/08/2026, 03:30:00 pm IST");
  assert.deepEqual(
    reportRows([{ created_at: "2026-08-05T10:00:00.000", detail: { completed_at: "2026-08-05T11:00:00Z" } }]),
    [{ created_at: "05/08/2026, 03:30:00 pm IST", detail: { completed_at: "05/08/2026, 04:30:00 pm IST" } }],
  );
});

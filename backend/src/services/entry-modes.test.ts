import assert from "node:assert/strict";
import { test } from "node:test";
import { localDate } from "./entry-modes.js";

test("device-local date follows the device's offset, not the server's", () => {
  // 2026-08-05T18:40:00Z is already 2026-08-06 in +05:30.
  const t = new Date("2026-08-05T18:40:00.000Z");
  assert.equal(localDate(t, 330), "2026-08-06");
  assert.equal(localDate(t, 0), "2026-08-05");
  // West of UTC the date can still be the previous day.
  assert.equal(localDate(new Date("2026-08-05T02:00:00.000Z"), -300), "2026-08-04");
});

test("midnight belongs to the new local day", () => {
  assert.equal(localDate(new Date("2026-08-05T18:30:00.000Z"), 330), "2026-08-06");
});

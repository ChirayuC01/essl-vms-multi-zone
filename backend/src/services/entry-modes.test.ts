import assert from "node:assert/strict";
import { test } from "node:test";
import { EntryMode } from "@prisma/client";
import { assertSingleEntrySupported, isResetDue, localDate, localHour } from "./entry-modes.js";
import { ServiceError } from "./errors.js";

// The provision-time guard and the device-local clock. Both are pure, and
// both encode decisions that are easy to "simplify" into something wrong
// later — hence the reasoning is asserted here, not only commented.

const dev = (role: string, window: number | null) => ({
  role,
  serialNo: "TESTUNIT01",
  duplicatePunchPeriodMinutes: window,
});

async function refuses(device: ReturnType<typeof dev>): Promise<ServiceError | null> {
  try {
    await assertSingleEntrySupported(device, EntryMode.SINGLE_ENTRY);
    return null;
  } catch (err) {
    return err as ServiceError;
  }
}

test("MULTI_ENTRY is never restricted", async () => {
  // The guard exists only because SINGLE_ENTRY depends on seeing the OUT
  // punch. Nothing else does, so nothing else may be refused by it.
  await assertSingleEntrySupported(dev("BOTH", 5), EntryMode.MULTI_ENTRY);
  await assertSingleEntrySupported(dev("BOTH", null), EntryMode.MULTI_ENTRY);
});

test("SINGLE_ENTRY is allowed on a bidirectional terminal with no duplicate window", async () => {
  assert.equal(await refuses(dev("BOTH", 0)), null);
});

test("SINGLE_ENTRY is refused when a duplicate window could swallow the OUT", async () => {
  const err = await refuses(dev("BOTH", 1));
  assert.ok(err, "expected a refusal");
  assert.equal(err.statusCode, 409);
  // The message has to be actionable: an operator needs the exact menu path,
  // not a restatement that something is wrong.
  assert.match(err.message, /Duplicate Punch Period/);
  assert.match(err.message, /MULTI_ENTRY/);
});

test("an unrecorded duplicate window is refused too", async () => {
  // "Nobody has checked" is not evidence of safety for a control that decides
  // who may re-enter a site.
  const err = await refuses(dev("BOTH", null));
  assert.ok(err, "expected a refusal");
  assert.match(err.message, /no recorded duplicate-punch window/);
});

test("dedicated gates are unaffected whatever their duplicate window", async () => {
  // The two halves of a visit land on different terminals, so neither sees a
  // repeat punch by the same user.
  assert.equal(await refuses(dev("IN", 5)), null);
  assert.equal(await refuses(dev("OUT", null)), null);
});

test("device-local date and hour follow the device's offset, not the server's", () => {
  // 2026-08-05T18:40:00Z is already 2026-08-06 in +05:30. A reset driven by
  // server time would fire on the wrong day for half the world.
  const t = new Date("2026-08-05T18:40:00.000Z");
  assert.equal(localDate(t, 330), "2026-08-06");
  assert.equal(localHour(t, 330), 0);

  assert.equal(localDate(t, 0), "2026-08-05");
  assert.equal(localHour(t, 0), 18);

  // West of UTC the date can still be the previous day.
  assert.equal(localDate(new Date("2026-08-05T02:00:00.000Z"), -300), "2026-08-04");
  assert.equal(localHour(new Date("2026-08-05T02:00:00.000Z"), -300), 21);
});

test("a device is due once its own local day differs from its last reset", () => {
  // 2026-08-05T18:40:00Z = 2026-08-06 00:10 in +05:30.
  const now = new Date("2026-08-05T18:40:00.000Z");
  const ist = (last: string | null) => ({ timezoneOffsetMinutes: 330, lastDayResetOn: last });

  assert.equal(isResetDue(ist("2026-08-05"), now, 0), true, "yesterday's reset is stale");
  assert.equal(isResetDue(ist("2026-08-06"), now, 0), false, "already reset today");
  assert.equal(isResetDue(ist(null), now, 0), true, "never reset");
});

test("the reset hour gates the release, and is judged in device time", () => {
  // The case a default of 0 hides completely: with DAILY_RESET_HOUR = 6, a
  // device at 00:10 local has rolled into a new day but must NOT release yet.
  const justAfterMidnightIst = new Date("2026-08-05T18:40:00.000Z");
  const device = { timezoneOffsetMinutes: 330, lastDayResetOn: "2026-08-05" };

  assert.equal(isResetDue(device, justAfterMidnightIst, 0), true);
  assert.equal(isResetDue(device, justAfterMidnightIst, 6), false, "00:10 is before 06:00");

  // 2026-08-06T01:00:00Z = 06:30 IST — now past the hour.
  const sixThirtyIst = new Date("2026-08-06T01:00:00.000Z");
  assert.equal(isResetDue(device, sixThirtyIst, 6), true);
});

test("two devices in different zones roll over independently", () => {
  // The whole reason the date is stored per device rather than once globally.
  const now = new Date("2026-08-05T18:40:00.000Z"); // 06 Aug in IST, 05 Aug in UTC
  const ist = { timezoneOffsetMinutes: 330, lastDayResetOn: "2026-08-05" };
  const utc = { timezoneOffsetMinutes: 0, lastDayResetOn: "2026-08-05" };

  assert.equal(isResetDue(ist, now, 0), true, "IST has rolled into the 6th");
  assert.equal(isResetDue(utc, now, 0), false, "UTC is still on the 5th");
});

test("midnight is the first hour of the new local day, not the last of the old", () => {
  // The boundary the reset turns on: at exactly 00:00 local the date must
  // already have rolled, or the reset waits a whole extra day.
  const midnightIst = new Date("2026-08-05T18:30:00.000Z");
  assert.equal(localHour(midnightIst, 330), 0);
  assert.equal(localDate(midnightIst, 330), "2026-08-06");
});

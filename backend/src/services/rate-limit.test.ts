import assert from "node:assert/strict";
import { test } from "node:test";
import { allow, resetLimits } from "./rate-limit.js";

test("a key gets its limit per window, then is refused until the window passes", () => {
  resetLimits();
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(allow("k", 3, 60_000, t + i), true);
  assert.equal(allow("k", 3, 60_000, t + 10), false);
  assert.equal(allow("other", 3, 60_000, t + 10), true, "keys are independent");
  assert.equal(allow("k", 3, 60_000, t + 60_000), true, "a new window starts fresh");
});

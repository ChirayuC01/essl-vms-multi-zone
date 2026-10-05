import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSettings, settingsPatchSchema } from "./settings.js";

test("an install with nothing stored gets the client-confirmed defaults", () => {
  const s = resolveSettings(undefined);
  assert.equal(s.entryLoadLeadMinutes, 5);
  assert.equal(s.unloadAfterPunchMinutes, 10);
  assert.equal(s.walkInRequiresHostClear, true);
  assert.deepEqual(s.documentTypes, ["jpeg", "png", "webp", "pdf"]);
  assert.equal(s.privacyNoticeVersion, null);
});

test("one corrupt stored field falls back alone, the rest are kept", () => {
  const s = resolveSettings({ entryLoadLeadMinutes: "soon", unloadAfterPunchMinutes: 15 });
  assert.equal(s.entryLoadLeadMinutes, 5);
  assert.equal(s.unloadAfterPunchMinutes, 15);
});

test("a patch may change any subset of fields", () => {
  assert.equal(settingsPatchSchema.safeParse({ walkInRequiresHostClear: false }).success, true);
  assert.equal(settingsPatchSchema.safeParse({}).success, true);
});

test("a patch is refused for unknown keys, bad values, or the server-set notice version", () => {
  assert.equal(settingsPatchSchema.safeParse({ exitCodeForMultiEntry: true }).success, false);
  assert.equal(settingsPatchSchema.safeParse({ visitorIdPrefix: "V-" }).success, false);
  assert.equal(settingsPatchSchema.safeParse({ entryLoadLeadMinutes: -1 }).success, false);
  assert.equal(settingsPatchSchema.safeParse({ documentTypes: ["exe"] }).success, false);
  assert.equal(settingsPatchSchema.safeParse({ privacyNoticeVersion: "x" }).success, false);
});

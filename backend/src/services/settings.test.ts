import assert from "node:assert/strict";
import { test } from "node:test";
import { missingForSending, publicSettings, resolveSettings, settingsPatchSchema } from "./settings.js";

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

test("a digit visitor prefix is allowed (numeric-only terminals), but never empty or a leading 0", () => {
  assert.equal(settingsPatchSchema.safeParse({ visitorIdPrefix: "9" }).success, true);
  assert.equal(settingsPatchSchema.safeParse({ visitorIdPrefix: "V" }).success, true);
  assert.equal(settingsPatchSchema.safeParse({ visitorIdPrefix: "" }).success, false);
  assert.equal(settingsPatchSchema.safeParse({ visitorIdPrefix: "0" }).success, false);
});

test("a channel that is turned on must have what it needs to send", () => {
  const s = resolveSettings(undefined);
  assert.equal(s.smsTransport, "console");
  assert.equal(s.emailEnabled, false);
  assert.equal(missingForSending(s), null);
  assert.match(missingForSending({ ...s, smsTransport: "msg91" }) ?? "", /auth key/);
  assert.equal(missingForSending({ ...s, smsTransport: "msg91", msg91AuthKey: "k" }), null);
  assert.match(missingForSending({ ...s, emailEnabled: true, smtpHost: "smtp.example.com" }) ?? "", /From/);
});

test("secrets never leave in clear; the console only learns whether each is set", () => {
  const out = publicSettings({ ...resolveSettings(undefined), msg91AuthKey: "secret-key" });
  assert.equal(out.msg91AuthKey, "");
  assert.equal(out.smtpPassword, "");
  assert.deepEqual(out.secretsSet, { msg91AuthKey: true, smtpPassword: false });
});

test("template IDs are accepted only for the registered templates", () => {
  assert.equal(settingsPatchSchema.safeParse({ msg91TemplateIds: { MOBILE_OTP: "abc123" } }).success, true);
  assert.equal(settingsPatchSchema.safeParse({ msg91TemplateIds: { SOMETHING_ELSE: "abc123" } }).success, false);
});

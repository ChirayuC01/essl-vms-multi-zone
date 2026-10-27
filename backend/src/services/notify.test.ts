import assert from "node:assert/strict";
import { test } from "node:test";
import { fitVar, msg91Mobile, renderSms, SMS_TEXT } from "./notify.js";
import { SMS_TEMPLATE_KEYS } from "./settings.js";

test("every registered template has its wording, and the wording renders in order", () => {
  for (const key of SMS_TEMPLATE_KEYS) assert.ok(SMS_TEXT[key].includes("{#}"), key);
  assert.equal(
    renderSms("MOBILE_OTP", ["482913", "Acme Industries", "10"]),
    "482913 is your code to confirm your visit to Acme Industries. It expires in 10 minutes. Do not share it.",
  );
});

test("values are cut to DLT's 30 characters, links never", () => {
  assert.equal(fitVar("a".repeat(45)).length, 30);
  assert.equal(fitVar("Priya Sharma"), "Priya Sharma");
  const link = `https://visit.example.com/v/${"k".repeat(40)}`;
  assert.equal(fitVar(link), link);
});

test("mobiles get India's code only when bare", () => {
  assert.equal(msg91Mobile("98765 43210"), "919876543210");
  assert.equal(msg91Mobile("+91 98765-43210"), "919876543210");
  assert.equal(msg91Mobile("+44 7700 900123"), "447700900123");
});

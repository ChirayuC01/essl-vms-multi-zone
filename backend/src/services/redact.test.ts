import assert from "node:assert/strict";
import { test } from "node:test";
import { isMasked, maskId } from "./redact.js";

test("an identity number keeps only its first two and last two characters", () => {
  assert.equal(maskId("CI12345A7b"), "CI******7b");
  assert.equal(maskId("234567890123"), "23********23");
  assert.equal(maskId("ABCDE1234F"), "AB******4F");
});

test("short values are fully masked and empty values stay empty", () => {
  assert.equal(maskId("1234"), "****");
  assert.equal(maskId(""), null);
  assert.equal(maskId(null), null);
});

test("a masked echo is recognised so it never overwrites the stored number", () => {
  assert.equal(isMasked(maskId("234567890123")), true);
  assert.equal(isMasked("234567890123"), false);
});

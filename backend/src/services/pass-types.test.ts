import assert from "node:assert/strict";
import { test } from "node:test";
import { PersonCategory } from "@prisma/client";
import { profileGaps, ruleFor } from "./pass-types.js";

const visitor = (values: Record<string, unknown>) => ({ category: PersonCategory.VISITOR, ...values });

test("untyped visitors and employees keep the long-standing rule", () => {
  assert.deepEqual(profileGaps(visitor({ mobile: "9", companyId: "c", departmentId: "d" }), null), ["aadharNumber|panNumber"]);
  assert.deepEqual(profileGaps(visitor({ mobile: "9", companyId: "c", departmentId: "d", panNumber: "ABCDE1234F" }), null), []);
  const typed = { fieldRules: {}, credentialLabel: null };
  assert.deepEqual(profileGaps({ category: PersonCategory.EMPLOYEE }, typed), ["mobile", "companyId", "departmentId", "aadharNumber|panNumber"]);
});

test("a type needing only a designation is complete with a name and designation", () => {
  const official = { fieldRules: { designation: "required", mobile: "hidden", companyId: "hidden", departmentId: "hidden" }, credentialLabel: null };
  assert.deepEqual(profileGaps(visitor({}), official), ["designation"]);
  assert.deepEqual(profileGaps(visitor({ designation: "Inspector" }), official), []);
});

test("a credential type requires its credential when the rules say so", () => {
  const rep = { fieldRules: { credentialNumber: "required", credentialExpiresAt: "required", policeClearance: "required" }, credentialLabel: "Port pass" };
  assert.deepEqual(profileGaps(visitor({ policeClearance: false }), rep), ["credentialNumber", "credentialExpiresAt"]);
  assert.deepEqual(profileGaps(visitor({ policeClearance: false, credentialNumber: "X1", credentialExpiresAt: new Date() }), rep), []);
});

test("credential fields are hidden on a type without a credential, whatever the rules say", () => {
  const plain = { fieldRules: { credentialNumber: "required" }, credentialLabel: null };
  assert.equal(ruleFor(plain, "credentialNumber"), "hidden");
  assert.deepEqual(profileGaps(visitor({}), plain), []);
});

test("an unlisted field is optional, and blanks count as missing", () => {
  const t = { fieldRules: { email: "required" }, credentialLabel: null };
  assert.equal(ruleFor(t, "vehicleNumber"), "optional");
  assert.deepEqual(profileGaps(visitor({ email: "  " }), t), ["email"]);
});

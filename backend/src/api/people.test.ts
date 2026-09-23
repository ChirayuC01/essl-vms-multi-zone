import { test } from "node:test";
import assert from "node:assert/strict";
import { createPersonSchema } from "./people.js";

const valid = {
  name: "Ramesh Kumar",
  mobile: "+91 9876543210",
  companyId: "00000000-0000-4000-8000-000000000001",
  departmentId: "00000000-0000-4000-8000-000000000002",
  category: "VISITOR" as const,
  aadharNumber: "234567890123",
  esslUserId: "WCTPL070",
};

test("registration requires every identifying field", () => {
  assert.equal(createPersonSchema.safeParse(valid).success, true);
  for (const field of Object.keys(valid)) {
    const partial: Record<string, unknown> = { ...valid };
    delete partial[field];
    assert.equal(createPersonSchema.safeParse(partial).success, false, `${field} was optional`);
  }
});

test("aadhar is normalised, so spacing cannot create a second row for one person", () => {
  const spaced = createPersonSchema.safeParse({ ...valid, aadharNumber: "2345 6789 0123" });
  assert.equal(spaced.success, true);
  assert.equal(spaced.success && spaced.data.aadharNumber, "234567890123");

  const hyphens = createPersonSchema.safeParse({ ...valid, aadharNumber: "2345-6789-0123" });
  assert.equal(hyphens.success && hyphens.data.aadharNumber, "234567890123");
});

test("aadhar rejects the shapes a real one never has", () => {
  for (const bad of ["12345678901", "1234567890123", "134567890123", "034567890123", "23456789012a", ""]) {
    assert.equal(
      createPersonSchema.safeParse({ ...valid, aadharNumber: bad }).success,
      false,
      `accepted ${bad}`,
    );
  }
});

test("PAN is uppercased and must match the official shape", () => {
  const parsed = createPersonSchema.safeParse({
    ...valid,
    aadharNumber: undefined,
    panNumber: " abcde1234f ",
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.panNumber, "ABCDE1234F");

  for (const bad of ["ABCD1234F", "ABCDE12345", "12345ABCD1", "ABCDE1234!"]) {
    assert.equal(
      createPersonSchema.safeParse({ ...valid, aadharNumber: undefined, panNumber: bad }).success,
      false,
      `accepted ${bad}`,
    );
  }
});

test("either Aadhaar or PAN is required", () => {
  assert.equal(
    createPersonSchema.safeParse({ ...valid, aadharNumber: undefined, panNumber: undefined }).success,
    false,
  );
});

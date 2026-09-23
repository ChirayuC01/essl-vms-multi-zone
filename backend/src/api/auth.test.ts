import assert from "node:assert/strict";
import { test } from "node:test";
import { profileSchema } from "./auth.js";

test("self-service profile edits only optional name and phone", () => {
  assert.deepEqual(profileSchema.parse({ name: "  Gate Operator  ", phone: "  9876543210  " }), {
    name: "Gate Operator",
    phone: "9876543210",
  });
  assert.deepEqual(profileSchema.parse({ name: "", phone: "" }), { name: null, phone: null });
  assert.equal(
    profileSchema.safeParse({ name: "New", phone: "", email: "changed@example.com" }).success,
    false,
  );
});

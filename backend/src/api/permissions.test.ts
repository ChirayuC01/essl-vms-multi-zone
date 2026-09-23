import assert from "node:assert/strict";
import { test } from "node:test";
import { UserRole } from "@prisma/client";
import { Permission, ROLE_PERMISSIONS, can } from "./permissions.js";

// The permission table is the entire access-control policy in one place.
// These assert the shape of that policy, not the plumbing — a route guard
// that consults a wrong table is still wrong.

test("an admin holds every permission that exists", () => {
  // Not cosmetic. A new permission added without a decision about who gets it
  // would otherwise sit unassigned and silently deny everyone, which looks
  // like a broken feature rather than a policy gap.
  for (const permission of Object.values(Permission)) {
    assert.equal(
      can(UserRole.ADMIN, permission),
      true,
      `ADMIN is missing ${permission} — add it to ROLE_PERMISSIONS deliberately`,
    );
  }
});

test("an authorized person can do the whole barrier job", () => {
  // The daily work must not need an admin standing behind it, or the role is
  // decoration and everyone will just share the admin login.
  for (const permission of [
    Permission.READ,
    Permission.PERSON_MANAGE,
    Permission.ENTRY_MANAGE,
    Permission.DEVICE_REFRESH,
    Permission.DIRECTORY_MANAGE,
  ]) {
    assert.equal(can(UserRole.AUTHORIZED_PERSON, permission), true, permission);
  }
});

test("an authorized person cannot change how the system behaves", () => {
  // The line: configuration and deletion are invisible from the screens an
  // operator watches all day, so a mistake there goes unnoticed.
  for (const permission of [
    Permission.DEVICE_CONFIGURE,
    Permission.MAINTENANCE_RUN,
    Permission.OPERATOR_MANAGE,
    Permission.AUDIT_READ,
    Permission.DIRECTORY_DEACTIVATE,
  ]) {
    assert.equal(can(UserRole.AUTHORIZED_PERSON, permission), false, permission);
  }
});

test("de-provisioning is an operator action, not an admin one", () => {
  // Called out separately because it is the judgement call in the split:
  // removing a person from a device is routine and reversible (the record and
  // photo survive; re-provisioning is free), so gating it behind an admin
  // would obstruct the job without protecting anything.
  assert.equal(can(UserRole.AUTHORIZED_PERSON, Permission.ENTRY_MANAGE), true);
});

test("every role's permissions are real permissions", () => {
  const known = new Set<string>(Object.values(Permission));
  for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
    for (const p of granted) {
      assert.equal(known.has(p), true, `${role} grants unknown permission ${p}`);
    }
    assert.equal(new Set(granted).size, granted.length, `${role} lists a duplicate`);
  }
});

test("an unknown role is denied everything", () => {
  // Fail closed. A role that arrives from a stale token or a hand-edited row
  // must not fall through to permitted.
  assert.equal(can("SUPERUSER" as UserRole, Permission.READ), false);
  assert.equal(can("" as UserRole, Permission.ENTRY_MANAGE), false);
});

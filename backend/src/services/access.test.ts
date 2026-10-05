import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ALL_PERMISSIONS, isPermissionKey, resolvePermissions } from "./access.js";

// ---------------------------------------------------------------------------
// The upgrade promise: every role keeps exactly the access it had in Phase 2.
// The Phase 2 matrix and the old-permission -> grid-cell mapping are written
// out here as the specification; the migration's seed must match them.
// ---------------------------------------------------------------------------

const MAP: Record<string, string[]> = {
  READ: ["dashboard:view", "onsite:view", "punches:view", "passes:view", "people:view", "directory:view", "devices:view", "zones:view", "commands:view", "maintenance:view", "reports:view", "settings:view", "license:view"],
  PERSON_MANAGE: ["people:create", "people:update", "people:delete"],
  ENTRY_MANAGE: ["passes:create", "passes:update", "passes:delete", "commands:update"],
  DEVICE_REFRESH: ["device_refresh:update"],
  DIRECTORY_MANAGE: ["directory:create", "directory:update"],
  WALKIN_REGISTER: ["walkins:create"],
  LONGTERM_ISSUE: ["longterm_passes:create"],
  EXIT_OVERRIDE: ["exit_override:update"],
  BLACKLIST_MANAGE: ["blacklist:update"],
  AUDIT_READ: ["audit:view"],
  VISIT_REQUEST: ["visit_requests:view", "visit_requests:create"],
  VISIT_REVIEW: ["visit_requests:update"],
  ZONE_WIDEN: ["zone_widen:update"],
};
const AP = ["READ", "PERSON_MANAGE", "ENTRY_MANAGE", "DEVICE_REFRESH", "DIRECTORY_MANAGE"];
const SEC = [...AP, "WALKIN_REGISTER", "LONGTERM_ISSUE", "EXIT_OVERRIDE"];
const PHASE2: Record<string, string[]> = {
  AUTHORIZED_PERSON: AP,
  HOST: ["VISIT_REQUEST", "VISIT_REVIEW", "ZONE_WIDEN"],
  SECURITY: SEC,
  SECURITY_INCHARGE: [...SEC, "BLACKLIST_MANAGE", "AUDIT_READ"],
  HR: ["READ"],
  HOD: ["READ"],
};
const expand = (perms: string[]) => [...new Set(perms.flatMap((p) => MAP[p]!))].sort();

const backendRoot = path.resolve(import.meta.dirname, "..", "..");
const seedSql = readFileSync(path.join(backendRoot, "prisma", "migrations", "20261002140000_configurable_access", "migration.sql"), "utf8");
function seededGrants(roleKey: string): string[] {
  const id = `role_${roleKey.toLowerCase()}`;
  return [...seedSql.matchAll(new RegExp(`\\('${id}', '([a-z_]+:[a-z]+)'\\)`, "g"))].map((m) => m[1]!).sort();
}

// Later decisions that deliberately narrow the seed, each its own migration.
const settingsAdminOnly = readFileSync(path.join(backendRoot, "prisma", "migrations", "20261005090000_settings_admin_only", "migration.sql"), "utf8");

test("every role's seeded grid is exactly its Phase 2 access", () => {
  for (const [role, perms] of Object.entries(PHASE2)) {
    assert.deepEqual(seededGrants(role), expand(perms), role);
  }
});

test("settings are Administrator-only by default: no seeded role keeps settings:view", () => {
  assert.match(settingsAdminOnly, /DELETE FROM "role_permission"\s+WHERE "permission" = 'settings:view'/);
  for (const role of Object.keys(PHASE2)) {
    assert.ok(settingsAdminOnly.includes(`'role_${role.toLowerCase()}'`), `${role} not covered`);
  }
});

test("the Admin role has no seeded rows: it always holds everything", () => {
  assert.deepEqual(seededGrants("ADMIN"), []);
  assert.equal(resolvePermissions("ADMIN", [], [{ key: "people:view", effect: "DENY" }]).size, ALL_PERMISSIONS.length);
});

test("every seeded cell exists in the catalogue", () => {
  for (const role of Object.keys(PHASE2)) for (const p of seededGrants(role)) assert.ok(isPermissionKey(p), p);
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test("an operator with no overrides gets exactly their role's grid", () => {
  assert.deepEqual([...resolvePermissions("SECURITY", ["people:view", "passes:create"], [])].sort(), ["passes:create", "people:view"]);
});

test("ALLOW adds a cell the role lacks; DENY removes one it has", () => {
  const out = resolvePermissions("SECURITY", ["people:view", "passes:create"], [
    { key: "audit:view", effect: "ALLOW" },
    { key: "passes:create", effect: "DENY" },
  ]);
  assert.deepEqual([...out].sort(), ["audit:view", "people:view"]);
});

test("unknown cells are ignored rather than granted", () => {
  assert.deepEqual([...resolvePermissions("HOST", ["nothing:here"], [{ key: "made:up", effect: "ALLOW" }])], []);
});

// ---------------------------------------------------------------------------
// The console asks about cells by name; a renamed cell would silently hide a
// screen. Every can("...") in the web app must name a real cell.
// ---------------------------------------------------------------------------

test("every permission the console checks exists in the catalogue", () => {
  const webSrc = path.resolve(backendRoot, "..", "web", "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) files.push(full);
    }
  };
  walk(webSrc);
  const used = new Set<string>();
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/(?:can\(|permission: )"([^"]+)"/g)) used.add(m[1]!);
  }
  assert.ok(used.size > 0, "no permission checks found in web/src");
  for (const key of used) assert.ok(isPermissionKey(key), `web uses unknown permission "${key}"`);
});

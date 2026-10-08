import { prisma } from "../db/index.js";

// Configurable access (two-zone rebuild, Phase 2b).
//
// Access is a grid of FEATURE x ACTION. An Admin edits each role's grid and
// may override single cells for a single operator (allow or deny). Routes
// declare one cell they need (`people:view`); nothing anywhere asks "what
// role is this" except the one rule that the system Admin role always holds
// everything, so the site can never be locked out.
//
// The catalogue lives in code because the routes it guards live in code: a
// cell nothing checks would be a lie in the grid. Only the actions that mean
// something for a feature are listed, and the grid shows only those.
//
// "Delete" never deletes data (CLAUDE.md #3). Where it appears it means
// deactivate or remove from terminals, and `deleteMeans` says which.

export const ACTIONS = ["view", "create", "update", "delete"] as const;
export type Action = (typeof ACTIONS)[number];

interface ResourceDef {
  label: string;
  group: string;
  actions: readonly Action[];
  /** What each action concretely allows, shown in the grid as a hint. */
  notes?: Partial<Record<Action, string>>;
}

export const RESOURCES = {
  dashboard: { label: "Dashboard and live feed", group: "General", actions: ["view"] },
  onsite: { label: "On site now", group: "General", actions: ["view"] },
  punches: { label: "Punch log", group: "General", actions: ["view"] },

  passes: {
    label: "Visitor passes",
    group: "Gate",
    actions: ["view", "create", "update", "delete"],
    notes: { create: "authorize a visitor", update: "block / unblock, query terminal", delete: "remove from terminals" },
  },
  visit_requests: {
    label: "Visit requests",
    group: "Gate",
    actions: ["view", "create", "update"],
    notes: { update: "Clear / Query / Reject (own visitors only)" },
  },
  visit_requests_all: {
    label: "Decide any host's visit requests",
    group: "Gate",
    actions: ["update"],
    notes: { update: "Clear / Query / Reject requests raised by other hosts" },
  },
  walkins: { label: "Walk-in registration", group: "Gate", actions: ["create"] },
  longterm_passes: { label: "Long-term passes", group: "Gate", actions: ["create"] },
  exit_override: { label: "Exit override", group: "Gate", actions: ["update"], notes: { update: "release without the exit code; reason required" } },
  blacklist: { label: "Blacklist", group: "Gate", actions: ["update"], notes: { update: "blacklist / lift" } },
  zone_widen: { label: "Widen a visitor's zones", group: "Gate", actions: ["update"] },

  people: {
    label: "People",
    group: "People",
    actions: ["view", "create", "update", "delete"],
    notes: { update: "details and photo", delete: "deactivate" },
  },
  person_category: { label: "Change employee / visitor category", group: "People", actions: ["update"] },
  employee_access: {
    label: "Employee terminal access",
    group: "People",
    actions: ["create", "delete"],
    notes: { create: "assign / restore / rehire", delete: "remove / resign" },
  },
  documents: {
    label: "Person documents",
    group: "People",
    actions: ["view", "create", "delete"],
    notes: { view: "list and download", delete: "remove from view (file kept)" },
  },
  directory: {
    label: "Companies and departments",
    group: "People",
    actions: ["view", "create", "update", "delete"],
    notes: { update: "bulk assign people", delete: "rename / deactivate / reactivate" },
  },

  devices: { label: "Terminals", group: "Terminals", actions: ["view", "create", "update"], notes: { create: "register", update: "role, zone, patterns, timezone" } },
  device_refresh: { label: "Refresh from terminal", group: "Terminals", actions: ["update"] },
  zones: { label: "Zones", group: "Terminals", actions: ["view", "create", "update"] },
  commands: { label: "Command queue", group: "Terminals", actions: ["view", "update"], notes: { update: "retry a command" } },
  maintenance: {
    label: "Maintenance jobs",
    group: "Terminals",
    actions: ["view", "update"],
    notes: { update: "run reconcile, retention, expiry, scans, baselines" },
  },

  reports: { label: "Reports", group: "Reports", actions: ["view"] },
  audit: { label: "Audit trail", group: "Reports", actions: ["view"] },

  operators: { label: "Operators", group: "Administration", actions: ["view", "create", "update"], notes: { update: "details, role, disable, reset password" } },
  access: { label: "Roles and access", group: "Administration", actions: ["view", "create", "update"], notes: { create: "add a role", update: "edit grids and user overrides" } },
  pass_types: { label: "Pass types", group: "Administration", actions: ["view", "create", "update"], notes: { update: "rules, validity, deactivate" } },
  settings: { label: "System settings", group: "Administration", actions: ["view", "update"] },
  messages: { label: "Message outbox", group: "Administration", actions: ["view"], notes: { view: "read every SMS and email sent, including links and codes while no provider is set up" } },
  branding: { label: "Branding", group: "Administration", actions: ["update"] },
  license: { label: "Licence", group: "Administration", actions: ["view", "update"], notes: { update: "install a key" } },
} as const satisfies Record<string, ResourceDef>;

export type Resource = keyof typeof RESOURCES;
type ActionsOf<R extends Resource> = (typeof RESOURCES)[R]["actions"][number];
export type PermissionKey = { [R in Resource]: `${R}:${ActionsOf<R>}` }[Resource];

/** Every cell that exists. */
export const ALL_PERMISSIONS: PermissionKey[] = (Object.entries(RESOURCES) as [Resource, ResourceDef][]).flatMap(
  ([resource, def]) => def.actions.map((action) => `${resource}:${action}` as PermissionKey),
);
const KNOWN = new Set<string>(ALL_PERMISSIONS);
export function isPermissionKey(value: string): value is PermissionKey {
  return KNOWN.has(value);
}

/** The system role that always holds everything. Never edited, never overridden. */
export const ADMIN_ROLE = "ADMIN";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface Override {
  key: string;
  effect: "ALLOW" | "DENY";
}

/** (role grants ∪ user ALLOW) − user DENY. The Admin role ignores everything. Pure. */
export function resolvePermissions(roleKey: string, roleGrants: readonly string[], overrides: readonly Override[]): Set<PermissionKey> {
  if (roleKey === ADMIN_ROLE) return new Set(ALL_PERMISSIONS);
  const out = new Set(roleGrants.filter(isPermissionKey));
  for (const o of overrides) {
    if (!isPermissionKey(o.key)) continue;
    if (o.effect === "ALLOW") out.add(o.key);
    else out.delete(o.key);
  }
  return out;
}

// Per-user cache. The guard runs on every operator request, and a remote
// database makes three extra round trips per request a real cost (CLAUDE.md
// #4). Every write that can change anyone's access calls `invalidateAccess`,
// so a revocation still lands on the very next request. Single backend
// process by design (see events/bus.ts), so an in-memory cache is coherent.
const CACHE_MS = 60_000;
const cache = new Map<string, { until: number; value: Set<PermissionKey> }>();

export function invalidateAccess(): void {
  cache.clear();
}

export async function effectivePermissions(userId: string, roleKey: string): Promise<Set<PermissionKey>> {
  // Keyed by role too: requireAuth re-reads the role on every request, so a
  // role change applies immediately even if it bypassed the API.
  const cacheKey = `${userId}:${roleKey}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.value;
  const [grants, overrides] = await Promise.all([
    roleKey === ADMIN_ROLE
      ? Promise.resolve([])
      : prisma.rolePermission.findMany({ where: { role: { key: roleKey, isActive: true } }, select: { permission: true } }),
    roleKey === ADMIN_ROLE
      ? Promise.resolve([])
      : prisma.userPermissionOverride.findMany({ where: { userId }, select: { permission: true, effect: true } }),
  ]);
  const value = resolvePermissions(
    roleKey,
    grants.map((g) => g.permission),
    overrides.map((o) => ({ key: o.permission, effect: o.effect })),
  );
  cache.set(cacheKey, { until: Date.now() + CACHE_MS, value });
  return value;
}

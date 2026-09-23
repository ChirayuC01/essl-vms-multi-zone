import { UserRole } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";

// Role-based access control (Phase 4 Milestone 17).
//
// Routes declare a PERMISSION; one table maps roles to permissions. That
// indirection is the whole design, and it is there for a reason that has
// nothing to do with today's two roles:
//
// The expensive part of RBAC is never the roles. It is retrofitting checks
// onto routes written assuming everyone may do everything — which is exactly
// the state this codebase was in until now. Adding a third role should cost
// one entry in ROLE_PERMISSIONS and nothing else. Scattering
// `if (role === "ADMIN")` through handlers is what makes that impossible, and
// it is the same failure the ban on client-specific conditionals prevents
// (CLAUDE.md #2).
//
// The split below draws one line: **does this change how the system behaves,
// or only what it holds?** An authorized person does the entire barrier job,
// including de-provisioning — routine, reversible, and visible on the screens
// they already watch. They do not reconfigure a gate's direction mapping or
// delete rows, because those are invisible from the daily screens and hard to
// notice going wrong.

export const Permission = {
  /** See anything: people, entries, punches, devices, the board, reports. */
  READ: "read",
  /** Register and edit people, upload photos, deactivate. */
  PERSON_MANAGE: "person:manage",
  /** The barrier job: provision, block, unblock, de-provision, retry. */
  ENTRY_MANAGE: "entry:manage",
  /** Ask a terminal to re-report itself. Read-only on the device. */
  DEVICE_REFRESH: "device:refresh",
  /** Change how a terminal is interpreted — gate role, punch-state maps. */
  DEVICE_CONFIGURE: "device:configure",
  /** Jobs that delete or rewrite rows: retention, reconcile, baselines. */
  MAINTENANCE_RUN: "maintenance:run",
  /** Create, disable and re-role other operators (Milestone 18). */
  OPERATOR_MANAGE: "operator:manage",
  /** Read the record of what other operators did. */
  AUDIT_READ: "audit:read",
  /** Install or replace the license key (Phase 6 task 5). */
  LICENSE_MANAGE: "license:manage",
  /** Create companies and departments and bulk-assign people. */
  DIRECTORY_MANAGE: "directory:manage",
  /** Deactivate or reactivate a company or department. */
  DIRECTORY_DEACTIVATE: "directory:deactivate",
  /** Category changes alter lifecycle and are therefore administrator-only. */
  PERSON_CATEGORY_MANAGE: "person:category:manage",
  /** Permanent employee roster ownership on devices. */
  EMPLOYEE_ACCESS_MANAGE: "employee:access:manage",
  /** Site-wide organization name and logo. */
  BRANDING_MANAGE: "branding:manage",
} as const;

export type PermissionName = (typeof Permission)[keyof typeof Permission];

const OPERATOR_PERMISSIONS: PermissionName[] = [
  Permission.READ,
  Permission.PERSON_MANAGE,
  Permission.ENTRY_MANAGE,
  Permission.DEVICE_REFRESH,
  Permission.DIRECTORY_MANAGE,
];

/**
 * The one place a role's abilities are defined.
 *
 * ADMIN is spelled out rather than given a wildcard: a new permission should
 * force a decision about who gets it, not silently land in the most powerful
 * role because that role was written as "everything".
 */
export const ROLE_PERMISSIONS: Record<UserRole, PermissionName[]> = {
  [UserRole.ADMIN]: [
    Permission.READ,
    Permission.PERSON_MANAGE,
    Permission.ENTRY_MANAGE,
    Permission.DEVICE_REFRESH,
    Permission.DEVICE_CONFIGURE,
    Permission.MAINTENANCE_RUN,
    Permission.OPERATOR_MANAGE,
    Permission.AUDIT_READ,
    Permission.LICENSE_MANAGE,
    Permission.DIRECTORY_MANAGE,
    Permission.DIRECTORY_DEACTIVATE,
    Permission.PERSON_CATEGORY_MANAGE,
    Permission.EMPLOYEE_ACCESS_MANAGE,
    Permission.BRANDING_MANAGE,
  ],
  [UserRole.AUTHORIZED_PERSON]: OPERATOR_PERMISSIONS,
};

export function can(role: UserRole, permission: PermissionName): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Route guard. Runs after `requireAuth`, which has already resolved the
 * operator from the database — so the role checked here is the CURRENT one,
 * not whatever was true when the token was issued.
 *
 * A refusal is audited. "Who tried to do what they were not allowed to" is
 * precisely the question an audit log exists to answer, and it is the only
 * signal that would distinguish a misconfigured role from someone probing.
 */
export function requirePermission(permission: PermissionName) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const operator = request.operator;
    if (!operator) {
      return reply.code(401).send({ error: "authentication required" });
    }
    if (can(operator.role, permission)) return;

    request.log.warn(
      { operator: operator.email, role: operator.role, permission, url: request.url },
      "permission denied",
    );
    await prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.PERMISSION_DENIED,
        entityType: "app_user",
        entityId: operator.id,
        detail: { permission, method: request.method, url: request.url, role: operator.role },
        actorId: operator.id,
      }),
    });
    return reply.code(403).send({
      error: `your role (${operator.role}) is not permitted to ${permission}`,
    });
  };
}

import type { FastifyReply, FastifyRequest } from "fastify";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { effectivePermissions, type PermissionKey } from "../services/access.js";

// Access control.
//
// Routes declare the ONE grid cell they need ("people:view"). Which roles and
// operators hold which cells is data an Admin edits (Phase 2b); see
// services/access.ts for the catalogue and how a user's effective access is
// resolved from their role's grid plus their own ALLOW/DENY overrides.
//
// The expensive part of access control is never the roles. It is retrofitting
// checks onto routes written assuming everyone may do everything. Every route
// declaring its cell is what lets an Admin reshape access without a code
// change, and it is the same discipline as the ban on client-specific
// conditionals (CLAUDE.md #2): nothing here asks "is this an admin".

export type { PermissionKey } from "../services/access.js";

/** Does the signed-in operator hold this cell right now? */
export async function hasPermission(request: FastifyRequest, permission: PermissionKey): Promise<boolean> {
  const operator = request.operator;
  if (!operator) return false;
  return (await effectivePermissions(operator.id, operator.role)).has(permission);
}

/**
 * Route guard. Runs after `requireAuth`, which has already resolved the
 * operator from the database, so the role checked here is the CURRENT one.
 * Grid and override edits invalidate the cache, so revocation lands on the
 * very next request too.
 *
 * A refusal is audited. "Who tried to do what they were not allowed to" is
 * precisely the question an audit log exists to answer, and it is the only
 * signal that would distinguish a misconfigured role from someone probing.
 */
export function requirePermission(permission: PermissionKey) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const operator = request.operator;
    if (!operator) {
      return reply.code(401).send({ error: "authentication required" });
    }
    if (await hasPermission(request, permission)) return;

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

/** Guard for a route several cells may open (e.g. the role list). */
export function requireAnyPermission(...permissions: PermissionKey[]) {
  const guards = permissions.map((p) => requirePermission(p));
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    for (const p of permissions) if (await hasPermission(request, p)) return;
    // Refuse (and audit) as the first cell would.
    return guards[0]!(request, reply);
  };
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { ADMIN_ROLE, invalidateAccess } from "../services/access.js";
import { hashPassword, verifyPassword } from "./auth.js";
import { requirePermission } from "./permissions.js";

// Operator management (Phase 4 Milestone 18).
//
// There is no email on-premise. Many sites have no outbound internet at all,
// so "we sent you a reset link" is not available and never will be. An admin
// sets a temporary password and the account is forced to change it on first
// use — which is why `must_change_password` exists rather than being a nicety.
//
// Operators are DEACTIVATED, never deleted. `audit_log.actor` and
// `sync_command.initiated_by` point here, and removing the row would orphan
// the record of who authorized what — destroying evidence to tidy a list.

// Length over composition. Complexity rules push people towards Passw0rd! and
// a sticky note; length is the property that actually resists guessing. Long
// enough to matter, short enough that a gate supervisor will not write it down.
const MIN_PASSWORD = 10;
// Exported: the setup wizard's first-admin bootstrap (api/setup.ts) applies
// the same length rule rather than defining its own.
export const password = z
  .string()
  .min(MIN_PASSWORD, `password must be at least ${MIN_PASSWORD} characters`)
  .max(200);

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(100).transform((value) => value || null).nullable().optional(),
  phone: z.string().trim().max(30).transform((value) => value || null).nullable().optional(),
  // A role key (Role.key); must name an active role.
  role: z.string().trim().min(1).max(64),
  temporaryPassword: password,
});

const updateSchema = z.object({
  name: z.string().trim().max(100).transform((value) => value || null).nullable().optional(),
  phone: z.string().trim().max(30).transform((value) => value || null).nullable().optional(),
  role: z.string().trim().min(1).max(64).optional(),
  isActive: z.boolean().optional(),
});

const resetSchema = z.object({ temporaryPassword: password });

const changeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: password,
});

function operatorDto(u: {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    passwordChangedAt: u.passwordChangedAt,
    createdAt: u.createdAt,
  };
}

/** Refuse a role key that does not name an active role. */
async function activeRole(key: string): Promise<boolean> {
  return (await prisma.role.count({ where: { key, isActive: true } })) === 1;
}

/** Active admins other than the one given. Guards the last-admin rules. */
async function otherActiveAdmins(exceptId: string): Promise<number> {
  return prisma.appUser.count({
    where: { role: ADMIN_ROLE, isActive: true, id: { not: exceptId } },
  });
}

export async function operatorRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/operators/active",
    { preHandler: requirePermission("people:view") },
    async (_request, reply) => {
      const items = await prisma.appUser.findMany({
        where: { isActive: true },
        orderBy: [{ name: "asc" }, { email: "asc" }],
        select: { id: true, name: true, phone: true, email: true },
      });
      return reply.send({ total: items.length, items });
    },
  );

  app.get(
    "/operators",
    { preHandler: requirePermission("operators:view") },
    async (_request, reply) => {
      const items = await prisma.appUser.findMany({ orderBy: { createdAt: "asc" } });
      return reply.send({ total: items.length, items: items.map(operatorDto) });
    },
  );

  app.post(
    "/operators",
    { preHandler: requirePermission("operators:create") },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const { email, name, phone, role, temporaryPassword } = parsed.data;

      if (!(await activeRole(role))) {
        return reply.code(400).send({ error: `no active role "${role}"` });
      }
      if (await prisma.appUser.findUnique({ where: { email } })) {
        return reply.code(409).send({ error: "an operator with that email already exists" });
      }

      const created = await prisma.appUser.create({
        data: {
          email,
          name: name ?? null,
          phone: phone ?? null,
          role,
          passwordHash: hashPassword(temporaryPassword),
          // The password is known to whoever typed it. Until it is changed,
          // the account can do nothing else.
          mustChangePassword: true,
        },
      });
      await prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.OPERATOR_CREATED,
          entityType: "app_user",
          entityId: created.id,
          detail: { email, name: name ?? null, phone: phone ?? null, role },
          actorId: request.operator?.id ?? null,
        }),
      });
      request.log.info({ email, role, by: request.operator?.email }, "operator created");
      return reply.code(201).send(operatorDto(created));
    },
  );

  app.patch(
    "/operators/:id",
    { preHandler: requirePermission("operators:update") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const body = parsed.data;
      if (body.name === undefined && body.phone === undefined && body.role === undefined && body.isActive === undefined) {
        return reply.code(400).send({ error: "nothing to change" });
      }

      const target = await prisma.appUser.findUnique({ where: { id } });
      if (!target) return reply.code(404).send({ error: "operator not found" });
      if (body.role !== undefined && body.role !== target.role && !(await activeRole(body.role))) {
        return reply.code(400).send({ error: `no active role "${body.role}"` });
      }

      // You cannot demote or disable yourself. Not paternalism: an admin who
      // does it by accident has no way back in, and on an on-premise install
      // with no other admin that means editing the database by hand to
      // recover. Refusing costs one extra click; the alternative costs a
      // site visit.
      if (target.id === request.operator?.id) {
        if (body.isActive === false) {
          return reply.code(409).send({ error: "you cannot disable your own account" });
        }
        if (body.role !== undefined && body.role !== target.role) {
          return reply.code(409).send({ error: "you cannot change your own role" });
        }
      }

      // The last active admin may not be removed by any route. Without one,
      // nobody can create operators, configure a device, or run maintenance —
      // the install is bricked short of direct database access.
      //
      // Unreachable through the API as it stands, and deliberately kept: only
      // ADMIN holds operator:manage, an admin must be active to authenticate,
      // and an admin acting on themselves is caught by the self-guard above —
      // so there is always another active admin. This is the backstop for the
      // day operator:manage is granted to another role, or the self-guard is
      // relaxed. Cheap now; a site visit if it is missing then.
      const losingAdmin =
        target.role === ADMIN_ROLE &&
        (body.isActive === false || (body.role !== undefined && body.role !== ADMIN_ROLE));
      if (losingAdmin && (await otherActiveAdmins(target.id)) === 0) {
        return reply.code(409).send({
          error:
            "this is the last active administrator — promote another operator to ADMIN first, " +
            "or nobody will be able to manage the system",
        });
      }

      const updated = await prisma.appUser.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
      });
      // A role change or deactivation changes what this operator may do on
      // their very next request.
      invalidateAccess();
      await prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.OPERATOR_UPDATED,
          entityType: "app_user",
          entityId: updated.id,
          detail: {
            email: updated.email,
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.phone !== undefined ? { phone: body.phone } : {}),
            ...(body.role !== undefined ? { roleFrom: target.role, roleTo: body.role } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          },
          actorId: request.operator?.id ?? null,
        }),
      });
      request.log.info(
        { target: updated.email, by: request.operator?.email, ...body },
        "operator updated",
      );
      return reply.send(operatorDto(updated));
    },
  );

  app.post(
    "/operators/:id/reset-password",
    { preHandler: requirePermission("operators:update") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = resetSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const target = await prisma.appUser.findUnique({ where: { id } });
      if (!target) return reply.code(404).send({ error: "operator not found" });

      await prisma.appUser.update({
        where: { id },
        data: {
          passwordHash: hashPassword(parsed.data.temporaryPassword),
          // Forced, always. Somebody else now knows this password.
          mustChangePassword: true,
          passwordChangedAt: new Date(),
        },
      });
      await prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.OPERATOR_PASSWORD_RESET,
          entityType: "app_user",
          entityId: id,
          detail: { email: target.email },
          actorId: request.operator?.id ?? null,
        }),
      });
      request.log.warn(
        { target: target.email, by: request.operator?.email },
        "operator password reset — they must change it at next sign-in",
      );
      return reply.send({ ok: true, mustChangePassword: true });
    },
  );

  // Self-service. Deliberately NOT behind OPERATOR_MANAGE: changing your own
  // password is not an administrative act, and an account under a forced
  // change would otherwise be unable to escape it.
  app.post("/auth/change-password", async (request, reply) => {
    const operator = request.operator;
    if (!operator) return reply.code(401).send({ error: "authentication required" });

    const parsed = changeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const { currentPassword, newPassword } = parsed.data;

    const user = await prisma.appUser.findUnique({ where: { id: operator.id } });
    if (!user) return reply.code(401).send({ error: "account is no longer active" });

    // The current password is required even under a forced change. Otherwise
    // an unattended browser is enough to take an account over permanently.
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      request.log.warn({ email: user.email }, "password change with wrong current password");
      return reply.code(403).send({ error: "current password is incorrect" });
    }
    if (verifyPassword(newPassword, user.passwordHash)) {
      return reply.code(400).send({ error: "the new password must be different" });
    }

    await prisma.appUser.update({
      where: { id: user.id },
      data: {
        passwordHash: hashPassword(newPassword),
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
    });
    await prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.OPERATOR_PASSWORD_CHANGED,
        entityType: "app_user",
        entityId: user.id,
        detail: { email: user.email, self: true },
        actorId: user.id,
      }),
    });
    request.log.info({ email: user.email }, "operator changed their own password");
    return reply.send({ ok: true });
  });
}

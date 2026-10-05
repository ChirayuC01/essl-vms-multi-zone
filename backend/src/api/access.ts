import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import {
  ADMIN_ROLE,
  ALL_PERMISSIONS,
  RESOURCES,
  effectivePermissions,
  invalidateAccess,
  isPermissionKey,
  resolvePermissions,
} from "../services/access.js";
import { actorId } from "./auth.js";
import { requireAnyPermission, requirePermission } from "./permissions.js";

// Roles and access (two-zone rebuild, Phase 2b). An Admin shapes what every
// role may do and adjusts single operators, without a code change. Every
// change is audited and takes effect on the affected operators' next request.

const permissionList = z.array(z.string()).max(ALL_PERMISSIONS.length).refine(
  (keys) => keys.every(isPermissionKey),
  "unknown permission",
);
const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
  // Start from another role's grid instead of an empty one.
  copyFrom: z.string().min(1).optional(),
});
const updateRoleSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  isActive: z.boolean().optional(),
});
const overridesSchema = z.object({
  overrides: z
    .array(z.object({ permission: z.string(), effect: z.enum(["ALLOW", "DENY"]) }))
    .max(ALL_PERMISSIONS.length)
    .refine((list) => list.every((o) => isPermissionKey(o.permission)), "unknown permission")
    .refine((list) => new Set(list.map((o) => o.permission)).size === list.length, "a permission is listed twice"),
});

/** An immutable key from a display name: "Gate Supervisor" -> GATE_SUPERVISOR. */
function keyFromName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "ROLE";
}

async function roleGrants(roleId: string): Promise<string[]> {
  return (await prisma.rolePermission.findMany({ where: { roleId }, select: { permission: true } }))
    .map((r) => r.permission)
    .sort();
}

export async function accessRoutes(app: FastifyInstance): Promise<void> {
  app.get("/access/catalogue", { preHandler: requirePermission("access:view") }, async (_request, reply) => {
    return reply.send({
      items: Object.entries(RESOURCES).map(([key, def]) => ({ key, ...def })),
    });
  });

  // The role list feeds both the access screens and the operator role picker.
  app.get("/roles", { preHandler: requireAnyPermission("access:view", "operators:view") }, async (_request, reply) => {
    const [roles, counts] = await Promise.all([
      prisma.role.findMany({ orderBy: [{ isSystem: "desc" }, { isActive: "desc" }, { name: "asc" }] }),
      prisma.appUser.groupBy({ by: ["role"], where: { isActive: true }, _count: { _all: true } }),
    ]);
    return reply.send({
      items: roles.map((r) => ({ ...r, activeUsers: counts.find((c) => c.role === r.key)?._count._all ?? 0 })),
    });
  });

  app.post("/roles", { preHandler: requirePermission("access:create") }, async (request, reply) => {
    const parsed = createRoleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    const { name, description, copyFrom } = parsed.data;
    let grants: string[] = [];
    if (copyFrom) {
      const source = await prisma.role.findUnique({ where: { key: copyFrom } });
      if (!source) return reply.code(404).send({ error: "role to copy from not found" });
      grants = source.key === ADMIN_ROLE ? [...ALL_PERMISSIONS] : await roleGrants(source.id);
    }
    // Keys are immutable and unique; a clash with an existing key gets a suffix.
    const base = keyFromName(name);
    const taken = new Set((await prisma.role.findMany({ where: { key: { startsWith: base } }, select: { key: true } })).map((r) => r.key));
    let key = base;
    for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
    try {
      const role = await prisma.$transaction(async (tx) => {
        const created = await tx.role.create({ data: { key, name, description: description ?? null } });
        if (grants.length) await tx.rolePermission.createMany({ data: grants.map((permission) => ({ roleId: created.id, permission })) });
        await tx.auditLog.create({
          data: auditRow({
            action: AuditAction.ROLE_CREATED,
            entityType: "role",
            entityId: created.id,
            detail: { key, name, copyFrom: copyFrom ?? null, permissions: grants },
            actorId: actorId(request),
          }),
        });
        return created;
      });
      return reply.code(201).send(role);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.code(409).send({ error: "a role with that name already exists" });
      }
      throw err;
    }
  });

  app.patch("/roles/:key", { preHandler: requirePermission("access:update") }, async (request, reply) => {
    const parsed = updateRoleSchema.safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: "nothing to change" });
    const role = await prisma.role.findUnique({ where: { key: (request.params as { key: string }).key } });
    if (!role) return reply.code(404).send({ error: "role not found" });
    if (role.isSystem) return reply.code(409).send({ error: "the Administrator role cannot be changed" });
    if (parsed.data.isActive === false && (await prisma.appUser.count({ where: { role: role.key, isActive: true } })) > 0) {
      return reply.code(409).send({ error: "move this role's active operators to another role before deactivating it" });
    }
    const data = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    try {
      const updated = await prisma.role.update({ where: { id: role.id }, data });
      await prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.ROLE_UPDATED,
          entityType: "role",
          entityId: role.id,
          detail: { key: role.key, before: { name: role.name, description: role.description, isActive: role.isActive }, changes: data },
          actorId: actorId(request),
        }),
      });
      invalidateAccess();
      return reply.send(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.code(409).send({ error: "a role with that name already exists" });
      }
      throw err;
    }
  });

  app.get("/roles/:key/permissions", { preHandler: requirePermission("access:view") }, async (request, reply) => {
    const role = await prisma.role.findUnique({ where: { key: (request.params as { key: string }).key } });
    if (!role) return reply.code(404).send({ error: "role not found" });
    return reply.send({ role: role.key, editable: !role.isSystem, permissions: role.isSystem ? [...ALL_PERMISSIONS] : await roleGrants(role.id) });
  });

  app.put("/roles/:key/permissions", { preHandler: requirePermission("access:update") }, async (request, reply) => {
    const parsed = z.object({ permissions: permissionList }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    const role = await prisma.role.findUnique({ where: { key: (request.params as { key: string }).key } });
    if (!role) return reply.code(404).send({ error: "role not found" });
    if (role.isSystem) return reply.code(409).send({ error: "the Administrator role always has full access" });
    const before = new Set(await roleGrants(role.id));
    const after = new Set<string>(parsed.data.permissions);
    const added = [...after].filter((p) => !before.has(p)).sort();
    const removed = [...before].filter((p) => !after.has(p)).sort();
    if (added.length || removed.length) {
      await prisma.$transaction([
        prisma.rolePermission.deleteMany({ where: { roleId: role.id, permission: { in: removed } } }),
        prisma.rolePermission.createMany({ data: added.map((permission) => ({ roleId: role.id, permission })) }),
        prisma.auditLog.create({
          data: auditRow({
            action: AuditAction.ROLE_PERMISSIONS_CHANGED,
            entityType: "role",
            entityId: role.id,
            detail: { key: role.key, added, removed },
            actorId: actorId(request),
          }),
        }),
      ]);
      invalidateAccess();
    }
    return reply.send({ role: role.key, editable: true, permissions: [...after].sort() });
  });

  // One operator's access: what their role grants, their own overrides, and
  // the result. The Admin role is immune to overrides.
  app.get("/operators/:id/permissions", { preHandler: requirePermission("access:view") }, async (request, reply) => {
    const user = await prisma.appUser.findUnique({
      where: { id: (request.params as { id: string }).id },
      include: { roleDef: true, permissionOverrides: true },
    });
    if (!user) return reply.code(404).send({ error: "operator not found" });
    return reply.send({
      role: user.role,
      editable: !user.roleDef.isSystem,
      roleGrants: user.roleDef.isSystem ? [...ALL_PERMISSIONS] : await roleGrants(user.roleDef.id),
      overrides: user.permissionOverrides.map((o) => ({ permission: o.permission, effect: o.effect })),
      effective: [...(await effectivePermissions(user.id, user.role))].sort(),
    });
  });

  app.put("/operators/:id/permissions", { preHandler: requirePermission("access:update") }, async (request, reply) => {
    const parsed = overridesSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    const user = await prisma.appUser.findUnique({
      where: { id: (request.params as { id: string }).id },
      include: { roleDef: true, permissionOverrides: true },
    });
    if (!user) return reply.code(404).send({ error: "operator not found" });
    if (user.roleDef.isSystem) return reply.code(409).send({ error: "an Administrator always has full access and cannot be overridden" });

    const before = new Map(user.permissionOverrides.map((o) => [o.permission, o.effect as string]));
    const after = new Map(parsed.data.overrides.map((o) => [o.permission, o.effect as string]));
    const changes: Record<string, { from: string; to: string }> = {};
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const from = before.get(key) ?? "INHERIT";
      const to = after.get(key) ?? "INHERIT";
      if (from !== to) changes[key] = { from, to };
    }
    if (Object.keys(changes).length) {
      await prisma.$transaction([
        prisma.userPermissionOverride.deleteMany({ where: { userId: user.id } }),
        prisma.userPermissionOverride.createMany({
          data: parsed.data.overrides.map((o) => ({ userId: user.id, permission: o.permission, effect: o.effect })),
        }),
        prisma.auditLog.create({
          data: auditRow({
            action: AuditAction.USER_PERMISSIONS_CHANGED,
            entityType: "app_user",
            entityId: user.id,
            detail: { email: user.email, role: user.role, changes },
            actorId: actorId(request),
          }),
        }),
      ]);
      invalidateAccess();
    }
    const grants = await roleGrants(user.roleDef.id);
    return reply.send({
      role: user.role,
      editable: true,
      roleGrants: grants,
      overrides: parsed.data.overrides,
      effective: [...resolvePermissions(user.role, grants, parsed.data.overrides.map((o) => ({ key: o.permission, effect: o.effect })))].sort(),
    });
  });
}

import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { wouldCreateCycle } from "../services/zones.js";
import { actorId } from "./auth.js";
import { Permission, requirePermission } from "./permissions.js";

// Site zones (two-zone rebuild, Phase 1). Topology is gate configuration, so
// changing it needs the same permission as changing a terminal's role.

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  parentZoneId: z.string().min(1).nullable().optional(),
  exitCodeDefault: z.boolean().optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  parentZoneId: z.string().min(1).nullable().optional(),
  exitCodeDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

// zod emits optional keys as `undefined`, which Prisma's exact types reject.
function defined<T extends object>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function conflict(reply: FastifyReply, err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return reply.code(409).send({ error: "a zone with that name already exists" });
  }
  throw err;
}

export async function zoneRoutes(app: FastifyInstance): Promise<void> {
  app.get("/zones", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    const [zones, counts] = await Promise.all([
      prisma.zone.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] }),
      prisma.device.groupBy({ by: ["zoneId", "role"], where: { zoneId: { not: null } }, _count: { _all: true } }),
    ]);
    return reply.send({
      items: zones.map((zone) => {
        const gates = { IN: 0, OUT: 0, BOTH: 0 };
        for (const row of counts) if (row.zoneId === zone.id) gates[row.role] = row._count._all;
        // A warning, not a refusal: a site is configured one terminal at a
        // time, and an empty zone is a normal intermediate state.
        const warning =
          gates.IN + gates.BOTH === 0 || gates.OUT + gates.BOTH === 0
            ? "This zone needs at least one entry and one exit terminal before passes can use it."
            : null;
        return { ...zone, gates, warning };
      }),
    });
  });

  app.post("/zones", { preHandler: requirePermission(Permission.DEVICE_CONFIGURE) }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    const { parentZoneId } = parsed.data;
    if (parentZoneId && !(await prisma.zone.findUnique({ where: { id: parentZoneId } }))) {
      return reply.code(404).send({ error: "parent zone not found" });
    }
    try {
      const zone = await prisma.zone.create({ data: defined(parsed.data) as Prisma.ZoneUncheckedCreateInput });
      await prisma.auditLog.create({
        data: auditRow({ action: AuditAction.ZONE_CREATED, entityType: "zone", entityId: zone.id, detail: parsed.data, actorId: actorId(request) }),
      });
      return reply.code(201).send(zone);
    } catch (err) { return conflict(reply, err); }
  });

  app.patch("/zones/:id", { preHandler: requirePermission(Permission.DEVICE_CONFIGURE) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: "validation" });
    }
    const zones = await prisma.zone.findMany({ select: { id: true, parentZoneId: true, name: true, isActive: true, exitCodeDefault: true } });
    const before = zones.find((z) => z.id === id);
    if (!before) return reply.code(404).send({ error: "zone not found" });
    const { parentZoneId } = parsed.data;
    if (parentZoneId !== undefined) {
      if (parentZoneId !== null && !zones.some((z) => z.id === parentZoneId)) {
        return reply.code(404).send({ error: "parent zone not found" });
      }
      if (wouldCreateCycle(zones, id, parentZoneId)) {
        return reply.code(400).send({ error: "a zone cannot sit inside itself or one of its own sub-zones" });
      }
    }
    try {
      const zone = await prisma.zone.update({ where: { id }, data: defined(parsed.data) as Prisma.ZoneUncheckedUpdateInput });
      await prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.ZONE_UPDATED,
          entityType: "zone",
          entityId: id,
          detail: { before, changes: parsed.data },
          actorId: actorId(request),
        }),
      });
      return reply.send(zone);
    } catch (err) { return conflict(reply, err); }
  });
}

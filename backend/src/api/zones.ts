import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { ACTIVE_ENTRY_STATES } from "../services/entries.js";
import { wouldCreateCycle } from "../services/zones.js";
import { actorId } from "./auth.js";
import { requirePermission } from "./permissions.js";

// Site zones (two-zone rebuild, Phase 1). Topology is gate configuration, so
// changing it needs the same permission as changing a terminal's role.

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  parentZoneId: z.string().min(1).nullable().optional(),
});
// No exit-code flag: which exits need the code is set on the pass type
// (F2 #10). An old client still sending `exitCodeDefault` has it stripped.
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  parentZoneId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
});

/** Live passes naming this zone. They keep the terminals they were given. */
function livePassesIn(zoneId: string) {
  return prisma.entry.count({ where: { zoneIds: { has: zoneId }, state: { in: [...ACTIVE_ENTRY_STATES] } } });
}

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
  app.get("/zones", { preHandler: requirePermission("zones:view") }, async (_request, reply) => {
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

  app.post("/zones", { preHandler: requirePermission("zones:create") }, async (request, reply) => {
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

  app.patch("/zones/:id", { preHandler: requirePermission("zones:update") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: "validation" });
    }
    const zones = await prisma.zone.findMany({ select: { id: true, parentZoneId: true, name: true, isActive: true } });
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
    // Deactivating hides a zone from new passes; one a live pass names stays
    // until those passes end, so nobody's access is changed underneath them.
    if (parsed.data.isActive === false && before.isActive) {
      const live = await livePassesIn(id);
      if (live > 0) return reply.code(409).send({ error: `${live} live pass(es) use this zone; deactivate it after they end` });
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

  // A zone may be deleted only if nothing ever used it: a typo. Anything used
  // is history (passes, requests, punches) and can only be deactivated.
  app.delete("/zones/:id", { preHandler: requirePermission("zones:delete") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const zone = await prisma.zone.findUnique({ where: { id } });
    if (!zone) return reply.code(404).send({ error: "zone not found" });
    const [children, devices, passes, requests, passTypes, punches] = await Promise.all([
      prisma.zone.count({ where: { parentZoneId: id } }),
      prisma.device.count({ where: { zoneId: id } }),
      prisma.entry.count({ where: { zoneIds: { has: id } } }),
      prisma.visitRequest.count({ where: { zoneIds: { has: id } } }),
      prisma.passType.count({ where: { exitCodeZoneIds: { has: id } } }),
      prisma.punchEvent.count({ where: { zoneId: id } }),
    ]);
    const used = [
      children && "zones inside it",
      devices && "terminals",
      passes && "passes",
      requests && "visit requests",
      passTypes && "pass types' exit-code settings",
      punches && "punches",
    ].filter(Boolean);
    if (used.length > 0) return reply.code(409).send({ error: `this zone has been used (${used.join(", ")}); deactivate it instead` });
    await prisma.$transaction([
      prisma.zone.delete({ where: { id } }),
      prisma.auditLog.create({ data: auditRow({ action: AuditAction.ZONE_DELETED, entityType: "zone", entityId: id, detail: { name: zone.name, parentZoneId: zone.parentZoneId }, actorId: actorId(request) }) }),
    ]);
    return reply.code(204).send();
  });
}

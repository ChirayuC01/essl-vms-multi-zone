import type { FastifyInstance } from "fastify";
import { CommandStatus, CommandType, Prisma } from "@prisma/client";
import { z } from "zod";
import { requeueCommand } from "../adms/queue.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { actorId } from "./auth.js";
import { requirePermission } from "./permissions.js";

// Command queue visibility (Milestone 4.5).
//
// This is the primary debugging surface for the whole product: when a person
// is not recognised at the barrier, the answer is almost always here — a
// command that never went out, or went out and came back with a non-zero
// return. Built as a first-class endpoint rather than an afterthought.

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  status: z.nativeEnum(CommandStatus).optional(),
  type: z.nativeEnum(CommandType).optional(),
  deviceId: z.string().min(1).optional(),
  personId: z.string().min(1).optional(),
  entryId: z.string().min(1).optional(),
  // The default view for an operator: everything not yet finished, plus
  // anything that failed.
  openOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

interface CommandRow {
  id: string;
  type: CommandType;
  status: CommandStatus;
  targetDeviceId: string;
  deviceCmdId: number | null;
  attempts: number;
  lastError: string | null;
  payload: Prisma.JsonValue;
  entryId: string | null;
  personId: string | null;
  initiatedById: string | null;
  createdAt: Date;
  sentAt: Date | null;
  completedAt: Date | null;
  device?: { serialNo: string; name: string | null } | undefined;
  person?: { name: string; esslUserId: string } | null | undefined;
}

function commandDto(c: CommandRow) {
  return {
    id: c.id,
    type: c.type,
    status: c.status,
    device: { id: c.targetDeviceId, serialNo: c.device?.serialNo ?? null, name: c.device?.name ?? null },
    // The protocol's own correlation id — the number sent as C:<id>: and
    // echoed back on devicecmd. Invaluable when reading device logs.
    deviceCmdId: c.deviceCmdId,
    attempts: c.attempts,
    lastError: c.lastError,
    // Small by construction: the photo push carries a path, never the JPEG.
    payload: c.payload,
    entryId: c.entryId,
    personId: c.personId,
    person: c.person ? { name: c.person.name, esslUserId: c.person.esslUserId } : null,
    // null = system-initiated (a scheduled job), not "unknown".
    initiatedById: c.initiatedById,
    createdAt: c.createdAt,
    sentAt: c.sentAt,
    completedAt: c.completedAt,
  };
}

const OPEN_STATUSES = [CommandStatus.PENDING, CommandStatus.SENT, CommandStatus.RETRY];

export async function commandRoutes(app: FastifyInstance): Promise<void> {
  app.get("/commands", { preHandler: requirePermission("commands:view") }, async (request, reply) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    const { page, pageSize, status, type, deviceId, personId, entryId, openOnly } = parsed.data;

    const where: Prisma.SyncCommandWhereInput = {};
    if (status) where.status = status;
    else if (openOnly) where.status = { in: [...OPEN_STATUSES, CommandStatus.FAILED] };
    if (type) where.type = type;
    if (deviceId) where.targetDeviceId = deviceId;
    if (personId) where.personId = personId;
    if (entryId) where.entryId = entryId;

    const [total, items] = await prisma.$transaction([
      prisma.syncCommand.count({ where }),
      prisma.syncCommand.findMany({
        where,
        // Newest first for a human; seq is the true order, not created_at.
        orderBy: { seq: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          device: { select: { serialNo: true, name: true } },
          person: { select: { name: true, esslUserId: true } },
        },
      }),
    ]);

    return reply.send({ total, page, pageSize, items: items.map(commandDto) });
  });

  app.get("/commands/:id", { preHandler: requirePermission("commands:view") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const command = await prisma.syncCommand.findUnique({
      where: { id },
      include: {
        device: { select: { serialNo: true, name: true } },
        person: { select: { name: true, esslUserId: true } },
      },
    });
    if (!command) return reply.code(404).send({ error: "command not found" });
    return reply.send(commandDto(command));
  });

  // ---- retry ---------------------------------------------------------------
  // Only FAILED commands: a PENDING one is already queued, and re-queueing a
  // SENT one would race the reply that is still on its way.
  app.post("/commands/:id/retry", { preHandler: requirePermission("commands:update") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const command = await prisma.syncCommand.findUnique({ where: { id } });
    if (!command) return reply.code(404).send({ error: "command not found" });
    if (command.status !== CommandStatus.FAILED) {
      return reply
        .code(409)
        .send({ error: `command is ${command.status} — only FAILED commands can be retried` });
    }

    const requeued = await requeueCommand(id);
    await prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.COMMAND_RETRIED,
        entityType: "sync_command",
        entityId: id,
        detail: { type: command.type, previousError: command.lastError },
        actorId: actorId(request),
      }),
    });
    request.log.info({ commandId: id, type: command.type }, "failed command requeued");
    return reply.send(commandDto(requeued));
  });
}

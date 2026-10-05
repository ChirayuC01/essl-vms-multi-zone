import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/index.js";
import { requirePermission } from "./permissions.js";
import { userIdKey } from "../user-id.js";

// Recent punch history. The SSE stream carries new punches live; this is what
// the feed loads first so a freshly opened page is not blank until someone
// walks through the barrier.

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  deviceId: z.string().min(1).optional(),
  esslUserId: z.string().trim().min(1).max(20).optional(),
});

export async function punchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/punches", { preHandler: requirePermission("punches:view") }, async (request, reply) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    const { page, pageSize, deviceId, esslUserId } = parsed.data;

    const where: Prisma.PunchEventWhereInput = {};
    if (deviceId) where.deviceId = deviceId;
    if (esslUserId) where.esslUserId = { equals: esslUserId, mode: "insensitive" };

    const [total, items] = await prisma.$transaction([
      prisma.punchEvent.count({ where }),
      prisma.punchEvent.findMany({
        where,
        orderBy: { punchedAtUtc: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { device: { select: { serialNo: true, name: true } } },
      }),
    ]);

    // esslUserId is not a foreign key — punches must ingest even for a PIN no
    // person claims — so names are resolved with one extra batched query
    // rather than a join, and a punch with no match is shown as unknown.
    const people = await prisma.person.findMany({
      where: {
        // OR of case-insensitive equals: Prisma has no case-insensitive `in`,
        // and `wctpl070` on the wire must still find `WCTPL070` in the table.
        // Bounded by pageSize (max 200), so still one query for the page.
        OR: [...new Set(items.map((p) => userIdKey(p.esslUserId)))].map((id) => ({
          esslUserId: { equals: id, mode: "insensitive" as const },
        })),
      },
      select: { id: true, name: true, esslUserId: true },
    });
    const byPin = new Map(people.map((v) => [userIdKey(v.esslUserId), v]));

    return reply.send({
      total,
      page,
      pageSize,
      items: items.map((p) => {
        const person = byPin.get(userIdKey(p.esslUserId));
        return {
          id: p.id,
          esslUserId: p.esslUserId,
          deviceId: p.deviceId,
          deviceSerialNo: p.device.serialNo,
          deviceName: p.device.name,
          // Both timestamps: the device reports local time, and keeping the
          // original alongside the normalised one makes timezone bugs
          // debuggable instead of mysterious.
          punchedAtUtc: p.punchedAtUtc,
          punchedAtDevice: p.punchedAtDevice,
          receivedAt: p.createdAt,
          verifyMode: p.verifyMode,
          statusCode: p.statusCode,
          processed: p.processed,
          person: person ? { id: person.id, name: person.name } : null,
        };
      }),
    });
  });
}

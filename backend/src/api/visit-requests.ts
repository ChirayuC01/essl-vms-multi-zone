import { readFile } from "node:fs/promises";
import { EntryMode, VisitOrigin, VisitRequestStatus, type Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { ServiceError } from "../services/errors.js";
import { cancelVisitRequest, createVisitRequest, maskSubmission, missingDetails, requestById, resendLink } from "../services/visit-requests.js";
import { clearRequest, queryRequest, rejectRequest } from "../services/visit-review.js";
import { context, visitorStepRoutes } from "./portal.js";
import { actorId } from "./auth.js";
import { mobileNumber } from "./people.js";
import { hasPermission, requireAnyPermission, requirePermission } from "./permissions.js";

// Visit requests, operator side (two-zone rebuild, Phase 5). A host sees and
// acts on their own requests; an operator who can see passes sees everyone's.
// Clear / Query / Reject (Phase 6) are the host's own: only the host named on
// the request decides it. Walk-ins (Phase 6) are registered by Security at the
// gate under /walk-ins, reusing the portal's steps with Security as the actor.

const createSchema = z.object({
  visitorName: z.string().trim().min(1).max(100),
  visitorMobile: mobileNumber,
  visitorEmail: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
  companyId: z.string().min(1).nullable().optional(),
  purpose: z.string().trim().min(1).max(300),
  passTypeId: z.string().min(1),
  zoneIds: z.array(z.string().min(1)).min(1).max(20),
  exitCodeZoneIds: z.array(z.string().min(1)).max(20).optional(),
  entryMode: z.nativeEnum(EntryMode),
  expectedAt: z.coerce.date(),
  validUntil: z.coerce.date(),
});

const listSchema = z.object({
  status: z.nativeEnum(VisitRequestStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

async function seesAll(request: FastifyRequest) {
  return hasPermission(request, "passes:view");
}

/** The request, if this operator may see it. */
async function visible(request: FastifyRequest, id: string) {
  const visit = await prisma.visitRequest.findUnique({ where: { id } });
  if (!visit || (visit.hostId !== actorId(request) && !(await seesAll(request)))) throw new ServiceError(404, "visit request not found");
  return visit;
}

export async function visitRequestRoutes(app: FastifyInstance): Promise<void> {
  app.post("/visit-requests", { preHandler: requirePermission("visit_requests:create") }, async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "validation", issues: body.error.issues });
    const visit = await createVisitRequest(body.data, actorId(request)!);
    return reply.code(201).send({ id: visit.id, status: visit.status });
  });

  // What the request, review and walk-in forms offer. Its own route because a
  // host holds no pass-type, zone or directory permissions, and needs only names.
  app.get("/visit-requests/options", { preHandler: requireAnyPermission("visit_requests:create", "visit_requests:update", "walkins:create") }, async (_request, reply) => {
    const [passTypes, zones, companies, departments, hosts] = await prisma.$transaction([
      prisma.passType.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, entryModes: true, maxValidityDays: true } }),
      prisma.zone.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, parentZoneId: true, exitCodeDefault: true } }),
      prisma.company.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
      prisma.department.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
      prisma.appUser.findMany({ where: { isActive: true }, orderBy: [{ name: "asc" }, { email: "asc" }], select: { id: true, name: true, email: true } }),
    ]);
    return reply.send({ passTypes, zones, companies, departments, hosts });
  });

  app.get("/visit-requests", { preHandler: requirePermission("visit_requests:view") }, async (request, reply) => {
    const query = listSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "validation", issues: query.error.issues });
    const { status, page, pageSize } = query.data;
    const where: Prisma.VisitRequestWhereInput = {
      ...(status ? { status } : {}),
      ...((await seesAll(request)) ? {} : { hostId: actorId(request)! }),
    };
    const [total, items] = await prisma.$transaction([
      prisma.visitRequest.count({ where }),
      prisma.visitRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { host: { select: { id: true, name: true, email: true } } },
      }),
    ]);
    const typeIds = [...new Set(items.map((v) => v.passTypeId).filter((t): t is string => Boolean(t)))];
    const typeName = new Map((await prisma.passType.findMany({ where: { id: { in: typeIds } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    return reply.send({
      total,
      items: items.map((v) => ({
        id: v.id,
        status: v.status,
        origin: v.origin,
        visitorName: v.visitorName,
        visitorMobile: v.visitorMobile,
        companyName: v.companyName,
        purpose: v.purpose,
        passTypeName: v.passTypeId ? typeName.get(v.passTypeId) ?? null : null,
        entryMode: v.entryMode,
        expectedAt: v.expectedAt,
        validUntil: v.validUntil,
        host: v.host,
        returning: Boolean(v.personId),
        createdAt: v.createdAt,
      })),
    });
  });

  app.get("/visit-requests/:id", { preHandler: requirePermission("visit_requests:view") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await visible(request, id);
    const v = await prisma.visitRequest.findUniqueOrThrow({
      where: { id },
      include: {
        host: { select: { id: true, name: true, email: true } },
        events: { orderBy: { createdAt: "asc" } },
        documents: { where: { removedAt: null }, orderBy: { createdAt: "asc" } },
        consents: { orderBy: { acceptedAt: "asc" } },
        tokens: { orderBy: { createdAt: "desc" }, take: 1, select: { expiresAt: true, revokedAt: true, createdAt: true } },
      },
    });
    const actorIds = [...new Set(v.events.map((e) => e.actorId).filter((a): a is string => Boolean(a)))];
    const [actors, zones, passType] = await Promise.all([
      prisma.appUser.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } }),
      prisma.zone.findMany({ where: { id: { in: v.zoneIds } }, select: { id: true, name: true } }),
      v.passTypeId ? prisma.passType.findUnique({ where: { id: v.passTypeId }, select: { id: true, name: true } }) : null,
    ]);
    const actorName = new Map(actors.map((a) => [a.id, a.name || a.email]));
    return reply.send({
      id: v.id,
      status: v.status,
      origin: v.origin,
      visitorName: v.visitorName,
      visitorMobile: v.visitorMobile,
      visitorEmail: v.visitorEmail,
      companyName: v.companyName,
      purpose: v.purpose,
      passType,
      zones,
      exitCodeZoneIds: v.exitCodeZoneIds,
      entryMode: v.entryMode,
      expectedAt: v.expectedAt,
      validUntil: v.validUntil,
      host: v.host,
      personId: v.personId,
      mobileVerifiedAt: v.mobileVerifiedAt,
      consents: v.consents.map((c) => ({ noticeVersion: c.noticeVersion, acceptedAt: c.acceptedAt, ipAddress: c.ipAddress })),
      details: maskSubmission(v.submission),
      missing: await missingDetails(v),
      hasSelfie: Boolean(v.selfiePath),
      documents: v.documents.map((d) => ({ id: d.id, kind: d.kind, fileName: d.fileName, mime: d.mime, sizeBytes: d.sizeBytes, createdAt: d.createdAt })),
      link: v.tokens[0] ?? null,
      pass: v.passId ? await prisma.entry.findUnique({ where: { id: v.passId }, select: { id: true, state: true, zoneIds: true, person: { select: { esslUserId: true } } } }) : null,
      canReview: (await hasPermission(request, "visit_requests:update")) && (v.hostId === actorId(request) || (await hasPermission(request, "visit_requests_all:update"))),
      companyId: v.companyId,
      queryText: v.queryText,
      events: v.events.map((e) => ({ ...e, actorName: e.actorId ? actorName.get(e.actorId) ?? null : null })),
      createdAt: v.createdAt,
    });
  });

  app.post("/visit-requests/:id/resend", { preHandler: requirePermission("visit_requests:create") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await visible(request, id);
    return reply.send(await resendLink(id, actorId(request)!));
  });

  app.post("/visit-requests/:id/cancel", { preHandler: requirePermission("visit_requests:create") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "a reason is required" });
    await visible(request, id);
    await cancelVisitRequest(id, body.data.reason, actorId(request)!);
    return reply.send({ cancelled: true });
  });

  // ---- host review (Phase 6) ----------------------------------------------
  const review = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const v = await visible(request, id);
    if (v.hostId !== actorId(request) && !(await hasPermission(request, "visit_requests_all:update"))) {
      throw new ServiceError(403, "only the visitor's host can decide this request");
    }
    return id;
  };
  app.post("/visit-requests/:id/clear", { preHandler: requirePermission("visit_requests:update") }, async (request, reply) => {
    const body = z.object({ companyId: z.string().min(1).nullable().optional(), departmentId: z.string().min(1).nullable().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "validation", issues: body.error.issues });
    const id = await review(request);
    return reply.send(await clearRequest(id, actorId(request)!, { companyId: body.data.companyId, departmentId: body.data.departmentId }));
  });
  app.post("/visit-requests/:id/query", { preHandler: requirePermission("visit_requests:update") }, async (request, reply) => {
    const body = z.object({ text: z.string().trim().min(3).max(500) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "write what the visitor needs to change" });
    const id = await review(request);
    await queryRequest(id, actorId(request)!, body.data.text);
    return reply.send({ queried: true });
  });
  app.post("/visit-requests/:id/reject", { preHandler: requirePermission("visit_requests:update") }, async (request, reply) => {
    const body = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "a reason is required" });
    const id = await review(request);
    await rejectRequest(id, actorId(request)!, body.data.reason);
    return reply.send({ rejected: true });
  });

  app.get("/visit-requests/:id/selfie", { preHandler: requirePermission("visit_requests:view") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const v = await visible(request, id);
    const bytes = v.selfiePath ? await readFile(v.selfiePath).catch(() => null) : null;
    if (!bytes) return reply.code(404).send({ error: "no photo yet" });
    return reply.header("Content-Type", "image/jpeg").header("Cache-Control", "no-store").send(bytes);
  });

  // Same rules as person documents: always a download, never rendered.
  app.get("/visit-requests/:id/documents/:docId/file", { preHandler: requirePermission("visit_requests:view") }, async (request, reply) => {
    const { id, docId } = request.params as { id: string; docId: string };
    await visible(request, id);
    const doc = await prisma.personDocument.findFirst({ where: { id: docId, visitRequestId: id, removedAt: null } });
    if (!doc) return reply.code(404).send({ error: "document not found" });
    const bytes = await readFile(doc.storedPath).catch(() => null);
    if (!bytes) return reply.code(410).send({ error: "document file is missing from disk" });
    await prisma.auditLog.create({
      data: auditRow({ action: AuditAction.DOCUMENT_DOWNLOADED, entityType: "visit_request", entityId: id, detail: { documentId: doc.id, kind: doc.kind }, actorId: actorId(request) }),
    });
    return reply
      .header("Content-Type", doc.mime)
      .header("Content-Disposition", `attachment; filename="${doc.fileName}"`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .header("Cache-Control", "no-store")
      .send(bytes);
  });

  // ---- walk-ins (Security, Phase 6) -----------------------------------------
  app.post("/walk-ins", { preHandler: requirePermission("walkins:create") }, async (request, reply) => {
    const body = createSchema.extend({ hostId: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "validation", issues: body.error.issues });
    const { hostId, ...input } = body.data;
    const visit = await createVisitRequest(input, hostId, { actorId: actorId(request)!, origin: VisitOrigin.WALK_IN });
    return reply.code(201).send({ id: visit.id, status: visit.status });
  });
  app.get("/walk-ins", { preHandler: requirePermission("walkins:create") }, async (_request, reply) => {
    const items = await prisma.visitRequest.findMany({
      where: { origin: VisitOrigin.WALK_IN, createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { host: { select: { id: true, name: true, email: true } } },
    });
    return reply.send({
      items: items.map((v) => ({ id: v.id, status: v.status, visitorName: v.visitorName, visitorMobile: v.visitorMobile, expectedAt: v.expectedAt, host: v.host, passId: v.passId, createdAt: v.createdAt })),
    });
  });
  await app.register(async (desk) => {
    desk.addHook("preHandler", requirePermission("walkins:create"));
    visitorStepRoutes(
      desk,
      "/walk-ins/:id",
      async (request) => {
        const v = await requestById((request.params as { id: string }).id);
        if (v.origin !== VisitOrigin.WALK_IN) throw new ServiceError(404, "walk-in not found");
        return v;
      },
      (request) => ({ ...context(request), actorId: actorId(request) }),
    );
  });

  // The outbox: every message sent. With the console transport this is how
  // links and codes are read during testing.
  app.get("/messages", { preHandler: requirePermission("messages:view") }, async (request, reply) => {
    const query = z
      .object({ relatedId: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "validation", issues: query.error.issues });
    const where = query.data.relatedId ? { relatedId: query.data.relatedId } : {};
    const [total, items] = await prisma.$transaction([
      prisma.message.count({ where }),
      prisma.message.findMany({ where, orderBy: { createdAt: "desc" }, skip: (query.data.page - 1) * query.data.pageSize, take: query.data.pageSize }),
    ]);
    return reply.send({ total, items });
  });
}

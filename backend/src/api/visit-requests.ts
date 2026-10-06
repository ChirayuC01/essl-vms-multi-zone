import { readFile } from "node:fs/promises";
import { EntryMode, VisitRequestStatus, type Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { ServiceError } from "../services/errors.js";
import { cancelVisitRequest, createVisitRequest, maskSubmission, missingDetails, resendLink } from "../services/visit-requests.js";
import { actorId } from "./auth.js";
import { mobileNumber } from "./people.js";
import { hasPermission, requirePermission } from "./permissions.js";

// Visit requests, operator side (two-zone rebuild, Phase 5). A host sees and
// acts on their own requests; an operator who can see passes sees everyone's.
// Clear / Query / Reject are Phase 6.

const createSchema = z.object({
  visitorName: z.string().trim().min(1).max(100),
  visitorMobile: mobileNumber,
  visitorEmail: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
  companyName: z.string().trim().max(100).transform((v) => v || null).nullable().optional(),
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

  // What the request form offers. Its own route because a host holds no
  // pass-type or zone permissions, and needs only names.
  app.get("/visit-requests/options", { preHandler: requirePermission("visit_requests:create") }, async (_request, reply) => {
    const [passTypes, zones] = await prisma.$transaction([
      prisma.passType.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, entryModes: true, maxValidityDays: true } }),
      prisma.zone.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, parentZoneId: true, exitCodeDefault: true } }),
    ]);
    return reply.send({ passTypes, zones });
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

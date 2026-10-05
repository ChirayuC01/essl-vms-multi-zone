import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config/index.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { DOCUMENT_SIGNATURES, detectDocumentType, safeFileName } from "../services/documents.js";
import { getSettings } from "../services/settings.js";
import { actorId } from "./auth.js";
import { requirePermission } from "./permissions.js";

// Person documents (two-zone rebuild, Phase 3). Files stay on local disk
// (CLAUDE.md #4); every upload, download and removal is audited against the
// person. Removal hides a document but keeps the file: records are never
// deleted.

const uploadQuery = z.object({
  kind: z.string().trim().min(1).max(60),
  fileName: z.string().max(200).optional(),
});

function documentDto(d: { id: string; kind: string; fileName: string; mime: string; sizeBytes: number; source: string; createdAt: Date; uploadedById: string | null }) {
  return { id: d.id, kind: d.kind, fileName: d.fileName, mime: d.mime, sizeBytes: d.sizeBytes, source: d.source, uploadedById: d.uploadedById, createdAt: d.createdAt };
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/people/:id/documents", { preHandler: requirePermission("documents:view") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const items = await prisma.personDocument.findMany({ where: { personId: id, removedAt: null }, orderBy: { createdAt: "desc" } });
    return reply.send({ items: items.map(documentDto) });
  });

  // Raw body, like photo upload: ?kind=Govt%20ID&fileName=card.pdf
  app.post("/people/:id/documents", { preHandler: requirePermission("documents:create") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = uploadQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "kind is required (e.g. Govt ID, Vehicle papers)" });
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: "send the file as the request body" });

    const settings = await getSettings();
    if (settings.documentMaxCount === 0) return reply.code(409).send({ error: "document uploads are switched off" });
    if (body.length > settings.documentMaxMb * 1024 * 1024) {
      return reply.code(413).send({ error: `document exceeds ${settings.documentMaxMb} MB` });
    }
    const type = detectDocumentType(body, settings.documentTypes);
    if (!type) {
      return reply.code(415).send({ error: `only ${settings.documentTypes.map((t) => t.toUpperCase()).join(", ")} documents are accepted` });
    }
    const person = await prisma.person.findUnique({ where: { id }, select: { id: true } });
    if (!person) return reply.code(404).send({ error: "person not found" });
    const held = await prisma.personDocument.count({ where: { personId: id, removedAt: null } });
    if (held >= settings.documentMaxCount) {
      return reply.code(409).send({ error: `a person may hold at most ${settings.documentMaxCount} documents; remove one first` });
    }

    // Stored under a generated name: the uploader's name never reaches the
    // filesystem.
    const sig = DOCUMENT_SIGNATURES[type];
    const docId = randomUUID();
    const dir = path.join(config.documentStoragePath, id);
    const storedPath = path.join(dir, `${docId}.${sig.ext}`);
    await mkdir(dir, { recursive: true });
    await writeFile(storedPath, body);

    const doc = await prisma.personDocument.create({
      data: {
        personId: id,
        kind: query.data.kind,
        fileName: safeFileName(query.data.fileName, sig.ext),
        mime: sig.mime,
        sizeBytes: body.length,
        storedPath,
        uploadedById: actorId(request) ?? null,
      },
    });
    await prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.DOCUMENT_UPLOADED,
        entityType: "person",
        entityId: id,
        detail: { documentId: doc.id, kind: doc.kind, fileName: doc.fileName, mime: doc.mime, sizeBytes: doc.sizeBytes },
        actorId: actorId(request),
      }),
    });
    return reply.code(201).send(documentDto(doc));
  });

  // Always a download, never rendered: attachment + nosniff + a sandboxing
  // CSP, so even a file that slipped past detection cannot run in the console.
  app.get("/people/:id/documents/:docId/file", { preHandler: requirePermission("documents:view") }, async (request, reply) => {
    const { id, docId } = request.params as { id: string; docId: string };
    const doc = await prisma.personDocument.findFirst({ where: { id: docId, personId: id, removedAt: null } });
    if (!doc) return reply.code(404).send({ error: "document not found" });
    const bytes = await readFile(doc.storedPath).catch(() => null);
    if (!bytes) return reply.code(410).send({ error: "document file is missing from disk" });
    await prisma.auditLog.create({
      data: auditRow({ action: AuditAction.DOCUMENT_DOWNLOADED, entityType: "person", entityId: id, detail: { documentId: doc.id, kind: doc.kind }, actorId: actorId(request) }),
    });
    return reply
      .header("Content-Type", doc.mime)
      .header("Content-Disposition", `attachment; filename="${doc.fileName}"`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .header("Cache-Control", "no-store")
      .send(bytes);
  });

  app.delete("/people/:id/documents/:docId", { preHandler: requirePermission("documents:delete") }, async (request, reply) => {
    const { id, docId } = request.params as { id: string; docId: string };
    const removed = await prisma.personDocument.updateMany({
      where: { id: docId, personId: id, removedAt: null },
      data: { removedAt: new Date(), removedById: actorId(request) ?? null },
    });
    if (removed.count === 0) return reply.code(404).send({ error: "document not found" });
    await prisma.auditLog.create({
      data: auditRow({ action: AuditAction.DOCUMENT_REMOVED, entityType: "person", entityId: id, detail: { documentId: docId }, actorId: actorId(request) }),
    });
    return reply.send({ removed: true });
  });
}

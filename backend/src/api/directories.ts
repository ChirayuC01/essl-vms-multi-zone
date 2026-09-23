import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { actorId } from "./auth.js";
import { Permission, requirePermission } from "./permissions.js";
import { prisma } from "../db/index.js";

const nameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});
const bulkSchema = z.object({ personIds: z.array(z.string().min(1)).min(1).max(1000) });

function conflict(reply: FastifyReply, err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return reply.code(409).send({ error: "a directory item with that name already exists" });
  }
  throw err;
}

export async function directoryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/companies", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    return reply.send({ items: await prisma.company.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] }) });
  });
  app.get("/departments", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    return reply.send({ items: await prisma.department.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] }) });
  });

  app.post("/companies", { preHandler: requirePermission(Permission.DIRECTORY_MANAGE) }, async (request, reply) => {
    const parsed = nameSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    try {
      const item = await prisma.company.create({ data: parsed.data });
      await prisma.auditLog.create({ data: { action: "COMPANY_CREATED", entityType: "company", entityId: item.id, detail: { name: item.name }, actorId: actorId(request) ?? null } });
      return reply.code(201).send(item);
    } catch (err) { return conflict(reply, err); }
  });
  app.post("/departments", { preHandler: requirePermission(Permission.DIRECTORY_MANAGE) }, async (request, reply) => {
    const parsed = nameSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    try {
      const item = await prisma.department.create({ data: parsed.data });
      await prisma.auditLog.create({ data: { action: "DEPARTMENT_CREATED", entityType: "department", entityId: item.id, detail: { name: item.name }, actorId: actorId(request) ?? null } });
      return reply.code(201).send(item);
    } catch (err) { return conflict(reply, err); }
  });

  app.patch("/companies/:id", { preHandler: requirePermission(Permission.DIRECTORY_DEACTIVATE) }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: "validation" });
    const data: Prisma.CompanyUpdateInput = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
    try { return reply.send(await prisma.company.update({ where: { id: (request.params as { id: string }).id }, data })); }
    catch (err) { return conflict(reply, err); }
  });
  app.patch("/departments/:id", { preHandler: requirePermission(Permission.DIRECTORY_DEACTIVATE) }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: "validation" });
    const data: Prisma.DepartmentUpdateInput = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
    try { return reply.send(await prisma.department.update({ where: { id: (request.params as { id: string }).id }, data })); }
    catch (err) { return conflict(reply, err); }
  });

  app.post("/companies/:id/people", { preHandler: requirePermission(Permission.DIRECTORY_MANAGE) }, async (request, reply) => {
    const parsed = bulkSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    const id = (request.params as { id: string }).id;
    if (!(await prisma.company.findFirst({ where: { id, isActive: true } }))) return reply.code(404).send({ error: "active company not found" });
    const result = await prisma.person.updateMany({ where: { id: { in: parsed.data.personIds } }, data: { companyId: id } });
    return reply.send({ assigned: result.count });
  });
  app.post("/departments/:id/people", { preHandler: requirePermission(Permission.DIRECTORY_MANAGE) }, async (request, reply) => {
    const parsed = bulkSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    const id = (request.params as { id: string }).id;
    if (!(await prisma.department.findFirst({ where: { id, isActive: true } }))) return reply.code(404).send({ error: "active department not found" });
    const result = await prisma.person.updateMany({ where: { id: { in: parsed.data.personIds } }, data: { departmentId: id } });
    return reply.send({ assigned: result.count });
  });
}

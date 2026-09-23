import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorId } from "./auth.js";
import { Permission, requirePermission } from "./permissions.js";
import {
  assignEmployeeDevices,
  listEmployeeDevices,
  removeEmployeeDevice,
  rehireEmployee,
  resignEmployee,
} from "../services/employee-access.js";

const assignSchema = z.object({ deviceIds: z.array(z.string().min(1)).min(1).max(50) });
const removeSchema = z.object({ reason: z.string().trim().max(500).optional() });

export async function employeeAccessRoutes(app: FastifyInstance): Promise<void> {
  app.get("/people/:id/device-access", { preHandler: requirePermission(Permission.READ) }, async (request, reply) => {
    return reply.send({ items: await listEmployeeDevices((request.params as { id: string }).id) });
  });
  app.post("/people/:id/device-access", { preHandler: requirePermission(Permission.EMPLOYEE_ACCESS_MANAGE) }, async (request, reply) => {
    const parsed = assignSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    const items = await assignEmployeeDevices((request.params as { id: string }).id, parsed.data.deviceIds, actorId(request));
    return reply.code(202).send({ items });
  });
  app.delete("/people/:id/device-access/:deviceId", { preHandler: requirePermission(Permission.EMPLOYEE_ACCESS_MANAGE) }, async (request, reply) => {
    const parsed = removeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    const { id, deviceId } = request.params as { id: string; deviceId: string };
    return reply.code(202).send(await removeEmployeeDevice(id, deviceId, actorId(request), parsed.data.reason));
  });
  app.post("/people/:id/device-access/:deviceId/restore", { preHandler: requirePermission(Permission.EMPLOYEE_ACCESS_MANAGE) }, async (request, reply) => {
    const { id, deviceId } = request.params as { id: string; deviceId: string };
    const items = await assignEmployeeDevices(id, [deviceId], actorId(request));
    return reply.code(202).send({ items });
  });
  app.post("/people/:id/resign", { preHandler: requirePermission(Permission.EMPLOYEE_ACCESS_MANAGE) }, async (request, reply) => {
    const parsed = removeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    return reply.code(202).send(await resignEmployee((request.params as { id: string }).id, actorId(request), parsed.data.reason));
  });
  app.post("/people/:id/rehire", { preHandler: requirePermission(Permission.EMPLOYEE_ACCESS_MANAGE) }, async (request, reply) => {
    const parsed = assignSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    return reply.code(202).send(await rehireEmployee((request.params as { id: string }).id, parsed.data.deviceIds, actorId(request)));
  });
}

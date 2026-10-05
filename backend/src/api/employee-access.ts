import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ServiceError } from "../services/errors.js";
import { actorId } from "./auth.js";
import { requirePermission } from "./permissions.js";
import {
  assignEmployeeDevices,
  listEmployeeDevices,
  removeEmployeeDevice,
  rehireEmployee,
  resignEmployee,
} from "../services/employee-access.js";
import { zoneDevices } from "../services/zones.js";

// Access can be granted by terminal or by zone. A zone expands to its own and
// its ancestors' terminals at the moment of assignment; the stored grant stays
// per device, so reconciliation and removal work exactly as before.
const assignSchema = z
  .object({
    deviceIds: z.array(z.string().min(1)).max(50).optional(),
    zoneIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .refine((b) => (b.deviceIds?.length ?? 0) + (b.zoneIds?.length ?? 0) > 0, "select at least one device or zone");

async function resolveDeviceIds(body: z.infer<typeof assignSchema>): Promise<string[]> {
  const fromZones = body.zoneIds?.length ? (await zoneDevices(body.zoneIds)).map((d) => d.id) : [];
  const ids = [...new Set([...(body.deviceIds ?? []), ...fromZones])];
  if (ids.length === 0) throw new ServiceError(409, "the selected zones have no terminals placed in them yet");
  return ids;
}
const removeSchema = z.object({ reason: z.string().trim().max(500).optional() });

export async function employeeAccessRoutes(app: FastifyInstance): Promise<void> {
  app.get("/people/:id/device-access", { preHandler: requirePermission("people:view") }, async (request, reply) => {
    return reply.send({ items: await listEmployeeDevices((request.params as { id: string }).id) });
  });
  app.post("/people/:id/device-access", { preHandler: requirePermission("employee_access:create") }, async (request, reply) => {
    const parsed = assignSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    const items = await assignEmployeeDevices((request.params as { id: string }).id, await resolveDeviceIds(parsed.data), actorId(request));
    return reply.code(202).send({ items });
  });
  app.delete("/people/:id/device-access/:deviceId", { preHandler: requirePermission("employee_access:delete") }, async (request, reply) => {
    const parsed = removeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    const { id, deviceId } = request.params as { id: string; deviceId: string };
    return reply.code(202).send(await removeEmployeeDevice(id, deviceId, actorId(request), parsed.data.reason));
  });
  app.post("/people/:id/device-access/:deviceId/restore", { preHandler: requirePermission("employee_access:create") }, async (request, reply) => {
    const { id, deviceId } = request.params as { id: string; deviceId: string };
    const items = await assignEmployeeDevices(id, [deviceId], actorId(request));
    return reply.code(202).send({ items });
  });
  app.post("/people/:id/resign", { preHandler: requirePermission("employee_access:delete") }, async (request, reply) => {
    const parsed = removeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    return reply.code(202).send(await resignEmployee((request.params as { id: string }).id, actorId(request), parsed.data.reason));
  });
  app.post("/people/:id/rehire", { preHandler: requirePermission("employee_access:create") }, async (request, reply) => {
    const parsed = assignSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    return reply.code(202).send(await rehireEmployee((request.params as { id: string }).id, await resolveDeviceIds(parsed.data), actorId(request)));
  });
}

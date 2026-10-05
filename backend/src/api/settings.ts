import type { FastifyInstance } from "fastify";
import { getSettings, updateSettings } from "../services/settings.js";
import { actorId } from "./auth.js";
import { requirePermission } from "./permissions.js";

// Site settings (two-zone rebuild, Phase 2). Read by anyone who can read the
// console; changed only by an Admin, and every change is audited old -> new.
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings", { preHandler: requirePermission("settings:view") }, async (_request, reply) => {
    return reply.send(await getSettings());
  });
  app.patch("/settings", { preHandler: requirePermission("settings:update") }, async (request, reply) => {
    return reply.send(await updateSettings(request.body, actorId(request)));
  });
}

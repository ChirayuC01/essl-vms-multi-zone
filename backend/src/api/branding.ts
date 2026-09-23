import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getBranding, readBrandingLogo, saveBrandingLogo, setOrganizationName } from "../services/branding.js";
import { actorId } from "./auth.js";
import { Permission, requirePermission } from "./permissions.js";

export async function brandingPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get("/branding", async (_request, reply) => reply.send(await getBranding()));
  app.get("/branding/logo", async (_request, reply) => {
    const logo = await readBrandingLogo();
    if (!logo) return reply.code(404).send({ error: "logo not configured" });
    return reply.type(logo.contentType).header("Cache-Control", "public, max-age=300").send(logo.bytes);
  });
}

const nameSchema = z.object({ organizationName: z.string().trim().min(1).max(120) });

export async function brandingAdminRoutes(app: FastifyInstance): Promise<void> {
  app.put("/branding", { preHandler: requirePermission(Permission.BRANDING_MANAGE) }, async (request, reply) => {
    const parsed = nameSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    return reply.send(await setOrganizationName(parsed.data.organizationName, actorId(request)));
  });
  app.put("/branding/logo", { preHandler: requirePermission(Permission.BRANDING_MANAGE) }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "send the raw image body" });
    return reply.send(await saveBrandingLogo(request.body, actorId(request)));
  });
}

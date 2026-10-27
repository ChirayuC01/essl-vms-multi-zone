import { MessageChannel } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getBranding } from "../services/branding.js";
import { ServiceError } from "../services/errors.js";
import { sendMessage } from "../services/notify.js";
import { getSettings, publicSettings, updateSettings } from "../services/settings.js";
import { actorId } from "./auth.js";
import { requirePermission } from "./permissions.js";

// Site settings (two-zone rebuild, Phase 2). Read by anyone who can read the
// console; changed only by an Admin, and every change is audited old -> new.
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings", { preHandler: requirePermission("settings:view") }, async (_request, reply) => {
    return reply.send(publicSettings(await getSettings()));
  });
  app.patch("/settings", { preHandler: requirePermission("settings:update") }, async (request, reply) => {
    return reply.send(publicSettings(await updateSettings(request.body, actorId(request))));
  });
  // Proves the saved SMS or email settings by sending the OTP template with a
  // dummy code. The attempt lands on the Outbox page like any other message.
  app.post("/settings/test-message", { preHandler: requirePermission("settings:update") }, async (request, reply) => {
    const body = z.object({ channel: z.nativeEnum(MessageChannel), to: z.string().trim().min(5).max(200) }).safeParse(request.body);
    if (!body.success) throw new ServiceError(400, "give a mobile number or email address to send the test to");
    const [{ organizationName }, settings] = await Promise.all([getBranding(), getSettings()]);
    const sent = await sendMessage({ ...body.data, template: "MOBILE_OTP", vars: ["123456", organizationName, String(settings.otpTtlMinutes)], related: { type: "settings_test", id: actorId(request) ?? "" } }, request.log);
    if (!sent) throw new ServiceError(409, "email is turned off — turn it on and save first");
    return reply.send({ status: sent.status, error: sent.error, transport: sent.transport });
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { getLicenseStatus, installLicenseKey } from "../services/license.js";
import { actorId } from "./auth.js";
import { Permission, requirePermission } from "./permissions.js";

// License status and installation remain available after expiry so an admin
// can renew without touching the device-facing ADMS service.

const installSchema = z.object({
  licenseKey: z.string().trim().min(1).max(4000),
});

export function publicLicenseStatus(status: Awaited<ReturnType<typeof getLicenseStatus>>) {
  const { installationId: _installationId, machineId: _machineId, ...publicStatus } = status;
  return publicStatus;
}

export async function licenseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/license", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    return reply.send(publicLicenseStatus(await getLicenseStatus()));
  });

  app.post("/license", { preHandler: requirePermission(Permission.LICENSE_MANAGE) }, async (request, reply) => {
    const parsed = installSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }

    const status = await installLicenseKey(parsed.data.licenseKey);

    await prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.LICENSE_INSTALLED,
        entityType: "license",
        entityId: "current-license",
        detail: { plan: status.plan, expiresAt: status.expiresAt },
        actorId: actorId(request),
      }),
    });
    request.log.warn(
      { plan: status.plan, expiresAt: status.expiresAt, by: request.operator?.email },
      "license key installed",
    );
    return reply.send(publicLicenseStatus(status));
  });
}

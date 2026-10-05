import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ADMIN_ROLE } from "../services/access.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { hashPassword } from "./auth.js";
import { password } from "./operators.js";
import { saveBrandingLogo, setOrganizationName, validateBrandingLogo } from "../services/branding.js";
import { startTrial } from "../services/license.js";

// First-run setup (Phase 6 task 4).
//
// Every other operator route requires an authenticated ADMIN — including
// creating a new operator (operators.ts POST /operators). On a brand-new
// database there is no admin to authenticate as, so this is the one place
// in the API that is deliberately reachable without a token, and it closes
// itself the moment it has done its job: once any AppUser row exists,
// POST /setup/admin refuses forever after.

const createAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password,
  organizationName: z.string().trim().min(1).max(120),
  logoBase64: z.string().max(3_000_000).optional(),
});

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/setup/status", async (_request, reply) => {
    const count = await prisma.appUser.count();
    return reply.send({ needsSetup: count === 0 });
  });

  app.post("/setup/admin", async (request, reply) => {
    const parsed = createAdminSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const { email, password: rawPassword, organizationName, logoBase64 } = parsed.data;
    const logoBytes = logoBase64 ? Buffer.from(logoBase64, "base64") : null;
    if (logoBytes) validateBrandingLogo(logoBytes);

    try {
      const created = await prisma.$transaction(async (tx) => {
        // Re-checked here, not just by the caller's earlier GET /setup/status
        // — the count must still be zero at the moment of insert, not merely
        // when the page loaded.
        const existing = await tx.appUser.count();
        if (existing > 0) {
          throw new Error("SETUP_ALREADY_DONE");
        }
        return tx.appUser.create({
          data: {
            email,
            role: ADMIN_ROLE,
            passwordHash: hashPassword(rawPassword),
            // Nobody else knows this password — the operator just chose it
            // themselves — so unlike an admin-issued temporary password there
            // is nothing to force a change away from.
            mustChangePassword: false,
          },
        });
      });

      await prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.SETUP_ADMIN_CREATED,
          entityType: "app_user",
          entityId: created.id,
          detail: { email },
          actorId: created.id,
        }),
      });
      await setOrganizationName(organizationName, created.id);
      if (logoBytes) {
        try { await saveBrandingLogo(logoBytes, created.id); }
        catch (err) { request.log.warn({ err }, "admin created but organization logo could not be saved"); }
      }
      await startTrial();
      request.log.warn({ email }, "first admin account created via setup wizard");
      return reply.code(201).send({ id: created.id, email: created.email, role: created.role });
    } catch (err) {
      if (err instanceof Error && err.message === "SETUP_ALREADY_DONE") {
        return reply.code(409).send({ error: "setup has already been completed — sign in instead" });
      }
      throw err;
    }
  });
}

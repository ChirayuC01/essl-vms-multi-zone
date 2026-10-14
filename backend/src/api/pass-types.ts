import { EntryMode, PassKind, Prisma, type PassType } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { ACTIVE_ENTRY_STATES } from "../services/entries.js";
import { FIELD_RULES, PROFILE_FIELDS, fieldRulesSchema, recomputeDetails } from "../services/pass-types.js";
import { actorId } from "./auth.js";
import { requirePermission } from "./permissions.js";

// Pass types (two-zone rebuild, Phase 3): a site's own visitor categories,
// each deciding which profile fields are required. Configuration an Admin
// edits, never a branch in code (CLAUDE.md #2).

const base = {
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).nullable(),
  kind: z.nativeEnum(PassKind),
  entryModes: z.array(z.nativeEnum(EntryMode)).min(1).max(2),
  requiresHostClear: z.boolean(),
  maxValidityDays: z.number().int().min(1).max(366).nullable(),
  fieldRules: fieldRulesSchema,
  credentialLabel: z.string().trim().min(1).max(60).nullable(),
  credentialCapsValidity: z.boolean(),
  exitCodeRequired: z.boolean(),
  exitCodeZoneIds: z.array(z.string().min(1)).max(50),
};
const createSchema = z.object(base).partial().required({ name: true });
const updateSchema = z.object({ ...base, isActive: z.boolean() }).partial();

function defined(value: object) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

type ExitRule = Pick<PassType, "entryModes" | "exitCodeRequired" | "exitCodeZoneIds">;

/**
 * F2 #10: a single-entry type that needs the exit code names which zones'
 * exits it applies to. Returns the problem, or null. A site with no zones yet
 * (an upgraded single-entrance site) has nothing to name.
 */
async function exitRuleProblem(rule: ExitRule): Promise<string | null> {
  if (!rule.entryModes.includes(EntryMode.SINGLE_ENTRY) || !rule.exitCodeRequired) return null;
  const ids = [...new Set(rule.exitCodeZoneIds)];
  const zones = await prisma.zone.findMany({ select: { id: true, isActive: true } });
  if (ids.some((id) => !zones.some((z) => z.id === id))) return "an exit-code zone was not found";
  if (ids.length === 0 && zones.some((z) => z.isActive)) return "choose which zones' exits need the exit code, or untick it";
  return null;
}

function conflict(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function passTypeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/pass-types", { preHandler: requirePermission("pass_types:view") }, async (_request, reply) => {
    const items = await prisma.passType.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] });
    // The field catalogue travels with the list so the console never
    // hard-codes which fields exist.
    return reply.send({ items, fields: PROFILE_FIELDS, rules: FIELD_RULES });
  });

  app.post("/pass-types", { preHandler: requirePermission("pass_types:create") }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    // Not told otherwise, a new type needs the code only if it names exits.
    parsed.data.exitCodeRequired ??= (parsed.data.exitCodeZoneIds?.length ?? 0) > 0;
    const problem = await exitRuleProblem({
      entryModes: parsed.data.entryModes ?? [EntryMode.SINGLE_ENTRY, EntryMode.MULTI_ENTRY],
      exitCodeRequired: parsed.data.exitCodeRequired,
      exitCodeZoneIds: parsed.data.exitCodeZoneIds ?? [],
    });
    if (problem) return reply.code(400).send({ error: problem });
    try {
      const created = await prisma.passType.create({ data: defined(parsed.data) as Prisma.PassTypeCreateInput });
      await prisma.auditLog.create({
        data: auditRow({ action: AuditAction.PASS_TYPE_CREATED, entityType: "pass_type", entityId: created.id, detail: JSON.parse(JSON.stringify(parsed.data)), actorId: actorId(request) }),
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (conflict(err)) return reply.code(409).send({ error: "a pass type with that name already exists" });
      throw err;
    }
  });

  app.patch("/pass-types/:id", { preHandler: requirePermission("pass_types:update") }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: parsed.success ? "nothing to change" : parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const { id } = request.params as { id: string };
    const before = await prisma.passType.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: "pass type not found" });
    const problem = await exitRuleProblem({
      entryModes: parsed.data.entryModes ?? before.entryModes,
      exitCodeRequired: parsed.data.exitCodeRequired ?? before.exitCodeRequired,
      exitCodeZoneIds: parsed.data.exitCodeZoneIds ?? before.exitCodeZoneIds,
    });
    if (problem) return reply.code(400).send({ error: problem });
    try {
      const updated = await prisma.passType.update({ where: { id }, data: defined(parsed.data) as Prisma.PassTypeUpdateInput });
      await prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.PASS_TYPE_UPDATED,
          entityType: "pass_type",
          entityId: id,
          detail: JSON.parse(JSON.stringify({ before, changes: parsed.data })),
          actorId: actorId(request),
        }),
      });
      // Stricter or looser rules change who counts as complete.
      if (parsed.data.fieldRules !== undefined || parsed.data.credentialLabel !== undefined) {
        await recomputeDetails({ passTypeId: id });
      }
      // Live passes keep the rule they were issued with (F2 #10); the console
      // says how many, so nobody expects the change to reach them.
      const livePasses = await prisma.entry.count({ where: { passTypeId: id, state: { in: [...ACTIVE_ENTRY_STATES] } } });
      return reply.send({ ...updated, livePasses });
    } catch (err) {
      if (conflict(err)) return reply.code(409).send({ error: "a pass type with that name already exists" });
      throw err;
    }
  });
}

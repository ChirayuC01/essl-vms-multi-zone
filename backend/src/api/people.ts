import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { EntryState, PersonCategory, Prisma, type Person } from "@prisma/client";
import { z } from "zod";
import { config } from "../config/index.js";
import { prisma } from "../db/index.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { actorId } from "./auth.js";
import { isJpeg, jpegDimensions } from "./jpeg.js";
import { MAX_USER_ID_LENGTH, parseUserId, photoPathFor } from "../user-id.js";
import { hasPermission, requirePermission } from "./permissions.js";
import { assignEmployeeDevices, removeEmployeeDevice } from "../services/employee-access.js";
import { describeGaps, profileGaps } from "../services/pass-types.js";
import { isMasked, maskId } from "../services/redact.js";
import { blacklistPerson, liftBlacklist } from "../services/passes.js";

// Person registration API (Phase 1 Milestone 3).
//
// Rules enforced here, not just documented:
//   - people are NEVER hard-deleted (soft is_active only)
//   - essl_user_id is the forever join key: TEXT (letters and digits, since
//     real rosters hold `WCTPL070` beside `1001`), supplied at registration -
//     the ID typed on the terminal for a device-first person, or one the
//     operator picks - matched case-insensitively, and immutable afterwards
//   - photos live on local disk; the DB holds the path
//   - every mutation writes an audit row; PHOTO_UPDATED carries its source

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

// Separators are stripped before validating, so "1234 5678 9012" and
// "123456789012" cannot become two rows for one person under the unique
// constraint. Real Aadhaar numbers never begin 0 or 1.
export const aadharNumber = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .pipe(
    z.string().regex(/^[2-9][0-9]{11}$/, "aadhar number must be 12 digits and cannot start with 0 or 1"),
  );

export const mobileNumber = z
  .string()
  .trim()
  .regex(/^[0-9+\-\s]{6,20}$/, "mobile must be 6-20 digits/+/-");

export const panNumber = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN must match ABCDE1234F"));

const identityFields = {
  aadharNumber: aadharNumber.optional(),
  panNumber: panNumber.optional(),
};

// A masked value echoed back by the console means "unchanged" (CLAUDE.md
// #12), so it is dropped before validation rather than stored or rejected.
export const unlessMasked = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (isMasked(v) ? undefined : v), schema);
const text = (max: number) => z.string().trim().max(max).transform((v) => v || null);

// Two-zone profile fields (Phase 3). Which are required depends on the
// person's pass type; null clears an optional one.
export const profileFields = {
  email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
  designation: text(100).nullable().optional(),
  govtIdType: text(40).nullable().optional(),
  govtIdNumber: unlessMasked(z.string().trim().toUpperCase().regex(/^[A-Z0-9\-\/ ]{3,40}$/, "govt ID number: letters, digits, - / and spaces").nullable().optional()),
  vehicleNumber: z.string().trim().toUpperCase().max(20).transform((v) => v || null).nullable().optional(),
  policeClearance: z.boolean().nullable().optional(),
  credentialNumber: unlessMasked(text(60).nullable().optional()),
  credentialExpiresAt: z.coerce.date().nullable().optional(),
  passTypeId: z.string().min(1).nullable().optional(),
};

// Every field is mandatory at registration: a person record is a permanent
// identity, and the cheapest moment to require the identifying details is the
// one moment somebody is looking at the person.
export const createPersonSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Which of these are mandatory is decided after parsing, by the person's
  // pass type (or the default rule): see services/pass-types.ts.
  mobile: mobileNumber.optional(),
  companyId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  category: z.nativeEnum(PersonCategory),
  ...identityFields,
  ...profileFields,
  deviceIds: z.array(z.string().min(1)).max(50).default([]),
  // The ID already typed on the terminal (device-first), or one the operator
  // chooses. Never auto-allocated — an ID somebody has to read back off a
  // person card is a decision, not a side effect.
  //
  // Letters and digits, because real rosters use both (`WCTPL070`, `ye01`).
  // Accepted as a string OR a number, so a client sending `{"esslUserId": 1001}`
  // keeps working across this change.
  esslUserId: z
    .union([z.string(), z.number()])
    .transform((v) => parseUserId(v))
    .refine((v): v is string => v !== null, {
      message: `user ID must be letters and digits only, 1-${MAX_USER_ID_LENGTH} characters`,
    }),
}).superRefine((value, ctx) => {
  if (value.category === PersonCategory.EMPLOYEE && value.deviceIds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "employees require at least one device", path: ["deviceIds"] });
  }
});

// Nothing mandatory at creation can be cleared afterwards, or the requirement
// lasts exactly one request. `aadharNumber` is settable here because people
// registered before it existed have none and need a way to acquire one.
const updatePersonSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  mobile: mobileNumber.optional(),
  aadharNumber: unlessMasked(aadharNumber.optional()),
  panNumber: unlessMasked(panNumber.optional()),
  ...profileFields,
  companyId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  category: z.nativeEnum(PersonCategory).optional(),
  deviceIds: z.array(z.string().min(1)).max(50).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  category: z.nativeEnum(PersonCategory).optional(),
  companyId: z.string().optional(),
  departmentId: z.string().optional(),
  needsDetails: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

// Photo constraints. Device-produced enrollment photos are ~44-59 KB at full
// photographic resolution; these bounds reject the obviously unusable early
// (photo quality determines template quality).
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_MIN_DIMENSION = 100;
const PHOTO_MAX_DIMENSION = 5000;

// ---------------------------------------------------------------------------

type SummaryInput = Person & {
  biometric?: { id: string } | null;
  company?: { id: string; name: string; isActive: boolean } | null;
  department?: { id: string; name: string; isActive: boolean } | null;
};

/**
 * The one shape a person leaves the API in. Identity numbers are masked here
 * and only here, so no route can forget (CLAUDE.md #12).
 */
function personSummary(v: SummaryInput) {
  return {
    id: v.id,
    name: v.name,
    category: v.category,
    companyId: v.companyId,
    company: v.company ?? null,
    departmentId: v.departmentId,
    department: v.department ?? null,
    mobile: v.mobile,
    aadharNumber: maskId(v.aadharNumber),
    panNumber: maskId(v.panNumber),
    email: v.email,
    designation: v.designation,
    govtIdType: v.govtIdType,
    govtIdNumber: maskId(v.govtIdNumber),
    vehicleNumber: v.vehicleNumber,
    policeClearance: v.policeClearance,
    credentialNumber: maskId(v.credentialNumber),
    credentialExpiresAt: v.credentialExpiresAt,
    passTypeId: v.passTypeId,
    blacklistedAt: v.blacklistedAt,
    blacklistReason: v.blacklistReason,
    esslUserId: v.esslUserId,
    isActive: v.isActive,
    resignedAt: v.resignedAt,
    resignedReason: v.resignedReason,
    hasPhoto: Boolean(v.biometric),
    profileComplete: v.detailsComplete,
    needsDetails: !v.detailsComplete,
    createdAt: v.createdAt,
  };
}

/**
 * Resolve the pass type a profile is checked against. Employees never have
 * one; a visitor's must exist and, when newly chosen, be active.
 */
async function passTypeFor(category: PersonCategory, passTypeId: string | null | undefined, current: string | null) {
  if (category === PersonCategory.EMPLOYEE || !passTypeId) return null;
  const type = await prisma.passType.findUnique({ where: { id: passTypeId } });
  if (!type || (!type.isActive && passTypeId !== current)) return undefined;
  return type;
}

/** Copy the optional profile fields a request actually sent. */
function profileData(input: Record<string, unknown>): Prisma.PersonUncheckedUpdateInput {
  const out: Record<string, unknown> = {};
  for (const key of ["email", "designation", "govtIdType", "govtIdNumber", "vehicleNumber", "policeClearance", "credentialNumber", "credentialExpiresAt", "passTypeId"]) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out as Prisma.PersonUncheckedUpdateInput;
}

export async function personRoutes(app: FastifyInstance): Promise<void> {
  // ---- create ------------------------------------------------------------
  app.post("/people", { preHandler: requirePermission("people:create") }, async (request, reply) => {
    const parsed = createPersonSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    const input = parsed.data;
    const actor = actorId(request);

    if (input.category === PersonCategory.EMPLOYEE && !(await hasPermission(request, "person_category:update"))) {
      return reply.code(403).send({ error: "only an administrator can register employees" });
    }
    const [company, department] = await prisma.$transaction([
      prisma.company.findFirst({ where: { id: input.companyId ?? "", isActive: true } }),
      prisma.department.findFirst({ where: { id: input.departmentId ?? "", isActive: true } }),
    ]);
    if ((input.companyId && !company) || (input.departmentId && !department)) {
      return reply.code(400).send({ error: "select an active company and department" });
    }
    const passType = await passTypeFor(input.category, input.passTypeId, null);
    if (passType === undefined) return reply.code(400).send({ error: "select an active pass type" });
    const gaps = profileGaps(input, passType);
    if (gaps.length > 0) return reply.code(400).send({ error: `required: ${describeGaps(gaps)}`, missing: gaps });

    try {
      const result = await prisma.$transaction(async (tx) => {
        const esslUserId = input.esslUserId;

        // Looked up before the person row is written, not after, because
        // whether a device-pushed photo already exists for this PIN decides
        // a field ON that row: a photo already on disk means the terminal
        // enrolled this person, we did not. See Person.adoptedFromDevice.
        const photoPath = photoPathFor(esslUserId);
        const existingPhoto = await stat(photoPath).catch(() => null);

        const person = await tx.person.create({
          data: {
            ...(profileData(input) as Prisma.PersonUncheckedCreateInput),
            name: input.name,
            mobile: input.mobile ?? null,
            companyId: input.companyId ?? null,
            departmentId: input.departmentId ?? null,
            category: input.category,
            aadharNumber: input.aadharNumber ?? null,
            panNumber: input.panNumber ?? null,
            passTypeId: passType?.id ?? null,
            esslUserId,
            adoptedFromDevice: existingPhoto !== null,
            detailsComplete: true,
          },
        });

        await tx.auditLog.create({
          data: auditRow({
            action: AuditAction.PERSON_CREATED,
            entityType: "person",
            entityId: person.id,
            // The number itself is deliberately not copied into the audit
            // detail: the person row already holds it, and the log is read far
            // more widely than the register.
            detail: { esslUserId },
            actorId: actor,
          }),
        });

        // Device-first registration: if this PIN's enrollment photo was
        // already pushed by the device (M2 saves it even when unmatched),
        // attach it now instead of losing it to registration ordering.
        let attachedExistingPhoto = false;
        if (existingPhoto) {
          await tx.personBiometric.create({
            data: {
              personId: person.id,
              photoPath,
              photoSizeBytes: existingPhoto.size,
              biometricType: 9,
            },
          });
          await tx.auditLog.create({
            data: auditRow({
              action: AuditAction.PHOTO_UPDATED,
              entityType: "person_biometric",
              entityId: person.id,
              detail: {
                source: "DEVICE_PUSH",
                attachedAtRegistration: true,
                photoSizeBytes: existingPhoto.size,
              },
              actorId: actor,
            }),
          });
          attachedExistingPhoto = true;
        }

        return { person, attachedExistingPhoto };
      });

      if (input.category === PersonCategory.EMPLOYEE) {
        await assignEmployeeDevices(result.person.id, input.deviceIds, actor);
      }

      return reply.code(201).send({
        ...personSummary({ ...result.person, company: input.companyId ? company : null, department: input.departmentId ? department : null, biometric: null }),
        hasPhoto: result.attachedExistingPhoto,
      });
    } catch (err) {
      // Two unique keys on this row now, so the refusal has to say which one
      // was hit — "already registered" against the wrong field sends an
      // operator hunting for a PIN clash that isn't there.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const target = Array.isArray(err.meta?.target) ? (err.meta.target as string[]) : [];
        return reply.code(409).send({
          error: target.some((t) => t.includes("aadhar"))
            ? "that Aadhaar number is already registered to another person"
            : target.some((t) => t.includes("pan"))
              ? "that PAN is already registered to another person"
              : `esslUserId ${input.esslUserId} is already registered`,
        });
      }
      throw err;
    }
  });

  // ---- list ----------------------------------------------------------------
  app.get("/people", { preHandler: requirePermission("people:view") }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    const { page, pageSize, q, active, category, companyId, departmentId, needsDetails } = parsed.data;

    const where: Prisma.PersonWhereInput = {};
    if (active !== undefined) where.isActive = active;
    if (category) where.category = category;
    if (companyId) where.companyId = companyId;
    if (departmentId) where.departmentId = departmentId;
    if (needsDetails !== undefined) where.detailsComplete = !needsDetails;
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { company: { name: { contains: q, mode: "insensitive" } } },
        { department: { name: { contains: q, mode: "insensitive" } } },
        { mobile: { contains: q } },
        // Exact, unlike every other term here: a partial aadhar match would
        // return several people for a number somebody read out, and this one
        // exists to identify exactly one.
        { aadharNumber: q },
        // Substring, and case-insensitive: an ID is now text, so `wctpl1`
        // usefully finds the whole block of them. It used to match only if the
        // whole number was typed exactly.
        { esslUserId: { contains: q, mode: "insensitive" as const } },
      ];
    }

    const [total, items] = await prisma.$transaction([
      prisma.person.count({ where }),
      prisma.person.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          biometric: { select: { id: true } },
          company: { select: { id: true, name: true, isActive: true } },
          department: { select: { id: true, name: true, isActive: true } },
        },
      }),
    ]);

    return reply.send({ total, page, pageSize, items: items.map(personSummary) });
  });

  // ---- detail ----------------------------------------------------------------
  app.get("/people/:id", { preHandler: requirePermission("people:view") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const person = await prisma.person.findUnique({
      where: { id },
      include: {
        biometric: true,
        company: { select: { id: true, name: true, isActive: true } },
        department: { select: { id: true, name: true, isActive: true } },
        employeeAccess: { include: { device: true }, orderBy: { assignedAt: "asc" } },
        entries: {
          orderBy: { createdAt: "desc" },
          take: 20,
          include: { personToMeet: { select: { id: true, name: true, email: true } } },
        },
      },
    });
    if (!person) return reply.code(404).send({ error: "person not found" });

    return reply.send({
      ...personSummary(person),
      // Drives the "enrolled on the terminal, not under management" notice —
      // this person IS on a device, which is exactly what the absence of an
      // active entry would otherwise be read to mean.
      adoptedFromDevice: person.adoptedFromDevice,
      biometric: person.biometric
        ? {
            photoUrl: `/api/people/${person.id}/photo`,
            photoSizeBytes: person.biometric.photoSizeBytes,
            algorithmVersion: person.biometric.algorithmVersion,
            hasCachedTemplate: Boolean(person.biometric.faceTemplate),
            capturedAt: person.biometric.capturedAt,
          }
        : null,
      entries: person.entries,
      employeeAccess: person.employeeAccess,
    });
  });

  // ---- this person's history -------------------------------------------------
  // "What happened to this person, and who did it" — answered where the
  // question is asked rather than by sending someone to a generic log and
  // asking them to filter.
  //
  // Spans the person row AND every entry belonging to them: a provision, a
  // block and a de-provision are recorded against the entry, not the person,
  // so a naive filter on entity_id would show registration and nothing else —
  // the least interesting half of the story.
  //
  // ADMIN only, like every other audit view: these rows name the operators who
  // acted, and who can see their colleagues' activity is a product decision
  // taken in Milestone 17, not one to re-open per endpoint.
  app.get(
    "/people/:id/audit",
    { preHandler: requirePermission("audit:view") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const person = await prisma.person.findUnique({ where: { id }, select: { id: true } });
      if (!person) return reply.code(404).send({ error: "person not found" });

      const rows = await prisma.$queryRaw<
        { createdAt: Date; action: string; actor: string; entityType: string | null; detail: unknown }[]
      >`
        SELECT a."created_at" AS "createdAt",
               a."action",
               COALESCE(u."email", 'system') AS actor,
               a."entity_type" AS "entityType",
               a."detail"
          FROM "audit_log" a
          LEFT JOIN "app_user" u ON u."id" = a."actor_id"
         WHERE (a."entity_type" = 'person' AND a."entity_id" = ${id})
            OR (a."entity_type" = 'person_biometric' AND a."entity_id" = ${id})
            OR (a."entity_type" = 'entry'
                AND a."entity_id" IN (SELECT e."id" FROM "entry" e WHERE e."person_id" = ${id}))
         ORDER BY a."created_at" DESC
         LIMIT 200
      `;
      return reply.send({ total: rows.length, items: rows });
    },
  );

  // ---- exact lookup by device PIN --------------------------------------------
  // For the returning-person desk flow: someone reads out the PIN from their
  // card and the operator provisions them without searching by name.
  //
  // Deliberately NOT the `?q=` search, which also matches a mobile number
  // *containing* those digits — so "1001" could return several people, and an
  // ambiguous match is the last thing this flow should produce. Here the PIN
  // is the unique join key it has always been, and the answer is one person
  // or none.
  app.get(
    "/people/by-pin/:pin",
    { preHandler: requirePermission("people:view") },
    async (request, reply) => {
      const pin = parseUserId((request.params as { pin: string }).pin);
      if (pin === null) {
        return reply.code(400).send({
          error: `PIN must be letters and digits only, 1-${MAX_USER_ID_LENGTH} characters`,
        });
      }

      // Case-insensitive: `wctpl070` and `WCTPL070` are one person, and
      // whoever is reading a number off a card has no idea which the terminal
      // was given.
      const person = await prisma.person.findFirst({
        where: { esslUserId: { equals: pin, mode: "insensitive" } },
        include: {
          biometric: true,
          company: { select: { id: true, name: true, isActive: true } },
          department: { select: { id: true, name: true, isActive: true } },
          employeeAccess: { include: { device: true }, orderBy: { assignedAt: "asc" } },
          entries: { orderBy: { createdAt: "desc" }, take: 5 },
        },
      });
      if (!person) return reply.code(404).send({ error: `no person holds PIN ${pin}` });

      return reply.send({
        ...personSummary(person),
        biometric: person.biometric
          ? {
              photoUrl: `/api/people/${person.id}/photo`,
              photoSizeBytes: person.biometric.photoSizeBytes,
              algorithmVersion: person.biometric.algorithmVersion,
              hasCachedTemplate: Boolean(person.biometric.faceTemplate),
              capturedAt: person.biometric.capturedAt,
            }
          : null,
        entries: person.entries,
        employeeAccess: person.employeeAccess,
      });
    },
  );

  // ---- update ----------------------------------------------------------------
  app.patch("/people/:id", { preHandler: requirePermission("people:update") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updatePersonSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    const current = await prisma.person.findUnique({
      where: { id },
      include: { employeeAccess: true },
    });
    if (!current) return reply.code(404).send({ error: "person not found" });
    if (parsed.data.category !== undefined && parsed.data.category !== current.category && !(await hasPermission(request, "person_category:update"))) {
      return reply.code(403).send({ error: "only an administrator can change category" });
    }
    const sent = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const merged = { ...current, ...sent } as typeof current;
    if (merged.category === PersonCategory.EMPLOYEE) merged.passTypeId = null;
    const passType = await passTypeFor(merged.category, merged.passTypeId, current.passTypeId);
    if (passType === undefined) return reply.code(400).send({ error: "select an active pass type" });
    const gaps = profileGaps(merged, passType);
    if (gaps.length > 0) return reply.code(400).send({ error: `required: ${describeGaps(gaps)}`, missing: gaps });
    // Only a newly chosen company or department must be active; a retired one
    // already on the profile stays valid (directories are never deleted).
    const [company, department] = await prisma.$transaction([
      prisma.company.findFirst({ where: { id: parsed.data.companyId ?? "", isActive: true } }),
      prisma.department.findFirst({ where: { id: parsed.data.departmentId ?? "", isActive: true } }),
    ]);
    if ((parsed.data.companyId && parsed.data.companyId !== current.companyId && !company) || (parsed.data.departmentId && parsed.data.departmentId !== current.departmentId && !department)) {
      return reply.code(400).send({ error: "select an active company and department" });
    }
    if (current.category !== PersonCategory.EMPLOYEE && merged.category === PersonCategory.EMPLOYEE && !(parsed.data.deviceIds?.length)) {
      return reply.code(400).send({ error: "select at least one device when changing to Employee" });
    }

    if (current.category === PersonCategory.EMPLOYEE && merged.category === PersonCategory.VISITOR) {
      for (const access of current.employeeAccess.filter((a) => a.desiredAccess)) {
        await removeEmployeeDevice(id, access.deviceId, actorId(request), "Category changed to Visitor");
      }
    }

    // Strip undefined keys — "field absent" means "leave unchanged".
    const data: Prisma.PersonUncheckedUpdateInput = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.mobile !== undefined) data.mobile = parsed.data.mobile;
    if (parsed.data.aadharNumber !== undefined) data.aadharNumber = parsed.data.aadharNumber;
    if (parsed.data.panNumber !== undefined) data.panNumber = parsed.data.panNumber;
    if (parsed.data.companyId !== undefined) data.companyId = parsed.data.companyId;
    if (parsed.data.departmentId !== undefined) data.departmentId = parsed.data.departmentId;
    if (parsed.data.category !== undefined) data.category = parsed.data.category;
    Object.assign(data, profileData(parsed.data));
    if (merged.category === PersonCategory.EMPLOYEE && current.passTypeId) data.passTypeId = null;
    if (Object.keys(data).length === 0 && !parsed.data.deviceIds?.length) {
      return reply.code(400).send({ error: "no fields to update" });
    }

    try {
      const [person] = await prisma.$transaction([
        prisma.person.update({
          where: { id },
          data: { ...data, detailsComplete: true },
          include: {
            biometric: { select: { id: true } },
            company: { select: { id: true, name: true, isActive: true } },
            department: { select: { id: true, name: true, isActive: true } },
          },
        }),
        prisma.auditLog.create({
          data: auditRow({
            action: AuditAction.PERSON_UPDATED,
            entityType: "person",
            entityId: id,
            detail: { fields: Object.keys(data) },
            actorId: actorId(request),
          }),
        }),
      ]);
      if (person.category === PersonCategory.EMPLOYEE && parsed.data.deviceIds?.length) {
        await assignEmployeeDevices(id, parsed.data.deviceIds, actorId(request));
      }
      return reply.send(personSummary(person));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return reply.code(404).send({ error: "person not found" });
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply
          .code(409)
          .send({ error: "that Aadhaar or PAN is already registered to another person" });
      }
      throw err;
    }
  });

  // ---- soft delete ------------------------------------------------------------
  app.delete("/people/:id", { preHandler: requirePermission("people:delete") }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const person = await prisma.person.findUnique({ where: { id } });
    if (!person) return reply.code(404).send({ error: "person not found" });

    // A person still loaded on (or headed to/from) a device must be
    // de-provisioned first — deactivating them here would strand a live
    // credential on the barrier.
    const activeEntry = await prisma.entry.findFirst({
      where: {
        personId: id,
        state: {
          in: [
            EntryState.PENDING_PROVISION,
            EntryState.PROVISIONED,
            EntryState.INSIDE,
            EntryState.PENDING_DEPROVISION,
          ],
        },
      },
    });
    if (activeEntry) {
      return reply.code(409).send({
        error: `person has an active entry (${activeEntry.state}) — de-provision before deactivating`,
      });
    }
    const employeeAccess = await prisma.employeeDeviceAccess.findFirst({
      where: { personId: id, desiredAccess: true },
    });
    if (employeeAccess) {
      return reply.code(409).send({
        error: "employee still has permanent device access — remove every assignment before deactivating",
      });
    }

    const [updated] = await prisma.$transaction([
      prisma.person.update({
        where: { id },
        data: { isActive: false },
        include: { biometric: { select: { id: true } } },
      }),
      prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.PERSON_DEACTIVATED,
          entityType: "person",
          entityId: id,
          actorId: actorId(request),
        }),
      }),
    ]);
    return reply.send(personSummary(updated));
  });

  // ---- photo: serve -------------------------------------------------------------
  app.get("/people/:id/photo", { preHandler: requirePermission("people:view") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const biometric = await prisma.personBiometric.findUnique({ where: { personId: id } });
    if (!biometric) return reply.code(404).send({ error: "no photo for this person" });
    try {
      const jpeg = await readFile(biometric.photoPath);
      return reply.type("image/jpeg").send(jpeg);
    } catch {
      request.log.error(
        { personId: id, photoPath: biometric.photoPath },
        "biometric row exists but photo file is missing from disk",
      );
      return reply.code(404).send({ error: "photo file missing" });
    }
  });

  // ---- photo: upload/replace -----------------------------------------------------
  // Raw JPEG body (Content-Type: image/jpeg), not multipart — keeps the API
  // dependency-free and trivially scriptable; the M5 UI sends the file blob
  // directly.
  app.post("/people/:id/photo", { preHandler: requirePermission("people:update") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const person = await prisma.person.findUnique({ where: { id } });
    if (!person) return reply.code(404).send({ error: "person not found" });

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply
        .code(400)
        .send({ error: "send the raw JPEG as the request body (Content-Type: image/jpeg)" });
    }
    if (body.length > PHOTO_MAX_BYTES) {
      return reply.code(413).send({ error: `photo exceeds ${PHOTO_MAX_BYTES} bytes` });
    }
    if (!isJpeg(body)) {
      return reply.code(400).send({ error: "not a JPEG (bad magic bytes)" });
    }
    const dims = jpegDimensions(body);
    if (!dims) {
      return reply.code(400).send({ error: "could not read JPEG dimensions" });
    }
    if (
      dims.width < PHOTO_MIN_DIMENSION ||
      dims.height < PHOTO_MIN_DIMENSION ||
      dims.width > PHOTO_MAX_DIMENSION ||
      dims.height > PHOTO_MAX_DIMENSION
    ) {
      return reply.code(400).send({
        error: `photo is ${dims.width}x${dims.height}px; must be between ${PHOTO_MIN_DIMENSION} and ${PHOTO_MAX_DIMENSION}px per side`,
      });
    }

    // Same canonical location the device-push path uses: photos/<pin>.jpg.
    const photoPath = photoPathFor(person.esslUserId);
    await writeFile(photoPath, body);

    await prisma.$transaction([
      prisma.personBiometric.upsert({
        where: { personId: person.id },
        create: {
          personId: person.id,
          photoPath,
          photoSizeBytes: body.length,
          biometricType: 9,
        },
        update: {
          photoPath,
          photoSizeBytes: body.length,
          // A new photo invalidates any cached template — it no longer
          // corresponds to this image.
          faceTemplate: null,
          capturedAt: new Date(),
        },
      }),
      prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.PHOTO_UPDATED,
          entityType: "person_biometric",
          entityId: person.id,
          detail: {
            source: "UI_UPLOAD",
            photoSizeBytes: body.length,
            width: dims.width,
            height: dims.height,
          },
          actorId: actorId(request),
        }),
      }),
    ]);

    return reply.code(201).send({
      photoUrl: `/api/people/${person.id}/photo`,
      photoSizeBytes: body.length,
      width: dims.width,
      height: dims.height,
    });
  });

  // ---- blacklist (Security In-charge) ----------------------------------------
  // Removes the visitor from every terminal at once and refuses any new pass
  // until lifted. Both directions need a reason and are audited.
  app.post("/people/:id/blacklist", { preHandler: requirePermission("blacklist:update") }, async (request, reply) => {
    const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "a reason is required to blacklist" });
    return reply.code(202).send(await blacklistPerson((request.params as { id: string }).id, parsed.data.reason, actorId(request)));
  });
  app.post("/people/:id/blacklist/lift", { preHandler: requirePermission("blacklist:update") }, async (request, reply) => {
    const parsed = z.object({ reason: z.string().trim().max(300).optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid reason" });
    await liftBlacklist((request.params as { id: string }).id, parsed.data.reason, actorId(request));
    return reply.send({ lifted: true });
  });
}

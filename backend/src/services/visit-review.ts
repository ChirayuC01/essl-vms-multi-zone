import { copyFile, stat } from "node:fs/promises";
import {
  EntryMode,
  MessageChannel,
  PersonCategory,
  Prisma,
  RetentionPolicy,
  VisitOrigin,
  VisitRequestStatus,
  type VisitRequest,
} from "@prisma/client";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { classifyDeviceId, parseUserId, photoPathFor } from "../user-id.js";
import { getBranding } from "./branding.js";
import { provisionPerson } from "./entries.js";
import { ServiceError } from "./errors.js";
import { sendMessage } from "./notify.js";
import { describeGaps, profileGaps } from "./pass-types.js";
import { getSettings } from "./settings.js";
import { messageHost, sendLink, submitRequest, when, type PortalRequest, type VisitorContext } from "./visit-requests.js";
import { zoneDevices } from "./zones.js";

// Host review (two-zone rebuild, Phase 6): Clear, Query, Reject — and the
// walk-in's automatic decision when the site does not require a host Clear.
//
// Clear turns a submitted request into a person and a pass. A returning
// visitor (matched by verified mobile in Phase 5) keeps their person record
// and their terminal ID; a new one is issued `<visitorIdPrefix><number>`.
// The selfie becomes the enrollment photo, the documents move to the person,
// and the pass goes to the gate engine like any other.

const OPEN: VisitRequestStatus[] = [VisitRequestStatus.SENT, VisitRequestStatus.SUBMITTED, VisitRequestStatus.QUERIED];

async function load(requestId: string) {
  const request = await prisma.visitRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new ServiceError(404, "visit request not found");
  return request;
}

function event(request: VisitRequest, to: VisitRequestStatus, actorId: string | null, note?: string, detail?: Prisma.InputJsonValue) {
  return prisma.visitRequestEvent.create({
    data: { requestId: request.id, actorId, actorKind: actorId ? "OPERATOR" : "SYSTEM", fromStatus: request.status, toStatus: to, note: note ?? null, ...(detail ? { detail } : {}) },
  });
}

async function messageVisitor(request: VisitRequest, template: string, body: string) {
  await sendMessage({ channel: MessageChannel.SMS, to: request.visitorMobile, template, body, related: { type: "visit_request", id: request.id } });
}

/**
 * The next free system visitor ID. The number comes from a database sequence
 * (atomic, never reused); an ID someone already holds — imported or typed on a
 * terminal — is skipped.
 */
async function issueVisitorId(prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [row] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('visitor_id_seq') AS n`;
    const n = row!.n;
    const id = parseUserId(`${prefix}${String(n).padStart(5, "0")}`);
    if (!id) throw new ServiceError(500, "the visitor ID prefix produces an invalid terminal ID");
    const taken = await prisma.person.count({ where: { esslUserId: { equals: id, mode: "insensitive" } } });
    if (!taken) return id;
  }
  throw new ServiceError(500, "could not find a free visitor ID");
}

/**
 * Every terminal the pass uses must see this ID as a VISITOR, or reconciliation
 * would never remove it (CLAUDE.md #7: IDs outside the patterns are untouched).
 */
function assertVisitorIdFits(id: string, prefix: string, devices: Awaited<ReturnType<typeof zoneDevices>>) {
  const misfit = devices.filter((d) => classifyDeviceId(id, d.employeeIdPatterns, d.visitorIdPatterns) !== PersonCategory.VISITOR);
  if (misfit.length) {
    throw new ServiceError(
      409,
      `visitor ID ${id} does not match the visitor ID patterns of ${misfit.map((d) => d.name ?? d.serialNo).join(", ")} — add a pattern such as ${prefix}* on the Devices page`,
    );
  }
}

export interface ClearOptions {
  /** Directory company and department; default to the request's company / the person's own. */
  companyId?: string | null | undefined;
  departmentId?: string | null | undefined;
  /** Issued without a host decision (walk-in with host Clear switched off, or a type that needs none). */
  automatic?: boolean;
  /** Why no host Clear was needed, for the request's history. */
  automaticReason?: string;
}

export async function clearRequest(requestId: string, actorId: string | null, opts: ClearOptions = {}) {
  const request = await load(requestId);
  if (request.status !== VisitRequestStatus.SUBMITTED) throw new ServiceError(409, `the request is ${request.status.toLowerCase()} — only a submitted request can be cleared`);
  if (!request.selfiePath) throw new ServiceError(409, "the visitor has no photo");
  const s = (request.submission ?? {}) as Record<string, unknown>;
  const passType = request.passTypeId ? await prisma.passType.findUnique({ where: { id: request.passTypeId } }) : null;
  const existing = request.personId ? await prisma.person.findUnique({ where: { id: request.personId } }) : null;
  if (existing?.blacklistedAt) throw new ServiceError(409, "this visitor is blacklisted — the request cannot be cleared");
  if (existing && existing.category !== PersonCategory.VISITOR) throw new ServiceError(409, "the matched person is an employee, not a visitor");

  // Company: from the directory only — the request's, unless the host picks one now.
  if (opts.companyId && !(await prisma.company.findFirst({ where: { id: opts.companyId, isActive: true } }))) {
    throw new ServiceError(400, "select an active company");
  }
  const companyId = opts.companyId || request.companyId || undefined;
  if (opts.departmentId && !(await prisma.department.findFirst({ where: { id: opts.departmentId, isActive: true } }))) {
    throw new ServiceError(400, "select an active department");
  }

  const text = (k: string) => (s[k] === undefined ? undefined : (s[k] as string | null) || null);
  const profile = {
    name: (s.name as string | undefined) || request.visitorName,
    mobile: request.visitorMobile,
    email: text("email"),
    designation: text("designation"),
    govtIdType: text("govtIdType"),
    govtIdNumber: text("govtIdNumber"),
    aadharNumber: text("aadharNumber"),
    panNumber: text("panNumber"),
    vehicleNumber: text("vehicleNumber"),
    policeClearance: s.policeClearance === undefined ? undefined : (s.policeClearance as boolean | null),
    credentialNumber: text("credentialNumber"),
    credentialExpiresAt: s.credentialExpiresAt === undefined ? undefined : s.credentialExpiresAt ? new Date(s.credentialExpiresAt as string) : null,
    passTypeId: request.passTypeId,
    ...(opts.departmentId ? { departmentId: opts.departmentId } : {}),
  };
  const defined = Object.fromEntries(Object.entries(profile).filter(([, v]) => v !== undefined));
  const merged = { ...(existing ?? {}), ...defined, companyId: companyId ?? existing?.companyId ?? null, category: PersonCategory.VISITOR };
  const gaps = profileGaps(merged, passType);
  if (gaps.length) throw new ServiceError(400, `still needed before clearing: ${describeGaps(gaps)}`);

  const devices = await zoneDevices(request.zoneIds);
  const { visitorIdPrefix } = await getSettings();
  // Checked with a sample before a number is used up.
  assertVisitorIdFits(existing?.esslUserId ?? `${visitorIdPrefix}00001`, visitorIdPrefix, devices);
  const esslUserId = existing?.esslUserId ?? (await issueVisitorId(visitorIdPrefix));
  const photoPath = photoPathFor(esslUserId);

  // The person, their photo and documents. Kept even if the pass below is
  // refused: a person record is durable, and a retried Clear finds it.
  let personId: string;
  try {
    personId = await prisma.$transaction(async (tx) => {
      const data = { ...defined, ...(companyId ? { companyId } : {}), detailsComplete: true };
      const person = existing
        ? await tx.person.update({ where: { id: existing.id }, data })
        : await tx.person.create({ data: { ...(data as Prisma.PersonUncheckedCreateInput), name: profile.name, category: PersonCategory.VISITOR, esslUserId } });
      await tx.auditLog.create({
        data: auditRow({
          action: existing ? AuditAction.PERSON_UPDATED : AuditAction.PERSON_CREATED,
          entityType: "person",
          entityId: person.id,
          detail: { esslUserId, fromVisitRequest: request.id, fields: Object.keys(defined) },
          actorId,
        }),
      });
      await tx.personBiometric.upsert({
        where: { personId: person.id },
        create: { personId: person.id, photoPath, photoSizeBytes: 0, biometricType: 9 },
        update: { photoPath, faceTemplate: null, capturedAt: new Date() },
      });
      await tx.personDocument.updateMany({ where: { visitRequestId: request.id }, data: { personId: person.id } });
      await tx.visitRequest.update({ where: { id: request.id }, data: { personId: person.id } });
      return person.id;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = Array.isArray(err.meta?.target) ? (err.meta.target as string[]).join(",") : String(err.meta?.target ?? "");
      throw new ServiceError(409, target.includes("aadhar") ? "that Aadhaar number is already registered to another person" : target.includes("pan") ? "that PAN is already registered to another person" : "this visitor clashes with an existing person");
    }
    throw err;
  }
  await copyFile(request.selfiePath, photoPath);
  const { size } = await stat(photoPath);
  await prisma.$transaction([
    prisma.personBiometric.update({ where: { personId }, data: { photoSizeBytes: size } }),
    prisma.auditLog.create({ data: auditRow({ action: AuditAction.PHOTO_UPDATED, entityType: "person_biometric", entityId: personId, detail: { source: "VISIT_REQUEST", requestId: request.id, photoSizeBytes: size }, actorId }) }),
  ]);

  const { entry } = await provisionPerson({
    personId,
    zoneIds: request.zoneIds,
    // Nothing ticked means the zones' own defaults (the office exit always).
    ...(request.entryMode === EntryMode.SINGLE_ENTRY && request.exitCodeZoneIds.length ? { exitCodeZoneIds: request.exitCodeZoneIds } : {}),
    entryMode: request.entryMode,
    expectedInAt: request.expectedAt,
    validUntil: request.validUntil,
    retentionPolicy: RetentionPolicy.CUSTOM,
    purposeOfVisit: request.purpose,
    personToMeetId: request.hostId,
    passTypeId: request.passTypeId ?? undefined,
    actorId: actorId ?? undefined,
  });

  await prisma.$transaction([
    prisma.visitRequest.update({ where: { id: request.id }, data: { status: VisitRequestStatus.CLEARED, passId: entry.id } }),
    event(request, VisitRequestStatus.CLEARED, actorId, opts.automatic ? `issued without a host Clear — ${opts.automaticReason ?? "not required"}` : undefined, { personId, esslUserId, entryId: entry.id }),
    prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.VISIT_REQUEST_CLEARED,
        entityType: "visit_request",
        entityId: request.id,
        detail: { personId, esslUserId, entryId: entry.id, returning: Boolean(existing), automatic: Boolean(opts.automatic), automaticReason: opts.automaticReason ?? null, companyId: companyId ?? null },
        actorId,
      }),
    }),
  ]);
  const { organizationName } = await getBranding();
  await messageVisitor(request, "VISIT_CONFIRMED", `Your visit to ${organizationName} on ${when(request.expectedAt)} is confirmed. At the entry gate, simply look at the camera.`);
  return { personId, esslUserId, entryId: entry.id, returning: Boolean(existing) };
}

/** The host asks the visitor to fix something. A new link goes out showing the question. */
export async function queryRequest(requestId: string, actorId: string, text: string) {
  const request = await load(requestId);
  if (request.status !== VisitRequestStatus.SUBMITTED) throw new ServiceError(409, `the request is ${request.status.toLowerCase()} — only a submitted request can be queried`);
  const [updated] = await prisma.$transaction([
    prisma.visitRequest.update({ where: { id: requestId }, data: { status: VisitRequestStatus.QUERIED, queryText: text } }),
    event(request, VisitRequestStatus.QUERIED, actorId, text),
    prisma.auditLog.create({ data: auditRow({ action: AuditAction.VISIT_REQUEST_QUERIED, entityType: "visit_request", entityId: requestId, detail: { query: text }, actorId }) }),
  ]);
  if (request.origin === VisitOrigin.PLANNED) await sendLink(updated, actorId);
}

export async function rejectRequest(requestId: string, actorId: string, reason: string, now = new Date()) {
  const request = await load(requestId);
  if (!OPEN.includes(request.status)) throw new ServiceError(409, `the request is ${request.status.toLowerCase()} and can no longer be rejected`);
  await prisma.$transaction([
    prisma.visitRequest.update({ where: { id: requestId }, data: { status: VisitRequestStatus.REJECTED } }),
    prisma.linkToken.updateMany({ where: { requestId, revokedAt: null }, data: { revokedAt: now } }),
    event(request, VisitRequestStatus.REJECTED, actorId, reason),
    prisma.auditLog.create({ data: auditRow({ action: AuditAction.VISIT_REQUEST_REJECTED, entityType: "visit_request", entityId: requestId, detail: { reason, from: request.status }, actorId }) }),
  ]);
  // The visitor is told it was not approved; the host's reason stays internal.
  const { organizationName } = await getBranding();
  await messageVisitor(request, "VISIT_REJECTED", `Your visit request to ${organizationName} for ${when(request.expectedAt)} was not approved. Please contact your host.`);
}

/** Requests whose visit window has ended without a decision. One read, three writes. */
export async function expireRequests(now = new Date()) {
  const due = await prisma.visitRequest.findMany({ where: { status: { in: OPEN }, validUntil: { lt: now } }, select: { id: true, status: true } });
  if (!due.length) return 0;
  const ids = due.map((r) => r.id);
  await prisma.$transaction([
    prisma.visitRequest.updateMany({ where: { id: { in: ids }, status: { in: OPEN } }, data: { status: VisitRequestStatus.EXPIRED } }),
    prisma.linkToken.updateMany({ where: { requestId: { in: ids }, revokedAt: null }, data: { revokedAt: now } }),
    prisma.visitRequestEvent.createMany({ data: due.map((r) => ({ requestId: r.id, actorKind: "SYSTEM", fromStatus: r.status, toStatus: VisitRequestStatus.EXPIRED, note: "visit time passed without a decision" })) }),
    prisma.auditLog.createMany({ data: due.map((r) => ({ action: AuditAction.VISIT_REQUEST_EXPIRED, entityType: "visit_request", entityId: r.id, detail: { from: r.status } })) }),
  ]);
  return ids.length;
}

/**
 * Submit, then decide. A host Clear is needed when the visitor type requires
 * one — and, for a walk-in, only while the site's "walk-in requires host
 * Clear" setting is on. Otherwise the pass is issued at once; if that fails
 * (e.g. an ID clash), the request waits for the host like any other.
 */
export async function submitAndDecide(request: PortalRequest, ctx: VisitorContext) {
  const [settings, passType] = await Promise.all([
    getSettings(),
    request.passTypeId ? prisma.passType.findUnique({ where: { id: request.passTypeId } }) : null,
  ]);
  const needsHost = (passType?.requiresHostClear ?? true) && (request.origin === VisitOrigin.PLANNED || settings.walkInRequiresHostClear);
  await submitRequest(request, ctx, needsHost);
  if (needsHost) return { status: VisitRequestStatus.SUBMITTED, awaitingHost: true };
  const name = ((request.submission ?? {}) as { name?: string }).name ?? request.visitorName;
  try {
    const automaticReason = passType && !passType.requiresHostClear
      ? `the visitor type "${passType.name}" does not require one`
      : "walk-ins do not require one (site setting)";
    const cleared = await clearRequest(request.id, ctx.actorId ?? null, { automatic: true, automaticReason });
    await messageHost(request, "PASS_ISSUED", `${name} has been issued a pass to visit you (${when(request.expectedAt)}).`);
    return { status: VisitRequestStatus.CLEARED, awaitingHost: false, ...cleared };
  } catch (err) {
    if (!(err instanceof ServiceError)) throw err;
    await messageHost(request, "REQUEST_SUBMITTED", `${name}'s pass could not be issued automatically (${err.message}). Please review the request in the visitor console.`);
    return { status: VisitRequestStatus.SUBMITTED, awaitingHost: true, problem: err.message };
  }
}

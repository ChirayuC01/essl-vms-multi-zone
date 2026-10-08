import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EntryMode, MessageChannel, Prisma, VisitOrigin, VisitRequestStatus, type VisitRequest } from "@prisma/client";
import { config } from "../config/index.js";
import { AuditAction, auditRow, type AuditActionName } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { getBranding } from "./branding.js";
import { checkCode, hashLinkToken, issueCode, newLinkToken } from "./codes.js";
import { ServiceError } from "./errors.js";
import { sendMessage } from "./notify.js";
import { PROFILE_FIELDS, ruleFor, type ProfileField, type RuleSource } from "./pass-types.js";
import { isMasked, maskId } from "./redact.js";
import { allow } from "./rate-limit.js";
import { getSettings } from "./settings.js";

// Visit requests and the visitor portal (two-zone rebuild, Phase 5).
//
// A host raises a request; the visitor gets a link (SMS, and email if one was
// given), verifies their mobile with a one-time code, accepts the site's
// privacy notice, fills the fields their pass type asks for, takes a live
// selfie, optionally uploads documents, and submits. The host's decision
// (Clear / Query / Reject) and the pass it issues are Phase 6.
//
// The link is the visitor's only credential. It is 32 random bytes, stored
// hashed, expires (setting), and is replaced when the host resends it. Until
// the mobile is verified the link shows almost nothing.

export const LINK_PURPOSE = "PREREG";
export const OTP_PURPOSE = "MOBILE_VERIFY";
const EDITABLE: VisitRequestStatus[] = [VisitRequestStatus.SENT, VisitRequestStatus.QUERIED];
const ID_FIELDS = ["govtIdNumber", "aadharNumber", "panNumber", "credentialNumber"] as const;

/**
 * Fields the visitor fills on the portal. Mobile is verified, not typed.
 * Company and department are the host's side: a visitor cannot know how the
 * site's directory spells their company, and free text made duplicates.
 */
export const PORTAL_FIELDS = [
  "email",
  "designation",
  "govtIdType",
  "govtIdNumber",
  "aadharNumber",
  "panNumber",
  "vehicleNumber",
  "policeClearance",
  "credentialNumber",
  "credentialExpiresAt",
] as const satisfies readonly ProfileField[];
type PortalField = (typeof PORTAL_FIELDS)[number];

/**
 * Who did it. On the portal it is the visitor (no operator, their address);
 * for a walk-in it is the Security operator at the gate (Phase 6).
 */
export interface VisitorContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
  actorId?: string | undefined;
}
const who = (ctx: VisitorContext) => ({ by: ctx.actorId ? "OPERATOR" : "VISITOR", ip: ctx.ip, userAgent: ctx.userAgent });

const IST = "Asia/Kolkata";
export const when = (d: Date) => d.toLocaleString("en-IN", { timeZone: IST, dateStyle: "medium", timeStyle: "short" });
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const lastDigits = (mobile: string) => mobile.replace(/\D/g, "").slice(-10);

function audit(action: AuditActionName, requestId: string, detail: Record<string, unknown>, actorId?: string | null) {
  return prisma.auditLog.create({ data: auditRow({ action, entityType: "visit_request", entityId: requestId, detail: detail as Prisma.InputJsonValue, actorId }) });
}

// ---------------------------------------------------------------------------
// Operator side
// ---------------------------------------------------------------------------

export interface CreateRequestInput {
  visitorName: string;
  visitorMobile: string;
  visitorEmail?: string | null | undefined;
  /** From the directory; never free text. */
  companyId?: string | null | undefined;
  purpose: string;
  passTypeId: string;
  zoneIds: string[];
  exitCodeZoneIds?: string[] | undefined;
  entryMode: EntryMode;
  expectedAt: Date;
  validUntil: Date;
}

/**
 * Raise a request. A planned visit (host) sends the visitor their link; a
 * walk-in (Security at the gate, Phase 6) names the host and sends nothing —
 * the details are taken at the desk.
 */
export async function createVisitRequest(
  input: CreateRequestInput,
  hostId: string,
  opts: { actorId?: string; origin?: VisitOrigin } = {},
  now = new Date(),
) {
  const actorId = opts.actorId ?? hostId;
  const origin = opts.origin ?? VisitOrigin.PLANNED;
  if (origin === VisitOrigin.WALK_IN && !(await prisma.appUser.findFirst({ where: { id: hostId, isActive: true } }))) {
    throw new ServiceError(400, "select the host the visitor is meeting");
  }
  if (input.expectedAt.getTime() < now.getTime() - 60 * 60_000) throw new ServiceError(400, "the visit must be in the future");
  if (input.validUntil <= input.expectedAt) throw new ServiceError(400, "the visit must end after it starts");
  const passType = await prisma.passType.findUnique({ where: { id: input.passTypeId } });
  if (!passType || !passType.isActive) throw new ServiceError(400, "select an active pass type");
  if (!passType.entryModes.includes(input.entryMode)) {
    throw new ServiceError(400, `${passType.name} passes do not allow ${input.entryMode === EntryMode.SINGLE_ENTRY ? "single" : "multi"} entry`);
  }
  if (passType.maxValidityDays !== null && input.validUntil.getTime() - input.expectedAt.getTime() > passType.maxValidityDays * 86_400_000) {
    throw new ServiceError(400, `${passType.name} passes last at most ${passType.maxValidityDays} day(s)`);
  }
  const company = input.companyId ? await prisma.company.findFirst({ where: { id: input.companyId, isActive: true } }) : null;
  if (input.companyId && !company) throw new ServiceError(400, "select an active company");
  const zoneIds = [...new Set(input.zoneIds)];
  if (zoneIds.length === 0) throw new ServiceError(400, "select at least one zone");
  const zones = await prisma.zone.count({ where: { id: { in: zoneIds }, isActive: true } });
  if (zones !== zoneIds.length) throw new ServiceError(400, "select active zones");
  // Exit-code zones are resolved against the terminals when the pass is
  // issued (Phase 6); here only their shape is kept.
  const exitCodeZoneIds = input.entryMode === EntryMode.SINGLE_ENTRY ? [...new Set(input.exitCodeZoneIds ?? [])] : [];

  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.visitRequest.create({
      data: {
        hostId,
        origin,
        visitorName: input.visitorName,
        visitorMobile: input.visitorMobile,
        visitorEmail: input.visitorEmail ?? null,
        companyId: company?.id ?? null,
        companyName: company?.name ?? null,
        purpose: input.purpose,
        passTypeId: passType.id,
        zoneIds,
        exitCodeZoneIds,
        entryMode: input.entryMode,
        expectedAt: input.expectedAt,
        validUntil: input.validUntil,
      },
    });
    await tx.visitRequestEvent.create({ data: { requestId: created.id, actorId, actorKind: "OPERATOR", toStatus: VisitRequestStatus.SENT, ...(origin === VisitOrigin.WALK_IN ? { note: "walk-in registered at the gate" } : {}) } });
    await tx.auditLog.create({
      data: auditRow({
        action: AuditAction.VISIT_REQUEST_CREATED,
        entityType: "visit_request",
        entityId: created.id,
        detail: { origin, hostId, visitorName: created.visitorName, visitorMobile: created.visitorMobile, passTypeId: passType.id, zoneIds, entryMode: created.entryMode, expectedAt: created.expectedAt.toISOString() },
        actorId,
      }),
    });
    return created;
  });
  if (origin === VisitOrigin.PLANNED) await sendLink(request, hostId, now);
  return request;
}

/**
 * Issue a fresh link and message it. Any earlier link for the request stops
 * working, so a resend is also how a host kills a link sent to the wrong place.
 */
export async function sendLink(request: VisitRequest, actorId: string | null, now = new Date()) {
  const settings = await getSettings();
  const { token, tokenHash } = newLinkToken();
  const expiresAt = new Date(now.getTime() + settings.linkExpiryHours * 3_600_000);
  await prisma.$transaction([
    prisma.linkToken.updateMany({ where: { requestId: request.id, purpose: LINK_PURPOSE, revokedAt: null }, data: { revokedAt: now } }),
    prisma.linkToken.create({ data: { requestId: request.id, purpose: LINK_PURPOSE, tokenHash, expiresAt } }),
  ]);
  const [{ organizationName }, host] = await Promise.all([getBranding(), prisma.appUser.findUnique({ where: { id: request.hostId }, select: { name: true, email: true } })]);
  const url = `${config.publicPortalUrl}/v/${token}`;
  const hostName = host?.name || host?.email || "your host";
  const intro = request.queryText
    ? `${hostName} at ${organizationName} needs a change to your visit details: "${request.queryText}".`
    : `${hostName} has invited you to ${organizationName} on ${when(request.expectedAt)}.`;
  const body = `${intro} Please complete your details before you arrive: ${url} (valid until ${when(expiresAt)}).`;
  const related = { type: "visit_request", id: request.id };
  await sendMessage({ channel: MessageChannel.SMS, to: request.visitorMobile, template: "VISIT_LINK", body, secrets: [token], related });
  if (request.visitorEmail) {
    await sendMessage({ channel: MessageChannel.EMAIL, to: request.visitorEmail, template: "VISIT_LINK", body, secrets: [token], related });
  }
  await audit(AuditAction.VISIT_LINK_SENT, request.id, { to: [request.visitorMobile, request.visitorEmail].filter(Boolean), expiresAt: expiresAt.toISOString() }, actorId);
  return { expiresAt };
}

export async function resendLink(requestId: string, actorId: string) {
  const request = await prisma.visitRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new ServiceError(404, "visit request not found");
  if (!EDITABLE.includes(request.status)) throw new ServiceError(409, `the request is ${request.status} — nothing for the visitor to complete`);
  return sendLink(request, actorId);
}

export async function cancelVisitRequest(requestId: string, reason: string, actorId: string, now = new Date()) {
  const request = await prisma.visitRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new ServiceError(404, "visit request not found");
  const cancellable: VisitRequestStatus[] = [VisitRequestStatus.SENT, VisitRequestStatus.SUBMITTED, VisitRequestStatus.QUERIED];
  if (!cancellable.includes(request.status)) throw new ServiceError(409, `the request is ${request.status} and can no longer be cancelled`);
  await prisma.$transaction([
    prisma.visitRequest.update({ where: { id: requestId }, data: { status: VisitRequestStatus.CANCELLED } }),
    prisma.linkToken.updateMany({ where: { requestId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.visitRequestEvent.create({ data: { requestId, actorId, actorKind: "OPERATOR", fromStatus: request.status, toStatus: VisitRequestStatus.CANCELLED, note: reason } }),
    prisma.auditLog.create({ data: auditRow({ action: AuditAction.VISIT_REQUEST_CANCELLED, entityType: "visit_request", entityId: requestId, detail: { reason, from: request.status }, actorId }) }),
  ]);
}

/** A request as the console sees it: identity numbers masked (CLAUDE.md #12). */
export function maskSubmission(submission: unknown): Record<string, unknown> | null {
  if (!submission || typeof submission !== "object") return null;
  const out: Record<string, unknown> = { ...(submission as Record<string, unknown>) };
  for (const f of ID_FIELDS) if (typeof out[f] === "string") out[f] = maskId(out[f] as string);
  return out;
}

// ---------------------------------------------------------------------------
// Visitor side
// ---------------------------------------------------------------------------

/**
 * A live link of this purpose. Unknown, replaced and expired links all refuse,
 * with a reason a visitor can act on.
 */
export async function liveLink(token: string, purpose: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new ServiceError(404, "this link is not valid");
  const link = await prisma.linkToken.findUnique({ where: { tokenHash: hashLinkToken(token) } });
  if (!link || link.purpose !== purpose) throw new ServiceError(404, "this link is not valid");
  if (link.revokedAt) throw new ServiceError(410, "this link has been replaced or withdrawn — use the latest link you were sent, or contact your host");
  if (link.expiresAt <= now) throw new ServiceError(410, "this link has expired — ask your host to send a new one");
  return link;
}

/** The request a pre-registration link opens. */
export async function requestForToken(token: string, now = new Date()) {
  const link = await liveLink(token, LINK_PURPOSE, now);
  if (!link.requestId) throw new ServiceError(404, "this link is not valid");
  return requestById(link.requestId);
}
const withPortalData = { host: { select: { name: true, email: true } }, documents: { where: { removedAt: null }, orderBy: { createdAt: "asc" } } } as const;

/** The same view of a request, by id — for the walk-in desk, where the operator is the credential. */
export async function requestById(id: string) {
  const request = await prisma.visitRequest.findUnique({ where: { id }, include: withPortalData });
  if (!request) throw new ServiceError(404, "visit request not found");
  return request;
}
export type PortalRequest = Awaited<ReturnType<typeof requestById>>;

function editable(request: PortalRequest) {
  if (!EDITABLE.includes(request.status)) throw new ServiceError(409, `this visit is ${request.status.toLowerCase()} — the details can no longer be changed`);
}
function verified(request: PortalRequest) {
  if (!request.mobileVerifiedAt) throw new ServiceError(403, "verify your mobile number first");
}

async function ruleSource(passTypeId: string | null): Promise<RuleSource & { name: string }> {
  const type = passTypeId ? await prisma.passType.findUnique({ where: { id: passTypeId } }) : null;
  // A request always names a pass type; a type deleted since is impossible
  // (never deleted), so this is only a guard.
  return type ?? { name: "Visitor", fieldRules: {}, credentialLabel: null };
}

/** What the portal page shows. Before the mobile is verified, only enough to recognise the invitation. */
export async function portalState(request: PortalRequest) {
  const [settings, branding, type] = await Promise.all([getSettings(), getBranding(), ruleSource(request.passTypeId)]);
  const base = {
    organizationName: branding.organizationName,
    hostName: request.host.name || request.host.email,
    expectedAt: request.expectedAt,
    mobileHint: `******${lastDigits(request.visitorMobile).slice(-4)}`,
    status: request.status,
    mobileVerified: Boolean(request.mobileVerifiedAt),
  };
  if (!request.mobileVerifiedAt) return base;
  const consented = settings.privacyNoticeVersion
    ? (await prisma.consentRecord.count({ where: { requestId: request.id, noticeVersion: settings.privacyNoticeVersion } })) > 0
    : false;
  return {
    ...base,
    visitorName: request.visitorName,
    purpose: request.purpose,
    validUntil: request.validUntil,
    passTypeName: type.name,
    queryText: request.status === VisitRequestStatus.QUERIED ? request.queryText : null,
    editable: EDITABLE.includes(request.status),
    returning: Boolean(request.personId),
    notice: { text: settings.privacyNoticeText, version: settings.privacyNoticeVersion },
    consented,
    fields: Object.fromEntries(PORTAL_FIELDS.map((f) => [f, { label: f === "credentialNumber" || f === "credentialExpiresAt" ? `${type.credentialLabel ?? ""} ${f === "credentialNumber" ? "number" : "expiry"}`.trim() : PROFILE_FIELDS[f], rule: ruleFor(type, f) }])),
    details: maskSubmission(request.submission) ?? {},
    hasSelfie: Boolean(request.selfiePath),
    documents: request.documents.map((d) => ({ id: d.id, kind: d.kind, fileName: d.fileName, sizeBytes: d.sizeBytes })),
    documentRules: { maxMb: settings.documentMaxMb, maxCount: settings.documentMaxCount, types: settings.documentTypes },
  };
}

/** Send the mobile code. Metered per request: one a minute, five an hour. */
export async function sendMobileCode(request: PortalRequest, ctx: VisitorContext, now = new Date()) {
  editable(request);
  if (request.mobileVerifiedAt) throw new ServiceError(409, "your mobile number is already verified");
  if (!allow(`otp-min:${request.id}`, 1, 60_000, now.getTime())) throw new ServiceError(429, "a code was just sent — wait a minute before asking for another");
  if (!allow(`otp-hour:${request.id}`, 5, 3_600_000, now.getTime())) throw new ServiceError(429, "too many codes requested — try again later");
  const settings = await getSettings();
  const code = await issueCode(OTP_PURPOSE, request.id, settings.otpTtlMinutes, now);
  const { organizationName } = await getBranding();
  await sendMessage({
    channel: MessageChannel.SMS,
    to: request.visitorMobile,
    template: "MOBILE_OTP",
    body: `${code} is your code to confirm your visit to ${organizationName}. It expires in ${settings.otpTtlMinutes} minutes. Do not share it.`,
    secrets: [code],
    related: { type: "visit_request", id: request.id },
  });
  await audit(AuditAction.VISITOR_OTP_SENT, request.id, { ...who(ctx) }, ctx.actorId);
}

/**
 * Check the mobile code. On success the request is matched to a returning
 * visitor by the verified number — exactly one visitor on file with it — and
 * their saved details prefill the form (identity numbers stay masked).
 */
export async function verifyMobileCode(request: PortalRequest, code: string, ctx: VisitorContext, now = new Date()) {
  editable(request);
  if (request.mobileVerifiedAt) return;
  const settings = await getSettings();
  const result = await checkCode(OTP_PURPOSE, request.id, code, settings.otpMaxAttempts, now);
  if (result !== "OK") {
    await audit(AuditAction.VISITOR_OTP_FAILED, request.id, { ...who(ctx), result }, ctx.actorId);
    const message = {
      WRONG: "that code is not right — check the message and try again",
      EXPIRED: "that code has expired — ask for a new one",
      NO_CODE: "ask for a code first",
      TOO_MANY_ATTEMPTS: "too many wrong attempts — ask for a new code",
    }[result];
    throw new ServiceError(400, message);
  }
  const matches = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM person
    WHERE category = 'VISITOR' AND mobile IS NOT NULL
      AND right(regexp_replace(mobile, '\\D', '', 'g'), 10) = ${lastDigits(request.visitorMobile)}
    LIMIT 2`;
  const personId = matches.length === 1 ? matches[0]!.id : null;
  let submission = request.submission as Prisma.InputJsonValue | null;
  if (personId && !submission) {
    const p = await prisma.person.findUniqueOrThrow({ where: { id: personId } });
    submission = {
      name: p.name,
      email: p.email,
      designation: p.designation,
      govtIdType: p.govtIdType,
      govtIdNumber: p.govtIdNumber,
      aadharNumber: p.aadharNumber,
      panNumber: p.panNumber,
      vehicleNumber: p.vehicleNumber,
      policeClearance: p.policeClearance,
      credentialNumber: p.credentialNumber,
      credentialExpiresAt: p.credentialExpiresAt?.toISOString() ?? null,
    };
  }
  await prisma.$transaction([
    prisma.visitRequest.update({ where: { id: request.id }, data: { mobileVerifiedAt: now, personId, ...(submission ? { submission } : {}) } }),
    audit(AuditAction.VISITOR_MOBILE_VERIFIED, request.id, { ...who(ctx), returningPersonId: personId, ambiguousMatch: matches.length > 1 }, ctx.actorId),
  ]);
}

export async function recordConsent(request: PortalRequest, noticeVersion: string, ctx: VisitorContext) {
  editable(request);
  verified(request);
  const settings = await getSettings();
  if (!settings.privacyNoticeText.trim() || !settings.privacyNoticeVersion) {
    throw new ServiceError(409, "the site has not published its privacy notice yet — please contact your host");
  }
  // The visitor must accept the wording they were shown, not one changed since.
  if (noticeVersion !== settings.privacyNoticeVersion) throw new ServiceError(409, "the privacy notice has just been updated — please read it again");
  await prisma.$transaction([
    prisma.consentRecord.create({ data: { requestId: request.id, noticeVersion, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent?.slice(0, 300) ?? null } }),
    prisma.visitRequest.update({ where: { id: request.id }, data: { consentedAt: new Date() } }),
    audit(AuditAction.VISITOR_CONSENTED, request.id, { ...who(ctx), noticeVersion }, ctx.actorId),
  ]);
}

/**
 * Save the visitor's details (already shape-validated by the route). Hidden
 * fields are dropped; a masked identity number means "keep the one on file".
 * Required fields are checked at submit, so a visitor can save part-way.
 */
export async function saveDetails(request: PortalRequest, details: Record<string, unknown>, ctx: VisitorContext) {
  editable(request);
  verified(request);
  const type = await ruleSource(request.passTypeId);
  const previous = (request.submission ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { name: details.name ?? previous.name ?? request.visitorName };
  for (const f of PORTAL_FIELDS) {
    if (ruleFor(type, f) === "hidden") continue;
    const value = details[f];
    if (value === undefined) {
      if (previous[f] !== undefined) next[f] = previous[f];
    } else if ((ID_FIELDS as readonly string[]).includes(f) && isMasked(value)) {
      next[f] = previous[f] ?? null;
    } else {
      next[f] = value instanceof Date ? value.toISOString() : value;
    }
  }
  await prisma.$transaction([
    prisma.visitRequest.update({ where: { id: request.id }, data: { submission: next as Prisma.InputJsonValue } }),
    audit(AuditAction.VISITOR_DETAILS_SAVED, request.id, { ...who(ctx), fields: Object.keys(next).filter((k) => !blank(next[k])) }, ctx.actorId),
  ]);
  return next;
}

/** Required fields the visitor has not filled yet, as labels. */
export async function missingDetails(request: Pick<VisitRequest, "passTypeId" | "submission">): Promise<string[]> {
  const type = await ruleSource(request.passTypeId);
  const s = (request.submission ?? {}) as Record<string, unknown>;
  const missing: string[] = blank(s.name) ? ["Name"] : [];
  for (const f of PORTAL_FIELDS) if (ruleFor(type, f) === "required" && blank(s[f])) missing.push(PROFILE_FIELDS[f]);
  return missing;
}

export const selfiePathFor = (requestId: string) => path.join(config.documentStoragePath, "requests", requestId, "selfie.jpg");

export async function saveSelfie(request: PortalRequest, jpeg: Buffer, ctx: VisitorContext) {
  editable(request);
  verified(request);
  const file = selfiePathFor(request.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, jpeg);
  await prisma.$transaction([
    prisma.visitRequest.update({ where: { id: request.id }, data: { selfiePath: file } }),
    audit(AuditAction.VISITOR_SELFIE_SAVED, request.id, { ...who(ctx), sizeBytes: jpeg.length }, ctx.actorId),
  ]);
}

export async function addPortalDocument(request: PortalRequest, file: { bytes: Buffer; kind: string; fileName: string; mime: string; ext: string }, ctx: VisitorContext) {
  editable(request);
  verified(request);
  const settings = await getSettings();
  if (settings.documentMaxCount === 0) throw new ServiceError(409, "document uploads are switched off");
  if (request.documents.length >= settings.documentMaxCount) throw new ServiceError(409, `at most ${settings.documentMaxCount} documents — remove one first`);
  const dir = path.join(config.documentStoragePath, "requests", request.id);
  const storedPath = path.join(dir, `${randomUUID()}.${file.ext}`);
  await mkdir(dir, { recursive: true });
  await writeFile(storedPath, file.bytes);
  const doc = await prisma.personDocument.create({
    data: { visitRequestId: request.id, kind: file.kind, fileName: file.fileName, mime: file.mime, sizeBytes: file.bytes.length, storedPath, source: ctx.actorId ? "GATE" : "PORTAL", uploadedById: ctx.actorId ?? null },
  });
  await audit(AuditAction.DOCUMENT_UPLOADED, request.id, { ...who(ctx), documentId: doc.id, kind: doc.kind, fileName: doc.fileName, mime: doc.mime, sizeBytes: doc.sizeBytes }, ctx.actorId);
  return doc;
}

export async function removePortalDocument(request: PortalRequest, documentId: string, ctx: VisitorContext) {
  editable(request);
  verified(request);
  const removed = await prisma.personDocument.updateMany({ where: { id: documentId, visitRequestId: request.id, removedAt: null }, data: { removedAt: new Date() } });
  if (removed.count === 0) throw new ServiceError(404, "document not found");
  await audit(AuditAction.DOCUMENT_REMOVED, request.id, { ...who(ctx), documentId }, ctx.actorId);
}

/** Hand the request to the host. Everything the pass type requires must be there. */
export async function submitRequest(request: PortalRequest, ctx: VisitorContext, notifyHost = true, now = new Date()) {
  editable(request);
  verified(request);
  const settings = await getSettings();
  const consented = settings.privacyNoticeVersion
    ? await prisma.consentRecord.count({ where: { requestId: request.id, noticeVersion: settings.privacyNoticeVersion } })
    : 0;
  if (!consented) throw new ServiceError(409, "accept the privacy notice first");
  const missing = await missingDetails(request);
  if (missing.length) throw new ServiceError(400, `still needed: ${missing.join(", ")}`);
  if (!request.selfiePath) throw new ServiceError(400, "take your photo first");
  await prisma.$transaction([
    prisma.visitRequest.update({ where: { id: request.id }, data: { status: VisitRequestStatus.SUBMITTED } }),
    prisma.visitRequestEvent.create({
      data: { requestId: request.id, actorId: ctx.actorId ?? null, actorKind: ctx.actorId ? "OPERATOR" : "VISITOR", fromStatus: request.status, toStatus: VisitRequestStatus.SUBMITTED, detail: (maskSubmission(request.submission) ?? Prisma.JsonNull) as Prisma.InputJsonValue },
    }),
    audit(AuditAction.VISIT_REQUEST_SUBMITTED, request.id, { ...who(ctx), from: request.status }, ctx.actorId),
  ]);
  if (notifyHost) {
    const name = ((request.submission ?? {}) as { name?: string }).name ?? request.visitorName;
    const lead = request.origin === VisitOrigin.WALK_IN ? `${name} is at the gate to see you` : `${name} has submitted their details for the visit on ${when(request.expectedAt)}`;
    await messageHost(request, "REQUEST_SUBMITTED", `${lead}. Please review the request in the visitor console.`);
  }
  return { submittedAt: now };
}

/** SMS and email the host, whichever they have. */
export async function messageHost(request: Pick<VisitRequest, "id" | "hostId">, template: string, body: string) {
  const host = await prisma.appUser.findUnique({ where: { id: request.hostId }, select: { email: true, phone: true } });
  const related = { type: "visit_request", id: request.id };
  if (host?.phone) await sendMessage({ channel: MessageChannel.SMS, to: host.phone, template, body, related });
  if (host?.email?.includes("@")) await sendMessage({ channel: MessageChannel.EMAIL, to: host.email, template, body, related });
}

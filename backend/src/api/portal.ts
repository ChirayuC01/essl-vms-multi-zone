import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DOCUMENT_SIGNATURES, detectDocumentType, safeFileName } from "../services/documents.js";
import { ServiceError } from "../services/errors.js";
import { allow } from "../services/rate-limit.js";
import { getSettings } from "../services/settings.js";
import {
  addPortalDocument,
  portalState,
  recordConsent,
  removePortalDocument,
  requestForToken,
  saveDetails,
  saveSelfie,
  sendMobileCode,
  verifyMobileCode,
  type PortalRequest,
  type VisitorContext,
} from "../services/visit-requests.js";
import { submitAndDecide } from "../services/visit-review.js";
import { outPassState, verifyExitCode } from "../services/exit-codes.js";
import { jpegDimensions } from "./jpeg.js";
import { aadharNumber, panNumber, profileFields, unlessMasked } from "./people.js";

// The visitor portal's API (two-zone rebuild, Phase 5), mounted at
// /public-api. Unauthenticated: the link token in the path is the only
// credential, and it reaches exactly one visit request. Nothing here can read
// another request, a person, or anything operator-side.
//
// The web app proxies /public-api to here, and the Cloudflare Tunnel (Phase 9)
// exposes only the portal pages and this prefix.

// Per client address: generous for a person filling a form, hopeless for a
// script guessing links.
const PER_MINUTE = 60;

/** The visitor's address. Behind the web proxy (loopback) it is the forwarded one. */
function clientIp(request: FastifyRequest): string {
  const loopback = request.ip === "127.0.0.1" || request.ip === "::1" || request.ip === "::ffff:127.0.0.1";
  const forwarded = request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return loopback && first ? first.slice(0, 64) : request.ip;
}
export function context(request: FastifyRequest): VisitorContext {
  const ua = request.headers["user-agent"];
  return { ip: clientIp(request), userAgent: typeof ua === "string" ? ua.slice(0, 300) : undefined };
}

const emptyIsNull = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? null : v), schema);
const detailsSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    email: emptyIsNull(profileFields.email),
    designation: profileFields.designation,
    govtIdType: profileFields.govtIdType,
    govtIdNumber: emptyIsNull(profileFields.govtIdNumber),
    aadharNumber: unlessMasked(emptyIsNull(aadharNumber.nullable().optional())),
    panNumber: unlessMasked(emptyIsNull(panNumber.nullable().optional())),
    vehicleNumber: profileFields.vehicleNumber,
    policeClearance: profileFields.policeClearance,
    credentialNumber: profileFields.credentialNumber,
    credentialExpiresAt: emptyIsNull(profileFields.credentialExpiresAt),
  })
  .strict();

/**
 * The visitor's steps (code, notice, details, photo, documents, submit) as
 * routes under `base`. Mounted twice: on the portal, where the link token
 * finds the request and the visitor acts; and on the walk-in desk (Phase 6),
 * where Security acts on the visitor's behalf and is the audited actor.
 */
export function visitorStepRoutes(
  app: FastifyInstance,
  base: string,
  resolve: (request: FastifyRequest) => Promise<PortalRequest>,
  ctxOf: (request: FastifyRequest) => VisitorContext,
): void {
  app.get(`${base}`, async (request) => portalState(await resolve(request)));

  app.post(`${base}/otp`, async (request) => {
    await sendMobileCode(await resolve(request), ctxOf(request));
    return { sent: true };
  });

  app.post(`${base}/otp/verify`, async (request) => {
    const body = z.object({ code: z.string().trim().regex(/^\d{4,8}$/, "enter the code from the message") }).safeParse(request.body);
    if (!body.success) throw new ServiceError(400, "enter the code from the message");
    const visit = await resolve(request);
    await verifyMobileCode(visit, body.data.code, ctxOf(request));
    return portalState(await resolve(request));
  });

  app.post(`${base}/consent`, async (request) => {
    const body = z.object({ noticeVersion: z.string().min(1).max(60), accept: z.literal(true) }).safeParse(request.body);
    if (!body.success) throw new ServiceError(400, "tick the box to accept the privacy notice");
    await recordConsent(await resolve(request), body.data.noticeVersion, ctxOf(request));
    return { consented: true };
  });

  app.put(`${base}/details`, async (request, reply) => {
    const body = detailsSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "validation", issues: body.error.issues });
    await saveDetails(await resolve(request), body.data, ctxOf(request));
    return portalState(await resolve(request));
  });

  // The portal normalises the camera frame to 480x640 before sending it
  // (CLAUDE.md #5), so anything else is not from the portal's camera step.
  app.post(`${base}/selfie`, async (request) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > 2 * 1024 * 1024) throw new ServiceError(400, "send the photo from the camera step");
    const dims = jpegDimensions(body);
    if (!dims || dims.width !== 480 || dims.height !== 640) throw new ServiceError(400, "the photo must come from the camera step (480x640 JPEG)");
    await saveSelfie(await resolve(request), body, ctxOf(request));
    return { saved: true };
  });

  app.post(`${base}/documents`, async (request, reply) => {
    const query = z.object({ kind: z.string().trim().min(1).max(60), fileName: z.string().max(200).optional() }).safeParse(request.query);
    if (!query.success) throw new ServiceError(400, "say what the document is (e.g. Govt ID)");
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new ServiceError(400, "choose a file");
    const settings = await getSettings();
    if (body.length > settings.documentMaxMb * 1024 * 1024) throw new ServiceError(413, `the file is larger than ${settings.documentMaxMb} MB`);
    const type = detectDocumentType(body, settings.documentTypes);
    if (!type) throw new ServiceError(415, `only ${settings.documentTypes.map((t) => t.toUpperCase()).join(", ")} files are accepted`);
    const sig = DOCUMENT_SIGNATURES[type];
    const doc = await addPortalDocument(
      await resolve(request),
      { bytes: body, kind: query.data.kind, fileName: safeFileName(query.data.fileName, sig.ext), mime: sig.mime, ext: sig.ext },
      ctxOf(request),
    );
    return reply.code(201).send({ id: doc.id, kind: doc.kind, fileName: doc.fileName, sizeBytes: doc.sizeBytes });
  });

  app.delete(`${base}/documents/:docId`, async (request) => {
    const { docId } = request.params as { docId: string };
    await removePortalDocument(await resolve(request), docId, ctxOf(request));
    return { removed: true };
  });

  app.post(`${base}/submit`, async (request) => {
    const visit = await resolve(request);
    const ctx = ctxOf(request);
    const result = await submitAndDecide(visit, ctx);
    // The visitor learns only the outcome; why an automatic pass failed (an
    // ID clash, say) is for the operator at the desk and the host.
    return ctx.actorId ? result : { status: result.status, awaitingHost: result.awaitingHost };
  });
}

const tokenOf = (request: FastifyRequest) => (request.params as { token: string }).token;

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!allow(`portal-ip:${clientIp(request)}`, PER_MINUTE, 60_000)) {
      return reply.code(429).send({ error: "too many requests — wait a minute and try again" });
    }
    void reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
  });
  visitorStepRoutes(app, "/v/:token", (request) => requestForToken(tokenOf(request)), context);

  // The out-pass (Phase 7): the visitor enters the exit code their host gave them.
  app.get("/out/:token", async (request) => outPassState(tokenOf(request)));
  app.post("/out/:token/verify", async (request) => {
    const body = z.object({ code: z.string().trim().regex(/^\d{4,8}$/) }).safeParse(request.body);
    if (!body.success) throw new ServiceError(400, "enter the exit code");
    return verifyExitCode(tokenOf(request), body.data.code, context(request));
  });
}

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
  submitRequest,
  verifyMobileCode,
  type VisitorContext,
} from "../services/visit-requests.js";
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
function context(request: FastifyRequest): VisitorContext {
  const ua = request.headers["user-agent"];
  return { ip: clientIp(request), userAgent: typeof ua === "string" ? ua.slice(0, 300) : undefined };
}

const emptyIsNull = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? null : v), schema);
const detailsSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    companyId: z.string().trim().max(100).transform((v) => v || null).nullable().optional(),
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

const tokenOf = (request: FastifyRequest) => (request.params as { token: string }).token;

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!allow(`portal-ip:${clientIp(request)}`, PER_MINUTE, 60_000)) {
      return reply.code(429).send({ error: "too many requests — wait a minute and try again" });
    }
    void reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
  });

  app.get("/v/:token", async (request) => portalState(await requestForToken(tokenOf(request))));

  app.post("/v/:token/otp", async (request) => {
    await sendMobileCode(await requestForToken(tokenOf(request)), context(request));
    return { sent: true };
  });

  app.post("/v/:token/otp/verify", async (request) => {
    const body = z.object({ code: z.string().trim().regex(/^\d{4,8}$/, "enter the code from the message") }).safeParse(request.body);
    if (!body.success) throw new ServiceError(400, "enter the code from the message");
    const visit = await requestForToken(tokenOf(request));
    await verifyMobileCode(visit, body.data.code, context(request));
    return portalState(await requestForToken(tokenOf(request)));
  });

  app.post("/v/:token/consent", async (request) => {
    const body = z.object({ noticeVersion: z.string().min(1).max(60), accept: z.literal(true) }).safeParse(request.body);
    if (!body.success) throw new ServiceError(400, "tick the box to accept the privacy notice");
    await recordConsent(await requestForToken(tokenOf(request)), body.data.noticeVersion, context(request));
    return { consented: true };
  });

  app.put("/v/:token/details", async (request, reply) => {
    const body = detailsSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "validation", issues: body.error.issues });
    await saveDetails(await requestForToken(tokenOf(request)), body.data, context(request));
    return portalState(await requestForToken(tokenOf(request)));
  });

  // The portal normalises the camera frame to 480x640 before sending it
  // (CLAUDE.md #5), so anything else is not from the portal's camera step.
  app.post("/v/:token/selfie", async (request) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > 2 * 1024 * 1024) throw new ServiceError(400, "send the photo from the camera step");
    const dims = jpegDimensions(body);
    if (!dims || dims.width !== 480 || dims.height !== 640) throw new ServiceError(400, "the photo must come from the camera step (480x640 JPEG)");
    await saveSelfie(await requestForToken(tokenOf(request)), body, context(request));
    return { saved: true };
  });

  app.post("/v/:token/documents", async (request, reply) => {
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
      await requestForToken(tokenOf(request)),
      { bytes: body, kind: query.data.kind, fileName: safeFileName(query.data.fileName, sig.ext), mime: sig.mime, ext: sig.ext },
      context(request),
    );
    return reply.code(201).send({ id: doc.id, kind: doc.kind, fileName: doc.fileName, sizeBytes: doc.sizeBytes });
  });

  app.delete("/v/:token/documents/:docId", async (request) => {
    const { docId } = request.params as { docId: string };
    await removePortalDocument(await requestForToken(tokenOf(request)), docId, context(request));
    return { removed: true };
  });

  app.post("/v/:token/submit", async (request) => {
    const visit = await requestForToken(tokenOf(request));
    return submitRequest(visit, context(request));
  });
}

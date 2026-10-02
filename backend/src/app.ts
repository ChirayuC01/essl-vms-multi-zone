import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { Prisma } from "@prisma/client";
import { config } from "./config/index.js";
import { assertDatabaseReachable } from "./db/index.js";
import { admsRoutes } from "./adms/routes.js";
import { authRoutes, requireAuth } from "./api/auth.js";
import { brandingAdminRoutes, brandingPublicRoutes } from "./api/branding.js";
import { commandRoutes } from "./api/commands.js";
import { deviceRoutes } from "./api/devices.js";
import { directoryRoutes } from "./api/directories.js";
import { enrollmentRoutes } from "./api/enrollments.js";
import { employeeAccessRoutes } from "./api/employee-access.js";
import { entryRoutes } from "./api/entries.js";
import { eventRoutes } from "./api/events.js";
import { licenseRoutes } from "./api/license.js";
import { operatorRoutes } from "./api/operators.js";
import { punchRoutes } from "./api/punches.js";
import { reportRoutes } from "./api/reports.js";
import { setupRoutes } from "./api/setup.js";
import { personRoutes } from "./api/people.js";
import { zoneRoutes } from "./api/zones.js";
import { ServiceError } from "./services/errors.js";
import { getLicenseStatus } from "./services/license.js";
import { VMS_VERSION } from "./version.js";

/**
 * Human-readable logs when a person is watching, raw JSON otherwise.
 *
 * Operating this system means reading its log — a punch arriving, a window
 * closing, a command failing — and a wall of JSON makes that materially
 * harder. A collector wants the opposite, so production keeps JSON.
 *
 * `pino-pretty` is a devDependency, so a production install will not have it.
 * Rather than let that become a crash at startup in the one environment that
 * matters most, an unavailable formatter degrades to JSON. A missing pretty
 * printer is a cosmetic problem; a service that will not boot is not.
 */
function prettyTransport(): { transport?: { target: string; options: object } } {
  if (!config.logPretty) return {};
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
  } catch {
    return {};
  }
  return {
    transport: {
      target: "pino-pretty",
      options: { translateTime: "HH:MM:ss", ignore: "pid,hostname,reqId" },
    },
  };
}

/**
 * Build the fully wired application without listening on a port.
 *
 * Separated from startup so verification can drive the real app through
 * `app.inject()` — same routes, same hooks, same error handling — instead of
 * a parallel test harness that can drift from what actually runs.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel, ...prettyTransport() },
    // BIOPHOTO uploads are ~59 KB base64 but other biometric payloads can be
    // far larger; the Phase 0 reference used 20 MB and never hit it.
    bodyLimit: 20 * 1024 * 1024,
  });

  await mkdir(config.photoStoragePath, { recursive: true });

  // The operator UI is served from a different origin (Next dev on :3000, a
  // static host later), so the browser needs CORS. Origins are configuration
  // — never a wildcard with credentials, never a hardcoded client address.
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(jwt, { secret: config.jwtSecret });

  // Non-JSON bodies arrive as raw buffers everywhere: the device sends
  // unusual or absent content-types, and photo uploads are raw image/jpeg.
  // application/json keeps Fastify's built-in parser (exact match wins).
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/health", async () => {
    const db = await assertDatabaseReachable();
    return {
      status: "ok",
      version: VMS_VERSION,
      database: "reachable",
      postgres: db.serverVersion,
    };
  });

  // Service-layer refusals carry the status the API should answer with, so a
  // rule enforced for a job is enforced identically for a request.
  //
  // Must be set BEFORE the routes are registered: a plugin inherits whatever
  // handler its parent had at registration time, so setting this afterwards
  // leaves every route on Fastify's default handler.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof ServiceError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return reply.code(409).send({ error: "conflict — that operation is already in progress" });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, "unhandled error");
      return reply.code(status).send({ error: "internal error" });
    }
    return reply.code(status).send({ error: err.message });
  });

  // Device endpoints are NEVER authenticated: a terminal cannot present a
  // token, and gating them would take the barrier down (CLAUDE.md #9).
  await app.register(admsRoutes);

  // Login is public; everything else under /api requires a bearer token.
  await app.register(authRoutes, { prefix: "/api" });
  // Also public — self-gated: only usable while zero operators exist.
  await app.register(setupRoutes, { prefix: "/api" });
  await app.register(brandingPublicRoutes, { prefix: "/api" });
  await app.register(
    async (api) => {
      api.addHook("preHandler", requireAuth);
      api.addHook("preHandler", async (request, reply) => {
        if (
          request.url.startsWith("/api/license") ||
          request.url.startsWith("/license") ||
          request.routeOptions.url === "/api/auth/change-password"
        ) return;
        const license = await getLicenseStatus(new Date(), true);
        if (license.expired) {
          return reply.code(402).send({ error: "LICENSE_EXPIRED", expiresAt: license.expiresAt });
        }
      });
      await api.register(personRoutes);
      await api.register(directoryRoutes);
      await api.register(employeeAccessRoutes);
      await api.register(entryRoutes);
      await api.register(commandRoutes);
      await api.register(deviceRoutes);
      await api.register(zoneRoutes);
      await api.register(punchRoutes);
      await api.register(enrollmentRoutes);
      await api.register(operatorRoutes);
      await api.register(reportRoutes);
      await api.register(licenseRoutes);
      await api.register(brandingAdminRoutes);
    },
    { prefix: "/api" },
  );
  // Registered outside the guarded scope because it authenticates itself:
  // EventSource cannot set an Authorization header, so the stream accepts
  // ?token= instead.
  await app.register(eventRoutes, { prefix: "/api" });

  // A silent 404 is indistinguishable from a dead network — this is how the
  // .aspx suffix was found. Unknown /iclock paths get logged and answered OK
  // (the device treats any non-OK as a dead server); everything else 404s
  // normally for the operator API's sake.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/iclock")) {
      request.log.warn(
        { method: request.method, url: request.url },
        "UNHANDLED device path — protocol variant? Investigate, never ignore",
      );
      void reply.type("text/plain").send("OK");
      return;
    }
    void reply.code(404).send({ error: "not found" });
  });

  return app;
}

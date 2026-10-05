import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { effectivePermissions } from "../services/access.js";
import { prisma } from "../db/index.js";
import { AuditAction, auditRow } from "../db/audit.js";

// Operator authentication (Phase 1 M5; revocation added Phase 4 M17).
//
// The device endpoints under /iclock are NEVER guarded. A terminal cannot
// present a token, and gating them would take the barrier down.

const SCRYPT_KEYLEN = 64;

/**
 * The only routes reachable while a forced password change is outstanding.
 * Matched on the route PATTERN, not the request URL, so a query string or a
 * path parameter cannot be used to slip past it.
 */
const PASSWORD_CHANGE_ALLOWED = new Set(["GET /api/auth/me", "POST /api/auth/change-password"]);

/** Hash format written by prisma/seed.ts: scrypt$<saltHex>$<hashHex>. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  // Constant-time: a length-dependent or short-circuiting compare leaks the
  // hash a byte at a time to anyone who can measure the response.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface TokenPayload {
  sub: string;
  email: string;
  role: string;
}

/** The operator behind this request, resolved from the database by requireAuth. */
export interface Operator {
  id: string;
  email: string;
  /** Role key (Role.key). What it may do is resolved from the access grid. */
  role: string;
}

declare module "fastify" {
  interface FastifyRequest {
    // Present on every authenticated operator request. Absent on /iclock,
    // which is deliberately unauthenticated.
    operator?: Operator;
  }
}

const loginSchema = z.object({
  email: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});

export const profileSchema = z
  .object({
    name: z.string().trim().max(100).transform((value) => value || null),
    phone: z.string().trim().max(30).transform((value) => value || null),
  })
  .strict();

/**
 * Guard for the operator API. Reads the bearer token, or `?token=` for the
 * SSE stream only — EventSource cannot set request headers, and the
 * alternative (a cookie) would need CSRF handling for no benefit on a LAN.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const queryToken = (request.query as { token?: string } | undefined)?.token;
    if (!request.headers.authorization && queryToken) {
      request.headers.authorization = `Bearer ${queryToken}`;
    }
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "authentication required" });
  }

  // The account is re-read on EVERY request, and this is the point of the
  // whole function rather than an optimisation to remove later.
  //
  // Verifying the signature alone means the token keeps working for its full
  // twelve hours after the account is disabled — so "we removed their access"
  // would have been false for most of a working day, in a system whose entire
  // job is controlling who gets through a door. It also means a role change
  // does not take effect until the operator signs in again, which is the
  // wrong way round for a demotion.
  //
  // The cost is one indexed lookup on the operator API only. The device path
  // (/iclock) is unauthenticated and never reaches here, so the getrequest
  // query budget that makes a remote database viable is untouched.
  const payload = request.user as TokenPayload;
  const user = await prisma.appUser.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, role: true, isActive: true, mustChangePassword: true },
  });
  if (!user || !user.isActive) {
    request.log.warn(
      { userId: payload.sub, email: payload.email },
      "token presented for an account that is disabled or gone",
    );
    return reply.code(401).send({ error: "account is no longer active" });
  }

  request.operator = { id: user.id, email: user.email, role: user.role };

  // A temporary password is one somebody else typed and therefore knows. If
  // the account could keep working with it, "temporary" would mean nothing —
  // so until it is changed the only things reachable are seeing who you are
  // and changing it. Blocking at the guard rather than in the UI matters:
  // the API is the boundary, and a client that skipped the change screen
  // would otherwise have a fully working session.
  if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(`${request.method} ${request.routeOptions.url ?? ""}`)) {
    return reply.code(403).send({
      error: "you must change your password before continuing",
      mustChangePassword: true,
    });
  }
}

export function actorId(request: FastifyRequest): string | undefined {
  // Prefers the database-resolved operator; falls back to the token for the
  // narrow window before requireAuth has run.
  return request.operator?.id ?? (request.user as TokenPayload | undefined)?.sub;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "email and password are required" });
    }
    const { email, password } = parsed.data;

    const user = await prisma.appUser.findUnique({
      where: { email: email.toLowerCase() },
    });

    // One message for every failure mode. Distinguishing "no such user" from
    // "wrong password" hands an attacker a list of valid operator accounts.
    const ok = user !== null && user.isActive && verifyPassword(password, user.passwordHash);
    if (!ok || !user) {
      request.log.warn({ email }, "failed login attempt");
      return reply.code(401).send({ error: "invalid email or password" });
    }

    const token = await reply.jwtSign(
      { sub: user.id, email: user.email, role: user.role } satisfies TokenPayload,
      { expiresIn: "12h" },
    );
    request.log.info({ userId: user.id, email: user.email }, "operator signed in");
    return reply.send({
      token,
      user: { id: user.id, email: user.email, role: user.role },
      // The client needs this to route straight to the change screen rather
      // than letting someone reach a dashboard that will 403 on every call.
      mustChangePassword: user.mustChangePassword,
    });
  });

  // requireAuth has already re-read the account and rejected it if disabled,
  // so this only has to report what it found.
  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const operator = request.operator as Operator;
    const fresh = await prisma.appUser.findUnique({
      where: { id: operator.id },
      select: { name: true, phone: true, mustChangePassword: true, passwordChangedAt: true, createdAt: true },
    });
    return reply.send({
      id: operator.id,
      email: operator.email,
      name: fresh?.name ?? null,
      phone: fresh?.phone ?? null,
      role: operator.role,
      permissions: [...(await effectivePermissions(operator.id, operator.role))].sort(),
      mustChangePassword: fresh?.mustChangePassword ?? false,
      passwordChangedAt: fresh?.passwordChangedAt ?? null,
      createdAt: fresh?.createdAt ?? null,
    });
  });

  app.patch("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid profile" });
    }
    const operator = request.operator as Operator;
    const updated = await prisma.appUser.update({ where: { id: operator.id }, data: parsed.data });
    await prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.OPERATOR_UPDATED,
        entityType: "app_user",
        entityId: operator.id,
        detail: { self: true, fields: ["name", "phone"] },
        actorId: operator.id,
      }),
    });
    return reply.send({ id: updated.id, email: updated.email, name: updated.name, phone: updated.phone, role: updated.role });
  });
}

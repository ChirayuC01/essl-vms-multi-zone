import type { TokenPayload } from "../api/auth.js";

// @fastify/jwt needs to be told what a verified token contains, so
// request.user is typed rather than `any` at every call site.
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: TokenPayload;
    user: TokenPayload;
  }
}

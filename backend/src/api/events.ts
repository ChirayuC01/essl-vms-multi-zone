import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db/index.js";
import { requireAuth } from "./auth.js";
import { Permission, requirePermission } from "./permissions.js";
import { subscribe, type VmsEventName } from "../events/bus.js";
import { getLicenseStatus } from "../services/license.js";

// Server-Sent Events (Phase 1 Milestone 5).
//
// SSE rather than WebSockets: the traffic is one-directional (server pushes
// punches and command transitions), it survives proxies as plain HTTP, and
// the browser reconnects on its own. A WebSocket would add a protocol and a
// keepalive story for nothing.

const HEARTBEAT_MS = 25_000;
const STREAMED: VmsEventName[] = ["punch", "command", "entry"];

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/events",
    { preHandler: [
      requireAuth,
      requirePermission(Permission.READ),
      async (_request, reply) => {
        const license = await getLicenseStatus(new Date(), true);
        if (license.expired) return reply.code(402).send({ error: "LICENSE_EXPIRED", expiresAt: license.expiresAt });
      },
    ] },
    (request, reply) => {
      // Tell Fastify this response is ours to manage, then write the head
      // ourselves so the stream stays open.
      //
      // Carrying reply.getHeaders() across is load-bearing, not tidiness:
      // @fastify/cors sets Access-Control-Allow-Origin on the *Fastify reply*,
      // and those headers are only flushed by reply.send(). Writing straight to
      // reply.raw would drop them, and a browser silently refuses a
      // cross-origin EventSource with no CORS header — the stream never opens,
      // which looks like a permanently reconnecting feed rather than an error.
      const inherited: OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) inherited[key] = value;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        ...inherited,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Nginx and friends buffer by default, which turns a live feed into a
        // feed that arrives in one lump minutes later.
        "X-Accel-Buffering": "no",
      });

      const send = (event: string, data: unknown): void => {
        if (reply.raw.writableEnded) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Tell the browser how fast to come back, then confirm the stream is live
      // so the UI can show "connected" rather than guessing.
      reply.raw.write("retry: 3000\n\n");
      send("ready", { at: new Date().toISOString() });

      const unsubscribers = STREAMED.map((name) => subscribe(name, (payload) => send(name, payload)));

      // Without traffic an idle proxy or NAT will drop the connection silently;
      // a comment line is the cheapest thing that keeps it open.
      //
      // The heartbeat also RE-CHECKS THE ACCOUNT, and that is the point rather
      // than a bonus. Every other route re-reads the operator on each request,
      // so disabling someone locks them out on their next click. A stream is
      // authorised once, at connect, and then lives for hours — so without
      // this a revoked operator keeps receiving punches, entry transitions and
      // command outcomes until they happen to close the tab. "Revocation is
      // immediate" has to hold for the long-lived connection too, or it is not
      // a property of the system, only a description of short requests.
      const operatorId = request.operator?.id;
      const heartbeat = setInterval(() => {
        if (reply.raw.writableEnded) return;
        void (async () => {
          const live = operatorId
            ? await prisma.appUser.findUnique({
                where: { id: operatorId },
                select: { isActive: true },
              })
            : null;
          const license = await getLicenseStatus(new Date(), true);
          if (!live?.isActive || license.expired) {
            const reason = !live?.isActive ? "account is no longer active" : "license expired";
            request.log.info({ operatorId, reason }, "closing event stream");
            send("revoked", { reason });
            close();
            reply.raw.end();
            return;
          }
          reply.raw.write(`: ping ${Date.now()}\n\n`);
        })();
      }, HEARTBEAT_MS);
      heartbeat.unref();

      const close = (): void => {
        clearInterval(heartbeat);
        for (const off of unsubscribers) off();
      };
      request.raw.on("close", close);
      request.raw.on("error", close);
    },
  );
}

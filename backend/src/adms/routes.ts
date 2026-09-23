import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CommandType } from "@prisma/client";
import { ingestCdataBody } from "./ingest.js";
import { parseDevicecmdReply } from "./parsers.js";
import { onCommandResolved } from "../services/entries.js";
import { nextWireCommand, resolveDeviceReply, startQueueMaintenance } from "./queue.js";
import {
  getDeviceBySn,
  markSeen,
  updateDeviceFromInfo,
  updateStamps,
} from "./registry.js";

// The four ADMS endpoints, served in BOTH plain and .aspx forms (this
// firmware calls .aspx; others may not). Wire behaviours mirror the proven
// Phase 0 reference implementation (docs/reference/adms-test-server):
//   - every response is text/plain
//   - "OK" is the affirmative/empty answer
//   - unknown /iclock paths are logged loudly and answered OK, never 404'd —
//     a silent 404 is indistinguishable from a dead network

interface AdmsQuery {
  SN?: string;
  table?: string;
  Stamp?: string;
  OpStamp?: string;
  INFO?: string;
}

function ok(reply: FastifyReply, body = "OK"): void {
  void reply.type("text/plain").send(body);
}

function bodyText(request: FastifyRequest): string {
  const b = request.body;
  if (Buffer.isBuffer(b)) return b.toString("utf8");
  if (typeof b === "string") return b;
  return "";
}

export async function admsRoutes(app: FastifyInstance): Promise<void> {
  // NOTE: the raw-buffer content-type parser these routes depend on is
  // registered at the ROOT instance (index.ts) — Fastify parsers are scoped,
  // and the person photo upload endpoint needs the same treatment.

  startQueueMaintenance((err) => app.log.error({ err }, "queue timeout sweep failed"));

  const register = (name: string, handler: (req: FastifyRequest, rep: FastifyReply) => Promise<void>) => {
    for (const url of [`/iclock/${name}`, `/iclock/${name}.aspx`]) {
      app.route({ method: ["GET", "POST"], url, handler });
    }
  };

  // 1) Data push / check-in
  register("cdata", async (request, reply) => {
    const q = request.query as AdmsQuery;
    if (!q.SN) return ok(reply);
    const device = await getDeviceBySn(q.SN, request.log);
    if (!device) return ok(reply); // logged as unregistered by the registry
    markSeen(device, (err) => request.log.error({ err }, "last_seen update failed"));

    // The handshake is a GET (the device asks for its configuration); data
    // pushes are POSTs. They were indistinguishable in the log, which made
    // the one request that decides incremental-sync behaviour invisible.
    //
    // We answer it with a bare "OK", and so did the Phase 0 reference server
    // that proved every capability on this hardware — so nothing this
    // firmware *requires* is missing. What is unknown is whether it would
    // honour a Stamp we sent back, which is the difference between being able
    // to ask for lost punches again and not. Logged verbatim so the question
    // can be answered by observation rather than by guessing at a format.
    if (request.method === "GET") {
      request.log.info(
        { device: device.serialNo, query: request.query, url: request.url },
        "device handshake (cdata GET) — answered OK; verbatim query recorded for M13",
      );
      return ok(reply);
    }

    const text = bodyText(request);
    if (text) await ingestCdataBody(device, q.table, text, request.log);

    // Logged as a transition, not a value: whether these advance, reset, or
    // sit still is the whole question, and a single number tells you nothing.
    if (q.Stamp !== undefined || q.OpStamp !== undefined) {
      if (q.Stamp !== device.lastStamp || q.OpStamp !== device.lastOpStamp) {
        request.log.info(
          {
            device: device.serialNo,
            table: q.table,
            stamp: { from: device.lastStamp, to: q.Stamp ?? null },
            opStamp: { from: device.lastOpStamp, to: q.OpStamp ?? null },
          },
          "incremental-sync markers moved",
        );
      }
    }
    await updateStamps(device, q.Stamp, q.OpStamp);
    ok(reply);
  });

  // 2) Command poll — the hot path. One DB round trip (the claim); device
  //    lookup is cached and last-seen writes are throttled.
  register("getrequest", async (request, reply) => {
    const q = request.query as AdmsQuery;
    if (!q.SN) return ok(reply);
    const device = await getDeviceBySn(q.SN, request.log);
    if (!device) return ok(reply);
    markSeen(device, (err) => request.log.error({ err }, "last_seen update failed"));

    // After executing a command the device appends its state as &INFO=<csv>.
    // Semantics of the positional fields are unverified — log, don't guess.
    if (q.INFO) request.log.debug({ info: q.INFO }, "poll carried device state");

    const cmd = await nextWireCommand(device.id);
    if (cmd) {
      request.log.info(
        { device: device.serialNo, wireId: cmd.deviceCmdId, type: cmd.type, bytes: cmd.body.length },
        "command dispatched",
      );
      return ok(reply, cmd.body);
    }
    ok(reply);
  });

  // 3) Command results: ID=<n>&Return=<code>&CMD=<name>
  register("devicecmd", async (request, reply) => {
    const q = request.query as AdmsQuery;
    if (!q.SN) return ok(reply);
    const device = await getDeviceBySn(q.SN, request.log);
    if (!device) return ok(reply);
    markSeen(device, (err) => request.log.error({ err }, "last_seen update failed"));

    const text = bodyText(request) || new URLSearchParams(request.query as Record<string, string>).toString();
    const parsed = parseDevicecmdReply(text);

    if (parsed.id !== null) {
      const { command } = await resolveDeviceReply(device.id, parsed.id, parsed.returnCode);
      if (!command) {
        request.log.warn(
          { wireId: parsed.id, returnCode: parsed.returnCode },
          "devicecmd reply matched no in-flight command (late or replayed ack)",
        );
      } else {
        request.log.info(
          { wireId: parsed.id, type: command.type, status: command.status },
          "command acknowledged",
        );
        // An INFO reply carries the capability dump in the same body.
        if (command.type === CommandType.DEVICE_INFO) {
          const kv = await updateDeviceFromInfo(device, text);
          request.log.info(
            { faceCount: kv["FaceCount"], maxFaces: kv["~MaxFaceCount"], fw: kv["FWVersion"] },
            "device INFO applied",
          );
        }
        // The acknowledgement is what advances the authorization lifecycle —
        // an entry becomes PROVISIONED because the device said so, never
        // because the server hoped so.
        await onCommandResolved(command, request.log);
      }
    } else {
      request.log.debug({ body: text.slice(0, 400) }, "devicecmd without ID");
    }
    ok(reply);
  });

  // 4) Biometric/photo payload uploads — same record grammar as cdata.
  register("fdata", async (request, reply) => {
    const q = request.query as AdmsQuery;
    if (!q.SN) return ok(reply);
    const device = await getDeviceBySn(q.SN, request.log);
    if (!device) return ok(reply);
    markSeen(device, (err) => request.log.error({ err }, "last_seen update failed"));

    const text = bodyText(request);
    request.log.info({ bytes: text.length }, "fdata received");
    if (text) await ingestCdataBody(device, undefined, text, request.log);
    ok(reply);
  });
}

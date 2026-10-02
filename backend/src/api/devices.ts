import type { FastifyInstance } from "fastify";
import { CommandStatus, CommandType, DeviceRole, type Prisma } from "@prisma/client";
import { z } from "zod";
import { config } from "../config/index.js";
import { enqueue } from "../adms/queue.js";
import { dropUnknownDevice, invalidateDevice, listUnknownDevices } from "../adms/registry.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { collectAlerts } from "../services/alerts.js";
import { listScans, startScan, stopScan, type ScanPlan } from "../services/backfill.js";
import { parseUserId, patternsOverlap, userIdKey } from "../user-id.js";
import { parseIdList } from "./id-list.js";
import { faceCountDrift, punchGaps, reconcileSweep, setPunchBaseline } from "../services/reconcile.js";
import { actorId } from "./auth.js";
import { Permission, requirePermission } from "./permissions.js";

// Device status for operators (and the Milestone 5 UI).
//
// Everything identifying here — capacity, firmware, algorithm — comes from
// the device's own INFO response, never from a spec sheet or a label. Three
// printed claims have already proven wrong.

// The device polls every 1-3 s after activity and about every 30 s when idle,
// so sustained silence is meaningful rather than normal.
//
// Detection is slower than this number alone suggests, and deliberately so:
// last_seen_at writes are throttled to one per 20 s per device to protect the
// hot path, so the stored timestamp already lags reality by up to that much.
// Real detection is therefore the threshold plus up to 20 s. Do not chase a
// faster figure by writing last_seen_at on every poll — that spends the
// getrequest budget (CLAUDE.md #4) to make a status badge twitchier.
const OFFLINE_AFTER_MS = config.deviceOfflineAfterSeconds * 1000;

/** Read one numeric key out of a stored INFO reply, or null if absent. */
function infoNumber(info: unknown, key: string): number | null {
  const raw = (info as Record<string, string> | null)?.[key];
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) ? n : null;
}

// Punch-state codes are small non-negative integers (0 = Check-In and
// 1 = Check-Out observed on ZAM180; the rest of the list runs to 5). Bounded
// generously rather than pinned to the states this firmware happens to have.
const statusCodes = z.array(z.number().int().min(0).max(255)).min(1).max(16);

// Group IDs are deliberately left at the schema's own defaults (1 / 100)
// rather than accepted here — they're already editable via PATCH below, and
// duplicating that validation for a field that's right the vast majority of
// the time (CLAUDE.md: numbering may vary, but 1/100 is what's been seen on
// every device to date) would just be two places to keep in sync.
const createDeviceSchema = z.object({
  serialNo: z.string().trim().min(1).max(50),
  name: z.string().min(1).max(80).optional(),
  ip: z.string().min(1).max(64).optional(),
  role: z.nativeEnum(DeviceRole).optional(),
});

const deviceSettingsSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  role: z.nativeEnum(DeviceRole).optional(),
  // null takes the terminal out of every zone.
  zoneId: z.string().min(1).nullable().optional(),
  timezoneOffsetMinutes: z.number().int().min(-720).max(840).optional(),
  inStatusCodes: statusCodes.optional(),
  outStatusCodes: statusCodes.optional(),
  // Mirrors Menu > System > Attendance; nullable because "not established"
  // is a distinct state from "known to be zero".
  duplicatePunchPeriodMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  employeeIdPatterns: z.array(z.string().regex(/^[A-Za-z0-9*]+$/)).max(20).optional(),
  visitorIdPatterns: z.array(z.string().regex(/^[A-Za-z0-9*]+$/)).max(20).optional(),
});

// Range bounds are the operator's, not anything this system configures: the
// PINs an existing terminal already used were chosen by whoever set it up,
// long before this system had an opinion about numbering.
// Three ways to say which IDs to ask about. A numeric roster is a range with
// no prefix; a real alphanumeric roster is a prefix and a zero-padded counter
// (`WCTPL001`..`WCTPL999`); anything without structure is a list, pasted or
// read out of an uploaded file. See services/backfill.ts.
const scanSchema = z.union([
  z.object({
    startPin: z.number().int().min(1),
    endPin: z.number().int().min(1),
    prefix: z.string().regex(/^[A-Za-z0-9]*$/).optional(),
    pad: z.number().int().min(0).max(12).optional(),
  }),
  z.object({
    ids: z.array(z.string()).min(1),
  }),
]);

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/devices", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    const devices = await prisma.device.findMany({ orderBy: { createdAt: "asc" } });

    // One grouped query for all devices rather than a count per device —
    // per-row queries are banned on a possibly-remote database.
    const counts = await prisma.syncCommand.groupBy({
      by: ["targetDeviceId", "status"],
      _count: { _all: true },
    });
    const byDevice = new Map<string, Record<string, number>>();
    for (const row of counts) {
      const bucket = byDevice.get(row.targetDeviceId) ?? {};
      bucket[row.status] = row._count._all;
      byDevice.set(row.targetDeviceId, bucket);
    }

    const now = Date.now();
    return reply.send({
      items: devices.map((d) => {
        const queue = byDevice.get(d.id) ?? {};
        return {
          id: d.id,
          name: d.name,
          serialNo: d.serialNo,
          ip: d.ip,
          role: d.role,
          zoneId: d.zoneId,
          timezoneOffsetMinutes: d.timezoneOffsetMinutes,
          firmwareVersion: d.firmwareVersion,
          algorithmVersion: d.algorithmVersion,
          maxFaces: d.maxFaces,
          facesUsed: d.facesUsed,
          normalGroupId: d.normalGroupId,
          blockedGroupId: d.blockedGroupId,
          inStatusCodes: d.inStatusCodes,
          outStatusCodes: d.outStatusCodes,
          duplicatePunchPeriodMinutes: d.duplicatePunchPeriodMinutes,
          employeeIdPatterns: d.employeeIdPatterns,
          visitorIdPatterns: d.visitorIdPatterns,
          // Surfaced, not merely stored. A non-zero window on a terminal that
          // has to report both directions can swallow an OUT punch entirely
          // (VMS_PROJECT_CONTEXT.md §4.10), which turns SINGLE_ENTRY into
          // MULTI_ENTRY with nothing logged anywhere. Null means nobody has
          // established the setting yet, which is its own kind of unknown.
          duplicatePunchWarning:
            d.role === "BOTH" && (d.duplicatePunchPeriodMinutes ?? 0) > 0
              ? "This terminal reports both directions, but the device drops repeat punches by the same user inside its Duplicate Punch Period. An OUT punch can be suppressed before it is ever sent. Set Menu > System > Attendance > Duplicate Punch Period(m) to 0."
              : null,
          lastSeenAt: d.lastSeenAt,
          // When the device last told us about itself. Distinct from
          // lastSeenAt: a device can be polling happily while its capacity and
          // transaction figures are hours stale, and every number sourced from
          // INFO — facesUsed, maxFaces, the punch-gap baseline — is only as
          // current as this.
          lastInfoAt: d.lastInfoAt,
          // Attendance records held on the device. Surfaced here rather than
          // the whole 74-key INFO reply: this list is polled every 15 s by the
          // dashboard, and the rest is diagnostic detail nobody reads at that
          // rate. Full reply at GET /devices/:id/info.
          transactionCount: infoNumber(d.lastInfo, "TransactionCount"),
          // Derived from last contact, not the stored flag: nothing sets that
          // flag false, because the device going quiet produces no request.
          online: d.lastSeenAt !== null && now - d.lastSeenAt.getTime() < OFFLINE_AFTER_MS,
          lastStamp: d.lastStamp,
          lastOpStamp: d.lastOpStamp,
          queue: {
            pending: queue[CommandStatus.PENDING] ?? 0,
            sent: queue[CommandStatus.SENT] ?? 0,
            retry: queue[CommandStatus.RETRY] ?? 0,
            failed: queue[CommandStatus.FAILED] ?? 0,
          },
        };
      }),
      // Serials seen on the wire that no device record claims. Never adopted
      // automatically — two masters on one roster cause mystery deletions.
      unregistered: listUnknownDevices(),
    });
  });

  // Adopt a serial into the roster. Never automatic (CLAUDE.md #7 — one
  // owner per device roster, two masters cause mystery deletions), which is
  // exactly why this exists as a deliberate operator action rather than the
  // registry silently upgrading an unknown serial the moment it is seen.
  app.post("/devices", { preHandler: requirePermission(Permission.DEVICE_CONFIGURE) }, async (request, reply) => {
    const parsed = createDeviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const { serialNo, name, ip, role } = parsed.data;

    if (await prisma.device.findUnique({ where: { serialNo } })) {
      return reply.code(409).send({ error: `a device with serial ${serialNo} is already registered` });
    }

    const data: Prisma.DeviceCreateInput = { serialNo };
    if (name !== undefined) data.name = name;
    if (ip !== undefined) data.ip = ip;
    if (role !== undefined) data.role = role;
    const device = await prisma.device.create({ data });
    dropUnknownDevice(serialNo);
    await prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.DEVICE_REGISTERED,
        entityType: "device",
        entityId: device.id,
        detail: { serialNo, name: name ?? null },
        actorId: actorId(request),
      }),
    });
    request.log.info({ serialNo, by: request.operator?.email }, "device registered");
    return reply.code(201).send({
      id: device.id,
      serialNo: device.serialNo,
      name: device.name,
      role: device.role,
      timezoneOffsetMinutes: device.timezoneOffsetMinutes,
      normalGroupId: device.normalGroupId,
      blockedGroupId: device.blockedGroupId,
    });
  });

  // How this device's punches are read. Deliberately editable: the gate a
  // terminal guards, and the codes its firmware stamps, are site facts that
  // cannot be known at build time (CLAUDE.md #2 — differences are config,
  // never conditionals).
  app.patch("/devices/:id", { preHandler: requirePermission(Permission.DEVICE_CONFIGURE) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = deviceSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const body = parsed.data;

    const device = await prisma.device.findUnique({ where: { id } });
    if (!device) return reply.code(404).send({ error: "device not found" });

    const inCodes = body.inStatusCodes ?? device.inStatusCodes;
    const outCodes = body.outStatusCodes ?? device.outStatusCodes;
    const both = inCodes.filter((c) => outCodes.includes(c));
    if (both.length > 0) {
      return reply.code(400).send({
        error: `status code ${both.join(", ")} cannot mean both IN and OUT`,
      });
    }

    const employeePatterns = body.employeeIdPatterns ?? device.employeeIdPatterns;
    const visitorPatterns = body.visitorIdPatterns ?? device.visitorIdPatterns;
    if (patternsOverlap(employeePatterns, visitorPatterns)) {
      return reply.code(400).send({ error: "employee and visitor ID patterns overlap" });
    }

    const data: Prisma.DeviceUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.role !== undefined) data.role = body.role;
    const zoneChanged = body.zoneId !== undefined && body.zoneId !== device.zoneId;
    if (zoneChanged) {
      if (body.zoneId && !(await prisma.zone.findUnique({ where: { id: body.zoneId } }))) {
        return reply.code(404).send({ error: "zone not found" });
      }
      data.zone = body.zoneId ? { connect: { id: body.zoneId } } : { disconnect: true };
    }
    if (body.timezoneOffsetMinutes !== undefined) {
      data.timezoneOffsetMinutes = body.timezoneOffsetMinutes;
    }
    if (body.inStatusCodes !== undefined) data.inStatusCodes = body.inStatusCodes;
    if (body.outStatusCodes !== undefined) data.outStatusCodes = body.outStatusCodes;
    if (body.employeeIdPatterns !== undefined) data.employeeIdPatterns = body.employeeIdPatterns;
    if (body.visitorIdPatterns !== undefined) data.visitorIdPatterns = body.visitorIdPatterns;
    if (body.duplicatePunchPeriodMinutes !== undefined) {
      data.duplicatePunchPeriodMinutes = body.duplicatePunchPeriodMinutes;
    }

    const updated = await prisma.device.update({ where: { id }, data });
    if (zoneChanged) {
      await prisma.auditLog.create({
        data: auditRow({
          action: AuditAction.DEVICE_ZONE_CHANGED,
          entityType: "device",
          entityId: id,
          detail: { from: device.zoneId, to: updated.zoneId },
          actorId: actorId(request),
        }),
      });
    }

    // The ADMS layer serves device lookups from a 60 s cache so the
    // getrequest hot path keeps its single-query budget. Everything changed
    // here — the gate's role, the punch-state maps — is read from that cached
    // copy on the punch path, so without this the new configuration silently
    // does not apply for up to a minute and punches are resolved by the old
    // rules. Found by the verification harness, which set a gate to IN and
    // watched the next punch still be treated as bidirectional.
    invalidateDevice(updated.serialNo);

    return reply.send({
      id: updated.id,
      serialNo: updated.serialNo,
      name: updated.name,
      role: updated.role,
      zoneId: updated.zoneId,
      timezoneOffsetMinutes: updated.timezoneOffsetMinutes,
      inStatusCodes: updated.inStatusCodes,
      outStatusCodes: updated.outStatusCodes,
      duplicatePunchPeriodMinutes: updated.duplicatePunchPeriodMinutes,
      employeeIdPatterns: updated.employeeIdPatterns,
      visitorIdPatterns: updated.visitorIdPatterns,
    });
  });

  // ---- alerts --------------------------------------------------------------
  // Everything currently wrong, worst first. Computed on every call and never
  // stored: an alert exists exactly as long as its condition does, so there
  // is no acknowledge flag to go stale and no resolved alert left lying
  // around for somebody to distrust.
  app.get("/alerts", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    const items = await collectAlerts();
    return reply.send({
      total: items.length,
      critical: items.filter((a) => a.severity === "critical").length,
      warning: items.filter((a) => a.severity === "warning").length,
      items,
    });
  });

  // ---- reconciliation ------------------------------------------------------
  // What the device holds that we did not put there, and vice versa. Reported
  // as a count rather than a list because no "enumerate the roster" command
  // has been established on this firmware — the count is the only signal
  // available for "something is on the device we do not know about", and a
  // count that is quietly wrong is exactly what nobody would otherwise notice.
  //
  // `facesUsed` is only current as of the last INFO, so this reads best right
  // after POST /devices/:id/refresh.
  app.get("/devices/drift", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    const items = await faceCountDrift();
    return reply.send({
      total: items.length,
      items: items.map((d) => ({
        ...d,
        note:
          d.excess > 0
            ? "The device holds more faces than we authorized. Something is loaded that we did not put there, or a removal was missed — either way it can open the barrier."
            : "The device holds fewer faces than we authorized. People we believe are provisioned will be turned away.",
      })),
      staleness: "faces_used is as of the last INFO — refresh the device for a current figure",
    });
  });

  // The device's own account of itself, verbatim. Kept off the list endpoint
  // because that one is polled every 15 s and 74 keys per device is a lot of
  // payload for something read occasionally and deliberately.
  app.get("/devices/:id/info", { preHandler: requirePermission(Permission.READ) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await prisma.device.findUnique({
      where: { id },
      select: { serialNo: true, lastInfo: true, lastInfoAt: true },
    });
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (device.lastInfoAt === null) {
      return reply.code(409).send({
        error: "this device has never reported INFO — POST /devices/:id/refresh first",
      });
    }
    return reply.send({
      serialNo: device.serialNo,
      reportedAt: device.lastInfoAt,
      info: device.lastInfo,
      note:
        "Verbatim from the device. Tilde-prefixed maxima are NOT in consistent units — " +
        "~MaxFaceCount is exact, ~MaxAttLogCount and ~MaxUserCount plainly are not. " +
        "Do not derive capacity from them.",
    });
  });

  // ---- punch loss ----------------------------------------------------------
  // Records the device logged that never reached us. Measured as growth from
  // a baseline, never as a raw difference: the device's log outlives a wiped
  // database, so its absolute count includes history this installation never
  // saw. Only as fresh as the last INFO.
  app.get("/devices/punch-gaps", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    const items = await punchGaps();
    return reply.send({
      total: items.length,
      items,
      note:
        "Counted from each device's baseline. Clearing the device log, or restoring the " +
        "database, invalidates that baseline — re-take it deliberately afterwards.",
    });
  });

  // Re-fix the comparison point. Required after clearing the device log or
  // restoring the database, because both make the previous baseline a lie.
  app.post("/devices/:id/punch-baseline", { preHandler: requirePermission(Permission.MAINTENANCE_RUN) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await setPunchBaseline(id);
    if (!result) {
      return reply.code(409).send({
        error:
          "no TransactionCount recorded for this device — refresh it first so there is " +
          "something to baseline against",
      });
    }
    return reply.send(result);
  });

  // Run the roster check now instead of waiting for the schedule.
  app.post("/devices/reconcile", { preHandler: requirePermission(Permission.MAINTENANCE_RUN) }, async (request, reply) => {
    const result = await reconcileSweep(request.log, config.reconcileBatch);
    return reply.send(result);
  });

  // Roster backfill for a terminal that was already populated before the VMS
  // was installed. Nothing else finds those people: this firmware cannot list
  // its users, and a person enrolled two years ago generates no traffic to
  // notice. See services/backfill.ts for why it is paced rather than bulk.
  app.get("/devices/scans", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    return reply.send({ items: await listScans() });
  });

  app.post("/devices/:id/scan", { preHandler: requirePermission(Permission.MAINTENANCE_RUN) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = scanSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    let plan: ScanPlan;
    if ("ids" in parsed.data) {
      // De-duplicated case-insensitively before anything is queued: a pasted
      // list or a spreadsheet column routinely repeats an ID, and asking the
      // device the same question twice is queue time an operator is waiting on.
      const seen = new Set<string>();
      const ids: string[] = [];
      const rejected: string[] = [];
      for (const raw of parsed.data.ids) {
        const id = parseUserId(raw);
        if (id === null) {
          rejected.push(raw);
          continue;
        }
        if (seen.has(userIdKey(id))) continue;
        seen.add(userIdKey(id));
        ids.push(id);
      }
      if (ids.length === 0) {
        return reply.code(400).send({
          error: "none of those are usable IDs — letters and digits only",
          rejected: rejected.slice(0, 20),
        });
      }
      plan = { kind: "LIST", ids };
    } else {
      if (parsed.data.endPin < parsed.data.startPin) {
        return reply.code(400).send({ error: "endPin must not be below startPin" });
      }
      plan = {
        kind: "RANGE",
        prefix: parsed.data.prefix ?? "",
        from: parsed.data.startPin,
        to: parsed.data.endPin,
        pad: parsed.data.pad ?? 0,
      };
    }

    const state = await startScan(id, plan, actorId(request) ?? null);
    request.log.info(
      { deviceId: id, plan, by: request.operator?.email },
      "device roster scan started",
    );
    return reply.code(202).send(state);
  });

  // Read IDs out of a file the site already has — the export from whatever
  // software the terminal was attached to before. Deliberately separate from
  // starting the scan: the operator sees what was found and what was rejected
  // BEFORE committing the device's command queue for the next hour.
  //
  // Raw body, not multipart: the same pattern the photo upload uses, and it
  // needs no dependency to accept a file.
  app.post("/devices/scan/parse-ids", { preHandler: requirePermission(Permission.MAINTENANCE_RUN) }, async (request, reply) => {
    const { filename } = request.query as { filename?: string };
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "send the file as the raw request body" });
    }
    if (body.length > 5 * 1024 * 1024) {
      return reply.code(413).send({ error: "that file is over 5 MB" });
    }
    try {
      const result = await parseIdList(filename ?? "list.txt", body);
      return reply.send(result);
    } catch (err) {
      request.log.warn({ err, filename }, "could not read an uploaded ID list");
      return reply.code(400).send({
        error: "could not read that file — save it as CSV and try again",
      });
    }
  });

  app.delete("/devices/:id/scan", { preHandler: requirePermission(Permission.MAINTENANCE_RUN) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await stopScan(id))) return reply.code(404).send({ error: "no scan is running on this device" });
    return reply.send({ stopped: true });
  });

  // Refresh capacity/firmware from the hardware itself.
  app.post("/devices/:id/refresh", { preHandler: requirePermission(Permission.DEVICE_REFRESH) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await prisma.device.findUnique({ where: { id } });
    if (!device) return reply.code(404).send({ error: "device not found" });

    const command = await enqueue({
      type: CommandType.DEVICE_INFO,
      targetDeviceId: device.id,
      payload: {},
      // Bucketed to a minute: repeated clicks collapse onto one read.
      idempotencyKey: `device-info:${device.id}:${Math.floor(Date.now() / 60_000)}`,
      initiatedById: actorId(request),
    });
    return reply.code(202).send({
      device: { id: device.id, serialNo: device.serialNo },
      command: { id: command.id, type: command.type, status: command.status },
    });
  });
}

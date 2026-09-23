import type { FastifyInstance } from "fastify";
import { EntryMode, EntryState, Prisma, RetentionPolicy } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/index.js";
import { overdueInside, sweepExpiredEntries } from "../jobs/expiry.js";
import { retentionStatus, runRetention } from "../jobs/retention.js";
import { dayBlockedEntries, runDailyReset } from "../services/entry-modes.js";
import { actorId } from "./auth.js";
import { Permission, requirePermission } from "./permissions.js";
import {
  ACTIVE_ENTRY_STATES,
  deprovisionEntry,
  provisionPerson,
  queryPersonOnDevice,
  setEntryBlocked,
} from "../services/entries.js";

// Manual device operations (Phase 1 Milestone 4).
//
// Every operation is asynchronous by design: the server never contacts the
// device, it queues work and the device collects it on its next poll (1–3 s
// after activity). So these endpoints answer with the entry plus the commands
// that were queued, and the caller watches status change — the illusion of a
// synchronous device call would be a lie the protocol cannot honour.

const provisionSchema = z.object({
  // A person is provisioned onto every device named here — an entry spanning
  // an IN terminal and an OUT terminal is two devices, one entry. Omit
  // entirely when exactly one device is registered, matching how a
  // single-device site has always worked.
  deviceIds: z.array(z.string().min(1)).min(1).optional(),
  retentionPolicy: z.nativeEnum(RetentionPolicy).default(RetentionPolicy.ONE_DAY),
  retentionExpiresAt: z.coerce.date().optional(),
  entryMode: z.nativeEnum(EntryMode).default(EntryMode.MULTI_ENTRY),
  // Required, and deliberately free text: why somebody was let in is the
  // question asked after an incident, and a dropdown of five reasons answers
  // it with whichever one was nearest the mouse.
  purposeOfVisit: z.string().trim().min(1).max(200),
  personToMeetId: z.string().min(1).optional(),
  expectedInAt: z.coerce.date().optional(),
});

const listEntriesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  personId: z.string().min(1).optional(),
  state: z.nativeEnum(EntryState).optional(),
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const querySchema = z.object({ deviceId: z.string().min(1).optional() });

interface EntryRow {
  id: string;
  personId: string;
  state: EntryState;
  dayBlocked: boolean;
  retentionPolicy: RetentionPolicy;
  retentionExpiresAt: Date | null;
  entryMode: EntryMode;
  purposeOfVisit: string | null;
  personToMeetId: string | null;
  expectedInAt: Date | null;
  inAt: Date | null;
  outAt: Date | null;
  createdAt: Date;
  person?: { id: string; name: string; company: { name: string } | null; esslUserId: string } | undefined;
  personToMeet?: { id: string; name: string | null; email: string } | null | undefined;
}

function entryDto(e: EntryRow) {
  return {
    id: e.id,
    personId: e.personId,
    state: e.state,
    dayBlocked: e.dayBlocked,
    retentionPolicy: e.retentionPolicy,
    // Load-bearing since M8: the expiry sweeper acts on this, and it is the
    // only thing that removes a lapsed person from a device.
    retentionExpiresAt: e.retentionExpiresAt,
    entryMode: e.entryMode,
    // Null only on entries authorized before the field existed.
    purposeOfVisit: e.purposeOfVisit,
    personToMeetId: e.personToMeetId,
    personToMeet: e.personToMeet ?? null,
    expectedInAt: e.expectedInAt,
    inAt: e.inAt,
    outAt: e.outAt,
    createdAt: e.createdAt,
    ...(e.person
      ? {
          person: {
            id: e.person.id,
            name: e.person.name,
            company: e.person.company?.name ?? null,
            esslUserId: e.person.esslUserId,
          },
        }
      : {}),
  };
}

function commandDto(c: {
  id: string;
  type: string;
  status: string;
  targetDeviceId: string;
  deviceCmdId: number | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
  completedAt: Date | null;
}) {
  return {
    id: c.id,
    type: c.type,
    status: c.status,
    targetDeviceId: c.targetDeviceId,
    deviceCmdId: c.deviceCmdId,
    attempts: c.attempts,
    lastError: c.lastError,
    createdAt: c.createdAt,
    sentAt: c.sentAt,
    completedAt: c.completedAt,
  };
}

export async function entryRoutes(app: FastifyInstance): Promise<void> {
  // ---- provision a person -------------------------------------------------
  app.post("/people/:id/provision", { preHandler: requirePermission(Permission.ENTRY_MANAGE) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = provisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }

    const result = await provisionPerson({
      personId: id,
      actorId: actorId(request),
      deviceIds: parsed.data.deviceIds,
      retentionPolicy: parsed.data.retentionPolicy,
      retentionExpiresAt: parsed.data.retentionExpiresAt,
      entryMode: parsed.data.entryMode,
      purposeOfVisit: parsed.data.purposeOfVisit,
      personToMeetId: parsed.data.personToMeetId,
      expectedInAt: parsed.data.expectedInAt,
    });

    request.log.info(
      {
        entryId: result.entry.id,
        personId: id,
        devices: result.devices.map((d) => d.serialNo),
        commands: result.commands.map((c) => c.type),
      },
      "provision queued — device(s) will collect on their next poll",
    );

    return reply.code(202).send({
      entry: entryDto(result.entry),
      devices: result.devices.map((d) => ({ id: d.id, serialNo: d.serialNo })),
      commands: result.commands.map(commandDto),
    });
  });

  // ---- ask the device what it thinks it has (4.4) --------------------------
  app.post("/people/:id/query-device", { preHandler: requirePermission(Permission.ENTRY_MANAGE) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = querySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    const { device, command } = await queryPersonOnDevice(
      id,
      parsed.data.deviceId,
      actorId(request),
    );
    return reply.code(202).send({
      device: { id: device.id, serialNo: device.serialNo },
      command: commandDto(command),
    });
  });

  // ---- list ----------------------------------------------------------------
  app.get("/entries", { preHandler: requirePermission(Permission.READ) }, async (request, reply) => {
    const parsed = listEntriesSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    const { page, pageSize, personId, state, active } = parsed.data;

    const where: Prisma.EntryWhereInput = {};
    if (personId) where.personId = personId;
    if (state) where.state = state;
    else if (active === true) where.state = { in: [...ACTIVE_ENTRY_STATES] };
    else if (active === false) where.state = { notIn: [...ACTIVE_ENTRY_STATES] };

    const [total, items] = await prisma.$transaction([
      prisma.entry.count({ where }),
      prisma.entry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          person: { select: { id: true, name: true, company: true, esslUserId: true } },
          personToMeet: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    return reply.send({ total, page, pageSize, items: items.map(entryDto) });
  });

  // ---- the inside-now board ------------------------------------------------
  // Everything the gate-desk screen needs, in one request and one database
  // round trip. It is deliberately not three calls to the lists below: this
  // screen sits open and refreshing all day, and on a client-supplied remote
  // database three round trips every few seconds is three times the cost for
  // a view that is always read together anyway.
  //
  // "Overdue" is not a fourth query — it is `retentionExpiresAt` in the past
  // on a row already returned, so the client derives it and the two can never
  // disagree with each other.
  app.get("/entries/board", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    const select = {
      id: true,
      state: true,
      dayBlocked: true,
      entryMode: true,
      // One short string per row, on a view whose whole question is "who is on
      // site" — the answer is far more useful with "and why" attached, and it
      // is already loaded either way.
      purposeOfVisit: true,
      inAt: true,
      outAt: true,
      retentionPolicy: true,
      retentionExpiresAt: true,
      person: {
        select: {
          id: true,
          name: true,
          company: { select: { name: true } },
          esslUserId: true,
        },
      },
    } as const;

    const [inside, dayBlocked] = await prisma.$transaction([
      prisma.entry.findMany({
        where: { state: EntryState.INSIDE },
        orderBy: { inAt: "asc" }, // longest-present first: that is who to look at
        take: 500,
        select,
      }),
      prisma.entry.findMany({
        where: {
          dayBlocked: true,
          state: { in: [EntryState.PROVISIONED, EntryState.INSIDE] },
        },
        orderBy: { outAt: "desc" },
        take: 500,
        select,
      }),
    ]);

    const boardDto = (entry: (typeof inside)[number]) => ({
      ...entry,
      person: {
        ...entry.person,
        company: entry.person.company?.name ?? null,
      },
    });

    return reply.send({
      serverTime: new Date().toISOString(),
      inside: inside.map(boardDto),
      dayBlocked: dayBlocked.map(boardDto),
    });
  });

  // ---- retention -----------------------------------------------------------
  // What the policy is, what it would act on, and how much history has
  // already been rolled into summaries. Exposed because a retention policy
  // nobody can see is one nobody can audit — and this one deletes rows.
  app.get("/maintenance/retention", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    return reply.send(await retentionStatus());
  });

  // Run a pass now. Bounded the same way the scheduled run is, so calling it
  // repeatedly is how a large backlog is cleared, not one enormous statement.
  app.post("/maintenance/retention", { preHandler: requirePermission(Permission.MAINTENANCE_RUN) }, async (request, reply) => {
    return reply.send(await runRetention(request.log));
  });

  // ---- run the sweep now ---------------------------------------------------
  // The scheduled job runs every few minutes; this is the same function, on
  // demand. Safe to call at any time — the sweep is idempotent, and an entry
  // already on its way off a device is not a candidate.
  app.post("/entries/sweep-expiry", { preHandler: requirePermission(Permission.MAINTENANCE_RUN) }, async (request, reply) => {
    const result = await sweepExpiredEntries(request.log);
    return reply.send(result);
  });

  // ---- run the daily reset now ---------------------------------------------
  // The scheduled job checks every few minutes and acts once per device-local
  // day. This is the same function on demand — it will do nothing if the
  // device's day has already been reset, which is the correct answer and not
  // a failure.
  app.post("/entries/daily-reset", { preHandler: requirePermission(Permission.MAINTENANCE_RUN) }, async (request, reply) => {
    const result = await runDailyReset(request.log);
    return reply.send(result);
  });

  // ---- day-blocked ---------------------------------------------------------
  // SINGLE_ENTRY people who have used today's visit. They are still loaded on
  // the device and still recognized by it — the terminal identifies them and
  // then denies, which is why blocking never disturbs the biometric.
  app.get("/entries/day-blocked", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    const items = await dayBlockedEntries();
    return reply.send({ total: items.length, items });
  });

  // ---- overdue -------------------------------------------------------------
  // People whose retention window closed while they were still on site. The
  // sweeper cannot act on these — removing a credential mid-visit strands
  // someone at the exit barrier — so it defers to their OUT punch. If that
  // punch never comes, they stay on the device indefinitely, and the only
  // thing separating "correctly deferred" from "quietly forgotten" is
  // somebody being able to see the list. That is what this route is for.
  app.get("/entries/overdue", { preHandler: requirePermission(Permission.READ) }, async (_request, reply) => {
    const items = await overdueInside();
    const now = Date.now();
    return reply.send({
      total: items.length,
      items: items.map((e) => ({
        id: e.id,
        state: e.state,
        inAt: e.inAt,
        retentionExpiresAt: e.retentionExpiresAt,
        overdueByMinutes: e.retentionExpiresAt
          ? Math.floor((now - e.retentionExpiresAt.getTime()) / 60_000)
          : null,
        person: e.person,
      })),
    });
  });

  // ---- detail --------------------------------------------------------------
  app.get("/entries/:id", { preHandler: requirePermission(Permission.READ) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await prisma.entry.findUnique({
      where: { id },
      include: {
        person: { select: { id: true, name: true, company: true, esslUserId: true } },
        personToMeet: { select: { id: true, name: true, email: true } },
        syncCommands: { orderBy: { seq: "desc" }, take: 50 },
      },
    });
    if (!entry) return reply.code(404).send({ error: "entry not found" });
    return reply.send({
      ...entryDto(entry),
      commands: entry.syncCommands.map(commandDto),
    });
  });

  // ---- block / unblock -----------------------------------------------------
  for (const [suffix, blocked] of [
    ["block", true],
    ["unblock", false],
  ] as const) {
    app.post(
      `/entries/:id/${suffix}`,
      { preHandler: requirePermission(Permission.ENTRY_MANAGE) },
      async (request, reply) => {
      const { id } = request.params as { id: string };
      const { devices, commands } = await setEntryBlocked(id, blocked, actorId(request));
      request.log.info(
        { entryId: id, devices: devices.map((d) => d.serialNo), blocked },
        "access-group change queued",
      );
      return reply.code(202).send({
        devices: devices.map((d) => ({ id: d.id, serialNo: d.serialNo })),
        commands: commands.map(commandDto),
      });
    });
  }

  // ---- de-provision --------------------------------------------------------
  app.post("/entries/:id/deprovision", { preHandler: requirePermission(Permission.ENTRY_MANAGE) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { entry, devices, commands } = await deprovisionEntry(id, actorId(request));
    request.log.info(
      { entryId: id, devices: devices.map((d) => d.serialNo) },
      "de-provision queued — device removal only, record retained",
    );
    return reply.code(202).send({
      entry: entryDto(entry),
      devices: devices.map((d) => ({ id: d.id, serialNo: d.serialNo })),
      commands: commands.map(commandDto),
    });
  });
}

import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CommandType, PersonCategory, Prisma, type Device, type Person } from "@prisma/client";
import { config } from "../config/index.js";
import { prisma } from "../db/index.js";
import { publish } from "../events/bus.js";
import { classifyDeviceId, photoPathFor, punchQueryCandidates, userIdKey } from "../user-id.js";
import { processPunches } from "../services/punches.js";
import { issueDueExitCodes } from "../services/exit-codes.js";
import { reconcileUserRecord } from "../services/reconcile.js";
import { enqueue, publishCommand } from "./queue.js";
import { adoptEmployeeOnDevice } from "../services/employee-access.js";
import {
  attlogHash,
  deviceTimestamps,
  parseAttlog,
  parseBiodata,
  parseBiophoto,
  parseKvRecord,
  parseOplog,
  parseUserRecord,
} from "./parsers.js";

// Ingestion of device-pushed data (cdata/fdata bodies). Batch-first: at
// 1,200–1,500 movements/day per site, and with a possibly-remote database,
// per-row loops are banned on the punch path (CLAUDE.md rule #4).

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  debug: (obj: object, msg: string) => void;
}

let photoDirReady = false;
async function ensurePhotoDir(): Promise<void> {
  if (photoDirReady) return;
  await mkdir(config.photoStoragePath, { recursive: true });
  photoDirReady = true;
}

export async function photoOnDisk(pin: string): Promise<boolean> {
  try {
    await access(photoPathFor(pin));
    return true;
  } catch {
    return false;
  }
}

export function automaticQueryKey(claimed: boolean, serialNo: string, pin: string, bucket: number): string {
  return `${claimed ? "autopull-photo" : "auto-discover-person"}:${serialNo}:${pin}:${bucket}`;
}

/**
 * This firmware auto-pushes the USER record and BIODATA template on
 * enrollment, but NOT the BIOPHOTO (confirmed on real hardware — see
 * VMS_PROJECT_CONTEXT.md §4.6). The photo must be pulled explicitly with
 * DATA QUERY USERINFO. So whenever we learn of a PIN we have no photo for,
 * queue that pull — making device-first registration hands-free, as the
 * plan intended. Idempotency is bucketed to ~10 min so a failed pull retries
 * but a burst of records can't spam the queue.
 */
async function autoPullPhotoIfMissing(device: Device, pin: string, log: Logger): Promise<void> {
  // Pulling a photo means storing somebody's face, so an unknown ID is only
  // claimed when exactly one category pattern classifies it. Empty patterns
  // intentionally claim nothing. A Person already known to the database is
  // always eligible even if the site's patterns later change.
  //
  // A person who already claims the ID is always pulled, patterns or not: the
  // relationship is established, and a pattern list that has drifted from the
  // site's numbering must never strand a real person.
  const claimed = await prisma.person.findFirst({
    where: { esslUserId: { equals: pin, mode: "insensitive" } },
    select: { id: true },
  });
  const category = classifyDeviceId(pin, device.employeeIdPatterns, device.visitorIdPatterns);
  if (!claimed && category === null) {
    // Logged rather than dropped in silence: if the patterns do not match the
    // IDs a site actually uses, enrollments would simply never appear as
    // unclaimed and nobody would know why.
    log.warn(
      { pin, employeePatterns: device.employeeIdPatterns, visitorPatterns: device.visitorIdPatterns },
      "enrollment ID is unclassified or ambiguous — left untouched for admin review",
    );
    return;
  }
  if (await photoOnDisk(pin)) return;
  const bucket = Math.floor(Date.now() / 600_000);
  await enqueue({
    type: CommandType.QUERY_USER,
    targetDeviceId: device.id,
    payload: { pin },
    // An unknown OPLOG/USER observation is discovery; once USER creates the
    // Person, the missing-photo pull is a second query and must not dedupe
    // against that first one.
    idempotencyKey: automaticQueryKey(Boolean(claimed), device.serialNo, pin, bucket),
  });
  log.info({ pin }, "no photo on disk for this PIN — auto-queued QUERY_USER to pull it");
}

async function autoRegisterPerson(
  device: Device,
  pin: string,
  reportedName: string | null,
  log: Logger,
  attachExistingPhoto = true,
) {
  const existing = await prisma.person.findFirst({
    where: { esslUserId: { equals: pin, mode: "insensitive" } },
  });
  if (existing) {
    if (existing.category === PersonCategory.EMPLOYEE) await adoptEmployeeOnDevice(existing.id, device.id);
    if (reportedName?.trim() && existing.name === `Device user ${existing.esslUserId}`) {
      return prisma.person.update({ where: { id: existing.id }, data: { name: reportedName.trim() } });
    }
    return existing;
  }
  const category = classifyDeviceId(pin, device.employeeIdPatterns, device.visitorIdPatterns);
  if (category === null) return null;
  try {
    const person = await prisma.person.create({
      data: {
        name: reportedName?.trim() || `Device user ${pin}`,
        category,
        esslUserId: pin,
        adoptedFromDevice: true,
      },
    });
    if (category === PersonCategory.EMPLOYEE) {
      await adoptEmployeeOnDevice(person.id, device.id);
    }
    await prisma.auditLog.create({
      data: {
        action: "PERSON_AUTO_REGISTERED",
        entityType: "person",
        entityId: person.id,
        detail: { deviceId: device.id, category, esslUserId: pin },
      },
    });
    log.info({ pin, personId: person.id, category }, "device person automatically registered");
    if (attachExistingPhoto) {
      const filePath = photoPathFor(pin);
      try {
        const file = await stat(filePath);
        await attachStoredPhoto(device, person, filePath, file.size, "DEVICE_PREVIOUSLY_RECEIVED", log);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return person;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const concurrent = await prisma.person.findFirst({ where: { esslUserId: { equals: pin, mode: "insensitive" } } });
      if (concurrent?.category === PersonCategory.EMPLOYEE) await adoptEmployeeOnDevice(concurrent.id, device.id);
      return concurrent;
    }
    throw err;
  }
}

async function attachStoredPhoto(
  device: Device,
  person: Person,
  filePath: string,
  photoSizeBytes: number,
  source: "DEVICE_PUSH" | "DEVICE_PREVIOUSLY_RECEIVED",
  log: Logger,
) {
  await prisma.$transaction([
    prisma.personBiometric.upsert({
      where: { personId: person.id },
      create: {
        personId: person.id,
        photoPath: filePath,
        photoSizeBytes,
        algorithmVersion: device.algorithmVersion,
        biometricType: 9,
      },
      update: {
        photoPath: filePath,
        photoSizeBytes,
        algorithmVersion: device.algorithmVersion,
        capturedAt: new Date(),
      },
    }),
    prisma.auditLog.create({
      data: {
        actorId: null,
        action: "PHOTO_UPDATED",
        entityType: "person_biometric",
        entityId: person.id,
        detail: { source, deviceId: device.id, photoSizeBytes },
      },
    }),
  ]);
  if (person.category === PersonCategory.VISITOR && person.adoptedFromDevice) {
    await enqueue({
      type: CommandType.DEPROVISION,
      targetDeviceId: device.id,
      personId: person.id,
      payload: { pin: person.esslUserId, countedOnDevice: true },
      idempotencyKey: `auto-visitor-remove:${person.id}:${device.id}`,
    });
    await prisma.person.update({ where: { id: person.id }, data: { adoptedFromDevice: false } });
    log.info({ pin: person.esslUserId, personId: person.id }, "visitor photo secured — device removal queued");
  } else if (person.category === PersonCategory.EMPLOYEE) {
    await prisma.person.update({ where: { id: person.id }, data: { adoptedFromDevice: false } });
  }
  log.info({ pin: person.esslUserId, personId: person.id, bytes: photoSizeBytes }, "BIOPHOTO stored");
}

/**
 * A face scan for somebody already enrolled on the terminal normally sends
 * ATTLOG only. Discover classified unknown IDs, and retry known People whose
 * photo is still missing. Two database round trips per batch, never per PIN.
 */
async function discoverPeopleFromPunches(device: Device, pins: readonly string[], log: Logger) {
  const keys = [...new Set(pins.map(userIdKey))];
  const claimed = await prisma.$queryRaw<{ key: string; hasPhoto: boolean }[]>`
    SELECT UPPER(p."essl_user_id") AS key,
           (b."person_id" IS NOT NULL) AS "hasPhoto"
      FROM "person" p
      LEFT JOIN "person_biometric" b ON b."person_id" = p."id"
     WHERE UPPER(p."essl_user_id") = ANY(${keys}::text[])
  `;
  const candidates = punchQueryCandidates(
    pins,
    device.employeeIdPatterns,
    device.visitorIdPatterns,
    new Map(claimed.map((row) => [row.key, row.hasPhoto])),
  );
  if (candidates.discovery.length === 0 && candidates.missingPhotos.length === 0) return;

  const bucket = Math.floor(Date.now() / 600_000);
  const commands = await prisma.syncCommand.createManyAndReturn({
    data: [
      ...candidates.discovery.map((pin) => ({
        type: CommandType.QUERY_USER,
        targetDeviceId: device.id,
        payload: { pin },
        // A returned USER with no BIOPHOTO must be allowed to queue the
        // separate autopull-photo retry below; sharing that key lost photos.
        idempotencyKey: `auto-discover-person:${device.serialNo}:${pin}:${bucket}`,
      })),
      ...candidates.missingPhotos.map((pin) => ({
        type: CommandType.QUERY_USER,
        targetDeviceId: device.id,
        payload: { pin },
        // A fresh punch is an independent recovery signal. Keep it separate
        // from the USER-triggered autopull so either failed path can retry.
        idempotencyKey: `recover-photo-from-punch:${device.serialNo}:${pin}:${bucket}`,
      })),
    ],
    skipDuplicates: true,
  });
  for (const command of commands) publishCommand(command);
  log.info(
    { device: device.serialNo, ...candidates, queued: commands.length },
    "punch IDs queued for automatic registration or missing-photo recovery",
  );
}

// ---------------------------------------------------------------------------
// ATTLOG — punches
// ---------------------------------------------------------------------------

export async function ingestAttlog(
  device: Device,
  body: string,
  log: Logger,
): Promise<{ received: number; inserted: number }> {
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = [];
  for (const line of lines) {
    const rec = parseAttlog(line);
    if (!rec) {
      log.warn({ line }, "unparseable ATTLOG line — skipped, kept in log");
      continue;
    }
    const { punchedAtDevice, punchedAtUtc } = deviceTimestamps(
      rec.timestampRaw,
      device.timezoneOffsetMinutes,
    );
    rows.push({
      esslUserId: rec.pin,
      deviceId: device.id,
      punchedAtDevice,
      punchedAtUtc,
      statusCode: rec.statusCode,
      verifyMode: rec.verifyMode,
      workCode: rec.workCode,
      raw: rec.raw,
      rawRecordHash: attlogHash(device.serialNo, rec.raw),
    });
  }
  if (rows.length === 0) return { received: lines.length, inserted: 0 };

  // One statement for the whole batch; skipDuplicates makes Stamp-replays
  // (same line re-sent after a missed ack) a silent no-op instead of a
  // double-counted punch. ...AndReturn gives back only the rows that were
  // actually new, so a replay cannot repeat itself on the live feed either.
  const inserted = await prisma.punchEvent.createManyAndReturn({
    data: rows,
    skipDuplicates: true,
  });
  log.info(
    { device: device.serialNo, received: lines.length, inserted: inserted.length },
    "punches ingested",
  );

  if (inserted.length > 0) {
    await discoverPeopleFromPunches(device, inserted.map((p) => p.esslUserId), log);
    await publishPunches(device, inserted);
    // Only newly-inserted rows are processed, so a Stamp-replay cannot move
    // an entry twice. Runs inline rather than as a job because the state
    // machine is what the inside-now board reads, and a movement that shows
    // up seconds late reads as a bug to whoever is standing at the barrier.
    // This is the cdata path, not the 1–3 s getrequest hot path.
    const result = await processPunches(device, inserted, log);
    // A single-entry holder's first IN makes their exit code due (Phase 7).
    // Cheap when nothing is due; the engine tick is the safety net.
    if (result.transitions > 0) await issueDueExitCodes();
    if (result.transitions > 0 || result.unmatched > 0) {
      log.info(
        { device: device.serialNo, ...result },
        "punches applied to entries",
      );
    }
  }
  return { received: lines.length, inserted: inserted.length };
}

/**
 * Push new punches onto the live feed, resolving person names in one query
 * for the whole batch — never one lookup per punch.
 */
async function publishPunches(
  device: Device,
  punches: { id: string; esslUserId: string; punchedAtUtc: Date; punchedAtDevice: Date; createdAt: Date; verifyMode: number | null; statusCode: number | null }[],
): Promise<void> {
  // Raw SQL because IDs match case-insensitively and Prisma has no
  // case-insensitive `in`. Still ONE query for the whole batch, and it lands on
  // the functional unique index over UPPER(essl_user_id) - the alternative,
  // a per-punch lookup, is exactly the loop CLAUDE.md #4 bans.
  const keys = [...new Set(punches.map((p) => userIdKey(p.esslUserId)))];
  const people = await prisma.$queryRaw<{ id: string; name: string; key: string }[]>`
    SELECT "id", "name", UPPER("essl_user_id") AS key
      FROM "person"
     WHERE UPPER("essl_user_id") = ANY(${keys}::text[])
  `;
  const byPin = new Map(people.map((v) => [v.key, v]));
  for (const p of punches) {
    const person = byPin.get(userIdKey(p.esslUserId));
    publish("punch", {
      id: p.id,
      esslUserId: p.esslUserId,
      deviceId: device.id,
      deviceSerialNo: device.serialNo,
      deviceName: device.name,
      punchedAtUtc: p.punchedAtUtc.toISOString(),
      punchedAtDevice: p.punchedAtDevice.toISOString(),
      receivedAt: p.createdAt.toISOString(),
      verifyMode: p.verifyMode,
      statusCode: p.statusCode,
      person: person ? { id: person.id, name: person.name } : null,
    });
  }
}

// ---------------------------------------------------------------------------
// BIOPHOTO — the durable artifact
// ---------------------------------------------------------------------------

export async function ingestBiophoto(
  device: Device,
  line: string,
  log: Logger,
): Promise<void> {
  const rec = parseBiophoto(line);
  if (!rec) {
    log.warn({ line: line.slice(0, 120) }, "unparseable BIOPHOTO record");
    return;
  }

  const jpeg = Buffer.from(rec.contentBase64, "base64");
  if (jpeg.length === 0 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    log.warn({ pin: rec.pin, bytes: jpeg.length }, "BIOPHOTO content is not a JPEG — ignored");
    return;
  }

  // Photo always lands on disk first — even for a PIN we can't match yet.
  // Losing an enrollment capture because registration hadn't happened in the
  // right order would be self-inflicted data loss.
  await ensurePhotoDir();
  const filePath = photoPathFor(rec.pin);
  await writeFile(filePath, jpeg);

  const person = await autoRegisterPerson(device, rec.pin, null, log, false)
    ?? await prisma.person.findFirst({ where: { esslUserId: { equals: rec.pin, mode: "insensitive" } } });
  if (!person) {
    log.warn(
      { pin: rec.pin, filePath, bytes: jpeg.length },
      "BIOPHOTO saved but no person has this PIN — will attach when registered",
    );
    return;
  }

  await attachStoredPhoto(device, person, filePath, jpeg.length, "DEVICE_PUSH", log);
}

// ---------------------------------------------------------------------------
// BIODATA — same-device template cache only
// ---------------------------------------------------------------------------

export async function ingestBiodata(device: Device, line: string, log: Logger): Promise<void> {
  const rec = parseBiodata(line);
  if (!rec) return;
  const person = await prisma.person.findFirst({ where: { esslUserId: { equals: rec.pin, mode: "insensitive" } } });
  if (!person) {
    log.debug({ pin: rec.pin }, "BIODATA for unknown PIN — ignored (photo is the artifact)");
    return;
  }
  // Cache only onto an existing biometric row; a template without its photo
  // is worthless (algorithm-bound), so we never create a row for one.
  const updated = await prisma.personBiometric.updateMany({
    where: { personId: person.id },
    data: { faceTemplate: rec.templateBase64 },
  });
  if (updated.count > 0) {
    log.debug(
      { pin: rec.pin, ver: `${rec.majorVer}.${rec.minorVer}` },
      "face template cached (same-device optimisation only)",
    );
  }
}

// ---------------------------------------------------------------------------
// cdata dispatch
// ---------------------------------------------------------------------------

/**
 * Line-dispatch known record types regardless of which endpoint or table
 * they arrived through. Lesson from real hardware: a fresh enrollment pushes
 * its BIOPHOTO via the fdata endpoint (no table param), while QUERY_USER
 * returns the same record via cdata?table=OPERLOG — the record grammar is
 * the contract, the envelope is not.
 */
async function ingestRecordLines(device: Device, body: string, log: Logger): Promise<void> {
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rec = parseKvRecord(line);
    switch (rec?.type) {
      case "BIOPHOTO":
        await ingestBiophoto(device, line, log);
        break;
      case "BIODATA":
        await ingestBiodata(device, line, log);
        break;
      case "USER": {
        const user = parseUserRecord(line);
        if (!user) break;
        await autoRegisterPerson(device, user.pin, user.name, log);
        // Every USER record is a free roster observation — whether the device
        // volunteered it on enrollment or we asked with DATA QUERY USERINFO.
        // Comparing it against what we believe turns ordinary traffic into a
        // continuous audit, which is the only roster check available without
        // a way to enumerate the device (see PHASE_3_PLAN.md).
        const observed = await reconcileUserRecord(device, user, log);
        log.info(
          { pin: user.pin, name: user.name, grp: user.grp, drift: observed.drift },
          "device reported USER record",
        );
        await autoPullPhotoIfMissing(device, user.pin, log);
        break;
      }
      case "OPLOG": {
        // A face enrolled directly on the terminal (bypassing the VMS) does
        // NOT push a USER/BIOPHOTO record on its own — confirmed on real
        // hardware: the only thing that arrives is this audit line. Without
        // this, a device-first enrollment is invisible until something else
        // happens to ask the device about that PIN, which for a genuinely
        // new PIN (no person, so never a reconcile-sweep candidate) is
        // never. Deliberately not filtered by opcode — the opcode-to-meaning
        // mapping is observational, not documented, and varies by firmware
        // batch (VMS_PROJECT_CONTEXT.md §4). Any OPLOG whose subject looks
        // like a PIN is worth asking about; autoPullPhotoIfMissing already
        // does the actual gating (person ID patterns, already-on-disk) so a
        // menu toggle or an out-of-range subject costs nothing beyond a
        // no-op check.
        const oplog = parseOplog(line);
        if (oplog?.pin !== null && oplog?.pin !== undefined) {
          await autoPullPhotoIfMissing(device, oplog.pin, log);
        }
        break;
      }
      default:
        // Never drop device data silently.
        log.debug({ line: line.slice(0, 200) }, "unhandled record line");
    }
  }
}

export async function ingestCdataBody(
  device: Device,
  table: string | undefined,
  body: string,
  log: Logger,
): Promise<void> {
  if (!body.trim()) return;

  if (table === "ATTLOG") {
    // Punches keep their dedicated batch path (single INSERT, dedup).
    await ingestAttlog(device, body, log);
    return;
  }

  if (table !== undefined && table !== "OPERLOG" && table !== "BIODATA") {
    log.warn({ table, body: body.slice(0, 400) }, "unrecognised cdata table — attempting line dispatch");
  }
  await ingestRecordLines(device, body, log);
}

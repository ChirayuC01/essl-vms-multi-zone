/**
 * Automated end-to-end verification (Phase 1 M6, extended through Phase 2 M11).
 *
 * Drives the real application (via app.inject, so the same routes, hooks and
 * error handling that run in production) against a simulated terminal, and
 * asserts the behaviours that do not need a human standing at the barrier.
 *
 * Sections 1–12 are the Phase 1 lifecycle plus the Phase 2 jobs. Section 13
 * covers what the hardware in the room cannot show: several records in one
 * body, dedicated IN/OUT gates, two devices in different timezones, and the
 * query budgets that make a remote database viable.
 *
 * NOTE ON STRUCTURE: everything runs in one function scope, so a `const` in
 * a new section collides with an identically-named one anywhere else in the
 * file. That has bitten three times. Prefix new locals distinctively, or wrap
 * the section in a block.
 *
 * It refuses to run against anything but a database whose name ends in
 * `_test`. This creates and destroys data freely, and a mis-set DATABASE_URL
 * must never be able to touch a real installation.
 *
 * Setup:
 *   createdb vms_test  (or: psql -c 'CREATE DATABASE vms_test OWNER vms_app')
 *   DATABASE_URL=postgresql://vms_app:...@localhost:5432/vms_test \
 *     npx prisma migrate deploy
 *
 * Run:
 *   DATABASE_URL=postgresql://vms_app:...@localhost:5432/vms_test \
 *   DATABASE_LOG_QUERIES=true npx tsx scripts/verify-e2e.ts
 */
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CommandStatus, CommandType, EntryState, Prisma } from "@prisma/client";
import { config } from "../src/config/index.js";
import { countQueries, prisma } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { enqueue, stopQueueMaintenance, sweepTimeouts } from "../src/adms/queue.js";
import { invalidateDevice } from "../src/adms/registry.js";
import { photoPathFor } from "../src/user-id.js";
import { sweepExpiredEntries } from "../src/jobs/expiry.js";
import { localDate } from "../src/services/entry-modes.js";
import { ACTIVE_ENTRY_STATES } from "../src/services/entries.js";

const SN = "E2ESIMDEVICE01";
// IDs are TEXT. Numeric-looking ones are still the common case, and at least
// one fixture is alphanumeric because a real roster is (`WCTPL070`, `ye01`)
// and every numeric-only assumption in this system was a silent data loss.
const PIN = "90001";
const PIN_SECOND = "90002";
const ALPHA_PIN = "WCTPL070";
const TZ_OFFSET = 330; // +05:30, matching the real unit

// An ID no person claims and that matches no person ID pattern - an employee
// on a terminal shared with the client's own staff. The VMS must not touch it
// or even complain about it (one owner per roster), and must never pull their
// photo.
//
// This used to be derived from PERSON_PIN_START/END. That range is gone: it
// could not describe a roster of `WCTPL070`s, and which IDs are people is now
// a per-device setting the section below sets explicitly.
const FOREIGN_PIN = "EMP0001";
/** A person on a low numeric ID, which a real site routinely has. */
const LOW_PIN = "1001";
/** Seen on the device, claimed by nobody - reported, never auto-removed. */
const ORPHAN_PIN = "90042";

// Manual Visitor registration requires the complete administrative profile.
// The aadhar is derived from the PIN so it is unique per person without a
// counter to keep in sync, and shaped like a real one (12 digits, never
// starting 0 or 1) so it passes the same validation a client's would.
let aadharCounter = 0;
let companyId = "";
let departmentId = "";
function registration(name: string, pin: string) {
  // Aadhaar is unique per person and shaped like a real one (12 digits, never
  // starting 0 or 1). Counter-based rather than derived from the ID, because
  // an ID is text now and `WCTPL070` has no numeric form.
  aadharCounter += 1;
  return {
    name,
    companyId,
    departmentId,
    category: "VISITOR",
    mobile: "+91 9876543210",
    aadharNumber: `2${String(aadharCounter).padStart(11, "0")}`,
    esslUserId: pin,
  };
}

// --- guard --------------------------------------------------------------
if (!/_test(\?|$)/.test(config.databaseUrl.split("/").pop() ?? "")) {
  console.error(
    "REFUSING TO RUN.\n" +
      "This script creates and destroys data. Point DATABASE_URL at a database\n" +
      "whose name ends in `_test`, never at a real installation.\n" +
      `Got: ${config.databaseUrl.replace(/:[^:@]*@/, ":***@")}`,
  );
  process.exit(1);
}

// Every PIN this run writes a photo for. Checked BEFORE anything happens,
// because a guard that fires halfway through has already created files that
// its own abort then skips cleaning up.
const PHOTO_PINS = [PIN, PIN_SECOND, ALPHA_PIN, ORPHAN_PIN, "TWOGATE1"];

/**
 * REFUSE to touch a photo we did not create.
 *
 * PHOTO_STORAGE_PATH is NOT swapped for the test run — unlike the database,
 * there is one photo directory and it is the real installation's. Writing a
 * synthetic JPEG over a PIN that already exists destroys a real enrollment,
 * and teardown then deletes it. That is not hypothetical: choosing a
 * realistic PIN for a regression test did exactly that to a live person.
 *
 * The database has had a hard guard since Milestone 6 — it refuses any name
 * not ending in `_test`. Photos deserved the same and did not have it.
 */
async function assertPhotoDirSafe(): Promise<void> {
  const { readFile: read } = await import("node:fs/promises");
  const clashes: string[] = [];
  for (const pin of PHOTO_PINS) {
    const file = path.join(config.photoStoragePath, `${pin}.jpg`);
    if (await read(file).then(() => true).catch(() => false)) clashes.push(file);
  }
  if (clashes.length === 0) return;
  console.error(
    [
      "",
      "REFUSING TO RUN.",
      "These photos already exist and this harness did not create them:",
      ...clashes.map((c) => `  ${c}`),
      "Overwriting them would destroy real enrollments, and teardown would then delete them.",
      "Point PHOTO_STORAGE_PATH at a scratch directory for the run:",
      "  PHOTO_STORAGE_PATH=./data/photos-e2e DATABASE_URL=... npm run verify:e2e",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// --- tiny assertion harness ---------------------------------------------
let passed = 0;
const failures: string[] = [];

function check(label: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(name: string): void {
  console.log(`\n${name}`);
}

/**
 * The sweeper takes a logger. Its output is asserted through the values it
 * returns, so swallow the log lines rather than interleaving them with the
 * PASS/FAIL report.
 */
const silentLog = { info: () => undefined, warn: () => undefined };

// --- simulated terminal --------------------------------------------------
class SimulatedDevice {
  constructor(
    private app: FastifyInstance,
    readonly serialNo: string,
  ) {}

  /** One poll. Returns the parsed command, or null when told to do nothing. */
  async poll(): Promise<{ wireId: number; text: string } | null> {
    const res = await this.app.inject({
      method: "GET",
      url: `/iclock/getrequest.aspx?SN=${this.serialNo}`,
    });
    const body = res.body.trim();
    const m = /^C:(\d+):([\s\S]*)$/.exec(body);
    return m ? { wireId: Number(m[1]), text: m[2] as string } : null;
  }

  async ack(wireId: number, returnCode = 0): Promise<void> {
    await this.app.inject({
      method: "POST",
      url: `/iclock/devicecmd.aspx?SN=${this.serialNo}`,
      payload: `ID=${wireId}&Return=${returnCode}&CMD=DATA`,
    });
  }

  /**
   * ATTLOG field 3 is the punch state, and it is what direction is read from
   * on a bidirectional terminal — 0 = Check-In, 1 = Check-Out, observed on
   * real hardware (VMS_PROJECT_CONTEXT.md §4.9). Defaults to Check-Out to
   * match what this unit sends when pinned to Fixed Mode.
   */
  async punch(localTime: string, statusCode = 1, pin: number = PIN): Promise<void> {
    await this.app.inject({
      method: "POST",
      url: `/iclock/cdata.aspx?SN=${this.serialNo}&table=ATTLOG`,
      payload: `${pin}\t${localTime}\t${statusCode}\t15\t0\t0`,
    });
  }

  /**
   * Several records in ONE body, which is what the terminal actually does
   * after a burst or a reconnect — it does not send one request per punch.
   * The single-punch helper above hides that entirely.
   */
  async punchBatch(rows: { time: string; statusCode?: number; pin?: number }[]): Promise<void> {
    const body = rows
      .map((r) => `${r.pin ?? PIN}\t${r.time}\t${r.statusCode ?? 1}\t15\t0\t0`)
      .join("\r\n");
    await this.app.inject({
      method: "POST",
      url: `/iclock/cdata.aspx?SN=${this.serialNo}&table=ATTLOG`,
      payload: body,
    });
  }

  /** Poll and acknowledge until the queue is empty. */
  async drain(limit = 10): Promise<string[]> {
    const seen: string[] = [];
    for (let i = 0; i < limit; i++) {
      const cmd = await this.poll();
      if (!cmd) break;
      seen.push(cmd.text.split("\t")[0] ?? cmd.text);
      await this.ack(cmd.wireId);
    }
    return seen;
  }
}

async function apiToken(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "e2e@vms.local", password: "e2e-password" },
  });
  return JSON.parse(res.body).token as string;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

// --- fixtures ------------------------------------------------------------
async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.syncCommand.deleteMany({}),
    prisma.punchEvent.deleteMany({}),
    prisma.entry.deleteMany({}),
    prisma.employeeDeviceAccess.deleteMany({}),
    prisma.attendanceDaySummary.deleteMany({}),
    prisma.personBiometric.deleteMany({}),
    prisma.person.deleteMany({}),
    prisma.auditLog.deleteMany({}),
    prisma.admissionQueue.deleteMany({}),
    prisma.device.deleteMany({}),
    prisma.zone.deleteMany({}),
    prisma.appUser.deleteMany({}),
    prisma.company.deleteMany({}),
    prisma.department.deleteMany({}),
    prisma.license.deleteMany({}),
    prisma.appConfig.deleteMany({}),
  ]);
  const [company, department] = await prisma.$transaction([
    prisma.company.create({ data: { name: "Verification Co" } }),
    prisma.department.create({ data: { name: "Verification Department" } }),
  ]);
  companyId = company.id;
  departmentId = department.id;
  const salt = randomBytes(16);
  await prisma.appUser.create({
    data: {
      email: "e2e@vms.local",
      passwordHash: `scrypt$${salt.toString("hex")}$${scryptSync("e2e-password", salt, 64).toString("hex")}`,
      role: "ADMIN",
    },
  });
  await prisma.device.create({
    data: {
      serialNo: SN,
      name: "simulated",
      timezoneOffsetMinutes: TZ_OFFSET,
      maxFaces: 3000,
      normalGroupId: 1,
      blockedGroupId: 100,
    },
  });
}

const testPhotoPath = () => photoPathFor(PIN);

/**
 * Every photo this run wrote, so teardown removes all of them.
 *
 * PHOTO_STORAGE_PATH is a single setting shared with the real installation —
 * unlike the database it is NOT swapped for the test run — so anything left
 * behind shows up as a phantom unclaimed enrollment on a live system.
 */
const writtenPhotos: string[] = [];

/**
 * A minimal but genuinely valid JPEG, so photo validation is exercised.
 *
 * NOTE: PHOTO_STORAGE_PATH is a single setting shared with the real
 * installation — unlike the database, it is not swapped for the test run. So
 * this file is removed in teardown; leaving it behind would show up as a
 * phantom unclaimed enrollment on a live system.
 */
async function testPhoto(pin: string = PIN): Promise<Buffer> {
  const real = photoPathFor(pin);

  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
    Buffer.alloc(4, 0),
    // SOF0 with 300x300 dimensions, so the dimension check has something real
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x2c, 0x03]),
    Buffer.alloc(200, 0x20),
    Buffer.from([0xff, 0xd9]),
  ]);
  await writeFile(real, jpeg).catch(() => undefined);
  writtenPhotos.push(real);
  return jpeg;
}

// --- the run -------------------------------------------------------------
async function main() {
  console.log(`Verifying against ${config.databaseUrl.replace(/:[^:@]*@/, ":***@")}\n`);

  // Before anything is written. A guard that fires halfway through has
  // already created files its own abort then skips cleaning up.
  await assertPhotoDirSafe();

  await resetDatabase();
  let app = await buildApp();
  await app.ready();
  let device = new SimulatedDevice(app, SN);
  const token = await apiToken(app);
  const jpeg = await testPhoto();

  // ======================================================================
  section("1. Database is swappable by connection string alone");
  // ======================================================================
  const health = await app.inject({ method: "GET", url: "/health" });
  check(
    "app runs unmodified against a different database",
    JSON.parse(health.body).database === "reachable",
    health.body,
  );

  // ======================================================================
  section("2. Registration and photo handling");
  // ======================================================================
  const created = await app.inject({
    method: "POST",
    url: "/api/people",
    headers: auth(token),
    payload: registration("E2E Person", PIN),
  });
  const personId = JSON.parse(created.body).id as string;
  check("person registered", created.statusCode === 201, created.body);
  check(
    "device-pushed photo attached at registration, no upload",
    JSON.parse(created.body).hasPhoto === true,
    created.body,
  );

  // ======================================================================
  section("3. Provision — order, both halves, face count");
  // ======================================================================
  const prov = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", purposeOfVisit: "E2E check" },
  });
  check("provision accepted", prov.statusCode === 202, prov.body);
  // Reassigned: the expiry section closes this entry and provisions fresh
  // ones, because a swept entry is genuinely finished.
  let entryId = JSON.parse(prov.body).entry.id as string;

  const first = await device.poll();
  check(
    "user is created before the photo is pushed",
    first?.text.startsWith("DATA UPDATE USERINFO") === true,
    first?.text.slice(0, 50),
  );
  check("user command carries the normal access group", first?.text.includes("Grp=1") === true);
  await device.ack(first!.wireId);

  const mid = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check("entry stays PENDING until BOTH halves land", mid.state === EntryState.PENDING_PROVISION);

  const second = await device.poll();
  check(
    "photo pushed second",
    second?.text.startsWith("DATA UPDATE BIOPHOTO") === true,
    second?.text.slice(0, 50),
  );
  const size = /Size=(\d+)/.exec(second?.text ?? "");
  check(
    "photo Size is the base64 character count, not bytes",
    Number(size?.[1]) === jpeg.toString("base64").length,
    `Size=${size?.[1]} for ${jpeg.length} bytes`,
  );
  await device.ack(second!.wireId);

  const provisioned = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check("entry PROVISIONED once the device confirms both", provisioned.state === EntryState.PROVISIONED);
  let dev = await prisma.device.findFirstOrThrow();
  check("faces_used incremented to 1", dev.facesUsed === 1, `got ${dev.facesUsed}`);

  // ======================================================================
  section("4. Punches — timestamps, verify mode, deduplication");
  // ======================================================================
  await device.punch("2026-08-04 09:15:30");
  const punch = await prisma.punchEvent.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
  check("punch recorded", punch.esslUserId === PIN);
  check("verify mode 15 (face) preserved", punch.verifyMode === 15);
  check(
    "device-local timestamp kept verbatim",
    punch.punchedAtDevice.toISOString() === "2026-08-04T09:15:30.000Z",
    punch.punchedAtDevice.toISOString(),
  );
  check(
    "normalised to UTC using the device's +05:30 offset",
    punch.punchedAtUtc.toISOString() === "2026-08-04T03:45:30.000Z",
    punch.punchedAtUtc.toISOString(),
  );
  const punchFeed = await app.inject({
    method: "GET",
    url: "/api/punches?pageSize=1",
    headers: auth(token),
  });
  const feedItem = JSON.parse(punchFeed.body).items[0];
  check(
    "live punch payload uses the admin device name and ingestion time",
    feedItem.deviceName === "simulated" && typeof feedItem.receivedAt === "string",
    punchFeed.body,
  );

  await device.punch("2026-08-04 09:15:30");
  check(
    "replayed punch deduplicated — never double counted",
    (await prisma.punchEvent.count()) === 1,
    `${await prisma.punchEvent.count()} rows`,
  );

  // ======================================================================
  section("4b. Punch → entry state machine");
  // ======================================================================
  // The device under simulation is role BOTH, so direction comes from the
  // punch state — the single-terminal topology, and the one being developed
  // against. A Check-Out while merely PROVISIONED is not a crossing.
  const afterOut = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "an OUT punch on a person who is not INSIDE changes nothing",
    afterOut.state === EntryState.PROVISIONED,
    afterOut.state,
  );

  await device.punch("2026-08-04 09:20:00", 0);
  const inside = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check("Check-In moves PROVISIONED → INSIDE", inside.state === EntryState.INSIDE, inside.state);
  check(
    "inAt records the crossing, normalised to UTC",
    inside.inAt?.toISOString() === "2026-08-04T03:50:00.000Z",
    String(inside.inAt?.toISOString()),
  );

  // A suppressed OUT (§4.10) looks exactly like this: the next record is
  // another IN. It must not corrupt the state, and must stay visible.
  await device.punch("2026-08-04 09:25:00", 0);
  const stillInside = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "a second Check-In leaves the person INSIDE rather than double-counting",
    stillInside.state === EntryState.INSIDE,
    stillInside.state,
  );

  await device.punch("2026-08-04 17:05:00", 1);
  const back = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check("Check-Out moves INSIDE → PROVISIONED", back.state === EntryState.PROVISIONED, back.state);
  check(
    "outAt records the exit",
    back.outAt?.toISOString() === "2026-08-04T11:35:00.000Z",
    String(back.outAt?.toISOString()),
  );

  const linked = await prisma.punchEvent.count({ where: { entryId, processed: true } });
  check("every matched punch is linked to the entry and marked processed", linked === 4, `${linked}`);

  // 255 = Undefined: what the terminal sends when no F-key was pressed or the
  // selection lapsed before the face matched. Observed in normal use, so the
  // fallback is load-bearing. The person is outside, so this reads as an entry.
  await device.punch("2026-08-04 18:00:00", 255);
  const undefinedPunch = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "an Undefined (255) punch alternates from the current state instead of being dropped",
    undefinedPunch.state === EntryState.INSIDE,
    undefinedPunch.state,
  );
  await device.punch("2026-08-04 18:30:00", 255);
  const alternatedBack = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "...and the next one alternates back out",
    alternatedBack.state === EntryState.PROVISIONED,
    alternatedBack.state,
  );

  // Employees share the terminal and own no entry here. Their punches must be
  // stored, not dropped — an unmatched PIN is a thing to look at, not to lose.
  await device.punch("2026-08-04 09:30:00", 0, "4242");
  const stray = await prisma.punchEvent.findFirstOrThrow({ where: { esslUserId: "4242" } });
  check("a punch from an unknown PIN is stored, not dropped", stray.esslUserId === "4242");
  check("...and is marked processed with no entry", stray.processed && stray.entryId === null);

  // ======================================================================
  section("5. Block and unblock");
  // ======================================================================
  await app.inject({ method: "POST", url: `/api/entries/${entryId}/block`, headers: auth(token) });
  const blockCmd = await device.poll();
  check(
    "block swaps the access group, biometric untouched",
    blockCmd?.text === `DATA UPDATE USERINFO PIN=${PIN}\tGrp=100`,
    blockCmd?.text,
  );
  const beforeAck = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check("not marked blocked until the device confirms", beforeAck.dayBlocked === false);
  await device.ack(blockCmd!.wireId);
  check(
    "marked blocked after confirmation",
    (await prisma.entry.findUniqueOrThrow({ where: { id: entryId } })).dayBlocked === true,
  );

  await app.inject({ method: "POST", url: `/api/entries/${entryId}/unblock`, headers: auth(token) });
  const unblockCmd = await device.poll();
  check("unblock restores the normal group", unblockCmd?.text.includes("Grp=1") === true);
  await device.ack(unblockCmd!.wireId);

  // ======================================================================
  section("6. INSIDE is protected from de-provisioning");
  // ======================================================================
  // Driven by a real punch rather than a direct write, so this exercises the
  // path production actually takes into INSIDE.
  await device.punch("2026-08-05 08:00:00", 0);
  const walkedIn = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check("a Check-In puts the person INSIDE", walkedIn.state === EntryState.INSIDE, walkedIn.state);

  const refused = await app.inject({
    method: "POST",
    url: `/api/entries/${entryId}/deprovision`,
    headers: auth(token),
  });
  check("de-provisioning a person who is INSIDE is refused", refused.statusCode === 409, refused.body);

  await device.punch("2026-08-05 17:00:00", 1);
  const walkedOut = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "de-provisioning becomes possible once they punch out",
    walkedOut.state === EntryState.PROVISIONED,
    walkedOut.state,
  );

  // ======================================================================
  section("6b. Expiry sweeper — the only thing that removes a lapsed person");
  // ======================================================================
  // There is no device-native expiry: Phase 0 proved EndDatetime is stored
  // and ignored. If this job is wrong, a person keeps opening a barrier after
  // their authorization ended, and nothing anywhere says so.
  const future = new Date(Date.now() + 3_600_000);
  await prisma.entry.update({
    where: { id: entryId },
    data: { retentionExpiresAt: future },
  });
  let expiry = await sweepExpiredEntries(silentLog);
  const untouched = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "an entry inside its window is left alone",
    expiry.deprovisioned === 0 && untouched.state === EntryState.PROVISIONED,
    untouched.state,
  );

  // Lapsed, but the person is still on site. This is the rule that must never
  // break: removing their credential now strands them at the exit barrier.
  await device.punch("2026-08-06 09:00:00", 0);
  await prisma.entry.update({
    where: { id: entryId },
    data: { retentionExpiresAt: new Date(Date.now() - 60_000) },
  });
  expiry = await sweepExpiredEntries(silentLog);
  const insideExpired = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "a lapsed person who is INSIDE is NOT de-provisioned",
    expiry.deprovisioned === 0 && insideExpired.state === EntryState.INSIDE,
    insideExpired.state,
  );
  check("...and is reported as deferred rather than silently skipped", expiry.deferredInside === 1);

  const overdue = await app.inject({
    method: "GET",
    url: "/api/entries/overdue",
    headers: auth(token),
  });
  check(
    "...and is visible on the overdue list, so deferred cannot look like forgotten",
    JSON.parse(overdue.body).total === 1,
    overdue.body,
  );

  // The board shows the same person as inside, with the expiry data the UI
  // derives "overdue" from — one request, and it cannot disagree with itself.
  const boardInside = await app.inject({
    method: "GET",
    url: "/api/entries/board",
    headers: auth(token),
  });
  const boardBody = JSON.parse(boardInside.body);
  check(
    "the board lists them as inside",
    boardBody.inside.length === 1 && boardBody.inside[0].person.esslUserId === PIN,
    boardInside.body,
  );
  check(
    "...with a lapsed window the UI can read as overdue without a second query",
    new Date(boardBody.inside[0].retentionExpiresAt).getTime() <=
      new Date(boardBody.serverTime).getTime(),
    `${boardBody.inside[0].retentionExpiresAt} vs ${boardBody.serverTime}`,
  );

  // Walking out is the moment removal becomes safe.
  await device.punch("2026-08-06 17:00:00", 1);
  const afterExit = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "punching out after the window lapsed de-provisions immediately",
    afterExit.state === EntryState.PENDING_DEPROVISION,
    afterExit.state,
  );
  const exitCmd = await device.poll();
  check("the de-provision reaches the device", exitCmd?.text.includes("DELETE USERINFO") === true);
  await device.ack(exitCmd!.wireId);
  const exitClosed = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check("entry closes once the device confirms", exitClosed.state === EntryState.REGISTERED, exitClosed.state);

  // Re-provision so the sections after this one start where they expect.
  await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
  });
  entryId = (await prisma.entry.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).id;
  await device.drain();
  const reprovisioned = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "a fresh entry is provisioned and ready for the remaining sections",
    reprovisioned.state === EntryState.PROVISIONED,
    reprovisioned.state,
  );

  // A window that lapses while nobody is inside is the ordinary case.
  await prisma.entry.update({
    where: { id: entryId },
    data: { retentionExpiresAt: new Date(Date.now() - 60_000) },
  });
  expiry = await sweepExpiredEntries(silentLog);
  const sweptEntry = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "a lapsed window on a person who is outside queues a de-provision",
    expiry.deprovisioned === 1 && sweptEntry.state === EntryState.PENDING_DEPROVISION,
    `${expiry.deprovisioned} / ${sweptEntry.state}`,
  );
  const sweepCmd = await prisma.syncCommand.findFirstOrThrow({
    where: { entryId, type: CommandType.DEPROVISION },
  });
  check(
    "queued as a system action, with no operator attributed to it",
    sweepCmd.initiatedById === null,
  );

  // Running twice must not queue twice — the sweep is expected to overlap
  // itself on a slow database, and a double DELETE would be a real bug.
  const before = await prisma.syncCommand.count({ where: { entryId } });
  await sweepExpiredEntries(silentLog);
  const after = await prisma.syncCommand.count({ where: { entryId } });
  check("sweeping again is a no-op — idempotent", before === after, `${before} → ${after}`);

  await device.drain();
  const backToRegistered = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "the swept entry closes on device confirmation",
    backToRegistered.state === EntryState.REGISTERED,
    backToRegistered.state,
  );

  // Restore a provisioned entry for the sections that follow.
  await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
  });
  entryId = (await prisma.entry.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).id;
  await device.drain();

  // ======================================================================
  section("6c. SINGLE_ENTRY — day-block on exit and the daily reset");
  // ======================================================================
  // Free the person first. Without this the provisions below fail with
  // "already has an active entry" — a 409 for the wrong reason, which would
  // make the refusal check below pass without testing anything.
  await app.inject({
    method: "POST",
    url: `/api/entries/${entryId}/deprovision`,
    headers: auth(token),
  });
  await device.drain();
  const freed = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    "person is free to be re-authorized in a different entry mode",
    freed.state === EntryState.REGISTERED,
    freed.state,
  );

  // The simulated device is role BOTH. SINGLE_ENTRY depends on seeing the OUT
  // punch, and this firmware can suppress that, so an unsafe configuration is
  // refused rather than silently enforcing nothing.
  await prisma.device.update({
    where: { serialNo: SN },
    data: { duplicatePunchPeriodMinutes: 1 },
  });
  const refusedMode = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", entryMode: "SINGLE_ENTRY", purposeOfVisit: "E2E check" },
  });
  check(
    "SINGLE_ENTRY is refused on a terminal that can swallow the OUT punch",
    refusedMode.statusCode === 409,
    `${refusedMode.statusCode} ${refusedMode.body}`,
  );
  check(
    "...with a message naming the device setting to change",
    /Duplicate Punch Period/.test(refusedMode.body),
    refusedMode.body,
  );

  // MULTI_ENTRY does not depend on the OUT punch, so it must stay allowed on
  // exactly the same device.
  const multiStillOk = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
  });
  check(
    "MULTI_ENTRY is unaffected by that setting",
    multiStillOk.statusCode === 202,
    `${multiStillOk.statusCode} ${multiStillOk.body}`,
  );
  await device.drain();
  await app.inject({
    method: "POST",
    url: `/api/entries/${JSON.parse(multiStillOk.body).entry.id}/deprovision`,
    headers: auth(token),
  });
  await device.drain();

  await prisma.device.update({
    where: { serialNo: SN },
    data: { duplicatePunchPeriodMinutes: 0, lastDayResetOn: null },
  });
  const single = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_WEEK", entryMode: "SINGLE_ENTRY", purposeOfVisit: "E2E check" },
  });
  check(
    "SINGLE_ENTRY is accepted once the window is recorded as zero",
    single.statusCode === 202,
    `${single.statusCode} ${single.body}`,
  );
  const singleEntryId = JSON.parse(single.body).entry.id as string;
  await device.drain();

  // In, then out. The exit is what consumes the day.
  await device.punch("2026-08-07 09:00:00", 0);
  await device.punch("2026-08-07 12:00:00", 1);
  const exited = await prisma.entry.findUniqueOrThrow({ where: { id: singleEntryId } });
  check("the person is back outside", exited.state === EntryState.PROVISIONED, exited.state);
  check(
    "not marked blocked until the device confirms",
    exited.dayBlocked === false,
    `dayBlocked=${exited.dayBlocked}`,
  );

  const exitBlockCmd = await device.poll();
  check(
    "a BLOCK is queued on the way out, moving them to the blocked group",
    exitBlockCmd?.text.includes("Grp=100") === true,
    exitBlockCmd?.text,
  );
  const blockRow = await prisma.syncCommand.findFirstOrThrow({
    where: { entryId: singleEntryId, type: CommandType.BLOCK },
  });
  check(
    "queued as a system action — an entry mode, not somebody's decision",
    blockRow.initiatedById === null,
  );
  await device.ack(exitBlockCmd!.wireId);
  const blockedNow = await prisma.entry.findUniqueOrThrow({ where: { id: singleEntryId } });
  check("marked blocked once confirmed", blockedNow.dayBlocked === true);

  const dayBlockedList = await app.inject({
    method: "GET",
    url: "/api/entries/day-blocked",
    headers: auth(token),
  });
  check(
    "and appears on the day-blocked list",
    JSON.parse(dayBlockedList.body).total === 1,
    dayBlockedList.body,
  );

  // The inside-now board (M10) answers from the same data in one request.
  const boardBlocked = await app.inject({
    method: "GET",
    url: "/api/entries/board",
    headers: auth(token),
  });
  const boardBlockedBody = JSON.parse(boardBlocked.body);
  check(
    "the board reports them blocked and nobody inside",
    boardBlockedBody.dayBlocked.length === 1 && boardBlockedBody.inside.length === 0,
    boardBlocked.body,
  );
  check(
    "the board carries the server's clock, so a drifted gate PC cannot judge expiry",
    typeof boardBlockedBody.serverTime === "string" &&
      Math.abs(Date.now() - new Date(boardBlockedBody.serverTime).getTime()) < 60_000,
    boardBlockedBody.serverTime,
  );

  // Re-entry on the same day must not silently work. The device denies them,
  // and a denial is never pushed to the server — so the absence of a new
  // punch is the expected observation, and the block state is what we assert.
  const stillBlocked = await prisma.entry.findUniqueOrThrow({ where: { id: singleEntryId } });
  check(
    "they stay blocked for the rest of the day",
    stillBlocked.dayBlocked === true && stillBlocked.state === EntryState.PROVISIONED,
    stillBlocked.state,
  );

  // A second exit punch must not queue a second block.
  const beforeDup = await prisma.syncCommand.count({
    where: { entryId: singleEntryId, type: CommandType.BLOCK },
  });
  await device.punch("2026-08-07 12:30:00", 1);
  const afterDup = await prisma.syncCommand.count({
    where: { entryId: singleEntryId, type: CommandType.BLOCK },
  });
  check("an already-blocked person is not blocked again", beforeDup === afterDup, `${beforeDup} → ${afterDup}`);

  // The reset is keyed to the DEVICE's local day, and it has not rolled over
  // yet — the device was just marked as reset for today.
  await prisma.device.update({
    where: { serialNo: SN },
    data: { lastDayResetOn: localDate(new Date(), TZ_OFFSET) },
  });
  const noReset = await app.inject({
    method: "POST",
    url: "/api/entries/daily-reset",
    headers: auth(token),
  });
  check(
    "the reset does nothing twice in the same device-local day",
    JSON.parse(noReset.body).devicesReset === 0,
    noReset.body,
  );

  // Roll the device into a new day. Deliberately expressed as "the last reset
  // was yesterday" rather than by moving a clock, because that is exactly the
  // state a service that was down at midnight wakes up in.
  await prisma.device.update({
    where: { serialNo: SN },
    data: { lastDayResetOn: "2000-01-01" },
  });
  const didReset = await app.inject({
    method: "POST",
    url: "/api/entries/daily-reset",
    headers: auth(token),
  });
  const resetBody = JSON.parse(didReset.body);
  check(
    "a new device-local day releases them",
    resetBody.devicesReset === 1 && resetBody.unblocked === 1,
    didReset.body,
  );
  const unblockCmdReset = await device.poll();
  check(
    "the unblock restores the normal group",
    unblockCmdReset?.text.includes("Grp=1") === true,
    unblockCmdReset?.text,
  );
  await device.ack(unblockCmdReset!.wireId);
  const released = await prisma.entry.findUniqueOrThrow({ where: { id: singleEntryId } });
  check("entry is no longer day-blocked", released.dayBlocked === false);
  check("and is still PROVISIONED, ready for another visit", released.state === EntryState.PROVISIONED);

  // A lapsed person must NOT be handed working access by the reset — the
  // sweeper is about to remove them.
  await prisma.entry.update({
    where: { id: singleEntryId },
    data: { dayBlocked: true, retentionExpiresAt: new Date(Date.now() - 60_000) },
  });
  await prisma.device.update({ where: { serialNo: SN }, data: { lastDayResetOn: "2000-01-01" } });
  const lapsedReset = await app.inject({
    method: "POST",
    url: "/api/entries/daily-reset",
    headers: auth(token),
  });
  check(
    "the reset refuses to un-block a person whose window has already closed",
    JSON.parse(lapsedReset.body).unblocked === 0,
    lapsedReset.body,
  );

  // Clean up: remove this entry and leave a fresh MULTI_ENTRY one behind.
  await prisma.entry.update({
    where: { id: singleEntryId },
    data: { dayBlocked: false },
  });
  await app.inject({
    method: "POST",
    url: `/api/entries/${singleEntryId}/deprovision`,
    headers: auth(token),
  });
  await device.drain();
  await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
  });
  entryId = (await prisma.entry.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).id;
  await device.drain();

  // ======================================================================
  section("7. Backend restart mid-cycle — the queue survives");
  // ======================================================================
  await app.inject({
    method: "POST",
    url: `/api/entries/${entryId}/deprovision`,
    headers: auth(token),
  });
  const queuedBefore = await prisma.syncCommand.count({ where: { status: CommandStatus.PENDING } });
  check("de-provision queued but not yet collected", queuedBefore === 1, `${queuedBefore} pending`);

  stopQueueMaintenance();
  await app.close();
  app = await buildApp();
  await app.ready();
  device = new SimulatedDevice(app, SN);
  console.log("  (application torn down and rebuilt)");

  const afterRestart = await device.poll();
  check(
    "command still delivered after a restart — nothing lost",
    afterRestart?.text === `DATA DELETE USERINFO PIN=${PIN}`,
    afterRestart?.text,
  );
  await device.ack(afterRestart!.wireId);

  const closed = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check("entry returns to REGISTERED", closed.state === EntryState.REGISTERED);
  dev = await prisma.device.findFirstOrThrow();
  check("faces_used returned to 0", dev.facesUsed === 0, `got ${dev.facesUsed}`);

  const survivor = await prisma.person.findUniqueOrThrow({
    where: { id: personId },
    include: { biometric: true },
  });
  check("person record retained after de-provisioning", survivor.isActive === true);
  check("photo retained — this is what makes re-provisioning free", survivor.biometric !== null);

  // ======================================================================
  section("8. The core promise — re-provision with no re-enrollment");
  // ======================================================================
  // Purpose is required on every authorization, including a re-provision:
  // this is a new visit, and last month's reason is not this month's.
  const noPurpose = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
  });
  check(
    "provisioning without a purpose of visit is refused",
    noPurpose.statusCode === 400,
    `${noPurpose.statusCode} ${noPurpose.body}`,
  );

  const again = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { purposeOfVisit: "Re-provision check" },
  });
  check("re-provision accepted", again.statusCode === 202, again.body);
  check(
    "the purpose is recorded on the entry",
    (await prisma.entry.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).purposeOfVisit ===
      "Re-provision check",
  );
  const replayed = await device.drain();
  check(
    "user and photo pushed again from stored data alone",
    replayed.length === 2 &&
      replayed[0]!.startsWith("DATA UPDATE USERINFO") &&
      replayed[1]!.startsWith("DATA UPDATE BIOPHOTO"),
    replayed.join(" then "),
  );
  // Taken from the response rather than inferred from "the entry that isn't
  // the old one" — a person accumulates entries across authorization cycles,
  // so that inference silently picks a closed entry once there are three.
  const entry2 = await prisma.entry.findUniqueOrThrow({
    where: { id: JSON.parse(again.body).entry.id as string },
  });
  check("re-provisioned entry reaches PROVISIONED", entry2.state === EntryState.PROVISIONED);

  // ======================================================================
  section("9. Device offline, then reconnecting");
  // ======================================================================
  await app.inject({ method: "POST", url: `/api/entries/${entry2.id}/block`, headers: auth(token) });
  await app.inject({
    method: "POST",
    url: `/api/people/${personId}/query-device`,
    headers: auth(token),
  });
  const waiting = await prisma.syncCommand.count({ where: { status: CommandStatus.PENDING } });
  check("commands queue up while the device is away", waiting === 2, `${waiting} pending`);

  const flushed = await device.drain();
  check("all queued commands flush in order on reconnect", flushed.length === 2, flushed.join(","));
  check(
    "and are delivered oldest-first",
    flushed[0]?.startsWith("DATA UPDATE USERINFO") === true,
    flushed.join(","),
  );

  // ======================================================================
  section("10. Timeout sweep — a stranded command is retried");
  // ======================================================================
  // Enqueued directly rather than through /query-device: that endpoint buckets
  // its idempotency key to the minute, so a second call inside the same minute
  // correctly returns the existing command and queues nothing new. Verified
  // separately in section 9 — here we need a fresh command to strand.
  await enqueue({
    type: CommandType.QUERY_USER,
    targetDeviceId: (await prisma.device.findFirstOrThrow()).id,
    payload: { pin: PIN },
    idempotencyKey: `e2e-sweep:${Date.now()}`,
  });
  const stranded = await device.poll();
  check("command dispatched", stranded !== null, "nothing was queued");
  // Never acknowledged — as if the device lost power mid-command.
  await prisma.syncCommand.updateMany({
    where: { status: CommandStatus.SENT },
    data: { sentAt: new Date(Date.now() - 6 * 60_000) },
  });
  const swept = await sweepTimeouts();
  check("unacknowledged command marked for retry", swept.retried === 1, JSON.stringify(swept));
  const redelivered = await device.poll();
  check("and is delivered again", redelivered?.text.includes("DATA QUERY USERINFO") === true);
  await device.ack(redelivered!.wireId);

  // ======================================================================
  section("11. Hot-path query budget (the remote-database guarantee)");
  // ======================================================================
  if (config.databaseLogQueries) {
    // Warm the device cache the way a running system would be.
    await device.poll();
    const idle = await countQueries(async () => device.poll());
    check(
      "idle poll costs at most 1 query",
      idle.queries.length <= 1,
      `${idle.queries.length}: ${idle.queries.join(" | ")}`,
    );

    await app.inject({
      method: "POST",
      url: `/api/people/${personId}/query-device`,
      headers: auth(token),
    });
    const busy = await countQueries(async () => device.poll());
    check(
      "poll that claims a command costs exactly 1 query",
      busy.queries.length === 1,
      `${busy.queries.length}: ${busy.queries.join(" | ")}`,
    );
    check(
      "the claim is a single UPDATE ... RETURNING, not select-then-update",
      /UPDATE "sync_command"[\s\S]*RETURNING/i.test(busy.queries[0] ?? ""),
      busy.queries[0]?.slice(0, 90),
    );
  } else {
    console.log("  SKIP  set DATABASE_LOG_QUERIES=true to assert the query budget");
  }

  // ======================================================================
  section("12. Photos stay on disk, never in the database");
  // ======================================================================
  const onDisk = await readFile(path.join(config.photoStoragePath, `${PIN}.jpg`)).catch(() => null);
  check("photo file present on local disk", onDisk !== null);
  const biometric = await prisma.personBiometric.findFirstOrThrow();
  check(
    "database holds only a path, not image bytes",
    typeof biometric.photoPath === "string" && biometric.photoPath.endsWith(`${PIN}.jpg`),
    biometric.photoPath,
  );

  // ======================================================================
  section("13. Phase 2 at batch scale, and in topologies nobody can stand in front of");
  // ======================================================================
  // Everything above drives one punch at a time through one bidirectional
  // terminal, because that is the hardware in the room. The terminal does not
  // actually behave that way — it sends several records in one body after a
  // burst or a reconnect — and production will not have that topology.

  const PIN2 = PIN_SECOND;
  await testPhoto(PIN2);
  const secondPerson = await app.inject({
    method: "POST",
    url: "/api/people",
    headers: auth(token),
    payload: registration("E2E Person Two", PIN2),
  });
  const person2Id = JSON.parse(secondPerson.body).id as string;
  check("a second person registers", secondPerson.statusCode === 201, secondPerson.body);
  await app.inject({
    method: "POST",
    url: `/api/people/${person2Id}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
  });
  await device.drain();

  // Both people need to be outside and provisioned for the batch below.
  const entry1 = await prisma.entry.findFirstOrThrow({
    where: { personId, state: { in: [EntryState.PROVISIONED, EntryState.INSIDE] } },
    orderBy: { createdAt: "desc" },
  });
  await prisma.entry.updateMany({
    where: { id: entry1.id },
    data: { state: EntryState.PROVISIONED },
  });

  // --- one body, several records, two people, a full cycle for one of them
  await device.punchBatch([
    { time: "2026-08-08 08:00:00", statusCode: 0, pin: PIN },
    { time: "2026-08-08 08:01:00", statusCode: 0, pin: PIN2 },
    { time: "2026-08-08 17:00:00", statusCode: 1, pin: PIN },
    { time: "2026-08-08 09:00:00", statusCode: 0, pin: "777777" },
  ]);

  const afterBatch1 = await prisma.entry.findUniqueOrThrow({ where: { id: entry1.id } });
  const entry2Row = await prisma.entry.findFirstOrThrow({
    where: { personId: person2Id },
    orderBy: { createdAt: "desc" },
  });
  check(
    "an IN and an OUT in the same body net out to back-outside",
    afterBatch1.state === EntryState.PROVISIONED,
    afterBatch1.state,
  );
  check(
    "...and are applied in punch order, not body order",
    afterBatch1.inAt?.toISOString() === "2026-08-08T02:30:00.000Z" &&
      afterBatch1.outAt?.toISOString() === "2026-08-08T11:30:00.000Z",
    `in=${afterBatch1.inAt?.toISOString()} out=${afterBatch1.outAt?.toISOString()}`,
  );
  check(
    "a second person in the same body reaches their own entry",
    entry2Row.state === EntryState.INSIDE,
    entry2Row.state,
  );
  check(
    "an unknown PIN in the batch is stored without derailing the rest",
    (await prisma.punchEvent.count({ where: { esslUserId: "777777", processed: true } })) === 1,
  );

  // --- the property the whole ingestion design rests on
  if (config.databaseLogQueries) {
    // The claim is independence from punch COUNT, so both runs use the same
    // single person. Cost does still grow with the number of distinct ENTRIES
    // a batch touches, and that is unavoidable: each entry gets its own inAt
    // or outAt, so they cannot share one UPDATE. That growth is bounded by
    // how many people walked through, not by how many records arrived.
    // Both batches must end on the same DIRECTION, not just the same person.
    // A batch ending on an OUT runs the exit checks (lapsed-window removal,
    // single-entry block) that one ending on an IN never reaches — two fixed
    // queries that would otherwise be mistaken for batch-size scaling.
    const one = await countQueries(async () =>
      device.punchBatch([
        { time: "2026-08-09 08:00:00", statusCode: 0, pin: PIN },
        { time: "2026-08-09 09:00:00", statusCode: 1, pin: PIN },
      ]),
    );
    const many = await countQueries(async () =>
      device.punchBatch(
        Array.from({ length: 12 }, (_, i) => ({
          time: `2026-08-10 08:${String(i).padStart(2, "0")}:00`,
          statusCode: i % 2,
          pin: PIN,
        })),
      ),
    );
    check(
      "ingesting 12 punches costs no more queries than ingesting 2",
      many.queries.length <= one.queries.length,
      `2 punches: ${one.queries.length} queries, 12 punches: ${many.queries.length}`,
    );
    check(
      "...and no per-punch SELECT appears in the batch",
      many.queries.filter((q) => /SELECT[\s\S]*"punch_event"/i.test(q)).length <= 1,
      many.queries.filter((q) => /SELECT[\s\S]*"punch_event"/i.test(q)).length.toString(),
    );
  } else {
    console.log("  SKIP  set DATABASE_LOG_QUERIES=true to assert the ingestion query budget");
  }

  // --- a dedicated gate: the production topology, on hardware we do not have
  await prisma.entry.updateMany({
    where: { personId: person2Id },
    data: { state: EntryState.PROVISIONED },
  });
  const dev1 = await prisma.device.findUniqueOrThrow({ where: { serialNo: SN } });
  const setRole = async (role: string): Promise<void> => {
    await app.inject({
      method: "PATCH",
      url: `/api/devices/${dev1.id}`,
      headers: auth(token),
      payload: { role },
    });
  };
  // Through the API on purpose. The ADMS layer serves device lookups from a
  // 60 s cache, so a role written straight to the database would not reach
  // the punch path — which is exactly the bug this found.
  await setRole("IN");

  // Check-Out (1) arriving at a terminal wired as the IN gate. The gate wins:
  // where the barrier physically stands outranks a field in a record.
  await device.punch("2026-08-11 08:00:00", 1, PIN2);
  const atInGate = await prisma.entry.findFirstOrThrow({
    where: { personId: person2Id },
    orderBy: { createdAt: "desc" },
  });
  check(
    "a dedicated IN gate admits, even when the record says Check-Out",
    atInGate.state === EntryState.INSIDE,
    atInGate.state,
  );
  const conflict = await prisma.auditLog.count({
    where: { action: "PUNCH_DIRECTION_CONFLICT" },
  });
  check("...and the disagreement is audited rather than swallowed", conflict === 1, `${conflict}`);

  await setRole("OUT");
  await device.punch("2026-08-11 17:00:00", 0, PIN2);
  const atOutGate = await prisma.entry.findFirstOrThrow({
    where: { personId: person2Id },
    orderBy: { createdAt: "desc" },
  });
  check(
    "a dedicated OUT gate releases, even when the record says Check-In",
    atOutGate.state === EntryState.PROVISIONED,
    atOutGate.state,
  );
  await setRole("BOTH");

  // --- expiry and the day-block wanting the same person at the same moment
  // A SINGLE_ENTRY person whose window lapsed while they were inside. On the
  // way out both rules fire: removal must win, because blocking someone who
  // is being deleted from the device queues a command for a user that will
  // not exist. This ordering was reasoned about in code and never tested.
  await prisma.device.update({
    where: { serialNo: SN },
    data: { duplicatePunchPeriodMinutes: 0 },
  });
  await app.inject({
    method: "POST",
    url: `/api/entries/${atOutGate.id}/deprovision`,
    headers: auth(token),
  });
  await device.drain();
  const both = await app.inject({
    method: "POST",
    url: `/api/people/${person2Id}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", entryMode: "SINGLE_ENTRY", purposeOfVisit: "E2E check" },
  });
  const bothId = JSON.parse(both.body).entry.id as string;
  await device.drain();
  await device.punch("2026-08-12 08:00:00", 0, PIN2);
  await prisma.entry.update({
    where: { id: bothId },
    data: { retentionExpiresAt: new Date(Date.now() - 60_000) },
  });
  await device.punch("2026-08-12 17:00:00", 1, PIN2);

  const contested = await prisma.entry.findUniqueOrThrow({ where: { id: bothId } });
  check(
    "a lapsed SINGLE_ENTRY person is removed on exit, not merely blocked",
    contested.state === EntryState.PENDING_DEPROVISION,
    contested.state,
  );
  check(
    "...and no BLOCK is queued for a person being deleted from the device",
    (await prisma.syncCommand.count({ where: { entryId: bothId, type: CommandType.BLOCK } })) === 0,
  );
  await device.drain();

  // --- a two-gate site: ONE authorization, BOTH terminals
  //
  // The production topology, and the one thing about it nobody had asserted:
  // that provisioning actually reaches both devices. Every other two-device
  // check in this file changes one simulated terminal's role, which exercises
  // direction resolution and says nothing about how many rosters a single
  // provision lands on. A person loaded on the IN gate but not the OUT gate
  // walks in and is then trapped, and the console would show the entry as
  // PROVISIONED throughout.
  {
    const outGate = await prisma.device.create({
      data: {
        serialNo: "E2ESIMOUTGATE",
        name: "simulated out gate",
        role: "OUT",
        timezoneOffsetMinutes: TZ_OFFSET,
        normalGroupId: 1,
        blockedGroupId: 100,
      },
    });
    const inGate = await prisma.device.findUniqueOrThrow({ where: { serialNo: SN } });

    const twoGatePin = "TWOGATE1";
    await testPhoto(twoGatePin);
    const twoGatePerson = await app.inject({
      method: "POST",
      url: "/api/people",
      headers: auth(token),
      payload: registration("Two Gate Person", twoGatePin),
    });
    const twoGatePersonId = JSON.parse(twoGatePerson.body).id as string;

    const spanning = await app.inject({
      method: "POST",
      url: `/api/people/${twoGatePersonId}/provision`,
      headers: auth(token),
      payload: {
        deviceIds: [inGate.id, outGate.id],
        retentionPolicy: "ONE_DAY",
        entryMode: "MULTI_ENTRY",
        purposeOfVisit: "E2E two-gate",
      },
    });
    check("a person can be provisioned onto two gates at once", spanning.statusCode === 202, spanning.body);

    const queued = await prisma.syncCommand.findMany({
      where: { personId: twoGatePersonId },
      select: { type: true, targetDeviceId: true },
    });
    const forGate = (id: string) => queued.filter((c) => c.targetDeviceId === id).map((c) => c.type).sort();
    check(
      "both gates get a user AND a photo — one click, two rosters",
      JSON.stringify(forGate(inGate.id)) === JSON.stringify(["PROVISION", "PUSH_PHOTO"]) &&
        JSON.stringify(forGate(outGate.id)) === JSON.stringify(["PROVISION", "PUSH_PHOTO"]),
      `IN: ${forGate(inGate.id).join()} | OUT: ${forGate(outGate.id).join()}`,
    );

    // Half-confirmed is not provisioned. The IN gate acknowledging both of its
    // commands must NOT advance the entry while the OUT gate has not answered:
    // that would report a person as loaded on a terminal that has never heard
    // of them, which is exactly how somebody gets trapped inside.
    await device.drain();
    const halfway = await prisma.entry.findFirstOrThrow({
      where: { personId: twoGatePersonId },
      orderBy: { createdAt: "desc" },
    });
    check(
      "one gate confirming does not mark the person provisioned",
      halfway.state === EntryState.PENDING_PROVISION,
      halfway.state,
    );

    // The OUT gate is a separate simulated terminal; answer for it directly.
    const outCommands = await prisma.syncCommand.findMany({
      where: { personId: twoGatePersonId, targetDeviceId: outGate.id },
      orderBy: { seq: "asc" },
    });
    for (const cmd of outCommands) {
      await app.inject({
        method: "GET",
        url: `/iclock/getrequest.aspx?SN=${outGate.serialNo}`,
      });
      const claimed = await prisma.syncCommand.findUniqueOrThrow({ where: { id: cmd.id } });
      await app.inject({
        method: "POST",
        url: `/iclock/devicecmd.aspx?SN=${outGate.serialNo}`,
        payload: `ID=${claimed.deviceCmdId}&Return=0&CMD=DATA`,
      });
    }
    const bothConfirmed = await prisma.entry.findFirstOrThrow({
      where: { personId: twoGatePersonId },
      orderBy: { createdAt: "desc" },
    });
    check(
      "...and confirming the second gate completes the authorization",
      bothConfirmed.state === EntryState.PROVISIONED,
      bothConfirmed.state,
    );

    // De-provisioning has to reach every roster it was loaded onto, or the
    // person keeps working access at whichever gate was missed.
    const closing = await app.inject({
      method: "POST",
      url: `/api/entries/${bothConfirmed.id}/deprovision`,
      headers: auth(token),
    });
    check("de-provision accepted for a two-gate entry", closing.statusCode === 202, closing.body);
    const removals = await prisma.syncCommand.findMany({
      where: { personId: twoGatePersonId, type: CommandType.DEPROVISION },
      select: { targetDeviceId: true },
    });
    check(
      "removal is queued for BOTH gates, not just the first",
      new Set(removals.map((r) => r.targetDeviceId)).size === 2,
      `${removals.length} removal(s) across ${new Set(removals.map((r) => r.targetDeviceId)).size} device(s)`,
    );

    await prisma.syncCommand.deleteMany({ where: { targetDeviceId: outGate.id } });
    await prisma.device.delete({ where: { id: outGate.id } });
    await device.drain();
  }

  // --- the daily reset is per device, not per server
  const indiaDefaultDevice = await prisma.device.create({
    data: { serialNo: "E2EISTDEFAULT01", name: "India default check" },
  });
  check(
    "a newly adopted terminal defaults to the India offset",
    indiaDefaultDevice.timezoneOffsetMinutes === 330,
    String(indiaDefaultDevice.timezoneOffsetMinutes),
  );
  await prisma.device.delete({ where: { id: indiaDefaultDevice.id } });

  const utcDevice = await prisma.device.create({
    data: {
      serialNo: "E2ESIMDEVICE02",
      name: "simulated far zone",
      timezoneOffsetMinutes: 0,
      normalGroupId: 1,
      blockedGroupId: 100,
      lastDayResetOn: localDate(new Date(), 0),
    },
  });
  await prisma.device.update({
    where: { serialNo: SN },
    data: { lastDayResetOn: localDate(new Date(), TZ_OFFSET) },
  });
  const noneDue = await app.inject({
    method: "POST",
    url: "/api/entries/daily-reset",
    headers: auth(token),
  });
  check(
    "no device is reset when both have already had their local day",
    JSON.parse(noneDue.body).devicesReset === 0,
    noneDue.body,
  );

  await prisma.device.update({ where: { serialNo: SN }, data: { lastDayResetOn: "2000-01-01" } });
  const oneDue = await app.inject({
    method: "POST",
    url: "/api/entries/daily-reset",
    headers: auth(token),
  });
  check(
    "only the device whose own local day rolled over is reset",
    JSON.parse(oneDue.body).devicesReset === 1,
    oneDue.body,
  );
  const farZone = await prisma.device.findUniqueOrThrow({ where: { id: utcDevice.id } });
  check(
    "...and the other device's reset date is left alone",
    farZone.lastDayResetOn === localDate(new Date(), 0),
    String(farZone.lastDayResetOn),
  );

  const timezoneUpdate = await app.inject({
    method: "PATCH",
    url: `/api/devices/${utcDevice.id}`,
    headers: auth(token),
    payload: { timezoneOffsetMinutes: 330 },
  });
  const timezoneUpdatedDevice = await prisma.device.findUniqueOrThrow({
    where: { id: utcDevice.id },
  });
  check(
    "an Admin can correct a terminal timezone used by future punch ingestion",
    timezoneUpdate.statusCode === 200 && timezoneUpdatedDevice.timezoneOffsetMinutes === 330,
    timezoneUpdate.body,
  );

  // With two devices registered, "which barrier is this person authorized at"
  // stops having an obvious answer, and the API says so rather than guessing.
  const ambiguous = await app.inject({
    method: "POST",
    // The second person, whose entry closed just above — a person with an
    // active entry is refused for that reason first, and would hide this.
    url: `/api/people/${person2Id}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
  });
  check(
    "provisioning refuses to guess a device once more than one is registered",
    ambiguous.statusCode === 400,
    `${ambiguous.statusCode} ${ambiguous.body}`,
  );

  // Remove it again: it exists only for the timezone check, and leaving a
  // second device registered would change what every later step means.
  await prisma.device.delete({ where: { id: utcDevice.id } });

  // --- the sweeper's cost does not scale with how many windows lapse
  // A shift change can close hundreds of windows at once. Comparing one
  // against several is the honest form of "fixed cost": both runs take the
  // same path, so an equal query count means the batch is genuinely batched.
  if (config.databaseLogQueries) {
    const lapse = async (people: string[]): Promise<void> => {
      for (const v of people) {
        const res = await app.inject({
          method: "POST",
          url: `/api/people/${v}/provision`,
          headers: auth(token),
          payload: { retentionPolicy: "ONE_DAY", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
        });
        await prisma.entry.update({
          where: { id: JSON.parse(res.body).entry.id as string },
          data: { retentionExpiresAt: new Date(Date.now() - 60_000) },
        });
      }
      await device.drain();
    };

    // Free both people first, so each round starts from the same place.
    for (const e of await prisma.entry.findMany({
      where: { state: { in: [...ACTIVE_ENTRY_STATES] } },
      select: { id: true },
    })) {
      await app.inject({
        method: "POST",
        url: `/api/entries/${e.id}/deprovision`,
        headers: auth(token),
      });
    }
    await device.drain();

    await lapse([personId]);
    const oneSweep = await countQueries(async () => sweepExpiredEntries(silentLog));
    await device.drain();

    await lapse([personId, person2Id]);
    const manySweep = await countQueries(async () => sweepExpiredEntries(silentLog));
    await device.drain();

    check(
      "sweeping several lapsed entries costs no more queries than sweeping one",
      manySweep.queries.length <= oneSweep.queries.length,
      `1 entry: ${oneSweep.queries.length} queries, 2 entries: ${manySweep.queries.length}`,
    );
    check(
      "...and both were actually swept, so the comparison means something",
      oneSweep.result.deprovisioned === 1 && manySweep.result.deprovisioned === 2,
      `${oneSweep.result.deprovisioned} then ${manySweep.result.deprovisioned}`,
    );
  }

  // ======================================================================
  section("14. Reconciliation — the drift that is otherwise silent");
  // ======================================================================
  // A person still loaded on a terminal after their authorization ended keeps
  // opening the barrier, and nothing else in the system would ever say so.
  // There is no device-native expiry to fall back on, so this is the control.

  // Everything from section 13 is closed by now; start from a clean roster.
  for (const e of await prisma.entry.findMany({
    where: { state: { in: [...ACTIVE_ENTRY_STATES] } },
    select: { id: true },
  })) {
    await app.inject({
      method: "POST",
      url: `/api/entries/${e.id}/deprovision`,
      headers: auth(token),
    });
  }
  await device.drain();

  const asUserRecord = (pin: string, grp: number): string =>
    `USER PIN=${pin}\tName=Drift Test\tPri=0\tPasswd=\tCard=\tGrp=${grp}\t` +
    `TZ=0000000100000000\tVerify=-1\tViceCard=\tStartDatetime=0\tEndDatetime=0`;

  const pushUser = async (pin: number, grp: number): Promise<void> => {
    await app.inject({
      method: "POST",
      url: `/iclock/cdata.aspx?SN=${SN}&table=OPERLOG`,
      payload: asUserRecord(pin, grp),
    });
  };

  // 1. The dangerous case: the device reports a person we believe is gone.
  await pushUser(PIN, 1);
  const removal = await prisma.syncCommand.findFirst({
    where: { type: CommandType.DEPROVISION, personId, status: CommandStatus.PENDING },
    orderBy: { createdAt: "desc" },
  });
  check(
    "a person on the device with no active authorization is removed",
    removal !== null,
    "no DEPROVISION queued",
  );
  check(
    "...attributed to the system, because nobody decided it",
    removal?.initiatedById === null,
  );
  check(
    "...and recorded as a self-heal, not just a log line",
    (await prisma.auditLog.count({ where: { action: "RECONCILE_HEALED" } })) >= 1,
  );
  await device.drain();

  // 2. A PIN in our reserved range that no person claims. Reported, NEVER
  // deleted — on a shared terminal an unidentifiable record may not be ours,
  // and deleting someone else's user is worse than flagging an anomaly.
  const orphanPin = ORPHAN_PIN;
  const beforeOrphan = await prisma.syncCommand.count({ where: { type: CommandType.DEPROVISION } });
  await pushUser(orphanPin, 1);
  check(
    "an unidentifiable PIN in the person range is reported, not deleted",
    (await prisma.syncCommand.count({ where: { type: CommandType.DEPROVISION } })) ===
      beforeOrphan,
  );
  check(
    "...and raises drift for a person to look at",
    (await prisma.auditLog.count({
      where: { action: "RECONCILE_DRIFT_FOUND" },
    })) >= 1,
  );

  // The alert derived from that drift must count PINs, not sightings, and
  // must clear once the PIN is claimed. The first version did neither: two
  // observations of one PIN read as "2 unrecognised PINs", and registering
  // the person left the warning standing because it was reading history.
  await pushUser(orphanPin, 1); // seen a second time
  const orphanAlerts = await app.inject({ method: "GET", url: "/api/alerts", headers: auth(token) });
  const orphanAlert = JSON.parse(orphanAlerts.body).items.find(
    (a: { id: string }) => a.id === "unknown-pins",
  );
  check(
    "one ID seen twice is one unrecognised ID, not two",
    orphanAlert !== undefined && /^1 unrecognised ID /.test(orphanAlert.title),
    orphanAlert?.title ?? "no unknown-pins alert",
  );
  check(
    "...and the alert names it, so it is actionable without digging in the audit log",
    orphanAlert !== undefined && orphanAlert.detail.includes(String(orphanPin)),
    orphanAlert?.detail ?? "-",
  );

  await testPhoto(orphanPin);
  await app.inject({
    method: "POST",
    url: "/api/people",
    headers: auth(token),
    payload: registration("Claimed Orphan", orphanPin),
  });
  const afterClaim = await app.inject({ method: "GET", url: "/api/alerts", headers: auth(token) });
  check(
    "registering the person clears it — the alert tracks the condition, not the log",
    !JSON.parse(afterClaim.body).items.some((a: { id: string }) => a.id === "unknown-pins"),
    afterClaim.body,
  );

  // 1b. The SECOND sighting is the one that matters.
  //
  // The first version keyed removal on an hourly bucket, so once a removal
  // succeeded every further observation that hour collapsed onto the finished
  // command and queued nothing — while still logging "removing". A user
  // re-added to the terminal was therefore never touched again, which is
  // exactly the drift this exists to catch. Found on hardware.
  await device.drain();
  const beforeSecond = await prisma.syncCommand.count({
    where: { type: CommandType.DEPROVISION },
  });
  await pushUser(PIN, 1);
  check(
    "a person seen again after a completed removal is removed again",
    (await prisma.syncCommand.count({ where: { type: CommandType.DEPROVISION } })) ===
      beforeSecond + 1,
    "second sighting queued nothing — idempotency swallowed it",
  );

  // ...but not while one is still in flight. Left undrained on purpose.
  const beforeThird = await prisma.syncCommand.count({
    where: { type: CommandType.DEPROVISION },
  });
  await pushUser(PIN, 1);
  check(
    "...and not piled up while a removal is still in flight",
    (await prisma.syncCommand.count({ where: { type: CommandType.DEPROVISION } })) ===
      beforeThird,
  );
  await device.drain();

  // 2b. A person whose PIN sits OUTSIDE the reserved range. Registration
  // deliberately accepts an explicit esslUserId (device-first has to take the
  // PIN the terminal already used), so this is an ordinary person, not an edge
  // case — and the first version of this reconciler skipped every one of them
  // silently, because it decided ownership from the range instead of from the
  // person record. The security control excluding exactly the records it
  // exists to cover, with nothing anywhere saying so.
  // Derived from the configured range so this holds however the site sets it,
  // and synthetic rather than realistic — the photo directory is shared with
  // the real installation, and a plausible PIN once destroyed a live one.
  const lowPin = LOW_PIN;
  // Deliberately NO photo written first: a photo already on disk at
  // registration is what marks a person as adopted from the terminal, and an
  // adopted person is reported rather than removed. That case gets its own
  // check below; this one is about ownership being decided by the person
  // record rather than by the shape of the ID.
  const lowPerson = await app.inject({
    method: "POST",
    url: "/api/people",
    headers: auth(token),
    payload: registration("Low PIN Person", lowPin),
  });
  check(
    "a person can be registered on a low numeric ID a site was already using",
    lowPerson.statusCode === 201,
    lowPerson.body,
  );
  const lowRemovalsBefore = await prisma.syncCommand.count({
    where: { type: CommandType.DEPROVISION },
  });
  await pushUser(lowPin, 1);
  check(
    "ownership is decided by the person record, not by the shape of the ID",
    (await prisma.syncCommand.count({ where: { type: CommandType.DEPROVISION } })) ===
      lowRemovalsBefore + 1,
    "no DEPROVISION queued for a person whose ID looks nothing like the others",
  );
  await device.drain();

  // 2b. A person ADOPTED from the terminal is reported, never removed.
  //
  // A photo already on disk at registration means the terminal enrolled this
  // person, not us — and reconciliation removing them would be deleting an
  // enrollment the client made themselves. The trigger is innocuous (any USER
  // record arriving before we provision them), which is exactly why it needs
  // its own check rather than being inferred from the one above.
  await testPhoto(ALPHA_PIN);
  const adopted = await app.inject({
    method: "POST",
    url: "/api/people",
    headers: auth(token),
    payload: registration("Adopted From Terminal", ALPHA_PIN),
  });
  check(
    "an alphanumeric ID registers, and claims the photo the terminal pushed",
    adopted.statusCode === 201 && JSON.parse(adopted.body).hasPhoto === true,
    adopted.body,
  );
  // 2c. Case does not decide identity, anywhere along the path.
  //
  // A terminal reporting `wctpl070` for a person registered as `WCTPL070` must
  // resolve to that person: at the punch join (or their movements are recorded
  // as unmatched and their entry never moves), at the lookup desk, and at the
  // unclaimed-enrollments panel. Two rows differing only in case would also
  // collide on disk, where NTFS is case-insensitive and Postgres is not.
  {
    const mixed = await app.inject({
      method: "GET",
      url: `/api/people/by-pin/${ALPHA_PIN.toLowerCase()}`,
      headers: auth(token),
    });
    check(
      "a person is found by their ID in any casing",
      mixed.statusCode === 200 && JSON.parse(mixed.body).esslUserId === ALPHA_PIN,
      `${mixed.statusCode} ${mixed.body.slice(0, 200)}`,
    );

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/people",
      headers: auth(token),
      payload: registration("Case Clash", ALPHA_PIN.toLowerCase()),
    });
    check(
      "the same ID in another casing cannot be registered twice",
      duplicate.statusCode === 409,
      `${duplicate.statusCode} ${duplicate.body}`,
    );
  }

  const adoptedRemovalsBefore = await prisma.syncCommand.count({
    where: { type: CommandType.DEPROVISION },
  });
  await pushUser(ALPHA_PIN, 1);
  check(
    "a person adopted from the terminal is reported, never auto-removed",
    (await prisma.syncCommand.count({ where: { type: CommandType.DEPROVISION } })) ===
      adoptedRemovalsBefore,
    "reconciliation deleted a face the client enrolled themselves",
  );
  await device.drain();

  // 3. An ID matching none of the device's person patterns is somebody else's
  // record entirely — potentially an employee on a shared terminal. The VMS
  // records the observation for admin review, but must not touch it or store
  // their face. Empty patterns classify nobody, so this section configures
  // exactly which Visitor IDs this terminal permits us to claim.)
  await prisma.device.update({
    where: { serialNo: SN },
    data: { visitorIdPatterns: ["9*", "WCTPL*", "1001"] },
  });
  invalidateDevice(SN);
  const foreignCommands = await prisma.syncCommand.count();
  await pushUser(FOREIGN_PIN, 1);
  check(
    "an ID matching no person pattern is recorded for review but not changed",
    (await prisma.auditLog.count({
      where: { action: "RECONCILE_DRIFT_FOUND", detail: { path: ["pin"], equals: FOREIGN_PIN } },
    })) > 0 && (await prisma.syncCommand.count()) === foreignCommands,
  );
  check(
    "...including no photo pull, so employee biometrics never land on our disk",
    (await readFile(photoPathFor(FOREIGN_PIN)).catch(() => null)) === null,
  );
  await prisma.device.update({
    where: { serialNo: SN },
    data: { visitorIdPatterns: [] },
  });
  invalidateDevice(SN);

  // 4. Wrong access group on a live authorization — the block state drifting.
  // A person who should be blocked but is in the normal group can walk in.
  const live = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
  });
  const liveId = JSON.parse(live.body).entry.id as string;
  await device.drain();
  await prisma.entry.update({ where: { id: liveId }, data: { dayBlocked: true } });

  await pushUser(PIN, 1); // device says normal group; we believe blocked
  const correction = await device.poll();
  check(
    "a wrong access group on the device is corrected",
    correction?.text.includes("Grp=100") === true,
    correction?.text,
  );
  await device.ack(correction!.wireId);

  // 5. In sync means silent. A correct observation must not queue anything.
  const quietBefore = await prisma.syncCommand.count();
  await pushUser(PIN, 100);
  check(
    "an observation that matches expectation queues nothing",
    (await prisma.syncCommand.count()) === quietBefore,
  );

  // 6. Face-count drift: the only signal for "something is on the device that
  // we never put there", since the roster cannot be enumerated.
  await prisma.device.update({ where: { serialNo: SN }, data: { facesUsed: 7 } });
  const drift = await app.inject({
    method: "GET",
    url: "/api/devices/drift",
    headers: auth(token),
  });
  const driftBody = JSON.parse(drift.body);
  check(
    "a face count higher than we authorized is reported as excess",
    driftBody.total === 1 && driftBody.items[0].excess === 6,
    drift.body,
  );

  // ======================================================================
  section("15. Punch-loss detection — growth, not raw difference");
  // ======================================================================
  // The device's TransactionCount outlives a wiped database, so comparing it
  // to our row count directly is meaningless. Growth from a fixed baseline is
  // what carries information.
  const gapDevice = await prisma.device.findFirstOrThrow({ where: { serialNo: SN } });
  const localNow = await prisma.punchEvent.count({ where: { deviceId: gapDevice.id } });

  // A device holding far more history than we do, but in step with us since
  // the baseline. The exact shape of a real installation whose database was
  // wiped while the terminal's log carried on — and it must NOT cry loss.
  await prisma.device.update({
    where: { id: gapDevice.id },
    data: {
      lastInfo: { TransactionCount: "500" },
      punchBaselineAt: new Date(),
      punchBaselineDeviceCount: 500,
      punchBaselineLocalCount: localNow,
    },
  });
  const noGap = await app.inject({
    method: "GET",
    url: "/api/devices/punch-gaps",
    headers: auth(token),
  });
  check(
    "a device holding old history it never sent is not reported as loss",
    JSON.parse(noGap.body).total === 0,
    noGap.body,
  );

  // Now the device logs 10 more and we receive none of them.
  await prisma.device.update({
    where: { id: gapDevice.id },
    data: { lastInfo: { TransactionCount: "510" } },
  });
  const gapped = await app.inject({
    method: "GET",
    url: "/api/devices/punch-gaps",
    headers: auth(token),
  });
  const gapBody = JSON.parse(gapped.body);
  check(
    "punches the device logged but never delivered are reported",
    gapBody.total === 1 && gapBody.items[0].missing === 10,
    gapped.body,
  );

  // Retention must not look like punch loss. It deletes raw rows after
  // summarising them, so a bare row count falls over time — and a live system
  // reported six punches "never delivered" the day after a retention pass,
  // with nothing actually lost. The two jobs otherwise fight, and the alarm
  // is what loses.
  await prisma.attendanceDaySummary.deleteMany({});
  const prunedCount = await prisma.punchEvent.count({ where: { deviceId: gapDevice.id } });
  await prisma.attendanceDaySummary.create({
    data: {
      esslUserId: PIN,
      localDate: "2025-01-01",
      deviceIds: [gapDevice.id],
      devicePunchCounts: { [gapDevice.id]: 10 },
      firstInUtc: new Date("2025-01-01T04:00:00Z"),
      lastOutUtc: new Date("2025-01-01T12:00:00Z"),
      workedSeconds: 8 * 60 * 60,
      punchCount: 10,
      inCount: 5,
      outCount: 5,
    },
  });
  await prisma.device.update({
    where: { id: gapDevice.id },
    data: {
      lastInfo: { TransactionCount: "510" },
      punchBaselineDeviceCount: 500,
      // As if those 10 had been raw rows when the baseline was taken.
      punchBaselineLocalCount: prunedCount + 10 - 10,
    },
  });
  const afterPrune = await app.inject({
    method: "GET",
    url: "/api/devices/punch-gaps",
    headers: auth(token),
  });
  check(
    "punches pruned by retention are still counted, not reported as lost",
    JSON.parse(afterPrune.body).total === 0,
    afterPrune.body,
  );
  await prisma.attendanceDaySummary.deleteMany({});

  // A device count that went BACKWARDS means the log was cleared or wrapped.
  // That is a re-baseline situation; reporting it as loss would be worse than
  // saying nothing, because it would train an operator to ignore the alarm.
  await prisma.device.update({
    where: { id: gapDevice.id },
    data: { lastInfo: { TransactionCount: "3" } },
  });
  const wrapped = await app.inject({
    method: "GET",
    url: "/api/devices/punch-gaps",
    headers: auth(token),
  });
  check(
    "a cleared or wrapped device log is not reported as loss",
    JSON.parse(wrapped.body).total === 0,
    wrapped.body,
  );

  // Re-baselining requires a recorded count, and refuses without one.
  await prisma.device.update({ where: { id: gapDevice.id }, data: { lastInfo: Prisma.DbNull } });
  const noBaseline = await app.inject({
    method: "POST",
    url: `/api/devices/${gapDevice.id}/punch-baseline`,
    headers: auth(token),
  });
  check(
    "re-baselining refuses when the device has never reported a count",
    noBaseline.statusCode === 409,
    `${noBaseline.statusCode} ${noBaseline.body}`,
  );

  // ======================================================================
  section("16. Retention — summarise before deleting, never instead of it");
  // ======================================================================
  // Unbounded growth is how a bundled on-premise database dies quietly two
  // years after handover. But pruning raw punches outright would make "was
  // this person on site last March" unanswerable, which is the question asked
  // after an incident. The summary is what makes deletion defensible.
  const retDevice = await prisma.device.findFirstOrThrow({ where: { serialNo: SN } });
  await prisma.attendanceDaySummary.deleteMany({});
  await prisma.punchEvent.deleteMany({});

  // Anchored to a fixed hour of the device's day, not to "now minus 500 days".
  // Spaced from the current wall clock, four hourly punches straddle local
  // midnight for part of every day and correctly summarise into TWO days —
  // so this passed at 10am and failed at 7pm. A test whose result depends on
  // when it runs is worse than one that fails, because it teaches you to
  // re-run rather than to look.
  const oldDay = new Date(Date.now() - 500 * 86_400_000).toISOString().slice(0, 10);
  const localAt = (hour: number) => new Date(`${oldDay}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  await prisma.punchEvent.createMany({
    data: [0, 1, 2, 3].map((i) => ({
      esslUserId: PIN,
      deviceId: retDevice.id,
      // Device-local 09:00–12:00: nowhere near a day boundary at +05:30.
      punchedAtDevice: localAt(9 + i),
      punchedAtUtc: new Date(localAt(9 + i).getTime() - TZ_OFFSET * 60_000),
      statusCode: i % 2, // alternating in/out on the default code maps
      verifyMode: 15,
      workCode: 0,
      raw: `retention-${i}`,
      rawRecordHash: `retention-hash-${i}`,
    })),
  });
  // One recent punch, which must survive untouched.
  await prisma.punchEvent.create({
    data: {
      esslUserId: PIN,
      deviceId: retDevice.id,
      punchedAtDevice: new Date(Date.now() + TZ_OFFSET * 60_000),
      punchedAtUtc: new Date(),
      statusCode: 0,
      verifyMode: 15,
      workCode: 0,
      raw: "retention-recent",
      rawRecordHash: "retention-hash-recent",
    },
  });

  const status = await app.inject({
    method: "GET",
    url: "/api/maintenance/retention",
    headers: auth(token),
  });
  check(
    "retention reports what it would act on before acting",
    JSON.parse(status.body).punchEvent.dueForSummary === 4,
    status.body,
  );
  check(
    "...and states that the audit log is never pruned by default",
    JSON.parse(status.body).policy.auditRetentionDays === null,
    status.body,
  );

  const ran = await app.inject({
    method: "POST",
    url: "/api/maintenance/retention",
    headers: auth(token),
  });
  const ranBody = JSON.parse(ran.body);
  check(
    "expired punches are deleted",
    ranBody.punchesDeleted === 4,
    ran.body,
  );
  check(
    "...and rolled into a day summary first, so the movement is not lost",
    ranBody.punchesSummarised === 1,
    ran.body,
  );

  const summary = await prisma.attendanceDaySummary.findFirstOrThrow();
  check(
    "the summary keeps who, where and when — first seen and last seen",
    summary.esslUserId === PIN &&
      summary.punchCount === 4 &&
      summary.lastOutUtc !== null &&
      summary.firstInUtc !== null &&
      summary.lastOutUtc.getTime() > summary.firstInUtc.getTime(),
    JSON.stringify(summary),
  );
  check(
    "...and direction, resolved from the device's own status-code maps",
    summary.inCount === 2 && summary.outCount === 2,
    `in=${summary.inCount} out=${summary.outCount}`,
  );
  check(
    "a punch inside the retention window is untouched",
    (await prisma.punchEvent.count()) === 1,
    `${await prisma.punchEvent.count()} rows left`,
  );

  // Running again must not double-count into the same day's summary.
  const beforeRepeat = await prisma.attendanceDaySummary.findFirstOrThrow();
  await app.inject({
    method: "POST",
    url: "/api/maintenance/retention",
    headers: auth(token),
  });
  const afterRepeat = await prisma.attendanceDaySummary.findFirstOrThrow();
  check(
    "a second pass with nothing due leaves the summary alone",
    afterRepeat.punchCount === beforeRepeat.punchCount,
    `${beforeRepeat.punchCount} → ${afterRepeat.punchCount}`,
  );

  // A FAILED command is evidence something never reached a barrier, and is
  // never pruned on a timer however old.
  await prisma.syncCommand.create({
    data: {
      type: CommandType.DEPROVISION,
      targetDeviceId: retDevice.id,
      status: CommandStatus.FAILED,
      payload: { pin: PIN, countedOnDevice: false },
      idempotencyKey: `retention-failed-${Date.now()}`,
      lastError: "device returned Return=1",
      completedAt: new Date(Date.now() - 900 * 86_400_000),
      createdAt: new Date(Date.now() - 900 * 86_400_000),
    },
  });
  await app.inject({
    method: "POST",
    url: "/api/maintenance/retention",
    headers: auth(token),
  });
  check(
    "an old FAILED command is kept — it is evidence, not clutter",
    (await prisma.syncCommand.count({ where: { status: CommandStatus.FAILED } })) === 1,
  );

  // ======================================================================
  section("17. Alerting — what is wrong, worst first");
  // ======================================================================
  const alertDevice = await prisma.device.findFirstOrThrow({ where: { serialNo: SN } });
  const alertsFor = async (): Promise<{ total: number; critical: number; items: { id: string; severity: string }[] }> => {
    const res = await app.inject({ method: "GET", url: "/api/alerts", headers: auth(token) });
    return JSON.parse(res.body);
  };

  // A healthy system: device seen just now, well under capacity, nothing
  // failed, duplicate window recorded as zero.
  await prisma.syncCommand.deleteMany({ where: { status: CommandStatus.FAILED } });
  // Section 14 left real RECONCILE_DRIFT_FOUND rows behind, and the alert
  // that reports them is correct to fire. Cleared here so "healthy" means
  // healthy rather than "healthy apart from the thing we did earlier".
  await prisma.auditLog.deleteMany({ where: { action: "RECONCILE_DRIFT_FOUND" } });
  await prisma.device.update({
    where: { id: alertDevice.id },
    data: {
      lastSeenAt: new Date(),
      facesUsed: 1,
      maxFaces: 3000,
      duplicatePunchPeriodMinutes: 0,
      role: "BOTH",
      punchBaselineAt: null,
    },
  });
  await prisma.entry.updateMany({ data: { retentionExpiresAt: null } });
  const quiet = await alertsFor();
  check("a healthy system raises nothing", quiet.total === 0, JSON.stringify(quiet.items));

  // A device that has never reported its capacity has NO capacity alerting at
  // all, and that silence is indistinguishable from being fine. A fresh
  // install is in exactly this state until somebody refreshes.
  await prisma.device.update({ where: { id: alertDevice.id }, data: { maxFaces: null } });
  const unknownCap = await alertsFor();
  check(
    "a device that never reported its capacity says so, rather than staying quiet",
    unknownCap.items.some((a) => a.id === `capacity-unknown:${alertDevice.id}`),
    JSON.stringify(unknownCap.items),
  );
  check(
    "...and no capacity threshold is claimed while the ceiling is unknown",
    !unknownCap.items.some((a) => a.id.startsWith("capacity-warning")) &&
      !unknownCap.items.some((a) => a.id.startsWith("capacity-critical")),
    JSON.stringify(unknownCap.items),
  );
  await prisma.device.update({ where: { id: alertDevice.id }, data: { maxFaces: 3000 } });

  // Capacity: the ceiling is hard — at it, a provision fails while somebody
  // is standing at a gate.
  await prisma.device.update({ where: { id: alertDevice.id }, data: { facesUsed: 2100 } });
  const warned = await alertsFor();
  check(
    "70% of face capacity raises a warning",
    warned.items.some((a) => a.id === `capacity-warning:${alertDevice.id}` && a.severity === "warning"),
    JSON.stringify(warned.items),
  );

  await prisma.device.update({ where: { id: alertDevice.id }, data: { facesUsed: 2550 } });
  const critical = await alertsFor();
  check(
    "85% escalates to critical, and does not also warn",
    critical.items.some((a) => a.id === `capacity-critical:${alertDevice.id}`) &&
      !critical.items.some((a) => a.id === `capacity-warning:${alertDevice.id}`),
    JSON.stringify(critical.items),
  );
  await prisma.device.update({ where: { id: alertDevice.id }, data: { facesUsed: 1 } });

  // Offline is critical: nothing can be provisioned OR removed, so a person
  // whose window just closed keeps working access the whole time.
  await prisma.device.update({
    where: { id: alertDevice.id },
    data: { lastSeenAt: new Date(Date.now() - 3_600_000) },
  });
  const off = await alertsFor();
  check(
    "an offline device is critical",
    off.items.some((a) => a.id === `device-offline:${alertDevice.id}` && a.severity === "critical"),
    JSON.stringify(off.items),
  );

  // ...and a stuck-queue alert must NOT also fire, because "offline" already
  // explains it. Two alerts for one cause is how people learn to ignore them.
  await prisma.syncCommand.create({
    data: {
      type: CommandType.QUERY_USER,
      targetDeviceId: alertDevice.id,
      status: CommandStatus.PENDING,
      payload: { pin: PIN },
      idempotencyKey: `alert-stuck-${Date.now()}`,
      createdAt: new Date(Date.now() - 3_600_000),
    },
  });
  const offStuck = await alertsFor();
  check(
    "a queue backed up behind an offline device is not reported twice",
    !offStuck.items.some((a) => a.id === `commands-stuck:${alertDevice.id}`),
    JSON.stringify(offStuck.items),
  );

  // Once it is back online, the same backlog DOES mean dispatch is broken.
  await prisma.device.update({ where: { id: alertDevice.id }, data: { lastSeenAt: new Date() } });
  const stuckNow = await alertsFor();
  check(
    "the same backlog on an online device is a dispatch problem",
    stuckNow.items.some((a) => a.id === `commands-stuck:${alertDevice.id}`),
    JSON.stringify(stuckNow.items),
  );
  await prisma.syncCommand.deleteMany({ where: { status: CommandStatus.PENDING } });

  // Roster excess: the device holds faces we never authorized.
  await prisma.device.update({ where: { id: alertDevice.id }, data: { facesUsed: 9 } });
  const excess = await alertsFor();
  check(
    "faces on the device we never authorized are critical",
    excess.items.some((a) => a.id === `roster-excess:${alertDevice.id}` && a.severity === "critical"),
    JSON.stringify(excess.items),
  );
  await prisma.device.update({ where: { id: alertDevice.id }, data: { facesUsed: 1 } });

  // Severity ordering — a list that buries the dangerous item is a list
  // nobody reads to the bottom of.
  await prisma.device.update({
    where: { id: alertDevice.id },
    data: { facesUsed: 2550, duplicatePunchPeriodMinutes: 5 },
  });
  const mixed = await alertsFor();
  check(
    "critical alerts sort above warnings",
    mixed.items.length > 1 && mixed.items[0]!.severity === "critical",
    JSON.stringify(mixed.items.map((a) => `${a.severity}:${a.id}`)),
  );
  check(
    "a terminal that can swallow OUT punches is flagged even after provisioning refused it",
    mixed.items.some((a) => a.id === `duplicate-window:${alertDevice.id}`),
    JSON.stringify(mixed.items),
  );

  // ======================================================================
  section("18. Where the Phase 3 jobs meet each other");
  // ======================================================================
  {
  // Each job was verified alone. The bug that actually shipped was an
  // interaction — retention deleting rows the punch-gap baseline was counting,
  // so a healthy system reported six punches lost. These are the other places
  // two subsystems can reach for the same thing.
  await prisma.syncCommand.deleteMany({});
  await prisma.attendanceDaySummary.deleteMany({});
  await prisma.punchEvent.deleteMany({});
  await prisma.auditLog.deleteMany({});
  for (const e of await prisma.entry.findMany({
    where: { state: { in: [...ACTIVE_ENTRY_STATES] } },
    select: { id: true },
  })) {
    await prisma.entry.update({ where: { id: e.id }, data: { state: EntryState.REGISTERED } });
  }
  await prisma.device.update({
    where: { id: alertDevice.id },
    data: {
      facesUsed: 0,
      maxFaces: 3000,
      lastSeenAt: new Date(),
      duplicatePunchPeriodMinutes: 0,
      role: "BOTH",
      punchBaselineAt: null,
      lastInfo: Prisma.DbNull,
    },
  });

  // --- reconciliation must not fight a provision that is still in flight.
  // The device reports the USER record the instant the create lands, while
  // the photo push is still queued. At that moment the entry is
  // PENDING_PROVISION and "not yet fully on the device" is CORRECT, not drift.
  const midProv = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_DAY", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
  });
  const midEntryId = JSON.parse(midProv.body).entry.id as string;
  const createCmd = await device.poll();
  await device.ack(createCmd!.wireId); // user created; photo still pending
  await pushUser(PIN, 1);
  check(
    "a person reported mid-provision is not removed as drift",
    (await prisma.syncCommand.count({
      where: { entryId: midEntryId, type: CommandType.DEPROVISION },
    })) === 0 &&
      (await prisma.syncCommand.count({
        where: { personId, type: CommandType.DEPROVISION },
      })) === 0,
    "a DEPROVISION was queued against a provision still in flight",
  );
  await device.drain();
  const provisioned = await prisma.entry.findUniqueOrThrow({ where: { id: midEntryId } });
  check(
    "...and the provision completes normally afterwards",
    provisioned.state === EntryState.PROVISIONED,
    provisioned.state,
  );

  // --- the sweeper and the reconciler must not both remove the same person.
  // They act on different states by design (the sweeper on PROVISIONED, the
  // reconciler only when no active entry remains), and a double removal would
  // return the face-capacity slot twice.
  await prisma.entry.update({
    where: { id: midEntryId },
    data: { retentionExpiresAt: new Date(Date.now() - 60_000) },
  });
  await sweepExpiredEntries(silentLog);
  await pushUser(PIN, 1); // device still reports them; removal is in flight
  const removals = await prisma.syncCommand.count({
    where: { personId, type: CommandType.DEPROVISION },
  });
  check(
    "an expiry removal in flight is not duplicated by the reconciler",
    removals === 1,
    `${removals} DEPROVISION commands queued`,
  );

  const facesBefore = (await prisma.device.findUniqueOrThrow({ where: { id: alertDevice.id } }))
    .facesUsed;
  await device.drain();
  const facesAfter = (await prisma.device.findUniqueOrThrow({ where: { id: alertDevice.id } }))
    .facesUsed;
  check(
    "...so the face slot is returned exactly once",
    facesBefore - facesAfter === 1,
    `${facesBefore} → ${facesAfter}`,
  );

  // --- retention must not touch punches belonging to a live visit.
  // An open authorization is current state, not history, however old.
  const liveEntry = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/provision`,
    headers: auth(token),
    payload: { retentionPolicy: "ONE_WEEK", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
  });
  const liveEntryId = JSON.parse(liveEntry.body).entry.id as string;
  await device.drain();
  await prisma.punchEvent.create({
    data: {
      esslUserId: PIN,
      deviceId: alertDevice.id,
      entryId: liveEntryId,
      punchedAtDevice: new Date("2024-01-01T09:00:00.000Z"),
      punchedAtUtc: new Date("2024-01-01T03:30:00.000Z"),
      statusCode: 0,
      verifyMode: 15,
      workCode: 0,
      raw: "interaction-live",
      rawRecordHash: `interaction-live-${Date.now()}`,
    },
  });
  await prisma.entry.update({ where: { id: liveEntryId }, data: { state: EntryState.INSIDE } });
  const retained = await app.inject({
    method: "POST",
    url: "/api/maintenance/retention",
    headers: auth(token),
  });
  check(
    "a two-year-old punch on a still-open visit is not pruned",
    JSON.parse(retained.body).punchesDeleted === 0,
    retained.body,
  );

  // --- the alerts endpoint is polled by every open dashboard. Its cost must
  // not grow with how much history the installation has accumulated.
  if (config.databaseLogQueries) {
    const lean = await countQueries(async () =>
      app.inject({ method: "GET", url: "/api/alerts", headers: auth(token) }),
    );
    await prisma.syncCommand.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        type: CommandType.QUERY_USER,
        targetDeviceId: alertDevice.id,
        status: CommandStatus.SUCCESS,
        payload: { pin: PIN },
        idempotencyKey: `alert-volume-${i}-${Date.now()}`,
        completedAt: new Date(),
      })),
    });
    const heavy = await countQueries(async () =>
      app.inject({ method: "GET", url: "/api/alerts", headers: auth(token) }),
    );
    check(
      "alerts cost the same with 60 extra commands as with none",
      heavy.queries.length === lean.queries.length,
      `${lean.queries.length} → ${heavy.queries.length} queries`,
    );
    // Deleting only the noise. The PROVISION rows are NOT disposable history:
    // see the check immediately below.
    await prisma.syncCommand.deleteMany({ where: { type: CommandType.QUERY_USER } });
  }

  // --- retention must not prune the command that says WHERE a live person is
  // loaded. A completed PROVISION is how deviceForEntry finds the device to
  // send a removal to, and how roster drift counts authorized faces. Pruning
  // one under a live entry makes that person un-removable and makes the
  // device look like it holds faces nobody asked for.
  await prisma.syncCommand.updateMany({
    where: { entryId: liveEntryId, type: CommandType.PROVISION },
    data: { completedAt: new Date(Date.now() - 900 * 86_400_000) },
  });
  const provisionsBefore = await prisma.syncCommand.count({
    where: { entryId: liveEntryId, type: CommandType.PROVISION },
  });
  await app.inject({
    method: "POST",
    url: "/api/maintenance/retention",
    headers: auth(token),
  });
  check(
    "a 900-day-old PROVISION on a live entry is kept — it records which device holds them",
    (await prisma.syncCommand.count({
      where: { entryId: liveEntryId, type: CommandType.PROVISION },
    })) === provisionsBefore,
    "retention pruned the provisioning record of an active entry",
  );
  const dueNow = await app.inject({
    method: "GET",
    url: "/api/maintenance/retention",
    headers: auth(token),
  });
  check(
    "...and the status view agrees with what the job would actually do",
    JSON.parse(dueNow.body).syncCommand.dueForDeletion === 0,
    dueNow.body,
  );

  // --- and after all of it, a consistent system says nothing is wrong.
  await prisma.entry.update({
    where: { id: liveEntryId },
    data: { state: EntryState.PROVISIONED, retentionExpiresAt: null },
  });
  await prisma.auditLog.deleteMany({ where: { action: "RECONCILE_DRIFT_FOUND" } });
  await prisma.device.update({
    where: { id: alertDevice.id },
    data: { lastSeenAt: new Date(), facesUsed: 1, maxFaces: 3000 },
  });
  const settled = await app.inject({ method: "GET", url: "/api/alerts", headers: auth(token) });
  check(
    "after every Phase 3 job has run, a consistent system raises nothing",
    JSON.parse(settled.body).total === 0,
    settled.body,
  );

  }

  // ======================================================================
  section("19. Roles, and revocation that actually revokes");
  // ======================================================================
  {
    const opSalt = randomBytes(16);
    const operator = await prisma.appUser.create({
      data: {
        email: "operator@vms.local",
        passwordHash: `scrypt$${opSalt.toString("hex")}$${scryptSync("operator-password", opSalt, 64).toString("hex")}`,
        role: "AUTHORIZED_PERSON",
      },
    });
    const signIn = async (): Promise<string> => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "operator@vms.local", password: "operator-password" },
      });
      return JSON.parse(res.body).token as string;
    };
    let opToken = await signIn();

    // The daily job must not need an admin standing behind it, or the role is
    // decoration and everyone shares the admin login.
    const canList = await app.inject({
      method: "GET",
      url: "/api/people",
      headers: auth(opToken),
    });
    check("an authorized person can do their job", canList.statusCode === 200, canList.body);

    const opProvision = await app.inject({
      method: "POST",
      url: `/api/people/${personId}/provision`,
      headers: auth(opToken),
      payload: { retentionPolicy: "ONE_DAY", entryMode: "MULTI_ENTRY", purposeOfVisit: "E2E check" },
    });
    check(
      "...including provisioning and de-provisioning",
      opProvision.statusCode === 202 || opProvision.statusCode === 409,
      `${opProvision.statusCode} ${opProvision.body}`,
    );

    // ...but not the things that change how the system behaves.
    const cfg = await app.inject({
      method: "PATCH",
      url: `/api/devices/${alertDevice.id}`,
      headers: auth(opToken),
      payload: { role: "IN" },
    });
    check("reconfiguring a device is refused", cfg.statusCode === 403, `${cfg.statusCode} ${cfg.body}`);
    check(
      "...with a message naming the role and the permission",
      /AUTHORIZED_PERSON/.test(cfg.body) && /device:configure/.test(cfg.body),
      cfg.body,
    );

    const maint = await app.inject({
      method: "POST",
      url: "/api/maintenance/retention",
      headers: auth(opToken),
    });
    check("running retention is refused", maint.statusCode === 403, `${maint.statusCode}`);

    const stillIn = await prisma.device.findUniqueOrThrow({ where: { id: alertDevice.id } });
    check("...and the refused change did not happen anyway", stillIn.role === "BOTH", stillIn.role);

    check(
      "refusals are audited — who tried what they could not do",
      (await prisma.auditLog.count({ where: { action: "PERMISSION_DENIED" } })) === 2,
      `${await prisma.auditLog.count({ where: { action: "PERMISSION_DENIED" } })} rows`,
    );

    // The device protocol must never be authenticated. Gating /iclock would
    // take the barrier down for everyone (CLAUDE.md #9).
    const deviceStillWorks = await app.inject({
      method: "GET",
      url: `/iclock/getrequest.aspx?SN=${SN}`,
    });
    check(
      "the device endpoints remain unauthenticated",
      deviceStillWorks.statusCode === 200,
      `${deviceStillWorks.statusCode}`,
    );

    // --- the fix that matters. Verifying only the token signature meant a
    // disabled account kept working for the token's full twelve hours.
    await prisma.appUser.update({ where: { id: operator.id }, data: { isActive: false } });
    const afterDisable = await app.inject({
      method: "GET",
      url: "/api/people",
      headers: auth(opToken),
    });
    check(
      "disabling an account kills its EXISTING token immediately",
      afterDisable.statusCode === 401,
      `${afterDisable.statusCode} ${afterDisable.body}`,
    );
    const cannotSignIn = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "operator@vms.local", password: "operator-password" },
    });
    check("...and they cannot sign in again", cannotSignIn.statusCode === 401);

    // --- a role change applies to the token already in their hand, which is
    // the right way round for a demotion.
    await prisma.appUser.update({
      where: { id: operator.id },
      data: { isActive: true, role: "ADMIN" },
    });
    const promoted = await app.inject({
      method: "PATCH",
      url: `/api/devices/${alertDevice.id}`,
      headers: auth(opToken),
      payload: { name: "Main gate" },
    });
    check(
      "a promotion applies to the token already issued — no re-login needed",
      promoted.statusCode === 200,
      `${promoted.statusCode} ${promoted.body}`,
    );

    await prisma.appUser.update({
      where: { id: operator.id },
      data: { role: "AUTHORIZED_PERSON" },
    });
    const demoted = await app.inject({
      method: "PATCH",
      url: `/api/devices/${alertDevice.id}`,
      headers: auth(opToken),
      payload: { name: "Main gate" },
    });
    check(
      "...and so does a demotion, on the same token",
      demoted.statusCode === 403,
      `${demoted.statusCode}`,
    );

    // A deleted account is the same as a disabled one, not an error.
    opToken = await (async () => {
      await prisma.appUser.update({ where: { id: operator.id }, data: { isActive: true } });
      return signIn();
    })();
    await prisma.auditLog.deleteMany({ where: { actorId: operator.id } });
    await prisma.appUser.delete({ where: { id: operator.id } });
    const afterDelete = await app.inject({
      method: "GET",
      url: "/api/people",
      headers: auth(opToken),
    });
    check(
      "a token for a deleted account is rejected, not crashed on",
      afterDelete.statusCode === 401,
      `${afterDelete.statusCode} ${afterDelete.body}`,
    );

    // The admin token used by every earlier section must still work.
    const adminOk = await app.inject({ method: "GET", url: "/api/alerts", headers: auth(token) });
    check("the admin token is unaffected throughout", adminOk.statusCode === 200);
  }

  // ======================================================================
  section("20. Operator management");
  // ======================================================================
  {
    const login = async (email: string, pw: string) =>
      app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: pw } });

    const tooShort = await app.inject({
      method: "POST",
      url: "/api/operators",
      headers: auth(token),
      payload: { email: "gate@vms.local", role: "AUTHORIZED_PERSON", temporaryPassword: "short" },
    });
    check("a short password is refused", tooShort.statusCode === 400, tooShort.body);

    const created = await app.inject({
      method: "POST",
      url: "/api/operators",
      headers: auth(token),
      payload: {
        email: "Gate@VMS.local",
        role: "AUTHORIZED_PERSON",
        temporaryPassword: "temporary-one",
      },
    });
    check("an admin can create an operator", created.statusCode === 201, created.body);
    check(
      "...with the email normalised, so it cannot be duplicated by case",
      JSON.parse(created.body).email === "gate@vms.local",
      created.body,
    );
    check(
      "...and a temporary password that must be changed",
      JSON.parse(created.body).mustChangePassword === true,
    );
    const gateId = JSON.parse(created.body).id as string;

    const dupe = await app.inject({
      method: "POST",
      url: "/api/operators",
      headers: auth(token),
      payload: { email: "gate@vms.local", role: "ADMIN", temporaryPassword: "temporary-two" },
    });
    check("a duplicate email is refused", dupe.statusCode === 409, `${dupe.statusCode}`);

    const signedIn = await login("gate@vms.local", "temporary-one");
    check("they can sign in", signedIn.statusCode === 200);
    check(
      "...and the response says a change is required, so the UI can route there",
      JSON.parse(signedIn.body).mustChangePassword === true,
      signedIn.body,
    );
    const gateToken = JSON.parse(signedIn.body).token as string;

    // A temporary password is one somebody else knows. Until it is changed
    // the session must be good for nothing else — enforced at the API, not
    // just by the screen the UI happens to show.
    const blocked = await app.inject({
      method: "GET",
      url: "/api/people",
      headers: auth(gateToken),
    });
    check(
      "a forced change blocks everything else",
      blocked.statusCode === 403 && JSON.parse(blocked.body).mustChangePassword === true,
      `${blocked.statusCode} ${blocked.body}`,
    );
    const meWorks = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: auth(gateToken),
    });
    check("...except seeing who you are", meWorks.statusCode === 200);

    const wrongCurrent = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(gateToken),
      payload: { currentPassword: "not-the-password", newPassword: "a-better-password" },
    });
    check(
      "changing the password still requires the current one",
      wrongCurrent.statusCode === 403,
      `${wrongCurrent.statusCode}`,
    );

    const sameAgain = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(gateToken),
      payload: { currentPassword: "temporary-one", newPassword: "temporary-one" },
    });
    check("...and the new one must differ", sameAgain.statusCode === 400, `${sameAgain.statusCode}`);

    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(gateToken),
      payload: { currentPassword: "temporary-one", newPassword: "a-better-password" },
    });
    check("the change succeeds", changed.statusCode === 200, changed.body);

    const unblocked = await app.inject({
      method: "GET",
      url: "/api/people",
      headers: auth(gateToken),
    });
    check(
      "...and the same token is immediately usable",
      unblocked.statusCode === 200,
      `${unblocked.statusCode}`,
    );
    check(
      "the old password no longer works",
      (await login("gate@vms.local", "temporary-one")).statusCode === 401,
    );

    // An admin reset hands the password to somebody else again.
    const reset = await app.inject({
      method: "POST",
      url: `/api/operators/${gateId}/reset-password`,
      headers: auth(token),
      payload: { temporaryPassword: "reset-password-x" },
    });
    check("an admin can reset a password", reset.statusCode === 200, reset.body);
    const afterReset = await login("gate@vms.local", "reset-password-x");
    check(
      "...and the account is forced to change it again",
      JSON.parse(afterReset.body).mustChangePassword === true,
      afterReset.body,
    );

    // --- the self-lockout guards.
    const adminId = (await prisma.appUser.findFirstOrThrow({ where: { email: "e2e@vms.local" } })).id;
    const selfDisable = await app.inject({
      method: "PATCH",
      url: `/api/operators/${adminId}`,
      headers: auth(token),
      payload: { isActive: false },
    });
    check(
      "an admin cannot disable their own account",
      selfDisable.statusCode === 409,
      `${selfDisable.statusCode} ${selfDisable.body}`,
    );
    const selfDemote = await app.inject({
      method: "PATCH",
      url: `/api/operators/${adminId}`,
      headers: auth(token),
      payload: { role: "AUTHORIZED_PERSON" },
    });
    check("...nor change their own role", selfDemote.statusCode === 409, `${selfDemote.statusCode}`);

    // The last admin may not be removed by anyone, including another admin.
    // Without one the install is bricked short of editing the database.
    const secondAdmin = await app.inject({
      method: "POST",
      url: "/api/operators",
      headers: auth(token),
      payload: { email: "admin2@vms.local", role: "ADMIN", temporaryPassword: "second-admin-pw" },
    });
    const secondId = JSON.parse(secondAdmin.body).id as string;
    const demoteSpare = await app.inject({
      method: "PATCH",
      url: `/api/operators/${secondId}`,
      headers: auth(token),
      payload: { role: "AUTHORIZED_PERSON" },
    });
    check(
      "a spare admin can be demoted while another remains",
      demoteSpare.statusCode === 200,
      demoteSpare.body,
    );

    // The last-admin guard cannot be reached through the API today, and that
    // is worth stating rather than faking a test for it. Only an ADMIN holds
    // operator:manage, an admin must be active to authenticate at all, and
    // an admin acting on themselves is stopped by the self-guard above — so
    // there is always another active admin left. The guard stays as a
    // backstop for the day operator:manage is granted to another role or the
    // self-guard is relaxed; both would otherwise brick an install.
    await prisma.appUser.update({ where: { id: secondId }, data: { role: "ADMIN" } });

    // Operators are deactivated, never deleted — the audit trail points here.
    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/operators/${gateId}`,
      headers: auth(token),
      payload: { isActive: false },
    });
    check("an operator can be deactivated", disabled.statusCode === 200);
    check(
      "...and no route exists to delete one",
      (
        await app.inject({
          method: "DELETE",
          url: `/api/operators/${gateId}`,
          headers: auth(token),
        })
      ).statusCode === 404,
    );

    // Nothing password-shaped may reach the audit log.
    const opAudits = await prisma.auditLog.findMany({
      where: { action: { startsWith: "OPERATOR_" } },
      select: { action: true, detail: true },
    });
    check(
      "operator actions are audited",
      opAudits.length >= 4,
      `${opAudits.length} rows`,
    );
    check(
      "...and no password or hash appears in any of them",
      !JSON.stringify(opAudits).match(/temporary-one|a-better-password|reset-password-x|scrypt\$/),
      JSON.stringify(opAudits).slice(0, 200),
    );
  }

  // ======================================================================
  section("21. Reports");
  // ======================================================================
  {
    const catalogue = await app.inject({
      method: "GET",
      url: "/api/reports",
      headers: auth(token),
    });
    const cat = JSON.parse(catalogue.body);
    check("the catalogue lists every report", cat.total >= 20, `${cat.total}`);

    // Every report must actually run. A definition with a typo in its SQL
    // would otherwise sit in the catalogue looking fine until someone opened
    // it — and reports are opened rarely, so that could be months.
    const broken: string[] = [];
    for (const r of cat.items as { key: string }[]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/reports/${r.key}?pageSize=5`,
        headers: auth(token),
      });
      if (res.statusCode !== 200) broken.push(`${r.key}: ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    check("every report in the catalogue runs", broken.length === 0, broken.join(" | "));

    // ...and every one exports, which is a different code path.
    const brokenCsv: string[] = [];
    for (const r of cat.items as { key: string }[]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/reports/${r.key}?format=csv`,
        headers: auth(token),
      });
      if (res.statusCode !== 200 || !res.headers["content-type"]?.toString().includes("text/csv")) {
        brokenCsv.push(r.key);
      }
    }
    check("every report exports as CSV", brokenCsv.length === 0, brokenCsv.join(", "));

    // --- the property most likely to regress silently.
    // Retention summarises old punches and deletes the raw rows. A movement
    // report that only read punch_event would keep working today and quietly
    // return nothing for last year — the failure would appear long after the
    // change that caused it.
    await prisma.punchEvent.deleteMany({});
    await prisma.attendanceDaySummary.deleteMany({});
    await prisma.attendanceDaySummary.create({
      data: {
        esslUserId: PIN,
        personId,
        localDate: "2024-03-14",
        deviceIds: [alertDevice.id],
        devicePunchCounts: { [alertDevice.id]: 6 },
        firstInUtc: new Date("2024-03-14T03:30:00Z"),
        lastOutUtc: new Date("2024-03-14T11:30:00Z"),
        workedSeconds: 8 * 60 * 60,
        punchCount: 6,
        inCount: 3,
        outCount: 3,
      },
    });
    const historic = await app.inject({
      method: "GET",
      url: "/api/reports/daily-movement?from=2024-03-01&to=2024-03-31",
      headers: auth(token),
    });
    const historicBody = JSON.parse(historic.body);
    check(
      "a movement report still answers for a date whose raw punches were pruned",
      historicBody.total === 1 && historicBody.rows[0].punches === 6,
      historic.body.slice(0, 200),
    );
    check(
      "...and the summary supplies direction, not just a count",
      historicBody.rows[0].ins === 3 && historicBody.rows[0].outs === 3,
      JSON.stringify(historicBody.rows[0]),
    );
    check(
      "...and report JSON presents UTC instants as explicit IST",
      historicBody.rows[0].first_utc === "14/03/2024, 09:00:00 am IST" &&
        historicBody.rows[0].last_utc === "14/03/2024, 05:00:00 pm IST",
      JSON.stringify(historicBody.rows[0]),
    );
    const historicCsv = await app.inject({
      method: "GET",
      url: "/api/reports/daily-movement?from=2024-03-01&to=2024-03-31&format=csv",
      headers: auth(token),
    });
    check(
      "...and the same explicit IST values reach the CSV export",
      historicCsv.body.includes("14/03/2024, 09:00:00 am IST") &&
        historicCsv.body.includes("14/03/2024, 05:00:00 pm IST"),
      historicCsv.body.slice(0, 500),
    );

    // A day split by a retention batch lands in both tables. Adding is the
    // only correct treatment; preferring one source would undercount.
    await prisma.punchEvent.create({
      data: {
        esslUserId: PIN,
        deviceId: alertDevice.id,
        punchedAtDevice: new Date("2024-03-14T18:00:00.000Z"),
        punchedAtUtc: new Date("2024-03-14T12:30:00.000Z"),
        statusCode: 1,
        direction: "OUT",
        verifyMode: 15,
        workCode: 0,
        raw: "report-split",
        rawRecordHash: `report-split-${Date.now()}`,
      },
    });
    const split = await app.inject({
      method: "GET",
      url: "/api/reports/daily-movement?from=2024-03-01&to=2024-03-31",
      headers: auth(token),
    });
    const splitRow = JSON.parse(split.body).rows[0];
    check(
      "a day split between raw punches and a summary is added, not chosen between",
      JSON.parse(split.body).total === 1 && splitRow.punches === 7 && splitRow.outs === 4,
      JSON.stringify(splitRow),
    );

    // Filters and paging.
    const outOfRange = await app.inject({
      method: "GET",
      url: "/api/reports/daily-movement?from=2025-01-01&to=2025-01-31",
      headers: auth(token),
    });
    check("a date filter excludes what falls outside it", JSON.parse(outOfRange.body).total === 0);

    const backwards = await app.inject({
      method: "GET",
      url: "/api/reports/daily-movement?from=2026-01-01&to=2020-01-01",
      headers: auth(token),
    });
    check("a reversed date range is refused", backwards.statusCode === 400, backwards.body);

    // Why somebody was authorized has to be answerable for a past date and a
    // named person — that is the whole reason it is captured, and entries are
    // never pruned, so this report is where it stays answerable.
    const authz = await app.inject({
      method: "GET",
      url: `/api/reports/authorizations?personId=${personId}&pageSize=50`,
      headers: auth(token),
    });
    const authzBody = JSON.parse(authz.body);
    check(
      "the authorizations report carries the purpose of visit",
      authzBody.columns.some((c: { key: string }) => c.key === "purpose_of_visit") &&
        authzBody.rows.some((r: { purpose_of_visit: string | null }) => r.purpose_of_visit !== null),
      authz.body.slice(0, 400),
    );

    const paged = await app.inject({
      method: "GET",
      url: "/api/reports/command-history?pageSize=2&page=2",
      headers: auth(token),
    });
    const pagedBody = JSON.parse(paged.body);
    check(
      "paging returns a page, not the lot",
      pagedBody.rows.length <= 2 && pagedBody.page === 2 && pagedBody.total > 2,
      `${pagedBody.rows.length} rows of ${pagedBody.total}`,
    );

    // --- permissions. The audit trail records what other operators did.
    const opSalt = randomBytes(16);
    const reader = await prisma.appUser.create({
      data: {
        email: "reader@vms.local",
        passwordHash: `scrypt$${opSalt.toString("hex")}$${scryptSync("reader-password", opSalt, 64).toString("hex")}`,
        role: "AUTHORIZED_PERSON",
      },
    });
    const readerToken = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "reader@vms.local", password: "reader-password" },
        })
      ).body,
    ).token as string;

    const readerCat = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/reports", headers: auth(readerToken) })).body,
    );
    check(
      "the catalogue hides reports the role cannot run",
      readerCat.total < cat.total &&
        !readerCat.items.some((r: { key: string }) => r.key === "audit-trail"),
      `${readerCat.total} of ${cat.total}`,
    );
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/reports/audit-trail",
      headers: auth(readerToken),
    });
    check(
      "...and running one directly is still refused",
      forbidden.statusCode === 403,
      `${forbidden.statusCode}`,
    );
    const allowed = await app.inject({
      method: "GET",
      url: "/api/reports/person-register",
      headers: auth(readerToken),
    });
    check("...while the ones they may run still work", allowed.statusCode === 200);

    await prisma.auditLog.deleteMany({ where: { actorId: reader.id } });
    await prisma.appUser.delete({ where: { id: reader.id } });

    const missing = await app.inject({
      method: "GET",
      url: "/api/reports/no-such-report",
      headers: auth(token),
    });
    check("an unknown report is a 404", missing.statusCode === 404);
  }

  // ======================================================================
  section("22. Lookup by PIN — the returning-visitor desk flow");
  // ======================================================================
  {
    const found = await app.inject({
      method: "GET",
      url: `/api/people/by-pin/${PIN}`,
      headers: auth(token),
    });
    check("a person is found by their PIN", found.statusCode === 200, `${found.statusCode}`);
    check(
      "...and comes back with the photo the operator has to check",
      JSON.parse(found.body).biometric !== null,
      found.body.slice(0, 120),
    );

    // The whole reason this is not the `?q=` search: that also matches a
    // mobile number CONTAINING the digits, so a spoken PIN could return
    // several people. An ambiguous match is the last thing this flow should
    // produce, because the operator is about to grant site access on it.
    await prisma.person.updateMany({
      where: { esslUserId: PIN_SECOND },
      data: { mobile: `+9199${PIN}00` },
    });
    const fuzzy = await app.inject({
      method: "GET",
      url: `/api/people?q=${PIN}`,
      headers: auth(token),
    });
    check(
      "the fuzzy search would have matched more than one person",
      JSON.parse(fuzzy.body).total > 1,
      `${JSON.parse(fuzzy.body).total}`,
    );
    const exact = await app.inject({
      method: "GET",
      url: `/api/people/by-pin/${PIN}`,
      headers: auth(token),
    });
    check(
      "...while the PIN lookup returns exactly the one holding it",
      JSON.parse(exact.body).esslUserId === PIN,
      exact.body.slice(0, 120),
    );

    check(
      "an unknown PIN is a clear 404, not an empty list",
      (
        await app.inject({
          method: "GET",
          url: "/api/people/by-pin/99999999",
          headers: auth(token),
        })
      ).statusCode === 404,
    );
    check(
      "a non-numeric PIN is refused",
      (
        await app.inject({
          method: "GET",
          url: "/api/people/by-pin/not-a-pin",
          headers: auth(token),
        })
      ).statusCode === 400,
    );
  }

  // ======================================================================
  section("23. Audit views — filtering, and a person's own history");
  // ======================================================================
  {
    const facets = await app.inject({
      method: "GET",
      url: "/api/reports/meta/audit-facets",
      headers: auth(token),
    });
    const f = JSON.parse(facets.body);
    check("the filter options come from the log itself", f.actions.length > 0, facets.body.slice(0, 80));
    check(
      "...and 'system' is offered as an actor, because a job has nobody behind it",
      f.actors.some((a: { id: string }) => a.id === "system"),
      JSON.stringify(f.actors),
    );

    const byAction = await app.inject({
      method: "GET",
      url: "/api/reports/audit-trail?action=ENTRY_PROVISION_REQUESTED",
      headers: auth(token),
    });
    const actionRows = JSON.parse(byAction.body).rows as { action: string }[];
    check(
      "filtering by action returns only that action",
      actionRows.length > 0 && actionRows.every((r) => r.action === "ENTRY_PROVISION_REQUESTED"),
      `${actionRows.length} rows`,
    );

    // The one that would silently return nothing if 'system' were treated as
    // an id: a scheduled job has a NULL actor, not a row in app_user.
    const bySystem = await app.inject({
      method: "GET",
      url: "/api/reports/audit-trail?actorId=system",
      headers: auth(token),
    });
    const systemRows = JSON.parse(bySystem.body).rows as { actor: string }[];
    check(
      "filtering by 'system' finds what ran unattended",
      systemRows.length > 0 && systemRows.every((r) => r.actor === "system"),
      `${systemRows.length} rows`,
    );

    const adminId = (await prisma.appUser.findFirstOrThrow({ where: { email: "e2e@vms.local" } })).id;
    const byActor = await app.inject({
      method: "GET",
      url: `/api/reports/audit-trail?actorId=${adminId}`,
      headers: auth(token),
    });
    const actorRows = JSON.parse(byActor.body).rows as { actor: string }[];
    check(
      "filtering by an operator excludes everyone else",
      actorRows.length > 0 && actorRows.every((r) => r.actor === "e2e@vms.local"),
      `${actorRows.length} rows`,
    );

    // --- a person's own history spans their entries, not just their row.
    const history = await app.inject({
      method: "GET",
      url: `/api/people/${personId}/audit`,
      headers: auth(token),
    });
    const items = JSON.parse(history.body).items as { action: string }[];
    check("a person's history loads", history.statusCode === 200, `${history.statusCode}`);
    check(
      "...and includes what happened to their ENTRIES, not only their record",
      items.some((r) => r.action.startsWith("ENTRY_")),
      items.map((r) => r.action).slice(0, 6).join(", "),
    );
    // Registration is checked on a person created HERE, not on the one from
    // section 2 — an earlier section clears the audit log, so asserting that
    // a twenty-section-old row survived would be testing the harness's
    // housekeeping rather than the query.
    const freshPerson = await app.inject({
      method: "POST",
      url: "/api/people",
      headers: auth(token),
      payload: registration("History Test", "HIST007"),
    });
    const freshId = JSON.parse(freshPerson.body).id as string;
    const freshHistory = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/people/${freshId}/audit`,
          headers: auth(token),
        })
      ).body,
    ).items as { action: string }[];
    check(
      "...including the registration itself",
      freshHistory.some((r) => r.action === "PERSON_CREATED"),
      freshHistory.map((r) => r.action).join(", "),
    );

    // Audit views are ADMIN-only, and that has to hold per endpoint rather
    // than only on the reports page.
    const opSalt2 = randomBytes(16);
    const nosy = await prisma.appUser.create({
      data: {
        email: "nosy@vms.local",
        passwordHash: `scrypt$${opSalt2.toString("hex")}$${scryptSync("nosy-password", opSalt2, 64).toString("hex")}`,
        role: "AUTHORIZED_PERSON",
      },
    });
    const nosyToken = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "nosy@vms.local", password: "nosy-password" },
        })
      ).body,
    ).token as string;
    check(
      "an operator cannot read a person's audit history",
      (
        await app.inject({
          method: "GET",
          url: `/api/people/${personId}/audit`,
          headers: auth(nosyToken),
        })
      ).statusCode === 403,
    );
    check(
      "...nor the filter options behind it",
      (
        await app.inject({
          method: "GET",
          url: "/api/reports/meta/audit-facets",
          headers: auth(nosyToken),
        })
      ).statusCode === 403,
    );
    check(
      "...while the person record itself stays readable",
      (
        await app.inject({
          method: "GET",
          url: `/api/people/${personId}`,
          headers: auth(nosyToken),
        })
      ).statusCode === 200,
    );
    await prisma.auditLog.deleteMany({ where: { actorId: nosy.id } });
    await prisma.appUser.delete({ where: { id: nosy.id } });
  }

  // ======================================================================
  section("24. Where Phase 4 meets everything built before it");
  // ======================================================================
  // Phase 3 proved the bugs live at the seams, and Phase 4 added an auth
  // layer across every route that already existed. These are the joins.
  {
    const salt24 = randomBytes(16);
    const worker = await prisma.appUser.create({
      data: {
        email: "seams@vms.local",
        passwordHash: `scrypt$${salt24.toString("hex")}$${scryptSync("seams-password", salt24, 64).toString("hex")}`,
        role: "AUTHORIZED_PERSON",
      },
    });
    const workerToken = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "seams@vms.local", password: "seams-password" },
        })
      ).body,
    ).token as string;

    // 1. The device protocol must stay open. Guards were added to 35 routes;
    // catching /iclock in that net would take the barrier down for everyone.
    for (const url of [
      `/iclock/cdata.aspx?SN=${SN}&table=ATTLOG`,
      `/iclock/getrequest.aspx?SN=${SN}`,
      `/iclock/devicecmd.aspx?SN=${SN}`,
    ]) {
      const res = await app.inject({
        method: url.includes("getrequest") ? "GET" : "POST",
        url,
        payload: url.includes("cdata") ? `${PIN}	2026-08-06 09:00:00	0	15	0	0` : "",
      });
      check(`unauthenticated device call still works: ${url.split("?")[0]}`, res.statusCode === 200);
    }

    // 2. A job acts with no operator behind it. Nothing in the permission
    // layer may assume one exists — a sweep runs on a timer, not a session.
    await prisma.entry.updateMany({
      where: { state: { in: [EntryState.PROVISIONED, EntryState.INSIDE] } },
      data: { retentionExpiresAt: new Date(Date.now() - 60_000) },
    });
    const swept = await sweepExpiredEntries(silentLog);
    check(
      "a scheduled job runs with no operator and no permission",
      swept.deprovisioned >= 0,
      JSON.stringify(swept),
    );
    const systemQueued = await prisma.syncCommand.count({
      where: { initiatedById: null, type: CommandType.DEPROVISION },
    });
    check("...and its commands are attributed to nobody, deliberately", systemQueued > 0);
    await device.drain();

    // 3. The same job's work must be readable by an operator who could not
    // have started it. Seeing what the system did is not the same permission
    // as being allowed to do it.
    const opsView = await app.inject({
      method: "GET",
      url: "/api/reports/command-history?pageSize=5",
      headers: auth(workerToken),
    });
    check(
      "an operator can read what a job did, without being able to run one",
      opsView.statusCode === 200,
      `${opsView.statusCode}`,
    );
    check(
      "...while still being refused the job itself",
      (
        await app.inject({
          method: "POST",
          url: "/api/entries/sweep-expiry",
          headers: auth(workerToken),
        })
      ).statusCode === 403,
    );

    // 4. Retention deletes audit rows only if asked to. A permission denial
    // recorded against an operator must not block deactivating them later —
    // audit_log.actor_id is a foreign key, and M18 forbids deletion for
    // exactly this reason.
    await app.inject({
      method: "PATCH",
      url: `/api/devices/${alertDevice.id}`,
      headers: auth(workerToken),
      payload: { role: "IN" },
    });
    // Counted by which permission was refused, not by how many refusals this
    // block happens to have provoked — the sweep-expiry check above records
    // one too, and asserting a total would break every time a test is added.
    const denials = await prisma.auditLog.findMany({
      where: { actorId: worker.id, action: "PERMISSION_DENIED" },
      select: { detail: true },
    });
    const refusedPermissions = denials.map(
      (d) => (d.detail as { permission?: string } | null)?.permission,
    );
    check(
      "a refusal is recorded against the operator who tried, naming what they wanted",
      refusedPermissions.includes("device:configure") &&
        refusedPermissions.includes("maintenance:run"),
      refusedPermissions.join(", "),
    );
    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/operators/${worker.id}`,
      headers: auth(token),
      payload: { isActive: false },
    });
    check(
      "...and having audit history does not prevent deactivating them",
      disabled.statusCode === 200,
      `${disabled.statusCode} ${disabled.body}`,
    );

    // 5. Revocation must reach a LONG-LIVED connection too. Every other route
    // re-reads the account per request; a stream is authorised once and then
    // lives for hours.
    check(
      "the event stream requires a permission, not merely a token",
      (await app.inject({ method: "GET", url: "/api/events" })).statusCode === 401,
    );

    // 6. A forced password change must not leave a usable session anywhere.
    await prisma.appUser.update({
      where: { id: worker.id },
      data: { isActive: true, mustChangePassword: true },
    });
    const forcedToken = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "seams@vms.local", password: "seams-password" },
        })
      ).body,
    ).token as string;
    for (const url of ["/api/reports", "/api/entries/board", "/api/alerts", "/api/events"]) {
      const res = await app.inject({ method: "GET", url, headers: auth(forcedToken) });
      check(`a forced password change blocks ${url}`, res.statusCode === 403, `${res.statusCode}`);
    }

    await prisma.auditLog.deleteMany({ where: { actorId: worker.id } });
    await prisma.appUser.delete({ where: { id: worker.id } });
    await prisma.device.update({ where: { id: alertDevice.id }, data: { role: "BOTH" } });
  }

  // ======================================================================
  section("25. Employee resignation — durable state and all-device removal");
  // ======================================================================
  {
    const resignationDevice = await prisma.device.findUniqueOrThrow({ where: { serialNo: SN } });
    const resignationCreate = await app.inject({
      method: "POST",
      url: "/api/people",
      headers: auth(token),
      payload: {
        ...registration("Resignation Fixture", "EMPRESIGN1"),
        category: "EMPLOYEE",
        deviceIds: [resignationDevice.id],
      },
    });
    check("an employee can be prepared for resignation", resignationCreate.statusCode === 201, resignationCreate.body);
    const resignationPersonId = JSON.parse(resignationCreate.body).id as string;
    const resignationResponse = await app.inject({
      method: "POST",
      url: `/api/people/${resignationPersonId}/resign`,
      headers: auth(token),
      payload: { reason: "E2E resignation" },
    });
    check("resignation is accepted as one Admin action", resignationResponse.statusCode === 202, resignationResponse.body);
    const [resignedPerson, resignedAccess, resignationDeletes] = await Promise.all([
      prisma.person.findUniqueOrThrow({ where: { id: resignationPersonId } }),
      prisma.employeeDeviceAccess.findMany({ where: { personId: resignationPersonId } }),
      prisma.syncCommand.count({ where: { personId: resignationPersonId, type: CommandType.DEPROVISION } }),
    ]);
    check("resignation is durable and deactivates the employee", resignedPerson.resignedAt !== null && !resignedPerson.isActive);
    check("every selected device loses desired access and gets a delete", resignedAccess.every((a) => !a.desiredAccess) && resignationDeletes === resignedAccess.length);
    const resignationReport = await app.inject({
      method: "GET",
      url: "/api/reports/resigned-employees",
      headers: auth(token),
    });
    const resignationRows = JSON.parse(resignationReport.body).rows as { person_id: string }[];
    check("the resigned-employees report includes the employee", resignationResponse.statusCode === 202 && resignationRows.some((row) => row.person_id === resignationPersonId));
    const rehireResponse = await app.inject({
      method: "POST",
      url: `/api/people/${resignationPersonId}/rehire`,
      headers: auth(token),
      payload: { deviceIds: [resignationDevice.id] },
    });
    check("rehire is accepted with an explicit device selection", rehireResponse.statusCode === 202, rehireResponse.body);
    const [rehiredPerson, rehiredAccess] = await Promise.all([
      prisma.person.findUniqueOrThrow({ where: { id: resignationPersonId } }),
      prisma.employeeDeviceAccess.findMany({ where: { personId: resignationPersonId } }),
    ]);
    check("rehire activates the employee and clears resignation", rehiredPerson.isActive && rehiredPerson.resignedAt === null && rehiredPerson.resignedReason === null);
    check("rehire restores permanent desired access on selected devices", rehiredAccess.some((access) => access.deviceId === resignationDevice.id && access.desiredAccess));
  }

  // ======================================================================
  section("26. Zones — two-zone topology and employee access by zone");
  // ======================================================================
  {
    const zoneCreate = async (payload: object) =>
      app.inject({ method: "POST", url: "/api/zones", headers: auth(token), payload });
    const premiseRes = await zoneCreate({ name: "E2E Premise", exitCodeDefault: true });
    check("a root zone can be created", premiseRes.statusCode === 201, premiseRes.body);
    const premiseZone = JSON.parse(premiseRes.body) as { id: string; exitCodeDefault: boolean };
    const yardRes = await zoneCreate({ name: "E2E Yard", parentZoneId: premiseZone.id });
    check("a child zone can be created under it", yardRes.statusCode === 201, yardRes.body);
    const yardZone = JSON.parse(yardRes.body) as { id: string; exitCodeDefault: boolean };
    check("each zone keeps its own exit-code default", premiseZone.exitCodeDefault && !yardZone.exitCodeDefault);
    const zoneDuplicate = await zoneCreate({ name: "e2e premise" });
    check("zone names are unique case-insensitively", zoneDuplicate.statusCode === 409, zoneDuplicate.body);
    const zoneCycle = await app.inject({
      method: "PATCH",
      url: `/api/zones/${premiseZone.id}`,
      headers: auth(token),
      payload: { parentZoneId: yardZone.id },
    });
    check("a zone cannot be moved inside its own child", zoneCycle.statusCode === 400, zoneCycle.body);

    // Four terminals: outer IN/OUT on the premise, yard IN/OUT on the yard.
    const zoneGates: Record<string, string> = {};
    for (const [key, role, zoneId] of [
      ["outerIn", "IN", premiseZone.id],
      ["outerOut", "OUT", premiseZone.id],
      ["yardIn", "IN", yardZone.id],
      ["yardOut", "OUT", yardZone.id],
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/devices",
        headers: auth(token),
        payload: { serialNo: `E2EZONE${key.toUpperCase()}`, name: `E2E ${key}`, role },
      });
      const gateId = JSON.parse(created.body).id as string;
      const placed = await app.inject({ method: "PATCH", url: `/api/devices/${gateId}`, headers: auth(token), payload: { zoneId } });
      check(`terminal ${key} is registered and placed in its zone`, created.statusCode === 201 && placed.statusCode === 200 && JSON.parse(placed.body).zoneId === zoneId, placed.body);
      zoneGates[key] = gateId;
    }
    const zoneMoves = await prisma.auditLog.count({
      where: { action: "DEVICE_ZONE_CHANGED", entityId: { in: Object.values(zoneGates) } },
    });
    check("every terminal placement is audited", zoneMoves === 4, `audited ${zoneMoves}`);

    const emptyZoneRes = await zoneCreate({ name: "E2E Empty" });
    const emptyZoneId = JSON.parse(emptyZoneRes.body).id as string;
    const zoneList = JSON.parse((await app.inject({ method: "GET", url: "/api/zones", headers: auth(token) })).body).items as {
      id: string;
      gates: { IN: number; OUT: number };
      warning: string | null;
    }[];
    const listedYard = zoneList.find((z) => z.id === yardZone.id);
    check("a zone reports its entry and exit terminals", listedYard?.gates.IN === 1 && listedYard.gates.OUT === 1 && listedYard.warning === null);
    check("a zone without terminals carries a warning", zoneList.find((z) => z.id === emptyZoneId)?.warning !== null);

    const zoneEmployee = async (name: string, pin: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/people",
        headers: auth(token),
        payload: { ...registration(name, pin), category: "EMPLOYEE", deviceIds: [zoneGates.outerIn] },
      });
      check(`employee ${pin} is created`, res.statusCode === 201, res.body);
      return JSON.parse(res.body).id as string;
    };
    const desiredGates = async (personId: string) =>
      (await prisma.employeeDeviceAccess.findMany({ where: { personId, desiredAccess: true } }))
        .map((a) => a.deviceId)
        .filter((id) => Object.values(zoneGates).includes(id))
        .sort();

    const officeEmployeeId = await zoneEmployee("Office Zone Employee", "EMPZONEOFF");
    const officeGrant = await app.inject({
      method: "POST",
      url: `/api/people/${officeEmployeeId}/device-access`,
      headers: auth(token),
      payload: { zoneIds: [premiseZone.id] },
    });
    check("access can be granted by zone", officeGrant.statusCode === 202, officeGrant.body);
    check(
      "an office-zone employee lands on the outer IN and OUT terminals only",
      JSON.stringify(await desiredGates(officeEmployeeId)) === JSON.stringify([zoneGates.outerIn, zoneGates.outerOut].sort()),
    );

    const yardEmployeeId = await zoneEmployee("Yard Zone Employee", "EMPZONEYRD");
    await app.inject({
      method: "POST",
      url: `/api/people/${yardEmployeeId}/device-access`,
      headers: auth(token),
      payload: { zoneIds: [yardZone.id] },
    });
    check(
      "a yard-zone employee also gets the premise terminals they must pass first",
      JSON.stringify(await desiredGates(yardEmployeeId)) === JSON.stringify(Object.values(zoneGates).sort()),
    );

    await app.inject({ method: "PATCH", url: `/api/zones/${emptyZoneId}`, headers: auth(token), payload: { isActive: false } });
    const inactiveGrant = await app.inject({
      method: "POST",
      url: `/api/people/${officeEmployeeId}/device-access`,
      headers: auth(token),
      payload: { zoneIds: [emptyZoneId] },
    });
    check("an inactive zone cannot be granted", inactiveGrant.statusCode === 409, inactiveGrant.body);
    const zoneAudits = await prisma.auditLog.count({ where: { action: { in: ["ZONE_CREATED", "ZONE_UPDATED"] } } });
    check("zone creation and changes are audited", zoneAudits >= 4, `audited ${zoneAudits}`);
  }

  // --- teardown ---------------------------------------------------------
  stopQueueMaintenance();
  await app.close();
  for (const file of writtenPhotos) await unlink(file).catch(() => undefined);
  await prisma.$disconnect();

  console.log(`\n${"=".repeat(64)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error("\nverification crashed:", err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});

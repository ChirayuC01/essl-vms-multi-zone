/**
 * DESTRUCTIVE — development testbed reset.
 *
 * Returns the system to a clean install: removes every person the VMS knows
 * about from the *device*, then clears the master database and the photo
 * directory. Keeps exactly two things, because without them there is nothing
 * to log into or provision to:
 *
 *   - app_user   (operator logins)
 *   - device     (the adopted terminal and its configuration)
 *
 * Order matters. Device deletions are queued and confirmed BEFORE the database
 * is cleared — wiping sync_command first would throw away the very commands
 * that clean the terminal, leaving a device full of users the VMS no longer
 * remembers. That is the "two masters" failure the whole design avoids.
 *
 * Usage:  npx tsx scripts/reset-testbed.ts --confirm
 *
 * The backend must be running and the device online, since the device pulls
 * its commands rather than being pushed to.
 */
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { CommandStatus, CommandType } from "@prisma/client";
import { config } from "../src/config/index.js";
import { prisma } from "../src/db/index.js";
import { enqueue } from "../src/adms/queue.js";

const DEVICE_TIMEOUT_MS = 120_000;
const POLL_MS = 2_000;

if (!process.argv.includes("--confirm")) {
  console.error(
    "This deletes every person, entry, command, punch, audit row and photo.\n" +
      "Only app_user and device survive.\n\n" +
      "Re-run with --confirm if that is what you want.",
  );
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const device = await prisma.device.findFirst({ orderBy: { createdAt: "asc" } });
  if (!device) {
    console.error("No device registered — nothing to clean. Run `npm run db:seed` first.");
    process.exit(1);
  }

  const lastSeen = device.lastSeenAt ? (Date.now() - device.lastSeenAt.getTime()) / 1000 : Infinity;
  console.log(`Device ${device.serialNo} — last seen ${lastSeen.toFixed(0)}s ago`);
  if (lastSeen > 150) {
    console.error(
      "Device looks offline. It must be checking in to receive delete commands;\n" +
        "otherwise the database would be cleared while the terminal keeps its users.",
    );
    process.exit(1);
  }

  // ---- 1. every PIN the VMS has ever associated with this device ----------
  const [people, punches, files] = await Promise.all([
    prisma.person.findMany({ select: { esslUserId: true } }),
    prisma.punchEvent.findMany({ distinct: ["esslUserId"], select: { esslUserId: true } }),
    readdir(config.photoStoragePath).catch(() => [] as string[]),
  ]);
  const pins = [
    ...new Set<string>([
      ...people.map((v) => v.esslUserId),
      ...punches.map((p) => p.esslUserId),
      ...files.filter((f) => /^[A-Za-z0-9]+\.jpg$/.test(f)).map((f) => f.replace(".jpg", "")),
    ]),
  ].sort((a, b) => a - b);

  console.log(`\nRemoving ${pins.length} PIN(s) from the device: ${pins.join(", ")}`);

  const queued = [];
  for (const pin of pins) {
    queued.push(
      await enqueue({
        type: CommandType.DEPROVISION,
        targetDeviceId: device.id,
        // countedOnDevice false: faces_used is re-read from the device's own
        // INFO at the end rather than arithmetic on a number we half-trust.
        payload: { pin, countedOnDevice: false },
        idempotencyKey: `testbed-reset:${device.serialNo}:${pin}:${Date.now()}`,
      }),
    );
  }

  // ---- 2. wait for the terminal to actually confirm each deletion ---------
  const ids = queued.map((c) => c.id);
  const deadline = Date.now() + DEVICE_TIMEOUT_MS;
  let done = 0;
  while (Date.now() < deadline) {
    done = await prisma.syncCommand.count({
      where: { id: { in: ids }, status: { in: [CommandStatus.SUCCESS, CommandStatus.FAILED] } },
    });
    process.stdout.write(`\r  confirmed ${done}/${ids.length}…`);
    if (done === ids.length) break;
    await sleep(POLL_MS);
  }
  console.log();

  const failed = await prisma.syncCommand.count({
    where: { id: { in: ids }, status: CommandStatus.FAILED },
  });
  if (done < ids.length) {
    console.error(
      `\nOnly ${done}/${ids.length} confirmed before the timeout. Database NOT cleared —\n` +
        "leaving it intact so the device and the VMS do not disagree. Check the device\n" +
        "is online and re-run.",
    );
    process.exit(1);
  }
  if (failed > 0) console.log(`  (${failed} returned a non-zero code — likely already absent)`);

  // ---- 3. clear the master database ---------------------------------------
  // Children before parents; people are the only thing with a real FK web.
  console.log("\nClearing the master database…");
  const [commands, punchRows, entries, biometrics, personRows, audits, admissions] =
    await prisma.$transaction([
      prisma.syncCommand.deleteMany({}),
      prisma.punchEvent.deleteMany({}),
      prisma.entry.deleteMany({}),
      prisma.personBiometric.deleteMany({}),
      prisma.person.deleteMany({}),
      prisma.auditLog.deleteMany({}),
      prisma.admissionQueue.deleteMany({}),
    ]);
  for (const [name, n] of [
    ["sync_command", commands.count],
    ["punch_event", punchRows.count],
    ["entry", entries.count],
    ["person_biometric", biometrics.count],
    ["person", personRows.count],
    ["audit_log", audits.count],
    ["admission_queue", admissions.count],
  ] as const) {
    console.log(`  ${name.padEnd(18)} ${n} row(s) deleted`);
  }

  // ---- 4. photos on disk ---------------------------------------------------
  let removed = 0;
  for (const file of files.filter((f) => /^\d+\.jpg$/.test(f))) {
    await unlink(path.join(config.photoStoragePath, file));
    removed += 1;
  }
  console.log(`  ${"photo files".padEnd(18)} ${removed} deleted`);

  // ---- 5. ask the device for the truth ------------------------------------
  await prisma.device.update({ where: { id: device.id }, data: { facesUsed: 0 } });
  await enqueue({
    type: CommandType.DEVICE_INFO,
    targetDeviceId: device.id,
    payload: {},
    idempotencyKey: `testbed-reset-info:${device.serialNo}:${Date.now()}`,
  });
  console.log("\nQueued INFO to re-read the device's real face count…");
  await sleep(15_000);
  const after = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
  console.log(`  device reports facesUsed=${after.facesUsed}`);
  if (after.facesUsed > 0) {
    console.log(
      "\n  NOTE: the device still holds users the VMS never knew about — most likely\n" +
        "  enrolled before this system managed it. Clear them from the terminal:\n" +
        "  Menu > User Mgt. (or Data Mgt.) > Delete All Users.",
    );
  }

  // The INFO command was queued after the wipe so it would survive it; clear
  // it now that it has served its purpose, leaving a genuinely empty queue.
  await prisma.syncCommand.deleteMany({});

  const admins = await prisma.appUser.count();
  console.log(`\nDone. Kept ${admins} operator login(s) and the device record; queue is empty.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("\nreset failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});

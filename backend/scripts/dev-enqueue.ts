// Dev helper until the Milestone 4 UI exists: enqueue a command for a device.
//
//   npx tsx scripts/dev-enqueue.ts <serialNo> DEVICE_INFO
//   npx tsx scripts/dev-enqueue.ts <serialNo> QUERY_USER <pin>
//   npx tsx scripts/dev-enqueue.ts <serialNo> BLOCK <pin>
//   npx tsx scripts/dev-enqueue.ts <serialNo> UNBLOCK <pin>
//   npx tsx scripts/dev-enqueue.ts <serialNo> DEPROVISION <pin>
//
// Uses the same queue module as the server, so idempotency and payload
// validation behave identically.

import { CommandType } from "@prisma/client";
import { prisma } from "../src/db/index.js";
import { parseUserId } from "../src/user-id.js";
import { enqueue, type CommandPayload } from "../src/adms/queue.js";

async function main(): Promise<void> {
  const [serialNo, typeArg, pinArg] = process.argv.slice(2);
  if (!serialNo || !typeArg) {
    console.error("usage: dev-enqueue.ts <serialNo> <TYPE> [pin]");
    process.exit(1);
  }
  const type = typeArg as CommandType;
  if (!Object.values(CommandType).includes(type)) {
    console.error(`unknown type ${typeArg}; valid: ${Object.values(CommandType).join(", ")}`);
    process.exit(1);
  }

  const device = await prisma.device.findUnique({ where: { serialNo } });
  if (!device) {
    console.error(`no device with serial ${serialNo}`);
    process.exit(1);
  }

  // Text, and validated here rather than at send time: an ID the device could
  // not hold should fail while a developer is looking at it.
  const pin = pinArg ? (parseUserId(pinArg) ?? undefined) : undefined;
  if (pinArg && pin === undefined) {
    console.error(`"${pinArg}" is not a usable user ID (letters and digits only)`);
    process.exit(1);
  }
  let payload: CommandPayload = {};
  if (type === CommandType.BLOCK) payload = { pin: pin!, grp: device.blockedGroupId };
  else if (type === CommandType.UNBLOCK) payload = { pin: pin!, grp: device.normalGroupId };
  else if (pin !== undefined) payload = { pin };

  const cmd = await enqueue({
    type,
    targetDeviceId: device.id,
    payload,
    idempotencyKey: `dev:${type}:${serialNo}:${pin ?? "-"}:${Date.now()}`,
  });
  console.log(`enqueued ${cmd.type} id=${cmd.id} status=${cmd.status}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

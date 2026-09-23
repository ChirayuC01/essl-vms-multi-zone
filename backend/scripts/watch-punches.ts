/**
 * Live punch inspector — for establishing what ATTLOG field 3 actually does.
 *
 * The dashboard feed shows who punched. This shows the raw record, because
 * the open question is whether the device stamps direction per punch (field 3)
 * or whether direction has to be inferred from which terminal reported it.
 * That answer shapes the Phase 2 state machine, so it is worth reading the
 * bytes rather than a rendering of them.
 *
 *   npx tsx scripts/watch-punches.ts
 *
 * Leave it running, walk to the terminal, punch, and watch. Field 3 is called
 * out on every row and any change to it is highlighted.
 */
import { prisma } from "../src/db/index.js";

const POLL_MS = 1_000;

const seen = new Set<string>();
let lastStatus: number | null = null;
let count = 0;

function ts(d: Date): string {
  return d.toISOString().slice(11, 19);
}

async function tick(): Promise<void> {
  const punches = await prisma.punchEvent.findMany({
    orderBy: { createdAt: "asc" },
    take: 200,
    include: { device: { select: { serialNo: true, timezoneOffsetMinutes: true } } },
  });

  for (const p of punches) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    // Skip whatever was already in the table when the watcher started.
    if (count === 0 && Date.now() - p.createdAt.getTime() > 10_000) continue;

    count += 1;
    const changed = lastStatus !== null && lastStatus !== p.statusCode;
    lastStatus = p.statusCode;

    console.log(
      `\n#${count}  ${ts(p.punchedAtUtc)} UTC  (device ${ts(p.punchedAtDevice)})  PIN ${p.esslUserId}`,
    );
    console.log(`     field 3 (status) = ${p.statusCode}${changed ? "   <<< CHANGED" : ""}`);
    console.log(`     field 4 (verify) = ${p.verifyMode}${p.verifyMode === 15 ? " (face)" : ""}`);
    console.log(`     raw: ${p.raw.replace(/\t/g, " | ")}`);
  }
}

async function main(): Promise<void> {
  const device = await prisma.device.findFirst();
  console.log("Watching for punches. Ctrl+C to stop.");
  console.log(`Device: ${device?.serialNo ?? "none registered"}\n`);
  console.log("Punch the terminal — each record prints below, field 3 called out.");
  console.log("Change the device's attendance-state setting between punches and");
  console.log("watch whether field 3 follows.\n");
  console.log("-".repeat(70));

  // Prime the seen-set so existing history is not replayed.
  const existing = await prisma.punchEvent.findMany({ select: { id: true } });
  for (const p of existing) seen.add(p.id);

  for (;;) {
    await tick().catch((err) => console.error("poll failed:", err));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

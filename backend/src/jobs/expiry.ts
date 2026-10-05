import { EntryState } from "@prisma/client";
import { prisma } from "../db/index.js";
import { gateTick } from "../services/gates.js";

// Pass expiry (two-zone rebuild, Phase 4). The old sweeper's work is now one
// step of the gate engine (services/gates.ts), which ends passes, removes
// their faces, and keeps an exit gate for anyone still inside. What remains
// here is the on-demand entry point and the "inside past their pass" list.

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface SweepResult {
  /** Passes that ended this run and are now being removed from terminals. */
  deprovisioned: number;
  /** Holders inside after their pass ended (kept an exit gate; listed for Security). */
  deferredInside: number;
}

/** Run the gate engine now and report what it did about ended passes. */
export async function sweepExpiredEntries(log: Logger, now: Date = new Date()): Promise<SweepResult> {
  const result = await gateTick(log, now);
  if (result.overstayed > 0) {
    log.warn({ count: result.overstayed }, "people are inside past the end of their pass — exit gate kept; Security should see them out");
  }
  return { deprovisioned: result.passesEnded, deferredInside: result.overstayed };
}

/** Passes that ended while the holder is still on site ("overstayed"). */
export async function overdueInside(limit = 200) {
  return prisma.entry.findMany({
    where: { state: EntryState.INSIDE, retentionExpiresAt: { not: null, lte: new Date() } },
    orderBy: { retentionExpiresAt: "asc" },
    take: limit,
    select: {
      id: true,
      state: true,
      inAt: true,
      retentionExpiresAt: true,
      locationZoneId: true,
      person: { select: { id: true, name: true, company: true, esslUserId: true } },
    },
  });
}

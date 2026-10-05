import { EntryState } from "@prisma/client";
import { prisma } from "../db/index.js";

// Entry modes (Phase 2, reduced in the two-zone rebuild, Phase 4).
//
// SINGLE_ENTRY used to be enforced by moving the person into the device's
// blocked group after their OUT punch and back again at a daily reset. That
// is retired: the gate engine now removes a single-entry face from each
// terminal shortly after that terminal is used (services/gates.ts), and a
// single-entry pass lasts one day. What remains here is the device-local
// clock helper and the list of entries an operator blocked by hand.

/** The device's local calendar date (YYYY-MM-DD) for an instant. */
export function localDate(now: Date, offsetMinutes: number): string {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Entries an operator has blocked by hand (the device identifies, then denies). */
export async function dayBlockedEntries(limit = 200) {
  return prisma.entry.findMany({
    where: { dayBlocked: true, state: { in: [EntryState.PROVISIONED, EntryState.INSIDE] } },
    orderBy: { outAt: "desc" },
    take: limit,
    select: {
      id: true,
      state: true,
      entryMode: true,
      inAt: true,
      outAt: true,
      retentionExpiresAt: true,
      person: { select: { id: true, name: true, company: true, esslUserId: true } },
    },
  });
}


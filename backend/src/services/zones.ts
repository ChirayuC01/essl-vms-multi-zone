import type { Device } from "@prisma/client";
import { prisma } from "../db/index.js";
import { ServiceError } from "./errors.js";

// Site topology (two-zone rebuild, Phase 1).
//
// Zones form a tree, and access to a zone implies access to every zone above
// it: a yard inside a premise is only reachable through the premise's gates,
// so a yard pass that loaded only the yard terminals would leave its holder
// standing at the outer barrier. Expansion therefore always walks UP.
//
// The zone table is a handful of rows on any real site, so it is read whole
// and walked in memory: two small queries regardless of how many zones are
// requested, never one per zone (CLAUDE.md #4).

export interface ZoneLink {
  id: string;
  parentZoneId: string | null;
}

/**
 * The requested zones plus every ancestor. Throws on an unknown id. A cycle
 * cannot be stored (see `wouldCreateCycle`), but the walk is bounded anyway so
 * a hand-edited database cannot hang a request.
 */
export function expandZoneIds(zones: readonly ZoneLink[], ids: readonly string[]): Set<string> {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const out = new Set<string>();
  for (const id of ids) {
    let current = byId.get(id);
    if (!current) throw new ServiceError(404, `zone not found: ${id}`);
    for (let steps = 0; current && !out.has(current.id) && steps <= zones.length; steps += 1) {
      out.add(current.id);
      current = current.parentZoneId ? byId.get(current.parentZoneId) : undefined;
    }
  }
  return out;
}

/** True when making `parentId` the parent of `zoneId` would close a loop. */
export function wouldCreateCycle(
  zones: readonly ZoneLink[],
  zoneId: string,
  parentId: string | null,
): boolean {
  if (parentId === null) return false;
  if (parentId === zoneId) return true;
  return expandZoneIds(zones, [parentId]).has(zoneId);
}

/**
 * Every terminal placed in the given zones or their ancestors. Requested zones
 * must exist and be active; an inactive zone cannot be newly granted, though an
 * inactive ancestor's gates are still included because they are still physically
 * in the way.
 */
export async function zoneDevices(zoneIds: readonly string[]): Promise<Device[]> {
  const unique = [...new Set(zoneIds)];
  if (unique.length === 0) throw new ServiceError(400, "select at least one zone");
  const zones = await prisma.zone.findMany({ select: { id: true, parentZoneId: true, isActive: true } });
  const inactive = zones.filter((z) => unique.includes(z.id) && !z.isActive);
  if (inactive.length > 0) throw new ServiceError(409, "an inactive zone cannot be granted");
  const expanded = expandZoneIds(zones, unique);
  return prisma.device.findMany({
    where: { zoneId: { in: [...expanded] } },
    orderBy: { createdAt: "asc" },
  });
}

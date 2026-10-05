import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { config } from "../config/index.js";
import { prisma } from "../db/index.js";
import { requirePermission } from "./permissions.js";
import { parseUserId, photoPathFor, userIdFromPhotoFile, userIdKey } from "../user-id.js";

// Unclaimed enrollments (Phase 1 Milestone 5).
//
// When someone is enrolled on the terminal, the device pushes a USER record
// and the backend auto-pulls the photo to photos/<pin>.jpg — before any
// person exists to own it. Registering with that PIN then attaches it.
//
// Without this endpoint that intermediate state is invisible: the photo sits
// on disk and the only way to claim it is to remember the PIN that was typed
// on the device. This makes the waiting enrollments visible so registration
// never depends on someone's memory.


/**
 * Resolve an ID to its photo path without ever letting caller input reach the
 * filesystem. The ID is validated against a strict letters-and-digits
 * whitelist and the filename rebuilt from the validated value, so
 * "../../etc/passwd" cannot survive the round trip. That whitelist IS the
 * traversal defence now that IDs are text - it replaces the Number() parse
 * that used to be doing this job.
 */
function photoPathForPin(raw: string): { pin: string; filePath: string } | null {
  const pin = parseUserId(raw);
  if (pin === null) return null;
  return { pin, filePath: photoPathFor(pin) };
}

export async function enrollmentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/enrollments/unclaimed", { preHandler: requirePermission("people:view") }, async (request, reply) => {
    let files: string[];
    try {
      files = await readdir(config.photoStoragePath);
    } catch {
      // No photo directory yet is a normal empty state, not an error.
      return reply.send({ items: [] });
    }

    const pins = files
      .map((name) => userIdFromPhotoFile(name))
      .filter((id): id is string => id !== null);
    if (pins.length === 0) return reply.send({ items: [] });

    // One query for the whole directory, never one per file. Raw SQL because
    // the match is case-insensitive and Prisma has no case-insensitive `in`;
    // this lands on the functional unique index over UPPER(essl_user_id).
    const claimed = await prisma.$queryRaw<{ key: string }[]>`
      SELECT UPPER("essl_user_id") AS key
        FROM "person"
       WHERE UPPER("essl_user_id") = ANY(${pins.map(userIdKey)}::text[])
    `;
    const claimedPins = new Set(claimed.map((v) => v.key));
    const unclaimed = pins.filter((pin) => !claimedPins.has(userIdKey(pin)));

    // Best-effort name, sourced from the device's own USER record rather than
    // anything typed here. Only lands once the backend's auto-pull QUERY_USER
    // round-trips (see ingest.ts/reconcile.ts) — a photo can arrive well
    // before its name does, so this is deliberately optional, not awaited on.
    // Also carries the ID in the DEVICE's own casing, which the filename has
    // lost: photos are written under the case-folded ID so `ABC1.jpg` and
    // `abc1.jpg` cannot be two files on a case-insensitive filesystem. That is
    // right for storage and wrong for registration - the person should be
    // created with the casing the terminal actually knows them by, because no
    // firmware has been shown to fold case and provisioning the wrong casing
    // could create a SECOND user on the device instead of updating theirs.
    const nameRows =
      unclaimed.length === 0
        ? []
        : await prisma.$queryRaw<{ key: string; observed: string; name: string | null }[]>`
            SELECT DISTINCT ON (UPPER(detail->>'pin'))
                   UPPER(detail->>'pin')  AS key,
                   detail->>'pin'         AS observed,
                   detail->>'deviceName'  AS name
              FROM "audit_log"
             WHERE "action" = 'RECONCILE_DRIFT_FOUND'
               AND UPPER(detail->>'pin') = ANY(${unclaimed.map(userIdKey)}::text[])
             ORDER BY UPPER(detail->>'pin'), "created_at" DESC
          `;
    const observedByKey = new Map(nameRows.map((r) => [r.key, r]));

    const items = await Promise.all(
      unclaimed.map(async (pin) => {
        const info = await stat(photoPathFor(pin));
        const observed = observedByKey.get(userIdKey(pin));
        return {
          // The device's casing when we have seen it, the folded form
          // otherwise. Either resolves to the same person here; only the
          // device might care about the difference.
          esslUserId: observed?.observed ?? pin,
          name: observed?.name ?? null,
          photoSizeBytes: info.size,
          // When the photo landed on disk — effectively when the person was
          // enrolled on the terminal.
          arrivedAt: info.mtime.toISOString(),
          photoUrl: `/api/enrollments/unclaimed/${userIdKey(pin)}/photo`,
        };
      }),
    );

    items.sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt));
    return reply.send({ items });
  });

  app.get("/enrollments/unclaimed/:pin/photo", { preHandler: requirePermission("people:view") }, async (request, reply) => {
    const { pin } = request.params as { pin: string };
    const resolved = photoPathForPin(pin);
    if (!resolved) return reply.code(400).send({ error: "pin must be a number" });

    try {
      return reply.type("image/jpeg").send(await readFile(resolved.filePath));
    } catch {
      return reply.code(404).send({ error: "no enrollment photo for that PIN" });
    }
  });
}

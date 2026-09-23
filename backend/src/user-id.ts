import path from "node:path";
import { PersonCategory } from "@prisma/client";
import { config } from "./config/index.js";

// The device user ID — the PIN typed at the terminal, and the forever join key
// between this database and a device roster.
//
// It is TEXT, not a number. Terminals in the field hold IDs like `WCTPL070`,
// `wctpl101` and `ye01` alongside plain numbers, and a site's numbering is
// whatever whoever set it up decided years ago. Treating it as an integer
// silently discarded every one of those records — a punch by `WCTPL070` parsed
// to `NaN` and was never stored at all.
//
// Three rules, enforced here so no caller has to remember them:
//
//   1. `[A-Za-z0-9]` only. The value becomes a filename and goes onto the wire
//      in a TAB-separated command, so anything looser is a path-traversal or a
//      command-injection question rather than a formatting preference. This is
//      a whitelist: it replaces the `Number()` parse that used to be the
//      traversal defence on the photo routes.
//   2. Case is preserved but never significant. `wctpl070` and `WCTPL071` sit
//      next to each other on a real roster, so the casing plainly means
//      nothing to the site — but we do not know whether the *device* agrees,
//      and sending back a casing it never saw could create a second user
//      instead of updating the one that exists. So: store what we were given,
//      compare case-insensitively.
//   3. Photo files are named from the case-folded form. Postgres is
//      case-sensitive and NTFS is not, so `ABC1.jpg` and `abc1.jpg` are two
//      rows and one file — which would silently overwrite one person's
//      enrollment photo with another's.

// The device's own field width is firmware-specific and has not been verified
// on the site's unit. Twenty is comfortably above the longest ID seen on a
// real roster (8 characters) while still refusing a value no terminal would
// accept. Raise it here if a device turns out to allow more.
export const MAX_USER_ID_LENGTH = 20;

const USER_ID_PATTERN = /^[A-Za-z0-9]+$/;

/**
 * Validate and normalise a user ID from any source — an operator, a device
 * record, a pasted list. Returns null for anything that is not a usable ID,
 * so callers decide whether that is a 400 or a line to skip.
 */
export function parseUserId(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (value.length === 0 || value.length > MAX_USER_ID_LENGTH) return null;
  if (!USER_ID_PATTERN.test(value)) return null;
  return value;
}

/**
 * The comparison and storage key: case-folded. Use for uniqueness, lookups and
 * filenames — never for what goes onto the wire, which must be the ID exactly
 * as the device knows it.
 */
export function userIdKey(id: string): string {
  return id.toUpperCase();
}

/** True when two IDs name the same person on a device. */
export function sameUserId(a: string, b: string): boolean {
  return userIdKey(a) === userIdKey(b);
}

/**
 * Where this user's enrollment photo lives. Built from the validated,
 * case-folded ID, so caller input never reaches the filesystem.
 */
export function photoPathFor(id: string): string {
  return path.join(config.photoStoragePath, `${userIdKey(id)}.jpg`);
}

/**
 * Does this ID look like one of ours, per a device's configured patterns?
 *
 * The successor to `PERSON_PIN_START/END`, which could only express a numeric
 * range and therefore could not describe a roster of `WCTPL070`s at all. A
 * pattern is a case-insensitive glob over the same charset — `WCTPL*`, `YE*`,
 * `1*` — and `*` is the only metacharacter.
 *
 * Empty means unclassified: automatically adopting a face without knowing
 * whether visitor-expiry or permanent employee rules apply is unsafe.
 */
export function matchesPersonIdPatterns(id: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const key = userIdKey(id);
  return patterns.some((pattern) => {
    const re = new RegExp(
      `^${userIdKey(pattern)
        .split("*")
        .map((part) => part.replace(/[^A-Z0-9]/g, ""))
        .join(".*")}$`,
    );
    return re.test(key);
  });
}

export function classifyDeviceId(
  id: string,
  employeePatterns: readonly string[],
  visitorPatterns: readonly string[],
): PersonCategory | null {
  const employee = matchesPersonIdPatterns(id, employeePatterns);
  const visitor = matchesPersonIdPatterns(id, visitorPatterns);
  if (employee === visitor) return null;
  return employee ? PersonCategory.EMPLOYEE : PersonCategory.VISITOR;
}

/** Device queries justified by a punch, preserving first-seen casing. */
export function punchQueryCandidates(
  ids: readonly string[],
  employeePatterns: readonly string[],
  visitorPatterns: readonly string[],
  claimedPhotoState: ReadonlyMap<string, boolean>,
): { discovery: string[]; missingPhotos: string[] } {
  const seen = new Set<string>();
  const discovery: string[] = [];
  const missingPhotos: string[] = [];
  for (const id of ids) {
    const key = userIdKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const hasPhoto = claimedPhotoState.get(key);
    if (hasPhoto === false) missingPhotos.push(id);
    else if (hasPhoto === undefined && classifyDeviceId(id, employeePatterns, visitorPatterns) !== null) {
      discovery.push(id);
    }
  }
  return { discovery, missingPhotos };
}

/** Exact intersection check for the deliberately tiny glob language (`*` only). */
export function patternsOverlap(left: readonly string[], right: readonly string[]): boolean {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const intersects = (aRaw: string, bRaw: string): boolean => {
    const a = userIdKey(aRaw);
    const b = userIdKey(bRaw);
    const queue: Array<[number, number]> = [[0, 0]];
    const seen = new Set<string>();
    while (queue.length) {
      const [i, j] = queue.shift()!;
      const state = `${i}:${j}`;
      if (seen.has(state)) continue;
      seen.add(state);
      if (i === a.length && j === b.length) return true;
      if (a[i] === "*") queue.push([i + 1, j]);
      if (b[j] === "*") queue.push([i, j + 1]);
      const charsA = a[i] === "*" ? alphabet : a[i] ?? "";
      const charsB = b[j] === "*" ? alphabet : b[j] ?? "";
      for (const ch of charsA) {
        if (!charsB.includes(ch)) continue;
        queue.push([a[i] === "*" ? i : i + 1, b[j] === "*" ? j : j + 1]);
      }
    }
    return false;
  };
  return left.some((a) => right.some((b) => intersects(a, b)));
}

/** `photos/<id>.jpg` → the ID, or null if the name is not one of ours. */
export function userIdFromPhotoFile(fileName: string): string | null {
  const match = /^([A-Za-z0-9]+)\.jpg$/.exec(fileName);
  return match ? parseUserId(match[1]) : null;
}

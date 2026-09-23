// Command builders — exact syntax confirmed on this firmware in Phase 0.
// Fields are TAB-separated on the wire; the C:<id>: prefix is added at send
// time by the queue, not here.
//
// The device does NOT validate payloads (it accepted the literal string
// "EndDatetime=<value>" with Return=0), so every field is validated here
// before a command string can exist at all.

import { MAX_USER_ID_LENGTH, parseUserId } from "../user-id.js";

const TAB = "\t";

export class CommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandValidationError";
  }
}

// The ID goes onto the wire inside a TAB-separated command, so the charset
// whitelist is a command-injection guard rather than a formatting preference.
// Sent exactly as stored and never case-folded: no firmware has been shown to
// treat `abc1` and `ABC1` as one user, and writing the wrong casing could
// create a second user instead of updating the intended one.
function assertPin(pin: string): void {
  if (parseUserId(pin) === null) {
    throw new CommandValidationError(
      `invalid PIN "${pin}": letters and digits only, 1-${MAX_USER_ID_LENGTH} characters`,
    );
  }
}

function assertSafeText(value: string, field: string, maxLen: number): void {
  if (value.length === 0) {
    throw new CommandValidationError(`${field} must not be empty`);
  }
  if (value.length > maxLen) {
    throw new CommandValidationError(`${field} exceeds ${maxLen} characters`);
  }
  // TAB is the field separator and newline the record separator — either one
  // inside a value corrupts the whole command.
  if (/[\t\r\n]/.test(value) || /[\x00-\x1f]/.test(value)) {
    throw new CommandValidationError(`${field} contains control characters`);
  }
}

function assertGroup(grp: number): void {
  if (!Number.isInteger(grp) || grp < 0 || grp > 9999) {
    throw new CommandValidationError(`invalid group id: ${grp}`);
  }
}

/** Create or update a user. Confirmed: DATA UPDATE USERINFO PIN=..<TAB>Name=..<TAB>Pri=0 */
export function buildCreateUser(opts: { pin: string; name: string; grp: number }): string {
  assertPin(opts.pin);
  assertSafeText(opts.name, "name", 40);
  assertGroup(opts.grp);
  return `DATA UPDATE USERINFO PIN=${opts.pin}${TAB}Name=${opts.name}${TAB}Pri=0${TAB}Grp=${opts.grp}`;
}

/**
 * Push an enrollment photo; the device regenerates the face template from it.
 * Size is the BASE64 CHARACTER COUNT, not the decoded byte count (observed:
 * Size=59128 for a 44,346-byte JPEG — exactly 4/3).
 */
export function buildPushPhoto(opts: { pin: string; jpeg: Buffer }): string {
  assertPin(opts.pin);
  if (opts.jpeg.length === 0) {
    throw new CommandValidationError("photo buffer is empty");
  }
  // JPEG magic: FF D8. A corrupt or non-JPEG file would be accepted by the
  // device (Return=0 means nothing) and silently produce a broken template.
  if (opts.jpeg[0] !== 0xff || opts.jpeg[1] !== 0xd8) {
    throw new CommandValidationError("photo is not a JPEG (bad magic bytes)");
  }
  const b64 = opts.jpeg.toString("base64");
  return (
    `DATA UPDATE BIOPHOTO PIN=${opts.pin}${TAB}FileName=${opts.pin}.jpg` +
    `${TAB}Type=9${TAB}Size=${b64.length}${TAB}Content=${b64}`
  );
}

/** Remove a user from the device (the DB record is never touched). */
export function buildDeleteUser(opts: { pin: string }): string {
  assertPin(opts.pin);
  return `DATA DELETE USERINFO PIN=${opts.pin}`;
}

/**
 * Block/unblock via access-group swap — the mechanism verified in Phase 0
 * (Grp resolves access; personal TZ is accepted and ignored). Group ids are
 * per-device configuration, passed in by the caller from the device row.
 */
export function buildSetGroup(opts: { pin: string; grp: number }): string {
  assertPin(opts.pin);
  assertGroup(opts.grp);
  return `DATA UPDATE USERINFO PIN=${opts.pin}${TAB}Grp=${opts.grp}`;
}

/** Ask the device to push back USER + BIODATA + BIOPHOTO for one PIN. */
export function buildQueryUser(opts: { pin: string }): string {
  assertPin(opts.pin);
  return `DATA QUERY USERINFO PIN=${opts.pin}`;
}

/** Full device capability/count dump. */
export function buildDeviceInfo(): string {
  return "INFO";
}

import { EntryMode, EntryState, GateReason, MessageChannel, type Entry } from "@prisma/client";
import { config } from "../config/index.js";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { getBranding } from "./branding.js";
import { checkCode, issueCode, newLinkToken } from "./codes.js";
import { ServiceError } from "./errors.js";
import { sendMessage } from "./notify.js";
import { loadExitGates } from "./passes.js";
import { getSettings } from "./settings.js";
import { liveLink, type VisitorContext } from "./visit-requests.js";

// The exit code (two-zone rebuild, Phase 7). SINGLE entry only, and only for
// passes whose exit is code-gated (Phase 4 `exitCodeZoneIds`); a multi-entry
// pass loads its exits with its entries and never gets a code.
//
// On the holder's first IN punch the host is sent the code (with an arrival
// note) and the visitor an out-pass link. When the visit ends the host gives
// the visitor the code; the visitor enters it on the out-pass page; a correct
// code loads the code-gated exit terminals (reason EXIT_CODE). A pass with no
// host (long-term, issued by Security) has its code issued at the Security
// desk on demand. Only hashes are stored, as for every code; Security's
// override (Phase 4) remains the fallback.

export const EXIT_CODE = "EXIT_CODE";
export const OUT_PASS = "OUT_PASS";
const GRACE_MS = 12 * 3_600_000;
const EXIT_REASONS = [GateReason.EXIT_CODE, GateReason.OVERRIDE];

/** A code and link stay usable until the pass ends, plus a grace for someone overstaying. */
const validUntil = (entry: Pick<Entry, "retentionExpiresAt">, now: Date) =>
  new Date(Math.max(entry.retentionExpiresAt?.getTime() ?? now.getTime(), now.getTime()) + GRACE_MS);

type CodeEntry = Entry & {
  person: { id: string; name: string; mobile: string | null };
  personToMeet: { phone: string | null; email: string } | null;
};

async function freshCode(entry: CodeEntry, now: Date) {
  const minutes = Math.ceil((validUntil(entry, now).getTime() - now.getTime()) / 60_000);
  return issueCode(EXIT_CODE, entry.id, minutes, now);
}

/** A new out-pass link for the visitor (the previous one stops working). */
async function sendOutPass(entry: CodeEntry, organizationName: string, who: string, now: Date): Promise<boolean> {
  if (!entry.person.mobile) return false;
  const { token, tokenHash } = newLinkToken();
  await prisma.$transaction([
    prisma.linkToken.updateMany({ where: { entryId: entry.id, purpose: OUT_PASS, revokedAt: null }, data: { revokedAt: now } }),
    prisma.linkToken.create({ data: { entryId: entry.id, purpose: OUT_PASS, tokenHash, expiresAt: validUntil(entry, now) } }),
  ]);
  await sendMessage({
    channel: MessageChannel.SMS,
    to: entry.person.mobile,
    template: "OUT_PASS",
    body: `Welcome to ${organizationName}. When you leave, open ${config.publicPortalUrl}/v/out/${token} and enter the exit code ${who} gives you.`,
    secrets: [token],
    related: { type: "entry", id: entry.id },
  });
  return true;
}

async function messageHostCode(entry: CodeEntry, organizationName: string, code: string): Promise<boolean> {
  const host = entry.personToMeet;
  if (!host) return false;
  const body = `${entry.person.name} has arrived at ${organizationName}. Their exit code is ${code} — give it to them when the visit ends.`;
  const related = { type: "entry", id: entry.id };
  if (host.phone) await sendMessage({ channel: MessageChannel.SMS, to: host.phone, template: "EXIT_CODE", body, secrets: [code], related });
  if (host.email.includes("@")) await sendMessage({ channel: MessageChannel.EMAIL, to: host.email, template: "EXIT_CODE", body, secrets: [code], related });
  return Boolean(host.phone || host.email.includes("@"));
}

const include = { person: { select: { id: true, name: true, mobile: true } }, personToMeet: { select: { phone: true, email: true } } } as const;

/**
 * Issue the exit code for every single-entry pass whose holder has just come
 * in. Runs after punches are applied and on every engine tick (a safety net).
 * Each pass is claimed first, so two runs never send two codes.
 */
export async function issueDueExitCodes(now = new Date()): Promise<number> {
  const due = await prisma.entry.findMany({
    where: { state: EntryState.INSIDE, entryMode: EntryMode.SINGLE_ENTRY, exitCodeSentAt: null, NOT: { exitCodeZoneIds: { isEmpty: true } } },
    include: { ...include, gates: { where: { reason: { in: EXIT_REASONS } }, select: { id: true } } },
    take: 100,
  });
  if (!due.length) return 0;
  const { organizationName } = await getBranding();
  let issued = 0;
  for (const entry of due) {
    const claimed = await prisma.entry.updateMany({ where: { id: entry.id, exitCodeSentAt: null }, data: { exitCodeSentAt: now } });
    // Exits already opened (an override before the first punch): nothing to send.
    if (!claimed.count || entry.gates.length) continue;
    const code = await freshCode(entry, now);
    const toHost = await messageHostCode(entry, organizationName, code);
    const outPass = await sendOutPass(entry, organizationName, toHost ? "your host" : "Security", now);
    await prisma.auditLog.create({
      data: auditRow({ action: AuditAction.EXIT_OTP_ISSUED, entityType: "entry", entityId: entry.id, detail: { personId: entry.personId, toHost, outPassSent: outPass, trigger: "FIRST_IN" } }),
    });
    issued += 1;
  }
  return issued;
}

/**
 * A new exit code, issued at the console (Security desk, or the host whose
 * phone never got it). Returned once to show on screen; earlier codes stop
 * working. The visitor gets a fresh out-pass link if they have no live one.
 */
export async function reissueExitCode(entryId: string, actorId: string, now = new Date()) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { ...include, gates: { where: { reason: { in: EXIT_REASONS } }, select: { id: true } } } });
  if (!entry) throw new ServiceError(404, "pass not found");
  if (entry.entryMode !== EntryMode.SINGLE_ENTRY || entry.exitCodeZoneIds.length === 0) throw new ServiceError(409, "this pass has no exit code — its exits load with the pass");
  if (entry.state !== EntryState.INSIDE && entry.state !== EntryState.PROVISIONED) throw new ServiceError(409, `pass is ${entry.state} — no exit code needed`);
  if (entry.gates.length) throw new ServiceError(409, "the exit terminals are already loaded for this pass");
  const code = await freshCode(entry, now);
  const live = await prisma.linkToken.count({ where: { entryId, purpose: OUT_PASS, revokedAt: null, expiresAt: { gt: now } } });
  const { organizationName } = await getBranding();
  const outPass = live ? false : await sendOutPass(entry, organizationName, "Security or your host", now);
  await prisma.$transaction([
    prisma.entry.updateMany({ where: { id: entryId, exitCodeSentAt: null }, data: { exitCodeSentAt: now } }),
    prisma.auditLog.create({
      data: auditRow({ action: AuditAction.EXIT_OTP_ISSUED, entityType: "entry", entityId: entryId, detail: { personId: entry.personId, trigger: "CONSOLE", outPassSent: outPass }, actorId }),
    }),
  ]);
  return { code, outPassSent: outPass };
}

async function entryForOutPass(token: string) {
  const link = await liveLink(token, OUT_PASS);
  const entry = link.entryId ? await prisma.entry.findUnique({ where: { id: link.entryId }, include: { person: { select: { name: true } }, gates: { where: { reason: { in: EXIT_REASONS } }, select: { id: true } } } }) : null;
  if (!entry) throw new ServiceError(404, "this link is not valid");
  return entry;
}

/** What the out-pass page shows. Nothing beyond the visitor's first name. */
export async function outPassState(token: string) {
  const entry = await entryForOutPass(token);
  const { organizationName } = await getBranding();
  const open = entry.state === EntryState.INSIDE || entry.state === EntryState.PROVISIONED;
  return {
    organizationName,
    firstName: entry.person.name.split(/\s+/)[0] ?? "",
    exitOpen: entry.gates.length > 0,
    closed: !open,
  };
}

/** The visitor enters the code; a correct one loads the code-gated exits. */
export async function verifyExitCode(token: string, code: string, ctx: VisitorContext) {
  const entry = await entryForOutPass(token);
  if (entry.gates.length) return { exitOpen: true };
  if (entry.state !== EntryState.INSIDE && entry.state !== EntryState.PROVISIONED) throw new ServiceError(409, "this pass has ended — please speak to Security");
  const { otpMaxAttempts } = await getSettings();
  const result = await checkCode(EXIT_CODE, entry.id, code, otpMaxAttempts);
  const who = { by: "VISITOR", ip: ctx.ip, userAgent: ctx.userAgent };
  if (result !== "OK") {
    await prisma.auditLog.create({ data: auditRow({ action: AuditAction.EXIT_OTP_FAILED, entityType: "entry", entityId: entry.id, detail: { ...who, result } }) });
    throw new ServiceError(400, {
      WRONG: "that code is not right — check it with your host",
      EXPIRED: "that code has expired — ask your host or Security for a new one",
      NO_CODE: "no exit code has been issued yet — please speak to Security",
      TOO_MANY_ATTEMPTS: "too many wrong attempts — ask your host or Security for a new code",
    }[result]);
  }
  await prisma.auditLog.create({ data: auditRow({ action: AuditAction.EXIT_OTP_VERIFIED, entityType: "entry", entityId: entry.id, detail: who }) });
  await loadExitGates(entry.id, GateReason.EXIT_CODE, undefined, who);
  return { exitOpen: true };
}

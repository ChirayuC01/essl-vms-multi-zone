import { createHash, randomBytes, randomInt } from "node:crypto";
import { prisma } from "../db/index.js";

// One-time codes and link tokens (two-zone rebuild, Phase 5). Only hashes are
// stored: the code or token exists in the message sent, and nowhere else.

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** A link token: 32 random bytes, URL-safe. */
export function newLinkToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hash(token) };
}
export const hashLinkToken = hash;

/** Issue a 6-digit code; earlier unused codes for the same subject stop working. */
export async function issueCode(purpose: string, subjectId: string, ttlMinutes: number, now = new Date()): Promise<string> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.$transaction([
    prisma.otp.updateMany({ where: { purpose, subjectId, consumedAt: null }, data: { consumedAt: now } }),
    prisma.otp.create({
      data: { purpose, subjectId, codeHash: hash(`${purpose}:${subjectId}:${code}`), expiresAt: new Date(now.getTime() + ttlMinutes * 60_000) },
    }),
  ]);
  return code;
}

export type CodeCheck = "OK" | "WRONG" | "EXPIRED" | "NO_CODE" | "TOO_MANY_ATTEMPTS";

/**
 * Check a code. Every wrong attempt counts; at the limit the code is burned
 * and a new one must be requested, so a 6-digit code cannot be guessed.
 */
export async function checkCode(purpose: string, subjectId: string, code: string, maxAttempts: number, now = new Date()): Promise<CodeCheck> {
  const otp = await prisma.otp.findFirst({ where: { purpose, subjectId, consumedAt: null }, orderBy: { createdAt: "desc" } });
  if (!otp) return "NO_CODE";
  if (otp.expiresAt <= now) return "EXPIRED";
  if (otp.attempts >= maxAttempts) return "TOO_MANY_ATTEMPTS";
  if (otp.codeHash !== hash(`${purpose}:${subjectId}:${code.trim()}`)) {
    const attempts = otp.attempts + 1;
    await prisma.otp.update({ where: { id: otp.id }, data: { attempts, ...(attempts >= maxAttempts ? { consumedAt: now } : {}) } });
    return attempts >= maxAttempts ? "TOO_MANY_ATTEMPTS" : "WRONG";
  }
  await prisma.otp.update({ where: { id: otp.id }, data: { consumedAt: now } });
  return "OK";
}

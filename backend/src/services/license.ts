import { createHash, randomUUID, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config/index.js";
import { prisma } from "../db/index.js";
import { ServiceError } from "./errors.js";

const execFileAsync = promisify(execFile);
const INSTALLATION_ID_KEY = "installation_id";
const TRIAL_STARTED_KEY = "trial_started_at";
const LATEST_SEEN_KEY = "license_latest_seen_at";
const WARNING_WINDOW_DAYS = 14;
const TRIAL_MS = 30 * 86_400_000;

interface LicenseMarker {
  installationId?: string;
  trialStartedAt?: string;
  latestSeenAt?: string;
  licenseKey?: string;
}

export interface LicensePayloadV2 {
  v: 2;
  licenseId: string;
  machineId: string;
  expiresAt: string;
  plan?: string;
}

export interface LicensePayloadV3 {
  v: 3;
  licenseId: string;
  expiresAt: string;
  plan?: string;
}

interface LegacyPayload {
  installationId: string;
  expiresAt: string;
  plan?: string;
}

type VerifiedLicense = {
  version: 1 | 2 | 3;
  licenseId: string | null;
  fingerprint: string;
  expiresAt: Date;
  plan: string | null;
};

async function readMarker(): Promise<LicenseMarker> {
  try { return JSON.parse(await readFile(config.licenseStatePath, "utf8")) as LicenseMarker; }
  catch { return {}; }
}

async function writeMarker(marker: LicenseMarker): Promise<void> {
  await mkdir(path.dirname(config.licenseStatePath), { recursive: true });
  const temporary = `${config.licenseStatePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(marker, null, 2), "utf8");
  await rename(temporary, config.licenseStatePath);
}

export async function getInstallationId(): Promise<string> {
  const [row, marker] = await Promise.all([
    prisma.appConfig.findUnique({ where: { key: INSTALLATION_ID_KEY } }),
    readMarker(),
  ]);
  const value = typeof row?.value === "string" ? row.value : marker.installationId ?? randomUUID();
  if (!row) await prisma.appConfig.upsert({
    where: { key: INSTALLATION_ID_KEY },
    create: { key: INSTALLATION_ID_KEY, value },
    update: {},
  });
  if (marker.installationId !== value) await writeMarker({ ...marker, installationId: value });
  return value;
}

let machineIdPromise: Promise<string> | null = null;
export function getMachineId(): Promise<string> {
  machineIdPromise ??= (async () => {
    let source: string;
    if (process.platform === "win32") {
      try {
        const { stdout } = await execFileAsync("reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
        const match = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(stdout);
        if (!match?.[1]) throw new Error("MachineGuid missing");
        source = match[1].trim();
      } catch {
        throw new ServiceError(500, "Windows MachineGuid could not be read");
      }
    } else {
      source = await getInstallationId();
    }
    return createHash("sha256").update(`vms-machine-v1:${source}`).digest("hex");
  })();
  return machineIdPromise;
}

function exactDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function legacyDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function verifyLicenseKey(licenseKey: string): Promise<VerifiedLicense> {
  if (!config.licensePublicKey) throw new ServiceError(409, "no LICENSE_PUBLIC_KEY is configured on this server");
  const parts = licenseKey.trim().split(".");
  if (parts.length !== 2) throw new ServiceError(400, "malformed license key");
  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    payloadBytes = Buffer.from(parts[0]!, "base64url");
    signature = Buffer.from(parts[1]!, "base64url");
  } catch { throw new ServiceError(400, "malformed license key"); }
  let raw: unknown;
  try { raw = JSON.parse(payloadBytes.toString("utf8")); }
  catch { throw new ServiceError(400, "malformed license key"); }
  if (!raw || typeof raw !== "object") throw new ServiceError(400, "malformed license key");
  const payload = raw as {
    v?: number;
    licenseId?: unknown;
    machineId?: unknown;
    installationId?: unknown;
    expiresAt?: unknown;
    plan?: unknown;
  };
  const localMachineId = payload.v === 3 ? await getMachineId() : null;
  const signedBytes = localMachineId
    ? Buffer.concat([payloadBytes, Buffer.from(`\0${localMachineId}`, "utf8")])
    : payloadBytes;
  if (!verify(null, signedBytes, config.licensePublicKey, signature)) {
    throw new ServiceError(400, "license key is not valid for this installation or is corrupted");
  }
  if (payload.v === 3) {
    const expiresAt = exactDate(payload.expiresAt);
    if (!expiresAt) throw new ServiceError(400, "license expiry must be an ISO timestamp with Z or an explicit timezone offset");
    if (typeof payload.licenseId !== "string" || !localMachineId) throw new ServiceError(400, "malformed v3 license key");
    return { version: 3, licenseId: payload.licenseId, fingerprint: localMachineId, expiresAt, plan: typeof payload.plan === "string" ? payload.plan : null };
  }
  if (payload.v === 2) {
    const expiresAt = exactDate(payload.expiresAt);
    if (!expiresAt) throw new ServiceError(400, "license expiry must be an ISO timestamp with Z or an explicit timezone offset");
    if (typeof payload.licenseId !== "string" || typeof payload.machineId !== "string") throw new ServiceError(400, "malformed v2 license key");
    const machineId = await getMachineId();
    if (payload.machineId !== machineId) throw new ServiceError(400, "this license key was issued for a different machine");
    return { version: 2, licenseId: payload.licenseId, fingerprint: machineId, expiresAt, plan: typeof payload.plan === "string" ? payload.plan : null };
  }
  const expiresAt = legacyDate(payload.expiresAt);
  if (!expiresAt) throw new ServiceError(400, "malformed legacy license expiry");
  if (typeof payload.installationId !== "string") throw new ServiceError(400, "malformed license key");
  if (payload.installationId !== await getInstallationId()) throw new ServiceError(400, "this license key was issued for a different installation");
  return { version: 1, licenseId: null, fingerprint: payload.installationId, expiresAt, plan: typeof payload.plan === "string" ? payload.plan : null };
}

export async function startTrial(now = new Date()): Promise<void> {
  const marker = await readMarker();
  const row = await prisma.appConfig.findUnique({ where: { key: TRIAL_STARTED_KEY } });
  const starts = [typeof row?.value === "string" ? new Date(row.value) : null, marker.trialStartedAt ? new Date(marker.trialStartedAt) : null, now]
    .filter((v): v is Date => v !== null && !Number.isNaN(v.getTime()));
  const trialStartedAt = new Date(Math.min(...starts.map((v) => v.getTime()))).toISOString();
  await prisma.$transaction([
    prisma.appConfig.upsert({ where: { key: TRIAL_STARTED_KEY }, create: { key: TRIAL_STARTED_KEY, value: trialStartedAt }, update: { value: trialStartedAt } }),
    prisma.appConfig.upsert({ where: { key: LATEST_SEEN_KEY }, create: { key: LATEST_SEEN_KEY, value: now.toISOString() }, update: {} }),
  ]);
  await writeMarker({ ...marker, installationId: await getInstallationId(), trialStartedAt, latestSeenAt: marker.latestSeenAt ?? now.toISOString() });
}

export interface LicenseStatus {
  installed: boolean;
  kind: "TRIAL" | "PAID" | null;
  plan: string | null;
  expiresAt: string | null;
  expired: boolean;
  expiringSoon: boolean;
  daysRemaining: number | null;
  installationId: string;
  machineId: string;
}

async function storeVerifiedKey(licenseKey: string, verified: VerifiedLicense): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.license.deleteMany({});
    await tx.license.create({ data: {
      licenseKey,
      licenseId: verified.licenseId,
      machineFingerprint: verified.fingerprint,
      plan: verified.plan,
      expiresAt: verified.expiresAt,
    } });
  });
}

let cached: { until: number; value: LicenseStatus } | null = null;
export async function getLicenseStatus(now = new Date(), useCache = false): Promise<LicenseStatus> {
  if (useCache && cached && cached.until > now.getTime()) return cached.value;
  const [installationId, machineId, marker, trialRow, seenRow] = await Promise.all([
    getInstallationId(), getMachineId(), readMarker(),
    prisma.appConfig.findUnique({ where: { key: TRIAL_STARTED_KEY } }),
    prisma.appConfig.findUnique({ where: { key: LATEST_SEEN_KEY } }),
  ]);
  let license = await prisma.license.findFirst({ orderBy: { createdAt: "desc" } });
  let verifiedLicense: VerifiedLicense | null = null;
  if (license) {
    try { verifiedLicense = await verifyLicenseKey(license.licenseKey); }
    catch { /* Database fields and keys are never trusted without verification. */ }
  }
  if (marker.licenseKey && marker.licenseKey !== license?.licenseKey) {
    try {
      const verified = await verifyLicenseKey(marker.licenseKey);
      if (!verifiedLicense || verified.expiresAt > verifiedLicense.expiresAt) {
        await storeVerifiedKey(marker.licenseKey, verified);
        license = await prisma.license.findFirst({ orderBy: { createdAt: "desc" } });
        verifiedLicense = verified;
      }
    } catch { /* A stale/tampered marker never overrides the database. */ }
  }

  const latestSeen = [now, typeof seenRow?.value === "string" ? new Date(seenRow.value) : null, marker.latestSeenAt ? new Date(marker.latestSeenAt) : null]
    .filter((v): v is Date => v !== null && !Number.isNaN(v.getTime()))
    .reduce((a, b) => a > b ? a : b);
  const latestSeenIso = latestSeen.toISOString();
  await prisma.appConfig.upsert({ where: { key: LATEST_SEEN_KEY }, create: { key: LATEST_SEEN_KEY, value: latestSeenIso }, update: { value: latestSeenIso } });

  const trialStarted = [typeof trialRow?.value === "string" ? new Date(trialRow.value) : null, marker.trialStartedAt ? new Date(marker.trialStartedAt) : null]
    .filter((v): v is Date => v !== null && !Number.isNaN(v.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const kind = verifiedLicense ? "PAID" as const : trialStarted ? "TRIAL" as const : null;
  const expiresAt = verifiedLicense?.expiresAt ?? (trialStarted ? new Date(trialStarted.getTime() + TRIAL_MS) : null);
  const remaining = expiresAt ? expiresAt.getTime() - latestSeen.getTime() : null;
  const status: LicenseStatus = {
    installed: kind !== null,
    kind,
    plan: verifiedLicense?.plan ?? null,
    expiresAt: expiresAt?.toISOString() ?? null,
    expired: remaining !== null && remaining <= 0,
    expiringSoon: remaining !== null && remaining > 0 && Math.ceil(remaining / 86_400_000) <= WARNING_WINDOW_DAYS,
    daysRemaining: remaining === null ? null : Math.ceil(remaining / 86_400_000),
    installationId,
    machineId,
  };
  const nextMarker: LicenseMarker = { ...marker, installationId, latestSeenAt: latestSeenIso };
  if (trialStarted) nextMarker.trialStartedAt = trialStarted.toISOString();
  if (verifiedLicense && license?.licenseKey) nextMarker.licenseKey = license.licenseKey;
  await writeMarker(nextMarker);
  cached = { until: Date.now() + 30_000, value: status };
  return status;
}

export async function installLicenseKey(licenseKey: string): Promise<LicenseStatus> {
  const verified = await verifyLicenseKey(licenseKey);
  await storeVerifiedKey(licenseKey, verified);
  const marker = await readMarker();
  await writeMarker({ ...marker, installationId: await getInstallationId(), licenseKey });
  cached = null;
  return getLicenseStatus();
}

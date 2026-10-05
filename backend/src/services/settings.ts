import { z } from "zod";
import { AuditAction, auditRow } from "../db/audit.js";
import { prisma } from "../db/index.js";
import { ServiceError } from "./errors.js";

// Site settings (two-zone rebuild, Phase 2).
//
// Everything a site may want different is a setting here, never a branch in
// code (CLAUDE.md #2). Machine-level config (ports, database URL) stays in
// config/; these are application decisions an Admin makes in the console.
//
// One app_config row holds the whole object. Each field has its own default,
// so a stored value that is missing or no longer valid falls back for that
// field alone instead of failing the whole read. A setting added in a later
// release therefore appears with its default on upgrade, with no migration.

const KEY = "site_settings";

export const DOCUMENT_TYPES = ["jpeg", "png", "webp", "pdf"] as const;

const fields = {
  /** Minutes before the expected time that a visitor's face loads onto the entry gates. */
  entryLoadLeadMinutes: z.number().int().min(0).max(240).default(5),
  /** Minutes after a punch that a single-entry face is removed from that terminal. */
  unloadAfterPunchMinutes: z.number().int().min(1).max(240).default(10),
  /** A walk-in waits for the host's Clear before anything is loaded. */
  walkInRequiresHostClear: z.boolean().default(true),
  /** A gap in the server's own heartbeat longer than this is treated as an outage. */
  outageGapMinutes: z.number().int().min(2).max(1440).default(10),
  /** Prefix of system-issued visitor terminal IDs. Must fit the visitor ID patterns. */
  visitorIdPrefix: z.string().regex(/^[A-Za-z0-9]{0,8}$/, "letters and digits only, up to 8").default("V"),
  /** How long a visitor's pre-registration link stays usable. */
  linkExpiryHours: z.number().int().min(1).max(720).default(72),
  /** How long a one-time code stays valid. */
  otpTtlMinutes: z.number().int().min(1).max(60).default(10),
  /** Wrong attempts before a one-time code is burned. */
  otpMaxAttempts: z.number().int().min(1).max(10).default(5),
  /** Largest uploaded document, in megabytes. */
  documentMaxMb: z.number().int().min(1).max(50).default(10),
  /** Most documents per visit. 0 disables uploads. */
  documentMaxCount: z.number().int().min(0).max(20).default(5),
  documentTypes: z.array(z.enum(DOCUMENT_TYPES)).max(DOCUMENT_TYPES.length).default([...DOCUMENT_TYPES]),
  /** The site's privacy (DPDP) notice, shown to every visitor before collection. */
  privacyNoticeText: z.string().max(10_000).default(""),
} as const;

type Fields = typeof fields;
export type SiteSettings = { [K in keyof Fields]: z.output<Fields[K]> } & {
  /**
   * When the notice text last changed. Set by the server, never by a caller,
   * so a visitor's consent can always be tied to the exact wording they saw.
   */
  privacyNoticeVersion: string | null;
};

/** What an Admin may change: any subset of the fields, each fully validated. */
export const settingsPatchSchema = z
  .object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.removeDefault().optional()])) as {
    [K in keyof Fields]: z.ZodOptional<ReturnType<Fields[K]["removeDefault"]>>;
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Merge stored JSON over the defaults, field by field. Pure, for tests. */
export function resolveSettings(stored: unknown): SiteSettings {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(fields)) {
    const parsed = (schema as z.ZodTypeAny).safeParse(raw[key]);
    out[key] = parsed.success ? parsed.data : (schema as z.ZodTypeAny).parse(undefined);
  }
  out.privacyNoticeVersion = typeof raw.privacyNoticeVersion === "string" ? raw.privacyNoticeVersion : null;
  return out as SiteSettings;
}

export async function getSettings(): Promise<SiteSettings> {
  const row = await prisma.appConfig.findUnique({ where: { key: KEY } });
  return resolveSettings(row?.value);
}

/**
 * Apply a patch. Only fields whose value actually changes are written to the
 * audit row, each with its old and new value. An unchanged patch writes
 * nothing.
 */
export async function updateSettings(patch: unknown, actorId?: string, now = new Date()): Promise<SiteSettings> {
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ServiceError(400, issue ? `${issue.path.join(".") || "settings"}: ${issue.message}` : "invalid settings");
  }
  const before = await getSettings();
  const next: SiteSettings = { ...before };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    const old = before[key as keyof SiteSettings];
    if (JSON.stringify(old) === JSON.stringify(value)) continue;
    changes[key] = { from: old, to: value };
    (next as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(changes).length === 0) return before;
  if (changes.privacyNoticeText) next.privacyNoticeVersion = now.toISOString();

  await prisma.$transaction([
    prisma.appConfig.upsert({
      where: { key: KEY },
      create: { key: KEY, value: next, updatedBy: actorId ?? null },
      update: { value: next, updatedBy: actorId ?? null },
    }),
    prisma.auditLog.create({
      data: auditRow({
        action: AuditAction.SETTINGS_CHANGED,
        entityType: "settings",
        entityId: KEY,
        detail: JSON.parse(JSON.stringify(changes)),
        actorId,
      }),
    }),
  ]);
  return next;
}

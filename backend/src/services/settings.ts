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

/** One per DLT-registered SMS template; see services/notify.ts for the wording. */
export const SMS_TEMPLATE_KEYS = [
  "MOBILE_OTP",
  "VISIT_LINK_INVITE",
  "VISIT_LINK_QUERY",
  "VISIT_CONFIRMED",
  "VISIT_REJECTED",
  "OUT_PASS",
  "EXIT_CODE",
  "REQUEST_SUBMITTED_WALK_IN",
  "REQUEST_SUBMITTED_PLANNED",
  "REQUEST_SUBMITTED_AUTO_FAILED",
  "PASS_ISSUED",
] as const;
export type SmsTemplateKey = (typeof SMS_TEMPLATE_KEYS)[number];

/** Never returned by the API or written to the audit log in clear. */
export const SECRET_SETTINGS = ["msg91AuthKey", "smtpPassword"] as const;

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
  // A digit prefix (e.g. "9") gives all-numeric IDs for terminals that accept
  // only numbers. Never a leading 0: a numeric terminal drops it, and the ID
  // on the terminal would no longer match the one on file.
  visitorIdPrefix: z.string().regex(/^[A-Za-z1-9][A-Za-z0-9]{0,7}$/, "1-8 letters or digits, not starting with 0").default("V"),
  /** How long a visitor's pre-registration link stays usable. */
  linkExpiryHours: z.number().int().min(1).max(720).default(72),
  /** How long a one-time code stays valid. */
  otpTtlMinutes: z.number().int().min(1).max(60).default(10),
  /** Wrong attempts before a one-time code is burned. */
  otpMaxAttempts: z.number().int().min(1).max(10).default(5),
  /** Largest uploaded document, in megabytes. Capped by the server's 20 MB request limit. */
  documentMaxMb: z.number().int().min(1).max(20).default(10),
  /** Most documents per visit. 0 disables uploads. */
  documentMaxCount: z.number().int().min(0).max(20).default(5),
  documentTypes: z.array(z.enum(DOCUMENT_TYPES)).max(DOCUMENT_TYPES.length).default([...DOCUMENT_TYPES]),
  /** The site's privacy (DPDP) notice, shown to every visitor before collection. */
  privacyNoticeText: z.string().max(10_000).default(""),
  /** "console" records SMS on the Outbox page only; "msg91" sends them. */
  smsTransport: z.enum(["console", "msg91"]).default("console"),
  msg91AuthKey: z.string().trim().max(200).default(""),
  /** MSG91's own template ID for each DLT template. A blank one is recorded as failed, never sent. */
  msg91TemplateIds: z.record(z.enum(SMS_TEMPLATE_KEYS), z.string().trim().max(64)).default({}),
  /** Off: no email is sent or recorded; SMS carries everything. */
  emailEnabled: z.boolean().default(false),
  smtpHost: z.string().trim().max(200).default(""),
  smtpPort: z.number().int().min(1).max(65535).default(587),
  /** TLS from the first byte (usually port 465); off means STARTTLS when offered. */
  smtpSecure: z.boolean().default(false),
  smtpUser: z.string().trim().max(200).default(""),
  smtpPassword: z.string().max(200).default(""),
  /** The From address, e.g. "Visitor desk <visitors@example.com>". */
  smtpFrom: z.string().trim().max(200).default(""),
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

/** What a turned-on channel still lacks, or null. Pure, for tests. */
export function missingForSending(s: SiteSettings): string | null {
  if (s.smsTransport === "msg91" && !s.msg91AuthKey) return "SMS via MSG91 needs the MSG91 auth key";
  if (s.emailEnabled && (!s.smtpHost || !s.smtpFrom)) return "email needs the SMTP server and the From address";
  return null;
}

/** Settings as the console sees them: secrets blanked, with whether each is set. */
export function publicSettings(s: SiteSettings) {
  return {
    ...s,
    ...Object.fromEntries(SECRET_SETTINGS.map((k) => [k, ""])),
    secretsSet: Object.fromEntries(SECRET_SETTINGS.map((k) => [k, s[k] !== ""])) as Record<(typeof SECRET_SETTINGS)[number], boolean>,
  };
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
    const secret = (SECRET_SETTINGS as readonly string[]).includes(key);
    // The console never sees a stored secret, so a blank one means "keep it".
    if (secret && value === "") continue;
    const old = before[key as keyof SiteSettings];
    if (JSON.stringify(old) === JSON.stringify(value)) continue;
    changes[key] = secret ? { from: old ? "set" : "not set", to: "set" } : { from: old, to: value };
    (next as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(changes).length === 0) return before;
  const missing = missingForSending(next);
  if (missing) throw new ServiceError(400, missing);
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

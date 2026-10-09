import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

// The only module allowed to read process.env. Everything else imports
// `config` from here. Validation fails loudly at startup — a half-configured
// service must never come up quietly.

// Normally two directories up from this file (src/config -> backend/). That
// trick breaks once the backend is bundled into a single file at an
// arbitrary depth (Phase 6 packaging), so an explicit VMS_APP_ROOT — set by
// the Windows service wrapper — takes priority when present. Unset in
// `npm run dev` / `npm test`, so both are unaffected there.
//
// The fallback additionally requires import.meta.url to be a real string.
// esbuild bundling to CommonJS (required for the packaged build — see
// scripts/build-package.mjs) leaves import.meta.url as undefined rather than
// shimming it, so fileURLToPath(undefined) would throw an opaque internal
// error. Failing loudly with a clear message here is the same philosophy as
// the rest of this file: a half-configured service must never come up
// quietly, and "opaque" is its own kind of quiet.
const backendRoot = process.env.VMS_APP_ROOT
  ? path.resolve(process.env.VMS_APP_ROOT)
  : typeof import.meta.url === "string"
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
    : (() => {
        throw new Error(
          "VMS_APP_ROOT must be set: import.meta.url is unavailable in the bundled (CommonJS) build.",
        );
      })();

dotenv.config({ path: path.join(backendRoot, ".env") });

const schema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      message: "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    }),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  PORT: z.coerce.number().int().min(1).max(65535).default(47102),
  ADMS_PORT: z.coerce.number().int().min(1).max(65535).default(47102),
  PHOTO_STORAGE_PATH: z.string().min(1).default("./data/photos"),
  // Where visitors open their links: the public address of the visitor portal
  // (the site's own domain through the tunnel, Phase 9). Links in messages are
  // built from it. The default is the installed web console on this machine,
  // so an upgraded site works before its tunnel exists; development sets the
  // dev port (48101) in backend/.env.
  PUBLIC_PORTAL_URL: z.string().url().default("http://localhost:47101"),
  // How messages leave: "console" writes them to the Outbox page (and the
  // log) without sending anything — for development and until the site's SMS
  // and email providers are confirmed.
  MESSAGE_TRANSPORT: z.enum(["console"]).default("console"),
  // Person documents (Govt ID copies, vehicle papers). Local disk, like photos.
  DOCUMENT_STORAGE_PATH: z.string().min(1).default("./data/documents"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // (PERSON_PIN_START/END removed: a numeric range cannot describe a roster
  // of `WCTPL070`s, and which IDs on a terminal are people is a per-device
  // question rather than a global one. See Device.personIdPatterns.)
  // Origins allowed to call the operator API from a browser. Comma-separated;
  // empty means "reflect any origin", which is acceptable only on an isolated
  // LAN and should be set explicitly by the installer in Phase 6.
  CORS_ORIGINS: z.string().default(""),
  // How long a device may stay silent before it is reported offline. The
  // terminal polls about every 30 s when idle, so the default of 90 s is
  // three missed polls — tolerant of jitter without pretending a dead device
  // is alive. Configuration rather than a constant because poll behaviour
  // varies by firmware.
  DEVICE_OFFLINE_AFTER_SECONDS: z.coerce.number().int().min(30).max(3600).default(90),
  // Emit every SQL statement as a Prisma event. Off by default; used to
  // assert the hot-path query budget and to diagnose a slow remote database,
  // where an accidental extra round trip is the difference between working
  // and unusable.
  DATABASE_LOG_QUERIES: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // How often the gate engine runs (services/gates.ts). It is the ONLY thing
  // that loads a scheduled face and removes one whose pass ended or whose
  // single-entry terminal was used — there is no device-native expiry — so
  // this interval is the worst-case lateness of every load and removal. A
  // minute keeps "load 5 min before, remove 10 min after" meaningful. Each
  // tick is a fixed handful of queries however many passes there are.
  GATE_TICK_CRON: z.string().min(1).default("* * * * *"),
  // pg-boss runs its own pool, separate from Prisma's. Kept small on purpose:
  // these jobs run minutes apart and never concurrently, and a managed
  // database's connection limit is a real constraint (CLAUDE.md #4).
  JOBS_POOL_SIZE: z.coerce.number().int().min(1).max(20).default(2),
  // pg-boss owns this schema and migrates it itself. Separate from the
  // application schema so Prisma migrations and job-queue internals can never
  // collide, and so a DBA can see which tables are ours.
  JOBS_SCHEMA: z.string().min(1).default("pgboss"),
  // How often the reconciliation sweep asks the device about a slice of the
  // roster. This is a security control, not housekeeping: it is what catches a
  // person still loaded on a terminal after their authorization ended, which
  // is otherwise completely silent. Hourly by default.
  RECONCILE_CRON: z.string().min(1).default("0 * * * *"),
  // People checked per sweep. Every check is a command the device collects
  // on a poll, so a whole roster at once would starve real work behind it.
  // The roster is covered over time rather than all at once.
  RECONCILE_BATCH: z.coerce.number().int().min(1).max(500).default(25),
  // How long raw punches are kept before being rolled into day summaries and
  // deleted. The movement record survives the prune — only its granularity is
  // lost — so this is rotation, not erasure.
  PUNCH_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(400),
  // Completed device commands. Only SUCCESS rows are ever pruned: a FAILED
  // command is evidence something never reached a barrier.
  COMMAND_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(120),
  // Audit log. Unset = NEVER pruned, deliberately. It records who authorized
  // whom to enter a site — the one thing an investigation needs, and the last
  // thing that should vanish on a timer. DPDP's "no longer than necessary"
  // pulls the other way, and resolving that is a client policy decision
  // rather than a default anyone else should pick for them.
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(36500).optional(),
  // How long a photo pulled from a terminal may sit unclaimed before it is
  // deleted from disk.
  //
  // Safe in a way nothing else in this product is: the DEVICE still holds the
  // photo, so a deleted unclaimed file is re-pullable at any time. We are
  // discarding a cache, not the durable artifact. It bounds what a terminal
  // shared with the client's employees can accumulate here (see
  // docs/DPDP_SHARED_TERMINAL_RISK.md) and keeps the unclaimed panel current.
  // Set to 0 to keep them indefinitely.
  UNCLAIMED_PHOTO_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  RETENTION_CRON: z.string().min(1).default("30 3 * * *"),
  // Rows per statement, and statements per run. Bounded so a year of backlog
  // is cleared over successive runs rather than in one pass holding locks for
  // minutes on a database that may not be ours.
  RETENTION_BATCH: z.coerce.number().int().min(50).max(20000).default(2000),
  RETENTION_PASSES_PER_RUN: z.coerce.number().int().min(1).max(100).default(10),
  // Face-capacity alert thresholds, as a percentage of the device's own
  // reported maximum. The ceiling is hard: at capacity a provision simply
  // fails, and it fails while somebody is waiting at a gate. On this hardware
  // (3,000 faces) these land at 2,100 and 2,550, matching the PRD's figures.
  FACE_CAPACITY_WARN_PERCENT: z.coerce.number().int().min(1).max(100).default(70),
  FACE_CAPACITY_CRITICAL_PERCENT: z.coerce.number().int().min(1).max(100).default(85),
  // How long a command may sit queued, while its device is online and
  // polling, before that counts as dispatch being broken rather than the
  // device being away. Generous: the queue is deliberately unhurried.
  COMMAND_STUCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  // Row cap on a CSV export. A year of movement is hundreds of thousands of
  // rows; an export that quietly truncates is worse than one that says so, so
  // the response carries X-Report-Truncated and the caller narrows the range.
  REPORT_EXPORT_MAX_ROWS: z.coerce.number().int().min(100).max(1000000).default(50000),
  // Pretty-print logs instead of emitting JSON. Defaults on when stdout is a
  // terminal, which is exactly "a person is watching". Turn it off for a
  // Windows service or anything shipping logs to a collector, where JSON is
  // the useful format. pino-pretty is a devDependency and must never be
  // required in production — hence the explicit off switch.
  LOG_PRETTY: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? process.stdout.isTTY === true : v === "true")),
  // Ed25519 public key (PEM), used only to VERIFY a license key — it can
  // never mint one. Absent means "no license configured", which is a normal
  // alert state (Phase 6 task 5 is warn-only, never a startup failure or a
  // lockout): a VMS outage must never strand authorized people, and a
  // licensing hiccup is exactly the kind of outage that rule covers.
  LICENSE_PUBLIC_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(`Invalid configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;


export const config = {
  databaseUrl: env.DATABASE_URL,
  databasePoolSize: env.DATABASE_POOL_SIZE,
  port: env.PORT,
  admsPort: env.ADMS_PORT,
  // Relative paths resolve against backend/, not the process CWD, so the
  // service behaves the same under nssm/WinSW later.
  photoStoragePath: path.isAbsolute(env.PHOTO_STORAGE_PATH)
    ? env.PHOTO_STORAGE_PATH
    : path.resolve(backendRoot, env.PHOTO_STORAGE_PATH),
  publicPortalUrl: env.PUBLIC_PORTAL_URL.replace(/\/+$/, ""),
  messageTransport: env.MESSAGE_TRANSPORT,
  documentStoragePath: path.isAbsolute(env.DOCUMENT_STORAGE_PATH)
    ? env.DOCUMENT_STORAGE_PATH
    : path.resolve(backendRoot, env.DOCUMENT_STORAGE_PATH),
  brandingStoragePath: path.resolve(backendRoot, "data", "branding"),
  licenseStatePath: process.platform === "win32" && process.env.PROGRAMDATA
    ? path.join(process.env.PROGRAMDATA, "VMS", "license-state.json")
    : path.resolve(backendRoot, "data", "license-state.json"),
  jwtSecret: env.JWT_SECRET,
  logLevel: env.LOG_LEVEL,
  logPretty: env.LOG_PRETTY,
  faceCapacityWarnPercent: env.FACE_CAPACITY_WARN_PERCENT,
  faceCapacityCriticalPercent: env.FACE_CAPACITY_CRITICAL_PERCENT,
  commandStuckMinutes: env.COMMAND_STUCK_MINUTES,
  reportExportMaxRows: env.REPORT_EXPORT_MAX_ROWS,
  punchRetentionDays: env.PUNCH_RETENTION_DAYS,
  commandRetentionDays: env.COMMAND_RETENTION_DAYS,
  auditRetentionDays: env.AUDIT_RETENTION_DAYS ?? null,
  unclaimedPhotoRetentionDays: env.UNCLAIMED_PHOTO_RETENTION_DAYS,
  retentionCron: env.RETENTION_CRON,
  retentionBatch: env.RETENTION_BATCH,
  retentionPassesPerRun: env.RETENTION_PASSES_PER_RUN,
  reconcileCron: env.RECONCILE_CRON,
  reconcileBatch: env.RECONCILE_BATCH,
  databaseLogQueries: env.DATABASE_LOG_QUERIES,
  deviceOfflineAfterSeconds: env.DEVICE_OFFLINE_AFTER_SECONDS,
  gateTickCron: env.GATE_TICK_CRON,
  jobsPoolSize: env.JOBS_POOL_SIZE,
  jobsSchema: env.JOBS_SCHEMA,
  corsOrigins: env.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
  licensePublicKey: env.LICENSE_PUBLIC_KEY ?? null,
} as const;

export type Config = typeof config;

/** Redacted view for startup logging — never log credentials. */
export function redactedConfig(): Record<string, string | number> {
  return {
    databaseUrl: redactDatabaseUrl(config.databaseUrl),
    databasePoolSize: config.databasePoolSize,
    port: config.port,
    admsPort: config.admsPort,
    photoStoragePath: config.photoStoragePath,
    jwtSecret: "<redacted>",
    logLevel: config.logLevel,
    logPretty: String(config.logPretty),
    corsOrigins: config.corsOrigins.length > 0 ? config.corsOrigins.join(",") : "<any origin>",
    deviceOfflineAfterSeconds: config.deviceOfflineAfterSeconds,
    gateTickCron: config.gateTickCron,
    faceCapacityWarnPercent: config.faceCapacityWarnPercent,
    faceCapacityCriticalPercent: config.faceCapacityCriticalPercent,
    commandStuckMinutes: config.commandStuckMinutes,
    reportExportMaxRows: config.reportExportMaxRows,
    punchRetentionDays: config.punchRetentionDays,
    commandRetentionDays: config.commandRetentionDays,
    auditRetentionDays: config.auditRetentionDays ?? "never",
    retentionCron: config.retentionCron,
    retentionBatch: config.retentionBatch,
    retentionPassesPerRun: config.retentionPassesPerRun,
    databaseLogQueries: String(config.databaseLogQueries),
    reconcileCron: config.reconcileCron,
    reconcileBatch: config.reconcileBatch,
    jobsPoolSize: config.jobsPoolSize,
    jobsSchema: config.jobsSchema,
    licensePublicKeyConfigured: config.licensePublicKey !== null ? "true" : "false",
  };
}

function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "<redacted>";
    return u.toString();
  } catch {
    // Connection strings must pass through untouched to the driver, but if
    // one is unparseable as a URL we refuse to echo it anywhere.
    return "<unparseable — redacted>";
  }
}

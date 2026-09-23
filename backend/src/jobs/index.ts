import { PgBoss } from "pg-boss";
import { config } from "../config/index.js";
import { scanTick } from "../services/backfill.js";
import { runDailyReset } from "../services/entry-modes.js";
import { reconcileSweep } from "../services/reconcile.js";
import { sweepExpiredEntries } from "./expiry.js";
import { runRetention } from "./retention.js";

// Scheduled jobs, on pg-boss over the same PostgreSQL the app already uses —
// no Redis, which keeps the on-prem footprint to one service to install.
//
// pg-boss opens its own connection pool, separate from Prisma's, and creates
// its own schema. Both matter on a client-supplied managed database, where
// connection limits are low and the app user may not hold CREATE: hence
// JOBS_POOL_SIZE (deliberately small — these jobs run minutes apart, not
// concurrently) and a startup failure that says which of the two went wrong.
//
// Started from index.ts rather than buildApp(), so the verification harness
// drives the sweep directly as a function and never has a scheduler racing
// its assertions.

const SWEEP_QUEUE = "entry-expiry-sweep";
const RESET_QUEUE = "entry-daily-reset";
const RECONCILE_QUEUE = "device-reconcile";
const RETENTION_QUEUE = "retention-sweep";
const SCAN_QUEUE = "device-roster-scan";

// Every minute, which is also the scan's rate limit: one window of queries
// per tick. Not configurable on purpose — this is a queue-pressure bound,
// not a site difference, and the device's own poll rate is the real ceiling.
const SCAN_TICK_CRON = "* * * * *";

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

let boss: PgBoss | null = null;

export async function startJobs(log: Logger): Promise<void> {
  if (boss) return;

  const instance = new PgBoss({
    connectionString: config.databaseUrl,
    schema: config.jobsSchema,
    max: config.jobsPoolSize,
  });

  // pg-boss surfaces background failures here rather than by rejecting; left
  // unhandled these are silent, and a sweeper that stopped running is exactly
  // the failure nobody notices until a lapsed person walks through a barrier.
  instance.on("error", (err: unknown) => {
    log.error({ err }, "pg-boss background error — scheduled jobs may not be running");
  });

  await instance.start();
  await instance.createQueue(SWEEP_QUEUE);

  await instance.work(SWEEP_QUEUE, async () => {
    const result = await sweepExpiredEntries(log);
    if (result.deprovisioned > 0 || result.deferredInside > 0) {
      log.info({ ...result }, "expiry sweep complete");
    }
  });

  // The daily reset checks far more often than it acts. It resets once per
  // DEVICE-local day, deciding from the device's own stored date rather than
  // from this schedule firing — so a service that was down at midnight still
  // catches up, and running it often is harmless.
  await instance.createQueue(RESET_QUEUE);
  await instance.work(RESET_QUEUE, async () => {
    const result = await runDailyReset(log);
    if (result.devicesReset > 0) log.info({ ...result }, "daily reset complete");
  });

  // Reconciliation asks the device about a slice of the roster. It is the
  // only thing that catches a person still loaded on a terminal after their
  // authorization ended — a state nothing else would ever report.
  await instance.createQueue(RECONCILE_QUEUE);
  await instance.work(RECONCILE_QUEUE, async () => {
    const result = await reconcileSweep(log, config.reconcileBatch);
    if (result.queried > 0) log.info({ ...result }, "reconciliation sweep complete");
  });

  // Retention runs at night by default. Nothing about it is urgent, and it is
  // the one job that deletes rows in bulk — best kept away from a shift change.
  await instance.createQueue(RETENTION_QUEUE);
  await instance.work(RETENTION_QUEUE, async () => {
    await runRetention(log);
  });

  // Roster backfill. Idle unless an operator started a scan, and deliberately
  // rate-limited: it feeds the same one-command-per-poll queue that operator
  // provisions use, so it refills a small window rather than dumping a range.
  await instance.createQueue(SCAN_QUEUE);
  await instance.work(SCAN_QUEUE, async () => {
    const result = await scanTick(log);
    if (result.queued > 0 || result.finished > 0) {
      log.info({ ...result }, "device roster scan advanced");
    }
  });

  // Idempotent: re-scheduling the same queue replaces the existing entry, so
  // a restart cannot accumulate duplicate schedules.
  await instance.schedule(SWEEP_QUEUE, config.expirySweepCron);
  await instance.schedule(RESET_QUEUE, config.dailyResetCron);
  await instance.schedule(RECONCILE_QUEUE, config.reconcileCron);
  await instance.schedule(RETENTION_QUEUE, config.retentionCron);
  await instance.schedule(SCAN_QUEUE, SCAN_TICK_CRON);

  boss = instance;
  log.info(
    {
      expirySweep: config.expirySweepCron,
      dailyResetCheck: config.dailyResetCron,
      dailyResetHour: config.dailyResetHour,
      reconcile: config.reconcileCron,
      retention: config.retentionCron,
    },
    "scheduled jobs started",
  );
}

export async function stopJobs(): Promise<void> {
  if (!boss) return;
  const instance = boss;
  boss = null;
  await instance.stop({ graceful: true });
}

/** Run the sweep now, outside the schedule. */
export async function runExpirySweepNow(log: Logger): Promise<void> {
  await sweepExpiredEntries(log);
}

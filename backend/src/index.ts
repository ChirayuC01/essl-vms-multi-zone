import { config, redactedConfig } from "./config/index.js";
import { assertDatabaseReachable, closeDatabase } from "./db/index.js";
import { stopQueueMaintenance } from "./adms/queue.js";
import { buildApp } from "./app.js";
import { startJobs, stopJobs } from "./jobs/index.js";

async function main(): Promise<void> {
  const app = await buildApp();

  const db = await assertDatabaseReachable();
  app.log.info({ postgres: db.serverVersion }, "database reachable");
  app.log.info({ config: redactedConfig() }, "resolved configuration");

  await app.listen({ port: config.port, host: "0.0.0.0" });

  // Deliberately fatal if this fails. The sweeper is the only thing that
  // removes a lapsed person from a device, so a service running without it is
  // silently insecure — and silence is the worst outcome available here. A
  // loud startup failure gets fixed; a missing sweeper does not get noticed.
  // People are not stranded either way: the device opens its own barrier
  // (CLAUDE.md #9), so this refuses to start without taking the gate down.
  try {
    await startJobs(app.log);
  } catch (err) {
    app.log.error(
      { err, schema: config.jobsSchema },
      "could not start scheduled jobs — the expiry sweeper would not run, so refusing to continue. " +
        "Check that the database user may CREATE this schema and that connections are available.",
    );
    throw err;
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    stopQueueMaintenance();
    await stopJobs();
    await app.close();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal startup error:", err);
  process.exit(1);
});

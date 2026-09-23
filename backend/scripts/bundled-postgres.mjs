// Phase 6 packaging — the bundled Postgres a client site runs without
// installing anything themselves. CLAUDE.md's rule stands regardless: the
// database is swappable by connection string alone, and a client may supply
// their own instead of this one. This script only exists to stand up the
// *default* — a self-contained cluster living entirely under this app's own
// data directory, managed by us, never touched by hand.
//
// Binaries come from `embedded-postgres` (github.com/leinelissen/embedded-postgres),
// which republishes zonky's per-platform Postgres builds as ordinary npm
// optionalDependencies — resolved by `npm install` like any other package,
// no separate download step and no dependency on the binaries.prisma.sh-style
// domain that blocked `prisma generate` in the sandbox this was first tried
// in. Pinned to 17.10.0-beta.17 (Postgres 17.10) to match the version this
// project's migrations were already validated against.
//
// Three subcommands:
//   init      - one-shot: initialise the data dir if new, start, ensure the
//               vms_app role + vms database exist, run `prisma migrate
//               deploy`, stop. Safe to run again later (e.g. after an
//               upgrade ships new migrations) — every step checks before
//               acting. Actually starts postgres.exe — do not call this from
//               an elevated process (see print-url below).
//   start     - long-running: initialise if new, start, stay in the
//               foreground until SIGINT/SIGTERM. This is what a Windows
//               service wrapper (Phase 6 task 3) will invoke; Postgres runs
//               as its own service, independent of the backend process, per
//               CLAUDE.md's principle that a VMS outage must never strand
//               the barrier. VmsPostgres runs as NetworkService (task 3),
//               never Administrator, so this is always safe there.
//   print-url - one-shot, no side effects: prints the connection string a
//               later `init`/`start` will use, WITHOUT starting postgres.
//               Added in task 7 after an elevated installer's call to
//               `init` (just to learn this URL) failed: the spawned
//               postgres.exe inherited the installer's Administrator token
//               and refused to run, on principle, same as task 3's finding
//               — just newly reachable through a plain child process rather
//               than a registered service. first-run-env.mjs uses this.
//
// Deliberately NOT done here: writing DATABASE_URL into .env. That decision
// belongs to the first-run setup wizard (task 4), which calls `print-url`,
// captures its output, and decides what to persist and where.

import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const backendRoot = process.env.VMS_APP_ROOT
  ? path.resolve(process.env.VMS_APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const config = {
  dataDir: process.env.VMS_PG_DATA_DIR ?? path.join(backendRoot, "data", "pgdata"),
  // Not 5432: a client machine (or a developer's own box, as found while
  // testing this) may already run a system-wide Postgres on the standard
  // port. The bundled cluster must never contend for it.
  port: Number(process.env.VMS_PG_PORT ?? 47103),
  superuser: process.env.VMS_PG_SUPERUSER ?? "postgres",
  // Fine as a fixed default for a cluster that only ever listens on
  // localhost and is never exposed off-box. Worth generating and persisting
  // a random one per install before this reaches a real client site.
  superuserPassword: process.env.VMS_PG_SUPERUSER_PASSWORD ?? "postgres",
  appUser: process.env.VMS_PG_APP_USER ?? "vms_app",
  appPassword: process.env.VMS_PG_APP_PASSWORD ?? "devpassword",
  appDatabase: process.env.VMS_PG_APP_DATABASE ?? "vms",
};

function databaseUrl() {
  return `postgresql://${config.appUser}:${config.appPassword}@localhost:${config.port}/${config.appDatabase}`;
}

function isAlreadyInitialised() {
  return existsSync(path.join(config.dataDir, "PG_VERSION"));
}

function newCluster() {
  return new EmbeddedPostgres({
    databaseDir: config.dataDir,
    user: config.superuser,
    password: config.superuserPassword,
    port: config.port,
    persistent: true,
  });
}

/** Idempotent: creates the app role and database only if either is missing. */
async function ensureAppRoleAndDatabase(pg) {
  const client = pg.getPgClient();
  await client.connect();
  try {
    const roleResult = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
      config.appUser,
    ]);
    if (roleResult.rowCount === 0) {
      console.log(`Creating role "${config.appUser}"...`);
      // CREATE ROLE does not accept bind parameters for identifiers or the
      // password literal. Both come from our own resolved config, not
      // untrusted input, but the password is still escaped defensively.
      const escapedPassword = config.appPassword.replace(/'/g, "''");
      await client.query(
        `CREATE ROLE "${config.appUser}" WITH LOGIN PASSWORD '${escapedPassword}'`,
      );
    }

    const dbResult = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      config.appDatabase,
    ]);
    if (dbResult.rowCount === 0) {
      console.log(`Creating database "${config.appDatabase}"...`);
      await client.query(`CREATE DATABASE "${config.appDatabase}" OWNER "${config.appUser}"`);
    }
  } finally {
    await client.end();
  }
}

/**
 * This release intentionally has no in-place legacy-identity data migration.
 * An uninstall preserves pgdata, so accepting an old cluster here would make a
 * "clean reinstall" silently reuse the old production-shaped schema.
 */
async function refuseLegacySchema() {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const result = await client.query("SELECT to_regclass('public.vendor') IS NOT NULL AS legacy");
    if (result.rows[0]?.legacy) {
      throw new Error(
        `Legacy VMS data was found at ${config.dataDir}. This release requires a clean People database. ` +
        "Stop installation, archive the old pgdata and photo directories if they are needed, then remove or relocate " +
        "the old backend data directory before installing again. A normal uninstall deliberately preserves it.",
      );
    }
  } finally {
    await client.end();
  }
}

/** Spawns `prisma migrate deploy` against the freshly-ensured database. */
function runMigrateDeploy() {
  return new Promise((resolve, reject) => {
    const schemaPath = path.join(backendRoot, "prisma", "schema.prisma");
    const prismaCli = path.join(backendRoot, "node_modules", "prisma", "build", "index.js");
    const child = spawn(
      process.execPath,
      [prismaCli, "migrate", "deploy", "--schema", schemaPath],
      {
        cwd: backendRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl() },
        stdio: "inherit",
      },
    );
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function init() {
  const pg = newCluster();
  const firstRun = !isAlreadyInitialised();

  if (firstRun) {
    console.log(`Initialising new Postgres data directory at ${config.dataDir}...`);
    await pg.initialise();
  } else {
    console.log(`Reusing existing data directory at ${config.dataDir}.`);
  }

  console.log(`Starting bundled Postgres on port ${config.port}...`);
  await pg.start();

  try {
    await ensureAppRoleAndDatabase(pg);
    await refuseLegacySchema();
    console.log("Running prisma migrate deploy...");
    await runMigrateDeploy();
  } finally {
    await pg.stop();
  }

  console.log("\nBundled Postgres initialised and migrated successfully.");
  console.log(`DATABASE_URL=${databaseUrl()}`);
}

async function start() {
  const pg = newCluster();
  const firstRun = !isAlreadyInitialised();

  try {
    if (firstRun) {
      console.log(`No existing data directory found at ${config.dataDir} — initialising...`);
      await pg.initialise();
    }
    await pg.start();
    // Cheap to re-check on every start, not just first-run: a client-site
    // upgrade that ships new migrations should not need a separate manual
    // step, and the checks are all idempotent no-ops when nothing changed.
    await ensureAppRoleAndDatabase(pg);
    await refuseLegacySchema();
    console.log("Running prisma migrate deploy...");
    await runMigrateDeploy();
  } catch (err) {
    // Unlike a failed one-shot `init`, a service manager may restart this
    // process — leaving the cluster running after a failed migrate step
    // would mean the next attempt starts against an already-running
    // postmaster on the same port and fails confusingly instead of cleanly.
    await pg.stop().catch(() => {});
    throw err;
  }

  console.log(`Bundled Postgres ready on port ${config.port}.`);
  console.log(`DATABASE_URL=${databaseUrl()}`);

  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, stopping bundled Postgres...`);
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const command = process.argv[2];

if (command === "init") {
  init().catch((err) => {
    console.error("Failed to initialise bundled Postgres:", err);
    process.exit(1);
  });
} else if (command === "start") {
  start().catch((err) => {
    console.error("Failed to start bundled Postgres:", err);
    process.exit(1);
  });
} else if (command === "print-url") {
  // Prints the connection string WITHOUT starting Postgres. Fully
  // deterministic from config, so no I/O is needed — and critically, no
  // postgres.exe gets spawned here. Phase 6 task 7 found that mattered:
  // when an elevated installer called `init` just to learn this URL, the
  // spawned postgres.exe inherited the installer's Administrator token and
  // refused to start (the exact same restriction task 3 already worked
  // around for the VmsPostgres *service*, by moving it to NetworkService —
  // but that fix only applies to a registered service, not an ad-hoc child
  // process). first-run-env.mjs only ever needed the URL string, never the
  // side effect; real initialisation happens exactly once, safely, when
  // the VmsPostgres service itself starts.
  console.log(`DATABASE_URL=${databaseUrl()}`);
} else {
  console.error("Usage: node scripts/bundled-postgres.mjs <init|start|print-url>");
  process.exit(1);
}

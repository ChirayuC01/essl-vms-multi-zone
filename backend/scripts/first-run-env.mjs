// Phase 6 packaging, task 4 — the piece bundled-postgres.mjs's own header
// comment deliberately deferred here: "the first-run setup wizard ... will
// call `init`, capture its output, and decide what to persist and where."
// (Now calls `print-url` instead — see the task 7 comment below.)
//
// `backend/src/config/index.ts` fails loudly and exits if DATABASE_URL or
// JWT_SECRET are missing, so neither can wait for a web UI step — this has
// to run before the backend process (or its Windows service) ever starts.
// Idempotent: only ever touches values still at their `.env.example`
// placeholder, so re-running after a real install is a safe no-op.
//
// Task 7: originally called `bundled-postgres.mjs init`, which actually
// starts postgres.exe. That's fine invoked by a human in an ordinary
// terminal, but an elevated installer running this step passes that
// elevation straight through to the spawned postgres.exe — which refuses
// to run under an Administrator token (task 3's finding, resurfacing in a
// new place). Switched to `print-url`, which only computes the connection
// string and never spawns postgres at all.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = process.env.VMS_APP_ROOT
  ? path.resolve(process.env.VMS_APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envPath = path.join(backendRoot, ".env");
const envExamplePath = path.join(backendRoot, ".env.example");

const JWT_SECRET_PLACEHOLDER = "change-me-to-a-long-random-string";
const DATABASE_URL_PLACEHOLDER = "postgresql://vms_app:devpassword@localhost:47103/vms";

function readEnvValue(contents, key) {
  const match = contents.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1] : undefined;
}

function setEnvValue(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`;
}

/**
 * Spawns `node scripts/bundled-postgres.mjs print-url` and returns the
 * DATABASE_URL it prints. Deliberately NOT `init`: that actually starts
 * postgres.exe, which refuses to run under an Administrator token (Phase 6
 * task 7 — an elevated installer running this step hit exactly that).
 * `print-url` is pure config, no process spawned, safe at any privilege
 * level. Real initialisation happens once, safely, when the VmsPostgres
 * service itself starts (as NetworkService, per task 3).
 */
function bundledPostgresUrl() {
  return new Promise((resolve, reject) => {
    const script = path.join(backendRoot, "scripts", "bundled-postgres.mjs");
    let stdout = "";
    const child = spawn(process.execPath, [script, "print-url"], { cwd: backendRoot });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`bundled-postgres.mjs print-url exited with code ${code}`));
      const match = stdout.match(/^DATABASE_URL=(.+)$/m);
      if (!match) return reject(new Error("bundled-postgres.mjs print-url did not print a DATABASE_URL"));
      resolve(match[1].trim());
    });
  });
}

/**
 * Reads `--backend-port=<n>` from argv, if present. Unlike JWT_SECRET/
 * DATABASE_URL below, this is force-written whenever passed — the installer
 * (or a human re-running this by hand) is the sole authority on the chosen
 * port, so a re-run with a different value must actually change it, not just
 * fill a placeholder.
 */
function backendPortArg() {
  const arg = process.argv.find((a) => a.startsWith("--backend-port="));
  if (!arg) return undefined;
  const value = arg.slice("--backend-port=".length);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --backend-port: ${value}`);
  }
  return port;
}

async function main() {
  const changes = [];

  if (!existsSync(envPath)) {
    if (!existsSync(envExamplePath)) {
      throw new Error(`Neither .env nor .env.example found at ${backendRoot}`);
    }
    copyFileSync(envExamplePath, envPath);
    changes.push("created .env from .env.example");
  }

  let contents = readFileSync(envPath, "utf8");

  const backendPort = backendPortArg();
  if (backendPort !== undefined) {
    contents = setEnvValue(contents, "PORT", String(backendPort));
    contents = setEnvValue(contents, "ADMS_PORT", String(backendPort));
    changes.push(`set PORT/ADMS_PORT=${backendPort}`);

    // 0.4.5 and earlier wrote the web service's loopback origin here. That
    // blocks a browser which opens the same console through the server's LAN
    // IP. Migrate only our old default; preserve an administrator's custom
    // allow-list.
    if (readEnvValue(contents, "CORS_ORIGINS") === "http://localhost:47101") {
      contents = setEnvValue(contents, "CORS_ORIGINS", "");
      changes.push("enabled installed-console access from LAN origins");
    }
  }

  const jwtSecret = readEnvValue(contents, "JWT_SECRET");
  if (!jwtSecret || jwtSecret === JWT_SECRET_PLACEHOLDER) {
    contents = setEnvValue(contents, "JWT_SECRET", randomBytes(48).toString("base64url"));
    changes.push("generated a new JWT_SECRET");
  }

  const databaseUrl = readEnvValue(contents, "DATABASE_URL");
  if (!databaseUrl || databaseUrl === DATABASE_URL_PLACEHOLDER) {
    console.log("DATABASE_URL is unset or still the example default — resolving the bundled Postgres connection string...");
    const realUrl = await bundledPostgresUrl();
    contents = setEnvValue(contents, "DATABASE_URL", realUrl);
    changes.push("set DATABASE_URL to the bundled Postgres instance");
  }

  writeFileSync(envPath, contents, "utf8");

  console.log(changes.length > 0 ? `.env updated: ${changes.join("; ")}.` : ".env already configured — nothing to do.");
}

main().catch((err) => {
  console.error("first-run-env.mjs failed:", err);
  process.exit(1);
});

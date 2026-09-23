// Mirrors backend/scripts/first-run-env.mjs's shape, kept separate rather
// than shared: this and the backend script run from different deployed
// roots with different node_modules, and each is only ~20 lines.
//
// Sets API_BASE_URL, the plain (non-NEXT_PUBLIC_) env var the root layout
// reads at request time to inject window.__VMS_API_BASE__ before hydration —
// see web/src/app/layout.tsx and web/src/lib/api.ts. This is what lets the
// backend's port be chosen at install time without rebuilding the frontend.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = process.env.VMS_APP_ROOT
  ? path.resolve(process.env.VMS_APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envPath = path.join(webRoot, ".env");
const envExamplePath = path.join(webRoot, ".env.example");

function setEnvValue(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`;
}

function backendPortArg() {
  const arg = process.argv.find((a) => a.startsWith("--backend-port="));
  const value = arg ? arg.slice("--backend-port=".length) : "47102";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --backend-port: ${value}`);
  }
  return port;
}

function main() {
  const backendPort = backendPortArg();

  if (!existsSync(envPath)) {
    if (!existsSync(envExamplePath)) {
      throw new Error(`Neither .env nor .env.example found at ${webRoot}`);
    }
    copyFileSync(envExamplePath, envPath);
  }

  let contents = readFileSync(envPath, "utf8");
  contents = setEnvValue(contents, "API_BASE_URL", `http://localhost:${backendPort}`);
  writeFileSync(envPath, contents, "utf8");

  console.log(`web/.env updated: API_BASE_URL=http://localhost:${backendPort}`);
}

main();

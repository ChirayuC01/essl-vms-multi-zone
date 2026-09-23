// Phase 6 task 7 — stages a clean, self-contained payload at
// installer/release/ for vms-installer.iss to package. Run by the
// developer before compiling the installer; does NOT run `npm install`,
// `npm run package`, or `npm run build` itself — same "prerequisite
// checked, not silently run" precedent as install-services.ps1.
//
// Release hardening: copy only first-party runtime artifacts, use Next's
// traced standalone server, prune backend devDependencies, remove source
// maps, and fail if source/issuer material slips into the staged payload.
// Third-party package source may remain where a runtime dependency ships it;
// the boundary here is that none of OUR TypeScript or source maps ship.

import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const installerRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(installerRoot, "..");
const backendRoot = path.join(repoRoot, "backend");
const webRoot = path.join(repoRoot, "web");
const releaseRoot = path.join(installerRoot, "release");
const licensePublicKeyFile = process.env.VMS_LICENSE_PUBLIC_KEY_FILE;

function requirePath(p, hint) {
  if (!existsSync(p)) {
    console.error(`Missing: ${p}\n${hint}`);
    process.exit(1);
  }
}

requirePath(path.join(backendRoot, "dist-package", "server.cjs"), "Run 'npm run package' in backend\\ first (Phase 6 task 1).");
requirePath(path.join(backendRoot, "node_modules"), "Run 'npm install' in backend\\ first.");
requirePath(path.join(backendRoot, "prisma", "schema.prisma"), "backend/prisma/schema.prisma not found — is this really the repo root?");
requirePath(path.join(backendRoot, "scripts", "windows-services", "winsw.exe"), "Download WinSW-x64.exe from https://github.com/winsw/winsw/releases and place it at backend/scripts/windows-services/winsw.exe first (Phase 6 task 3).");
requirePath(path.join(webRoot, ".next", "standalone", "server.js"), "Run 'npm run build' in web\\ first; next.config.ts must use output: 'standalone'.");
requirePath(path.join(webRoot, ".next", "static"), "web\\.next\\static is missing; rerun 'npm run build'.");
requirePath(path.join(webRoot, ".env.example"), "web/.env.example not found — is this really the repo root?");
requirePath(path.join(backendRoot, "scripts", "license", "create-license-request.mjs"), "Installed license-request helper is missing.");
if (!licensePublicKeyFile) {
  console.error("Missing VMS_LICENSE_PUBLIC_KEY_FILE. Point it at the issuer's Ed25519 PUBLIC key PEM; the private key must never be used here.");
  process.exit(1);
}
requirePath(path.resolve(licensePublicKeyFile), "The configured license public-key file does not exist.");
const licensePublicKey = readFileSync(path.resolve(licensePublicKeyFile), "utf8").trim();
if (!licensePublicKey.includes("-----BEGIN PUBLIC KEY-----") || !licensePublicKey.includes("-----END PUBLIC KEY-----")) {
  console.error("VMS_LICENSE_PUBLIC_KEY_FILE is not a PEM public key.");
  process.exit(1);
}

// The node.exe currently running this script — not a hardcoded path, so
// this works whatever machine/Node install actually built the release.
const nodeExePath = process.execPath;
requirePath(nodeExePath, "process.execPath does not exist — unexpected.");

console.log(`Staging release payload at ${releaseRoot}...`);
rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(releaseRoot, { recursive: true });

function copy(src, dest, opts = {}) {
  console.log(`  ${path.relative(repoRoot, src)} -> ${path.relative(installerRoot, dest)}`);
  cpSync(src, dest, { recursive: true, ...opts });
}

function requireEnvValue(file, key, expected) {
  const value = readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];
  if (value !== expected) {
    console.error(`Release environment must set ${key}=${expected}; found ${value ?? "missing"}.`);
    process.exit(1);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) {
    console.error(result.error ?? `${command} exited with code ${result.status}`);
    process.exit(1);
  }
}

function walkFiles(root, visit) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(absolute, visit);
    else if (entry.isFile()) visit(absolute);
  }
}

function removeSourceMaps(root) {
  let removed = 0;
  walkFiles(root, (file) => {
    if (path.extname(file).toLowerCase() === ".map") {
      unlinkSync(file);
      removed += 1;
    }
  });
  return removed;
}

function auditRelease(root) {
  const violations = [];
  const devArtifacts = new Set([
    "build-package.mjs",
    "dev-enqueue.ts",
    "reset-testbed.ts",
    "verify-e2e.ts",
    "watch-punches.ts",
  ]);

  walkFiles(root, (file) => {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    const firstParty = !relative.includes("/node_modules/");
    const extension = path.extname(file).toLowerCase();

    if (extension === ".map") violations.push(`${relative}: source map`);
    if (firstParty && (extension === ".ts" || extension === ".tsx")) {
      violations.push(`${relative}: first-party TypeScript source`);
    }
    if (relative.includes("/scripts/license/") || devArtifacts.has(path.basename(file))) {
      violations.push(`${relative}: issuer/development tool`);
    }
    if (firstParty && statSync(file).size <= 5 * 1024 * 1024) {
      const textExtensions = new Set([".js", ".cjs", ".mjs", ".json", ".html", ".rsc", ".example", ".ps1", ".prisma", ".sql", ".txt", ".pem"]);
      if (textExtensions.has(extension)) {
        const text = readFileSync(file, "utf8");
        if (text.includes("-----BEGIN PRIVATE KEY-----")) {
          violations.push(`${relative}: private key material`);
        }
        if (relative.startsWith("web/") && text.includes("http://localhost:48102")) {
          violations.push(`${relative}: development backend URL baked into web release`);
        }
      }
    }
  });

  if (violations.length > 0) {
    console.error("Release hardening audit failed:\n" + violations.map((v) => `  - ${v}`).join("\n"));
    process.exit(1);
  }
}

// backend/
copy(path.join(backendRoot, "dist-package"), path.join(releaseRoot, "backend", "dist-package"));
copy(path.join(backendRoot, "node_modules"), path.join(releaseRoot, "backend", "node_modules"));
copy(path.join(backendRoot, "package.json"), path.join(releaseRoot, "backend", "package.json"));
copy(path.join(backendRoot, "package-lock.json"), path.join(releaseRoot, "backend", "package-lock.json"));
copy(path.join(backendRoot, "prisma", "schema.prisma"), path.join(releaseRoot, "backend", "prisma", "schema.prisma"));
copy(path.join(backendRoot, "prisma", "migrations"), path.join(releaseRoot, "backend", "prisma", "migrations"));
// seed.ts is deliberately excluded: it upserts a hardcoded, published dev
// password and must never be reachable at a real site now that /setup
// exists. Copying only schema.prisma + migrations/ (not the whole prisma/
// folder) excludes it without needing a filter.
copy(path.join(backendRoot, "scripts", "bundled-postgres.mjs"), path.join(releaseRoot, "backend", "scripts", "bundled-postgres.mjs"));
copy(path.join(backendRoot, "scripts", "first-run-env.mjs"), path.join(releaseRoot, "backend", "scripts", "first-run-env.mjs"));
copy(path.join(backendRoot, "scripts", "windows-services"), path.join(releaseRoot, "backend", "scripts", "windows-services"));
// This collector contains no issuer key and cannot create a license. Shipping
// it avoids carrying a separate support file while issuer tooling stays out.
copy(
  path.join(backendRoot, "scripts", "license", "create-license-request.mjs"),
  path.join(releaseRoot, "tools", "create-license-request.mjs"),
);
copy(path.join(backendRoot, ".env.example"), path.join(releaseRoot, "backend", ".env.example"));
const stagedBackendEnv = path.join(releaseRoot, "backend", ".env.example");
requireEnvValue(stagedBackendEnv, "DATABASE_URL", "postgresql://vms_app:devpassword@localhost:47103/vms");
requireEnvValue(stagedBackendEnv, "PORT", "47102");
requireEnvValue(stagedBackendEnv, "ADMS_PORT", "47102");
writeFileSync(
  stagedBackendEnv,
  `${readFileSync(stagedBackendEnv, "utf8")}\n# Embedded by installer/build-release.mjs; public verification material only.\nLICENSE_PUBLIC_KEY=${JSON.stringify(licensePublicKey)}\n`,
  "utf8",
);

console.log("  pruning backend devDependencies from the staged runtime...");
run(process.platform === "win32" ? "npm.cmd" : "npm", ["prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], path.join(releaseRoot, "backend"));

// web/
copy(path.join(webRoot, ".next", "standalone"), path.join(releaseRoot, "web"));
copy(path.join(webRoot, ".next", "static"), path.join(releaseRoot, "web", ".next", "static"));
if (existsSync(path.join(webRoot, "public"))) {
  copy(path.join(webRoot, "public"), path.join(releaseRoot, "web", "public"));
}
copy(path.join(webRoot, ".env.example"), path.join(releaseRoot, "web", ".env.example"));
const stagedWebEnv = path.join(releaseRoot, "web", ".env.example");
requireEnvValue(stagedWebEnv, "API_BASE_URL", "http://localhost:47102");
requireEnvValue(stagedWebEnv, "NEXT_PUBLIC_API_URL", "http://localhost:47102");
// scripts/first-run-env.mjs writes API_BASE_URL at install time so the
// pre-built frontend above learns a chosen backend port without a rebuild.
copy(
  path.join(webRoot, "scripts", "first-run-env.mjs"),
  path.join(releaseRoot, "web", "scripts", "first-run-env.mjs"),
);

// Bundled Node runtime — a single self-contained node.exe on Windows.
mkdirSync(path.join(releaseRoot, "node"), { recursive: true });
copy(nodeExePath, path.join(releaseRoot, "node", "node.exe"));

const removedMaps = removeSourceMaps(releaseRoot);
auditRelease(releaseRoot);

console.log(`\nRelease payload staged and audited (${removedMaps} source maps removed).`);
console.log("Nothing under backend/data was copied — a fresh install always initializes its own.");

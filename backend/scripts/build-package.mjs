// Phase 6 packaging — bundles the backend into one file for distribution.
//
// Why CJS, not ESM: Prisma's generated client is CommonJS. Bundling to ESM
// while leaving @prisma/client external throws "Named export 'X' not found"
// at runtime even though the export genuinely exists — Node's static
// named-export detection for an external CJS module, imported from ESM, is
// unreliable. Targeting CJS avoids the problem entirely. The output keeps
// the .cjs extension so Node treats it as CommonJS regardless of this
// package's own "type": "module".
//
// Why @prisma/client and .prisma/client are external rather than inlined:
// the generated client locates its native query engine binary by walking
// the filesystem relative to its own location at runtime. Inlining it into
// the bundle breaks that lookup. Instead we bundle everything else and copy
// the real, generated client (and its engine binaries) into the package's
// own node_modules afterward, so `require("@prisma/client")` resolves
// exactly as it would in a normal install.
//
// No source maps, minified: a deliberate (if modest) source-hiding boundary
// for on-prem distribution. Not a security control — a speed bump.

import { build } from "esbuild";
import { existsSync, cpSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerFile = path.resolve(backendRoot, "..", "installer", "vms-installer.iss");
const productVersion = readFileSync(installerFile, "utf8").match(/^AppVersion=(\S+)$/m)?.[1];
if (!productVersion) throw new Error(`AppVersion not found in ${installerFile}`);

// Overridable so a sandbox that refuses to unlink previously-written files
// (hit during development) can redirect output; harmless to keep otherwise.
const outDir = process.env.VMS_PACKAGE_OUT
  ? path.resolve(process.env.VMS_PACKAGE_OUT)
  : path.join(backendRoot, "dist-package");

async function main() {
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  await build({
    entryPoints: [path.join(backendRoot, "src", "index.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: path.join(outDir, "server.cjs"),
    minify: true,
    sourcemap: false,
    logLevel: "info",
    define: { __VMS_VERSION__: JSON.stringify(productVersion) },
    // Both spellings: the package name, and the path the generated client's
    // own internals require() at runtime.
    external: ["@prisma/client", ".prisma/client"],
  });

  copyPrismaClient();

  console.log(`\nVMS ${productVersion} package built: ${path.join(outDir, "server.cjs")}`);
  console.log("Run with: node server.cjs   (from inside the output directory)");
}

function copyPrismaClient() {
  const srcNodeModules = path.join(backendRoot, "node_modules");
  const outNodeModules = path.join(outDir, "node_modules");
  mkdirSync(outNodeModules, { recursive: true });

  const prismaClientPkg = path.join(srcNodeModules, "@prisma", "client");
  const dotPrismaClient = path.join(srcNodeModules, ".prisma", "client");

  if (!existsSync(prismaClientPkg) || !existsSync(dotPrismaClient)) {
    throw new Error(
      "Prisma client not found in node_modules. Run `npx prisma generate` before `npm run package`.",
    );
  }

  mkdirSync(path.join(outNodeModules, "@prisma"), { recursive: true });
  cpSync(prismaClientPkg, path.join(outNodeModules, "@prisma", "client"), { recursive: true });
  cpSync(dotPrismaClient, path.join(outNodeModules, ".prisma", "client"), { recursive: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

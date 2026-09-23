// Phase 6 task 5 — run ONCE, offline, by whoever issues licenses. NOT part
// of the packaged backend (build-package.mjs only bundles src/index.ts) and
// NOT something to run on a client machine.
//
// Prints both keys to stdout. The PUBLIC key goes into a client's
// LICENSE_PUBLIC_KEY env var — it can only verify, never mint, a license.
// The PRIVATE key must never be committed to this repo, copied to a client
// machine, or pasted anywhere logged — it is the only thing that can
// produce a license issue-license.mjs will accept. Keep it offline.

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-dir");
const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : null;

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

if (outputDir) {
  const resolved = path.resolve(outputDir);
  const publicPath = path.join(resolved, "vms-license-public.pem");
  const privatePath = path.join(resolved, "vms-license-private.pem");
  if (existsSync(publicPath) || existsSync(privatePath)) {
    console.error("Refusing to overwrite an existing license keypair.");
    process.exit(1);
  }
  mkdirSync(resolved, { recursive: true });
  writeFileSync(publicPath, publicKey, { encoding: "utf8", mode: 0o644 });
  writeFileSync(privatePath, privateKey, { encoding: "utf8", mode: 0o600 });
  console.log(`Public key: ${publicPath}`);
  console.log(`Private key: ${privatePath} (keep offline; never ship)`);
} else {
  console.log("=== PUBLIC KEY (set as LICENSE_PUBLIC_KEY on the client machine) ===");
  console.log(publicKey);
  console.log("=== PRIVATE KEY (keep offline — never commit, never send to a client) ===");
  console.log(privateKey);
}

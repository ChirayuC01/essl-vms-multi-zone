// Issuer-only offline tool. Never package this folder or the private key on a
// client machine.
import { createHash, randomUUID, sign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const privateKeyPath = option("--private-key");
const ledgerPath = option("--ledger");
const machineIdPath = option("--machine-id-file");
const machineId = machineIdPath ? readFileSync(machineIdPath, "utf8").trim() : undefined;
const clientName = option("--client-name");
const expiresInput = option("--expires-at");
const plan = option("--plan");

if (!privateKeyPath || !ledgerPath || !machineId || !clientName || !expiresInput) {
  console.error('Usage: node issue-license.mjs --private-key <pem> --ledger <json> --machine-id-file <file> --client-name <name> --expires-at <ISO timestamp with Z/offset> [--plan <plan>]');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(expiresInput)) {
  console.error("--expires-at must include an exact time and Z or an explicit timezone offset");
  process.exit(1);
}
const expiresAt = new Date(expiresInput);
if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
  console.error("--expires-at must be a valid future timestamp");
  process.exit(1);
}

const payload = {
  v: 3,
  licenseId: randomUUID(),
  expiresAt: expiresAt.toISOString(),
  ...(plan ? { plan } : {}),
};
const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
const signedBytes = Buffer.concat([payloadBytes, Buffer.from(`\0${machineId}`, "utf8")]);
const signature = sign(null, signedBytes, readFileSync(privateKeyPath, "utf8"));
const licenseKey = `${payloadBytes.toString("base64url")}.${signature.toString("base64url")}`;

let ledger = [];
try {
  const parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("ledger root is not an array");
  ledger = parsed;
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
ledger.push({
  licenseId: payload.licenseId,
  clientName,
  machineId,
  expiresAt: payload.expiresAt,
  plan: plan ?? null,
  issuedAt: new Date().toISOString(),
  keyFingerprint: createHash("sha256").update(licenseKey).digest("hex"),
  licenseKey,
});
mkdirSync(dirname(ledgerPath), { recursive: true });
const temporary = `${ledgerPath}.tmp`;
writeFileSync(temporary, JSON.stringify(ledger, null, 2), "utf8");
renameSync(temporary, ledgerPath);

console.log(`Client: ${clientName}`);
console.log(`License ID: ${payload.licenseId}`);
console.log(`Expires (UTC): ${payload.expiresAt}`);
console.log("License key:");
console.log(licenseKey);

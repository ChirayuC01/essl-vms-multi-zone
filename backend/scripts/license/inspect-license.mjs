// Verifies a key and resolves its private client label from the issuer ledger.
import { verify } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const publicKeyPath = option("--public-key");
const ledgerPath = option("--ledger");
const licenseKey = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--public-key" && args[i - 1] !== "--ledger");
if (!publicKeyPath || !ledgerPath || !licenseKey) {
  console.error("Usage: node inspect-license.mjs --public-key <pem> --ledger <json> <license-key>");
  process.exit(1);
}
const [payloadPart, signaturePart] = licenseKey.split(".");
if (!payloadPart || !signaturePart) throw new Error("malformed license key");
const payloadBytes = Buffer.from(payloadPart, "base64url");
const payload = JSON.parse(payloadBytes.toString("utf8"));
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
const record = ledger.find((item) => item.licenseId === payload.licenseId);
const signedBytes = payload.v === 3
  ? record?.machineId
    ? Buffer.concat([payloadBytes, Buffer.from(`\0${record.machineId}`, "utf8")])
    : null
  : payloadBytes;
if (!signedBytes || !verify(null, signedBytes, readFileSync(publicKeyPath, "utf8"), Buffer.from(signaturePart, "base64url"))) {
  throw new Error("signature does not verify against the private ledger");
}
console.log(JSON.stringify({
  clientName: record?.clientName ?? null,
  licenseId: payload.licenseId,
  expiresAt: payload.expiresAt,
  plan: payload.plan ?? null,
  issuedAt: record?.issuedAt ?? null,
  ledgerMatch: Boolean(record),
}, null, 2));

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "vms-license-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePath = path.join(root, "private.pem");
  const publicPath = path.join(root, "public.pem");
  const ledgerPath = path.join(root, "ledger.json");
  const machineIdPath = path.join(root, "machine-id.txt");
  writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }));
  writeFileSync(machineIdPath, "machine-123\n");
  return { privatePath, publicPath, ledgerPath, machineIdPath };
}

test("issuer writes an exact UTC expiry and inspector resolves the private client label", () => {
  const files = fixture();
  const issued = spawnSync(process.execPath, [
    path.join(scripts, "issue-license.mjs"),
    "--private-key", files.privatePath,
    "--ledger", files.ledgerPath,
    "--machine-id-file", files.machineIdPath,
    "--client-name", "Example Customer",
    "--expires-at", "2037-08-01T18:30:00+05:30",
    "--plan", "standard",
  ], { encoding: "utf8" });
  assert.equal(issued.status, 0, issued.stderr);
  const key = issued.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(key);
  const publicPayload = JSON.parse(Buffer.from(key.split(".")[0], "base64url").toString("utf8"));
  assert.equal(publicPayload.v, 3);
  assert.equal("machineId" in publicPayload, false);
  const ledger = JSON.parse(readFileSync(files.ledgerPath, "utf8"));
  assert.equal(ledger[0].expiresAt, "2037-08-01T13:00:00.000Z");
  assert.equal(ledger[0].clientName, "Example Customer");

  const inspected = spawnSync(process.execPath, [
    path.join(scripts, "inspect-license.mjs"),
    "--public-key", files.publicPath,
    "--ledger", files.ledgerPath,
    key,
  ], { encoding: "utf8" });
  assert.equal(inspected.status, 0, inspected.stderr);
  const result = JSON.parse(inspected.stdout);
  assert.equal(result.clientName, "Example Customer");
  assert.equal("machineId" in result, false);
  assert.equal(result.ledgerMatch, true);

  // Change a full signature byte, not the final base64url character whose
  // unused padding bits can decode to the same bytes for more than one glyph.
  const signatureStart = key.indexOf(".") + 1;
  const altered = `${key.slice(0, signatureStart)}${key[signatureStart] === "A" ? "B" : "A"}${key.slice(signatureStart + 1)}`;
  const rejected = spawnSync(process.execPath, [
    path.join(scripts, "inspect-license.mjs"), "--public-key", files.publicPath,
    "--ledger", files.ledgerPath, altered,
  ], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
});

test("issuer rejects an expiry without a timezone", () => {
  const files = fixture();
  const result = spawnSync(process.execPath, [
    path.join(scripts, "issue-license.mjs"),
    "--private-key", files.privatePath,
    "--ledger", files.ledgerPath,
    "--machine-id-file", files.machineIdPath,
    "--client-name", "Example Customer",
    "--expires-at", "2037-08-01T18:30:00",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timezone offset/);
});

test("request helper writes the binding without printing it", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "vms-license-request-test-"));
  const requestPath = path.join(root, "license-request.txt");
  const result = spawnSync(process.execPath, [
    path.join(scripts, "create-license-request.mjs"),
    "--output", requestPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const binding = readFileSync(requestPath, "utf8").trim();
  assert.match(binding, /^[a-f0-9]{64}$/);
  assert.equal(result.stdout.includes(binding), false);
});

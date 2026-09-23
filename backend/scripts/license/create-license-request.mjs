// Installed client-side helper. It contains no signing secret and only writes
// the opaque installation binding to the caller-selected request file.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;

if (!outputPath) {
  console.error("Usage: node create-license-request.mjs --output <request-file>");
  process.exit(1);
}
if (process.platform !== "win32") {
  console.error("A production license request must be created on the target Windows computer.");
  process.exit(1);
}

const output = execFileSync(
  "reg.exe",
  ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
  { encoding: "utf8" },
);
const machineGuid = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1]?.trim();
if (!machineGuid) {
  console.error("The Windows installation identity could not be read.");
  process.exit(1);
}

const binding = createHash("sha256").update(`vms-machine-v1:${machineGuid}`).digest("hex");
writeFileSync(outputPath, `${binding}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`License request created: ${outputPath}`);

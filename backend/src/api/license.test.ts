import assert from "node:assert/strict";
import { test } from "node:test";
import { publicLicenseStatus } from "./license.js";

test("public license status omits private installation identifiers", () => {
  const status = publicLicenseStatus({
    installationId: "installation-secret",
    machineId: "machine-secret",
    installed: true,
    kind: "PAID",
    expiresAt: "2037-08-01T13:00:00.000Z",
    daysRemaining: 365,
    plan: "standard",
    expired: false,
    expiringSoon: false,
  });

  assert.equal("installationId" in status, false);
  assert.equal("machineId" in status, false);
  assert.equal(status.kind, "PAID");
});

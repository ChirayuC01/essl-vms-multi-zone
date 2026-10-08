import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Every operator route declares the access-grid cell it needs (CLAUDE.md:
// "each route declares one grid cell"). A route added without one is open to
// every signed-in operator — the kind of gap nobody notices until an audit.
// This scans the route files, so a new unguarded route fails here.
//
// The exceptions are deliberate and each says why. A new one belongs here
// only with a reason.

const EXEMPT: Record<string, string> = {
  "auth.ts POST /auth/login": "signing in; no operator yet",
  "operators.ts POST /auth/change-password": "any signed-in operator changes their own password",
  "branding.ts GET /branding": "the sign-in page shows the site name",
  "branding.ts GET /branding/logo": "the sign-in page shows the logo",
  "events.ts GET /events": "authenticates itself (?token=); its events are filtered per permission",
  "setup.ts GET /setup/status": "first-run wizard; self-gated to an empty installation",
  "setup.ts POST /setup/admin": "first-run wizard; self-gated to an empty installation",
  "reports.ts GET /reports": "lists only the reports the operator's cells allow",
  "reports.ts GET /reports/meta/audit-facets": "checks audit:view in the handler",
  "reports.ts GET /reports/:key": "checks each report's own cell in the handler",
  "portal.ts *": "the visitor portal: token-scoped, no operator (walk-in desk mounts it behind walkins:create)",
};

const apiDir = path.resolve(import.meta.dirname);
const ROUTE = /\b(?:app|api|desk)\.(get|post|put|patch|delete)\(\s*([`"])([^`"]+)\2\s*,([\s\S]*?)async\s*\(/g;

test("every operator route declares the permission it needs", () => {
  const unguarded: string[] = [];
  let seen = 0;
  for (const file of readdirSync(apiDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const source = readFileSync(path.join(apiDir, file), "utf8");
    for (const m of source.matchAll(ROUTE)) {
      seen += 1;
      const id = `${file} ${m[1]!.toUpperCase()} ${m[3]}`;
      if (m[4]!.includes("preHandler") || EXEMPT[id] || EXEMPT[`${file} *`]) continue;
      unguarded.push(id);
    }
  }
  assert.ok(seen > 100, `the scan found only ${seen} routes — has the registration style changed?`);
  assert.deepEqual(unguarded, [], "routes without a permission (add a preHandler, or an EXEMPT entry with the reason)");
});

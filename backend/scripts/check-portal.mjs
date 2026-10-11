// Checks the visitor portal's internet-facing protections (Phase 9) and
// prints PASS / FAIL for each. Read-only: it only makes GET requests.
//
//   node scripts/check-portal.mjs                         (dev web, http://localhost:48101)
//   node scripts/check-portal.mjs http://localhost:47101   (installed web)
//   node scripts/check-portal.mjs https://visit.example.com  (through the tunnel)
//
// Through the tunnel (an https address) it also checks that the console and
// the terminal endpoints are NOT reachable from the internet.

const base = (process.argv[2] ?? "http://localhost:48101").replace(/\/+$/, "");
const viaTunnel = base.startsWith("https://");
let failed = 0;

function result(ok, what, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail && !ok ? `  (${detail})` : ""}`);
}

async function get(path) {
  try {
    const res = await fetch(base + path, { redirect: "manual" });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } catch (err) {
    return { status: 0, headers: new Headers(), body: String(err) };
  }
}

console.log(`Checking ${base}\n`);

const page = await get("/v/check-portal-test");
if (page.status === 0) {
  console.log(`Cannot reach ${base} — is the web server running? (dev: \`npm run dev\` in web; installed: the VmsWeb service)`);
  process.exit(1);
}
result(page.status === 200, "the portal page opens", `status ${page.status}`);
result(page.headers.get("referrer-policy") === "no-referrer", "the link is never passed on to other sites (Referrer-Policy)", page.headers.get("referrer-policy") ?? "missing");
result(page.headers.get("x-frame-options") === "DENY", "other sites cannot embed the portal (X-Frame-Options)", page.headers.get("x-frame-options") ?? "missing");
result((page.headers.get("x-robots-tag") ?? "").includes("noindex"), "search engines are told not to index it (X-Robots-Tag)", page.headers.get("x-robots-tag") ?? "missing");
result(/no-store|no-cache/.test(page.headers.get("cache-control") ?? ""), "browsers do not reuse a cached copy (Cache-Control)", page.headers.get("cache-control") ?? "missing");

const link = await get(`/public-api/v/${"x".repeat(43)}`);
result(link.status === 404 && link.body.includes("not valid"), "the portal reaches the backend (a fake link is refused)", `status ${link.status}`);

for (const trick of ["/public-api/%2E%2E/api/auth/me", "/public-api/..%2Fapi%2Fauth%2Fme", "/public-api/%2e%2e/health"]) {
  const r = await get(trick);
  result(r.status === 404 && !r.body.includes('"status":"ok"') && !r.body.includes("authentication required"), `a path trick cannot reach the operator API: ${trick}`, `status ${r.status}`);
}

if (viaTunnel) {
  for (const hidden of ["/login", "/", "/people", "/api/auth/me", "/iclock/cdata?SN=TEST", "/health"]) {
    const r = await get(hidden);
    result(r.status === 404, `not published to the internet: ${hidden}`, `status ${r.status}`);
  }
} else {
  console.log("\n(Tunnel checks skipped: pass the https tunnel address to run them.)");
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exitCode = failed ? 1 : 0;

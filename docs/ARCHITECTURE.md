# Architecture

How the system is built today (0.4.19 base) and where the two-zone rebuild
changes it. Phase-by-phase changes are recorded in `EXECUTION_LOG.md`; update
this file when a phase changes a section.

## 1. Shape

```
 Operators (browser on LAN) ──► VmsWeb  (Next.js console, :47101)
                                   │ REST + SSE
                                   ▼
 eSSL terminals ──ADMS/HTTP──►  VmsBackend (Fastify, :47102)
   (poll + push)                operator API · /iclock endpoints · pg-boss jobs
                                   │
                                   ▼
                                VmsPostgres (bundled PostgreSQL, :47103)
                                photos / logo on local disk (backend/data)
```

Three Windows services managed by WinSW, installed by one Inno Setup installer
(`installer/vms-installer.iss`). Development runs the same three processes on
`48101–48103` (`DEVELOPMENT_SETUP.md`).

**Rebuild addition (Phases 5, 9):** a visitor portal under `/v/*` in the same
Next.js app, calling `/public-api/*` on the backend through a Next.js rewrite,
published to the internet only through a Cloudflare Tunnel whose ingress allows
`/v/`, `/_next/` and `/public-api/` and nothing else.

## 2. Backend layout (`backend/src`)

| Folder | Holds |
|---|---|
| `adms/` | Terminal protocol: routes for the four `/iclock` endpoints, parsers, command builders (validate-before-send), the command queue, record ingestion |
| `api/` | Operator REST API. Every route declares one access-grid cell (`requirePermission("people:view")`); grants are data, resolved by `services/access.ts` |
| `services/` | Lifecycle rules shared by API and jobs: entries/provisioning, punches → state, entry modes, employee access, reconciliation, backfill scan, alerts, attendance, licence, branding |
| `jobs/` | pg-boss scheduling: expiry sweep, daily reset, reconcile, retention, roster scan |
| `reports/` | One report registry; no route per report |
| `db/` | Prisma client wrapper, audit helper (`auditRow`, `AuditAction`) |
| `config/` | The only reader of `process.env`; zod-validated, fails loudly |
| `events/` | In-process pub/sub feeding SSE (single backend process by design) |

## 3. Core mechanisms

- **Command queue** (`adms/queue.ts`). Every device write is a `sync_command`
  row. `getrequest` claims the oldest `PENDING`/`RETRY` row for the device in
  one `UPDATE … FOR UPDATE SKIP LOCKED` round trip, ordered by `seq` (never
  `created_at` — rows in one transaction tie). `PUSH_PHOTO` reads the JPEG from
  disk at send time. Unanswered `SENT` rows retry after 5 min, failing after 5
  attempts. Idempotency keys make every enqueue safe to repeat.
- **Ack-driven state.** An entry becomes provisioned because the device
  acknowledged it (`services/entries.ts` → `onCommandResolved`), never because
  the server hoped so. Face counts move on acknowledgement.
- **Punch processing** (`services/punches.ts`). Fixed query shape per batch, no
  per-punch lookups. Direction from the terminal's role; status code
  corroborates.
- **Jobs** (`jobs/index.ts`, pg-boss on the same database, own schema
  `pgboss`). Today: expiry sweep (*/5 min), daily reset (*/15 min check),
  reconcile (hourly, 25 IDs per sweep), retention (03:30), roster scan tick
  (every minute). **Rebuild:** a one-minute gate-load engine tick replaces the
  daily reset and absorbs the expiry sweep (Phase 4).
- **Reconciliation** (`services/reconcile.ts`) — a security control: the
  terminal enforces no expiry, so a stale face opens the barrier silently.
- **Audit** — every state change writes `audit_log`; system actions have a null
  actor. `sync_command.initiated_by` attributes device writes to operators.
- **Licensing** — offline Ed25519 keys bound to the installation, 30-day trial,
  expiry blocks operator API (HTTP 402) but never ADMS or jobs
  (`legacy/LICENSING.md`).

## 4. Rebuild data model direction

Delivered phase by phase; see `PLAN.md` for the exact fields.

| New | Purpose | Phase |
|---|---|---|
| `Zone`, `Device.zoneId` | Site topology, access by zone (`services/zones.ts`, `api/zones.ts`) — **done** | 1 |
| typed settings over `app_config` | Every site toggle (`services/settings.ts`, `api/settings.ts`) — **done** | 2 |
| `Role`, `RolePermission`, `UserPermissionOverride` | Configurable access grid (`services/access.ts`, `api/access.ts`) — **done** | 2b |
| `PassType`, Person fields, `PersonDocument` | Per-type validation, documents | 3 |
| `Entry` extended into a pass, `PassGate` | Per-terminal load/unload schedule | 4 |
| `Message`, `Otp`, link tokens, `ConsentRecord` | Outbox, OTPs, portal | 5 |
| `VisitRequest`, `VisitRequestEvent` | Request workflow with full history | 6 |
| `Outage` | Outage detection and automatic release | 7 |

## 5. Database rules

- Swappable by connection string; pool sizes configurable; never assume a
  local database. No N+1 queries; no per-row loops in ingestion,
  reconciliation or jobs.
- Timestamps stored as UTC; `timestamp without time zone` columns compared with
  `(NOW() AT TIME ZONE 'UTC')` in raw SQL (bare `NOW()` lands in the session
  zone and breaks comparisons).
- Device user IDs compared case-insensitively via `UPPER(essl_user_id)`
  (functional unique index); stored in original casing.
- Photos and documents stay on local disk; only paths and metadata in the
  database.

## 6. Packaging traps (already paid for)

From `legacy/SESSION_HANDOFF_PHASE6.md`; each cost real debugging time.

- **PostgreSQL refuses to run elevated.** The `VmsPostgres` service runs as
  `NT AUTHORITY\NetworkService`, and nothing in the installer may start
  `postgres.exe` from the elevated installer process (`bundled-postgres.mjs
  print-url` exists for that reason).
- **PowerShell scripts must be plain ASCII.** Windows PowerShell 5.1 misreads
  BOM-less UTF-8; one em dash broke parsing.
- **Never `sc.exe delete` a running service.** It reports success but keeps the
  old binary path; the next install silently binds to the stale executable.
  `install-services.ps1` waits for a confirmed stop before deleting. Check with
  `sc.exe queryex` + the PID's real path, not `Get-Service`.
- **WinSW restart-on-failure is a native SCM recovery action** — killing a
  service process makes Windows restart it.
- **Rebuild the package after every backend change** (`npm run package`); a
  stale `dist-package/server.cjs` shows up as 404s on new routes.
- **Next.js bakes environment at build time.** 0.4.14 shipped with the dev
  backend URL compiled in; release staging now rejects any web payload
  containing `48102`.
- In PowerShell use `$env:VAR = "…"`, never `set VAR=…`.
- Increment `AppVersion` for every changed installer; never change `AppId`
  (`VERSIONS.md`).
- Browsers allow the webcam only on `localhost` or HTTPS; LAN operator PCs need
  `enable-webcam-on-operator-pc.ps1` (or Group Policy). The visitor portal
  avoids this by being served over HTTPS through the tunnel.

## 7. Verification

```bash
cd backend && npm run typecheck && npm test          # unit tests
DATABASE_URL=postgresql://…/vms_test npx tsx scripts/verify-e2e.ts   # simulated terminal, real app via app.inject
cd web && npm run lint && npm run build
```

`verify-e2e.ts` refuses any database whose name does not end in `_test`.

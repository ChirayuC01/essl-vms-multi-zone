# Phase 1 — Master DB, Registration, Manual Device Control

> **Historical record — do not read as current behaviour.** This documents what was decided and verified during this phase, at the time. Where it disagrees with `CLAUDE.md`, `docs/API_REFERENCE.md` or `docs/VERSIONS.md`, those are current and this is not. (Most likely divergence: device user IDs are **text** since 0.3.0, and the `VENDOR_PIN_START`/`VENDOR_PIN_END` range described here no longer exists.)


**Goal:** a working system where a vendor can be registered once, provisioned to the device, blocked, unblocked, and de-provisioned — all manually triggered from a UI, all against real hardware.

**Not in scope:** automated lifecycle, retention windows firing on their own, entry modes, reporting, RBAC. Those are Phases 2–4. Resist scope creep; the point of Phase 1 is a solid foundation with every device operation working end to end under manual control.

**Definition of done:** register a vendor with a photo → click Provision → they walk up and the barrier opens → click Block → they are denied → click Unblock → admitted → click De-provision → removed from the device but still present in the database.

---

## Progress — updated as milestones land (3 Aug 2026)

| Milestone | Status |
|---|---|
| 0 — Environment | ✅ **Done** |
| 1 — Data model | ✅ **Done** |
| 2 — ADMS device layer | ✅ **Done** (verified on real hardware — check-ins update `last_seen_at`, punches land in `punch_event`, `INFO` populates the device record, all surviving a restart) |
| 3 — Vendor registration | ✅ **Done** (verified end-to-end incl. real device photo auto-attach at registration) |
| 4 — Manual device operations | ✅ **Done** — verified on real hardware 3 Aug 2026: provision → barrier opens → block → denied → unblock → admitted → de-provision → gone from device but retained in DB → re-provision recognised with **no re-enrollment** |
| 5 — Basic UI | ✅ **Done** — full walkthrough passed in the browser 3 Aug 2026: login, live feed updating instantly, registration, and the whole barrier cycle driven from the UI |
| 6 — End-to-end verification | ✅ **Done** (4 Aug 2026) — 41/41 automated, full hardware cycle from a clean install including re-provision and the device unplug. Remote-Postgres check deferred by decision |

### Settled decision — photo storage stays on local disk (3 Aug 2026)

Raised as a durability worry (a dead disk, corruption, or an accidental delete loses the durable artifact, which means re-enrolling every vendor) and resolved after team discussion: **local disk remains the primary photo store.** `PHOTO_STORAGE_PATH` holds `photos/<pin>.jpg`; the DB holds only the path and metadata, per CLAUDE.md hard rules #4/#5.

The reasoning behind keeping it: S3/blob as the *primary* store puts the cloud in the provisioning read path — breaking the no-internet guarantee the product depends on — and makes the vendor of this software custodian of every client's biometric data, which is a DPDP and liability problem, not a technical one. The durability concern is real but is a **backup/redundancy** problem: scheduled backup of the photo directory alongside the database, a redundant volume or NAS, and optionally encrypted object storage as a **backup target only** (never the read path). That work belongs to Phase 6 (deployment/packaging), not here.

No `PhotoStore` abstraction was added. It would be a seam with exactly one implementation and no second one in prospect; the two places that touch photo files (`adms/ingest.ts` writing device pushes, `api/vendors.ts` serving and replacing them) are both small and obvious. If a client ever genuinely needs a different backend, introducing the interface then is a contained change — inventing it now would be speculative structure.

Decisions and environment facts a fresh session needs, beyond what the code shows:

- **PostgreSQL 17** installed as Windows service `postgresql-x64-17`; psql at `C:\Program Files\PostgreSQL\17\bin\psql.exe` (not on PATH). Database `vms`, app user `vms_app` (password in `backend/.env`, gitignored).
- `vms_app` is the **owner** of database `vms` rather than holding `GRANT ALL` — on PG 15+ `GRANT ALL ON DATABASE` no longer permits creating tables in schema `public`, and ownership keeps Prisma migrations working with least privilege. `vms_app` also has `CREATEDB`, needed only by `prisma migrate dev` for its shadow database (production uses `migrate deploy`, which doesn't need it).
- **Migrations applied:** `20260802161403_init` (full schema), `20260802162545_add_command_attribution` (`sync_command.initiated_by`), `20260802163628_add_wire_id_sequence`, `20260803153610_add_command_sequence` (`sync_command.seq`, the queue FIFO key).
- **Seed** (`backend/prisma/seed.ts`, idempotent): admin `admin@vms.local` / `admin` (dev only), and the test device `NCD8252500406` with groups 1/100, TZ +330, `Face VX3.9`. Password hashes use Node's built-in scrypt in the format `scrypt$<saltHex>$<hashHex>` — **the Milestone 5 auth layer verifies against this format** (`src/api/auth.ts`), so re-seeding is only needed if the format changes.
- Prisma is **6.19.3**; the deprecated `package.json#prisma` seed config warning is known and deliberately deferred to a future Prisma 7 upgrade. The Prisma client pool size comes from `DATABASE_POOL_SIZE` via `src/db/index.ts`, which appends `connection_limit` only when the connection string doesn't already set one.
- `web/` is a stock create-next-app scaffold (TS, Tailwind, App Router); its nested `.git` was removed so the repo root stays the git root. The repo is now version-controlled (`git init`, initial commit `bc21f1c`). Its `npm audit` highs are transitive pins inside Next itself — not actionable.
- Backend boot verification: `npx tsx src/index.ts` → `/health` returns `{"status":"ok","database":"reachable","postgres":"17.10"}`.

**Milestone 2 (ADMS device layer) — done, with decisions:**

- Modules: `src/adms/parsers.ts` (pure, 16 unit tests against real Phase 0 payloads — `npm test`), `commands.ts` (builders validate every field before a command string can exist; JPEG magic checked on photo push), `queue.ts` (DB-backed), `registry.ts` (device cache), `ingest.ts`, `routes.ts` (both `/iclock/x` and `/iclock/x.aspx` forms, GET+POST, raw-buffer bodies, 20 MB limit).
- **Hot path budget:** `getrequest` does exactly one DB round trip — a single `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` claim. Device lookup is cached (60 s TTL); `last_seen_at` writes are throttled to one per 20 s per device, fire-and-forget.
- **Wire command IDs** come from a Postgres sequence (`sync_command_wire_id_seq`, migration `20260802163628`), drawn fresh **per send attempt** so a late `devicecmd` reply to an earlier attempt can't mis-correlate. Sequence cycles at int4 max — uniqueness only matters across the in-flight window.
- **Timeout sweep:** in-process `setInterval` (60 s) marks SENT > 5 min as RETRY (< 5 attempts) or FAILED. Becomes a pg-boss job in Phase 3.
- `CLEAR_LOGS` deliberately throws — raw-protocol syntax not verified on this firmware (Phase 0 open item); the builder refuses to guess.
- Unknown serials are logged (throttled), tracked in memory for the M5 UI, **never auto-adopted**. Unknown `/iclock` paths are answered `OK` and logged loudly; non-iclock paths 404 normally.
- BIOPHOTO ingestion writes the JPEG to disk **before** looking for a matching vendor (an enrollment capture must never be lost to registration ordering); vendor match → `vendor_biometric` upsert + `PHOTO_UPDATED` audit row (source `DEVICE_PUSH`, actor null) in one transaction.
- `scripts/dev-enqueue.ts` — dev stand-in for the M4 UI: `npx tsx scripts/dev-enqueue.ts <serial> DEVICE_INFO|QUERY_USER|BLOCK|UNBLOCK|DEPROVISION [pin]`.
- **Verified by simulation** (before real hardware): idle poll → `OK`; enqueue → claim → `C:1:INFO` → `devicecmd` ack → SUCCESS + INFO applied to device row; ATTLOG punch ingested with correct +05:30 → UTC normalisation; identical replayed line deduped (1 row); BIOPHOTO saved to disk with unmatched-PIN warning. Simulated rows were deleted afterward.
- **Verified on real hardware:** device pointed at the backend on port 8080 — check-ins update `last_seen_at`, real punches land in `punch_event`, `INFO` populates the device record, and all of it survives a backend restart. Milestone 2 "Verify" step passed.

**Milestone 3 (vendor registration) — done, with decisions:**

- `src/api/vendors.ts` under `/api`: POST/GET(list+detail)/PATCH/DELETE `/vendors`, POST/GET `/vendors/:id/photo`. zod-validated bodies; 400/404/409 semantics; list is paginated (`page`, `pageSize` ≤ 100) with `q` search over name/company/mobile/PIN and `active` filter.
- **PIN allocation:** `VENDOR_PIN_START`/`VENDOR_PIN_END` env config (default 1–99999999 — the whole PIN space, since many clients already have vendors registered with low PINs on the device; narrow it per-site only when the terminal is also shared with employee attendance). Auto-allocated max+1 inside the range; the unique constraint arbitrates races with bounded retry. **Explicit `esslUserId` is allowed at create** — required by the device-first flow, where the PIN was already typed on the terminal at enrollment. Immutable after creation (no PATCH).
- **Attach-on-registration:** creating a vendor whose PIN already has a device-pushed photo on disk (`photos/<pin>.jpg`, saved by M2 even when unmatched) attaches it in the same transaction, with a `PHOTO_UPDATED` audit row (`source: DEVICE_PUSH, attachedAtRegistration: true`). Verified with the real 44,346-byte device photo for PIN 9001.
- **Photo upload is a raw `image/jpeg` body**, not multipart — dependency-free, trivially scriptable; the M5 UI sends the file blob directly. Validation: JPEG magic, ≤ 5 MB, dimensions 100–5000 px per side via a built-in SOF parser (`src/api/jpeg.ts`, unit-tested). Upload replaces the file at the canonical `photos/<pin>.jpg` path and **nulls any cached face template** (it no longer matches the new photo).
- **Soft delete only**, and refused (409) while the vendor has an active entry (`PENDING_PROVISION`/`PROVISIONED`/`INSIDE`/`PENDING_DEPROVISION`) — deactivation must never strand a live credential on the barrier.
- Audit actions written: `VENDOR_CREATED`, `VENDOR_UPDATED`, `VENDOR_DEACTIVATED`, `PHOTO_UPDATED` (with source `DEVICE_PUSH`/`UI_UPLOAD`). `actor_id` is null until the auth layer (M5/Phase 4) — helpers in `src/api/audit.ts`.
- The raw-buffer content-type parser moved from the ADMS plugin scope to the root instance (`index.ts`) — Fastify parsers are scope-bound and the photo upload needs raw bodies too. `application/json` still uses the built-in parser.
- **Real-hardware finding (3 Aug 2026):** a fresh on-device enrollment auto-pushes only the USER record + BIODATA template, **not** the BIOPHOTO (see `VMS_PROJECT_CONTEXT.md` §4.6 — an earlier guess that the photo came via `fdata` was wrong; it simply isn't auto-sent). Two changes came out of it:
  1. `ingest.ts` now line-dispatches known record types (`BIOPHOTO`/`BIODATA`/`USER`) from **every** endpoint and table rather than only `table=OPERLOG` (ATTLOG keeps its dedicated batch path). Robustness — so a photo arriving via any envelope is always saved.
  2. **Auto-pull:** when a USER record names a PIN with no photo on disk, the backend auto-enqueues `QUERY_USER` to pull the photo (idempotency bucketed ~10 min). This makes device-first registration hands-free as the plan's §3.2 assumed. Verified end-to-end on the real device: enroll → USER record → auto `QUERY_USER` → `photos/<pin>.jpg` saved. Manual recovery if ever needed: `dev-enqueue.ts <serial> QUERY_USER <pin>`.

**Milestone 4 (manual device operations) — done, with decisions:**

- **New layer: `src/services/`.** The lifecycle rules live in `services/entries.ts`, not in route handlers, because Phase 2's expiry sweeper and daily-reset job must obey exactly the same ones. Services throw `ServiceError(statusCode, message)` (`services/errors.ts`); a Fastify error handler at the root translates them. `src/api/audit.ts` moved to `src/db/audit.ts` so services and jobs can write audit rows without importing upward from the API layer.
- **Queue ordering bug found and fixed before it could bite.** The claim used `ORDER BY created_at`, but `created_at` is `CURRENT_TIMESTAMP`, which Postgres holds constant for a whole transaction — the `PROVISION` and `PUSH_PHOTO` rows written together tie, and the photo could be dispatched before the user it attaches to exists. `sync_command` now has a `seq SERIAL` column (migration `20260803153610_add_command_sequence`) and the claim orders by it. FIFO is now insertion order, not clock resolution.
- **Device acknowledgements drive every state change.** `onCommandResolved()` is called from the `devicecmd` handler; an entry becomes `PROVISIONED` because the device said so, never because the server hoped so. Requesting a block does *not* set `day_blocked` — the acknowledgement does, and the gap between the two is visible in the command queue. Every transition is a guarded conditional update (`updateMany` filtered on the expected state), so a replayed or duplicated ack cannot apply twice.
- **`faces_used` accounting:** +1 when an entry reaches `PROVISIONED`, −1 when a de-provision completes — but only if that entry was actually counted. Cancelling a still-`PENDING_PROVISION` entry carries `countedOnDevice: false` on the `DEPROVISION` payload so it cannot decrement a count it never incremented. The decrement is floored at zero, and `DEVICE_INFO` remains the authority (`FaceCount` overwrites it).
- **Validation happens at request time, not send time** (hard rule #10). Provisioning runs `buildCreateUser` and reads the photo's magic bytes off disk *before* writing anything, so an over-long name or a missing/corrupt JPEG is a 400/409 the operator sees immediately rather than a `FAILED` command discovered minutes later.
- **Rules enforced in the service layer:** never de-provision an `INSIDE` vendor (409, deferred to their OUT punch); one active entry per vendor; no provisioning a deactivated vendor, a vendor with no photo, or onto a device at face capacity; block/unblock only for a vendor actually loaded on a device, refused when one is already in flight or when it would be a no-op.
- **Retention windows are computed and stored but not enforced** — `resolveRetentionExpiry` (unit-tested) fills `retention_expires_at` so the history is right when the Phase 2 sweeper arrives. There is no device-native expiry and no sweeper yet; nothing closes a window today. `entry_mode` is likewise stored and inert until Phase 2.
- **Device targeting is derived, not stored.** The device an entry lives on comes from its `PROVISION` command rather than an `entry.device_id` column, because Phase 2 will provision one entry to several devices (an IN terminal and an OUT terminal) and a single column would have to be undone to get there. Phase 1 provisions to one device; `deviceId` may be omitted only while exactly one device is registered.
- **API added** (all under `/api`): `POST /vendors/:id/provision` and `/vendors/:id/query-device`; `GET /entries`, `GET /entries/:id`, `POST /entries/:id/{block,unblock,deprovision}`; `GET /commands`, `GET /commands/:id`, `POST /commands/:id/retry`; `GET /devices`, `POST /devices/:id/refresh`. Device-facing operations answer **202** with the queued command — the server never contacts the device, so a synchronous-looking response would be a lie the protocol cannot honour.
- **Retry is FAILED-only.** A `PENDING` command is already queued and a `SENT` one would race the reply still on its way. Requeueing resets `attempts` and clears the stale wire id, so a fresh one is drawn at claim.
- `GET /devices` reports `online` **derived from `last_seen_at`** (quiet for >150 s) rather than the stored `online` flag — nothing can set that flag false, because a device going quiet produces no request. Queue depth per device comes from one `groupBy`, never a count per device.
- **A Fastify ordering trap, worth remembering:** `setErrorHandler` must be called *before* `app.register(...)`. A plugin inherits whatever handler its parent had at registration time, so setting it afterwards silently leaves every route on Fastify's default handler — the symptom was every service message arriving as a bare `"Conflict"`.
- **Verified on real hardware (3 Aug 2026):** the full definition-of-done cycle passed on the terminal — provision, barrier opens, block, denial, unblock, de-provision, and re-provision with no re-enrollment. Milestone 4 is closed.
- **A bug the simulation could not have caught,** found while capturing API examples: the queue claim wrote `sent_at` with bare `NOW()`. That column is `timestamp without time zone`, which Prisma reads as UTC, but `NOW()` is a `timestamptz` that Postgres converts to the *session* zone on assignment — so on any server east of UTC every `sent_at` landed in the future. `sweepTimeouts` compares against a JS UTC cutoff, so it could **never fire**: a command stranded by a device going offline would sit in `SENT` forever, never retried, never failed. Now written as `NOW() AT TIME ZONE 'UTC'`, and the sweep is confirmed to move a stranded command to `RETRY`. Historical rows written before the fix still carry skewed `sent_at` values; they are all completed dev data and were left alone rather than migrated with a hardcoded offset.
- **Verified by simulation first** (fake device `SIMM4TEST`, driven over real HTTP, all rows removed afterwards): provision → poll 1 returns `DATA UPDATE USERINFO … Grp=1`, entry stays `PENDING_PROVISION` after that ack alone → poll 2 returns `DATA UPDATE BIOPHOTO … Size=59128` (base64 char count for a 44,346-byte JPEG) → both acked → `PROVISIONED`, `faces_used=1`. Block → `Grp=100`, `day_blocked` only after the ack; re-block → 409. Unblock → `Grp=1`. De-provision refused while `INSIDE`; allowed from `PROVISIONED` → `DATA DELETE USERINFO` → `REGISTERED`, `faces_used=0`, **vendor and photo retained**. Re-provision from the stored photo with no re-enrollment. `Return=1` → `FAILED` with `last_error`, retry re-dispatches and succeeds. Guard rails returned their intended 400/409s.

**Milestone 5 (basic UI) — done, with decisions:**

- **Auth landed here, as the plan allowed.** `POST /api/auth/login` issues a 12 h JWT (`@fastify/jwt`), verified against the seeded `scrypt$<salt>$<hash>` format with a constant-time compare. Every `/api/*` route is now guarded; `/health`, the login route and **all `/iclock/*` device endpoints are not** — a terminal cannot present a token, and gating it would take the barrier down (CLAUDE.md #9). Wrong password and unknown email return the identical 401, so the API cannot be used to enumerate operator accounts. This is one login with a role on the token, **not** RBAC: per-action permissions, user management and password reset stay in Phase 4.
- **The audit trail now has a real actor.** `audit_log.actor_id` and `sync_command.initiated_by` are populated from the token on every mutation, closing the "null until the auth layer" note carried since Milestone 3. A null in those columns now means genuinely system-initiated, not "unknown".
- **Live updates: SSE over an in-process event bus** (`src/events/bus.ts`, `src/api/events.ts`), carrying `punch`, `command` and `entry` frames plus a 25 s heartbeat. Chosen over WebSockets because the traffic is one-directional, it survives proxies as plain HTTP, and the browser reconnects by itself. Entry frames are published **after** the transaction commits and re-read from the database, so the feed can never describe a change that rolled back. The bus is deliberately in-memory: with two backend processes a client connected to one would miss events raised on the other — written down rather than left to be discovered, and revisited only if the service is ever scaled out.
- `punch_event` ingestion moved to `createManyAndReturn` so only genuinely new rows are broadcast; a `Stamp` replay is still deduped and cannot repeat itself on the feed. Vendor names for a batch are resolved in one query, never one per punch.
- **The token reaches the browser, so it lives in `localStorage`,** not an httpOnly cookie: `EventSource` cannot set an `Authorization` header, and the photo `<img>` is a cross-origin GET. Both accept `?token=` — the SSE stream and the guarded API share one `requireAuth` that falls back to the query parameter. Acceptable for a LAN tool with no cross-site surface; revisit if the console is ever exposed publicly.
- **CORS is configuration** (`CORS_ORIGINS`, comma-separated). Empty reflects any origin, which is acceptable only on an isolated LAN and should be set explicitly by the Phase 6 installer. Verified: the configured origin gets `Access-Control-Allow-Origin`, a foreign origin gets none.
- **Theming is CSS variables and nothing else** (`web/src/app/globals.css`): every colour and radius is a variable, no component hardcodes one, and both light and dark schemes are defined. Phase 6 per-client branding becomes an override of those variables rather than a refactor. Fonts are the system stack — an on-premise install may have no internet, so fetching a webfont would fail exactly where it matters.
- **SWR for data fetching, not `useEffect` + `useState`.** The token lives in the browser, so server components cannot fetch this data; fetching in an effect trips React 19's `set-state-in-effect` rule for real reasons (cascading renders). The bundled Next 16 docs name SWR as the sanctioned client-side option. Actions and live events call `refresh(prefix)`, which revalidates every cached query under a path prefix — a provision touches the vendor, its entries, the command queue and the device's face count at once.
- **Read `web/AGENTS.md` before touching this app.** Next 16 differs from older releases in ways that matter: Turbopack is the default (no `--turbopack` flag), `params`/`searchParams` are async in server components, `middleware` is now `proxy`, and `next lint` is gone in favour of the ESLint CLI. The bundled reference is in `web/node_modules/next/dist/docs/`.
- **Pages:** login; dashboard (device cards + live punch feed); vendor list with search and provisioning status; register vendor (covers both office-first upload and device-first PIN); vendor detail (photo, provision/block/unblock/de-provision/query buttons, command history, authorization history); command queue with retry; device status with `INFO` refresh. No screens that Phases 2–4 will own.
- The UI states plainly where behaviour is not yet real — the retention window is labelled "not enforced yet", and the queue view spells out that `SUCCESS` means *processed*, not *correct*.
- **A CORS bug the curl tests could not catch.** The SSE handler wrote its head with `reply.raw.writeHead()`, which bypasses the Fastify reply — and `@fastify/cors` sets `Access-Control-Allow-Origin` *on the reply*, flushed only by `reply.send()`. So the stream carried no CORS header, and a browser silently refuses a cross-origin `EventSource` without one. `curl` has no same-origin policy, so every command-line test passed while the real browser feed never connected: the dot stayed red and punches only appeared when SWR happened to revalidate. Fixed by `reply.hijack()` plus carrying `reply.getHeaders()` into `writeHead`. **Lesson: test a browser-facing stream with an `Origin` header, or test it in a browser.**
- **Measured, not assumed:** the device pushes a punch to the backend in **0.1–1.2 s** (comparing `punched_at_utc` against `created_at` over real punches). The ~30 s lag reported from the UI was entirely the dead stream, not the hardware or the ~30 s idle poll.
- **The feed degrades rather than lies.** While the stream is disconnected the punch and command views fall back to polling (10 s / 5 s) and stop the moment it reconnects. A live feed that quietly stops updating is worse than a slow one.
- **Verified in the browser (3 Aug 2026):** the full walkthrough passed — login, dashboard with the feed showing **live** and punches appearing instantly, vendor registration, and the entire provision → block → unblock → de-provision → re-provision cycle driven from the UI against the real terminal. Milestone 5 is closed.

### How a vendor actually gets registered — the two routes, and which to use

Worth stating plainly because the device-first route is less work than it looks, and it is the one that applies when the office has no photo of the person:

**Device-first (no photo in hand — the common case).** Two steps of human work:
1. Enroll on the terminal: the admin types a PIN and captures the face.
2. In the UI, register the vendor **entering that same PIN**. The photo attaches automatically.

Between those two steps the backend does the rest unprompted: the device pushes a USER record (but *not* the photo — see `VMS_PROJECT_CONTEXT.md` §4.6), the backend notices a PIN it has no photo for and auto-queues `QUERY_USER`, and the returned BIOPHOTO is written to `photos/<pin>.jpg`. Registration then finds that file and attaches it in the same transaction, writing a `PHOTO_UPDATED` audit row with `attachedAtRegistration: true`.

**There is no manual upload in this route, and the photo never passes through the admin's PC.** It is written wherever the *backend* runs — today a dev laptop, in production the server. That is the directory backups must cover.

**Upload route.** Only for when no terminal is at hand: a photo from HR now, webcam capture later. It is the fallback, not the default.

**Unclaimed enrollments — built 3 Aug 2026.** The gap this closes: a photo the device pushed for an unregistered PIN used to be invisible, claimable only by someone remembering the PIN they typed on the terminal.

- `GET /api/enrollments/unclaimed` lists every `photos/<pin>.jpg` with no matching vendor — one `readdir` plus one batched `IN` query, never a lookup per file. `GET /api/enrollments/unclaimed/:pin/photo` serves the thumbnail.
- **Path traversal is closed at the type boundary:** the PIN is matched against `^\d{1,9}$`, parsed to a number, and the filename rebuilt *from the number*. Caller input never reaches the filesystem. Verified — `../../../../etc/passwd`, URL-encoded variants, `9001abc` and `-1` are all refused.
- The panel appears on both the dashboard and the vendor list (only when non-empty), showing thumbnail, PIN, and how long it has been waiting. **Register** goes to `/vendors/new?pin=<pin>`, which pre-fills the PIN, shows the photo that will be attached, and hides the upload field — because in this route uploading is exactly the wrong thing to do.

### Clean-slate reset — `backend/scripts/reset-testbed.ts`

Development-only, guarded behind `--confirm`. Returns the system to a fresh install: keeps `app_user` and `device`, removes everything else.

**Order is the whole point.** It queues `DATA DELETE USERINFO` for every PIN the VMS has ever associated with the device, **waits for the terminal to confirm each one**, and only then clears the database. Clearing first would destroy the very commands that clean the device, leaving a terminal full of users the VMS no longer remembers — the "two masters" failure the design exists to prevent. If the device is offline, or any deletion is unconfirmed within the timeout, it aborts *without touching the database* rather than letting the two disagree.

It finishes by re-reading `FaceCount` from the device's own `INFO` rather than trusting arithmetic, and says so if the device still holds users the VMS never knew about (those need `Menu > Data Mgt. > Delete All Users` on the terminal).

**Run 3 Aug 2026:** 7 PINs removed and confirmed, 107 rows and 6 photos deleted, device reported `facesUsed=0`. The testbed is now a clean install with only the admin login and the adopted device.

---

## Milestone 0 — Environment

### 0.1 PostgreSQL

Not yet installed. On Windows:

1. Download the installer from postgresql.org (v16 or v17)
2. Run it; note the superuser password
3. Accept the default port 5432
4. Skip Stack Builder

Then create the database:

```bash
psql -U postgres
CREATE DATABASE vms;
CREATE USER vms_app WITH PASSWORD 'devpassword';
GRANT ALL PRIVILEGES ON DATABASE vms TO vms_app;
\q
```

Use a least-privilege application user from the start rather than connecting as superuser — it is a Phase 6 requirement and free to do now.

### 0.2 Repo scaffold

```
vms/
  backend/
    src/
      adms/
      api/
      jobs/
      db/
      config/
      index.ts
    prisma/
      schema.prisma
    package.json
    tsconfig.json
    .env.example
  web/
  docs/
    CLAUDE.md  (at repo root, not in docs)
    VMS_PRD_Technical_Plan.md
    VMS_PROJECT_CONTEXT.md
    PHASE_0_CHECKLIST.md
    PHASE_1_PLAN.md
  .gitignore
```

Also copy the Phase 0 test server into `docs/reference/adms-test-server/` — it is a working reference implementation of the protocol and worth keeping alongside the code.

### 0.3 Config system

Everything client-specific must be configuration from the first commit. Two layers:

**Environment** (`.env`, machine-level, set by the installer later):
```
DATABASE_URL=postgresql://vms_app:devpassword@localhost:5432/vms
PORT=8080
ADMS_PORT=8080
PHOTO_STORAGE_PATH=./data/photos
JWT_SECRET=...
LOG_LEVEL=debug
```

#### Requirement: the database must be swappable without code changes

Default deployment is bundled local PostgreSQL on the client's machine. But a client may want to supply their own database — their existing Postgres server, or a managed cloud provider (Neon, RDS, Supabase). **Changing `DATABASE_URL` must be the only thing required.**

This is nearly free with Prisma, but four things must be respected or a remote database will fail in ways that are hard to diagnose:

**1. No assumption of low latency.** Local Postgres answers in under a millisecond; a remote one may take 50–200 ms. Anything that issues N queries in a loop will be unusable. Batch reads, avoid per-row queries in ingestion and reconciliation, and keep the ADMS request path to a small fixed number of queries. **The `getrequest` handler is the hot path** — it fires every 1–3 s per device and must claim a command in a single round trip.

**2. Connection pooling and SSL.** Managed providers require TLS and often impose low connection limits or need a pooled endpoint. Make pool size configurable (`DATABASE_POOL_SIZE`), never hardcode `sslmode`, and pass the connection string through untouched so provider-specific parameters survive.

**3. Photos stay on local disk regardless.** `vendor_biometric.photo_path` points at the local filesystem. Pushing ~44 KB JPEGs through a remote database on every provision would be slow and expensive, and photos are biometric data under the DPDP Act — keeping them on-premise is the simpler compliance position. A remote database therefore holds metadata and history; photos remain local. **Document this: with a remote database, backups must cover both the database and the photo directory.**

**4. The backend still runs on the LAN.** The device POSTs to a configured IP on the local network and cannot reach a cloud host. A remote database changes where *data* lives, never where the *service* runs. Barrier operation already survives a VMS outage (the device matches faces locally), but a client choosing a remote database accepts that new authorizations and de-provisioning pause during an internet outage. **Say this explicitly in the deployment documentation** — it is a real operational tradeoff, not a detail.

**5. Job scheduling.** pg-boss polls Postgres. Verify its polling interval is sane against a remote database, and make it configurable.

Verify by testing against a free Neon instance before Phase 1 closes — a five-minute check that proves the seam is real rather than assumed.

**Application config** (`app_config` table, written by the setup wizard in Phase 6, editable by an admin):
branding (logo, colours, product name), defaults (retention, entry mode, day-reset time), device list, license state.

Validate config at startup with zod and fail loudly on anything missing. Never read `process.env` outside `src/config/`.

### 0.4 Verify

Backend starts, connects to Postgres, logs its resolved config (secrets redacted).

---

## Milestone 1 — Data model

Prisma schema per PRD §8, **with the Phase 0 corrections applied**. Getting this right matters more than getting it fast; everything downstream depends on it.

### Models

**`vendor`** — permanent identity, never deleted (soft `is_active` only)
`id`, `name`, `company`, `mobile`, `essl_user_id` (the device PIN), `is_active`, `created_at`, `updated_at`

**`vendor_biometric`**
`vendor_id`, `photo_path` (file on disk; keep the DB lean), `photo_size_bytes`, `face_template` (nullable — same-device cache only), `algorithm_version` (e.g. `Face VX3.9`), `biometric_type` (9 = face), `captured_at`

**`entry`** — one authorization cycle
`vendor_id`, `state` (enum), `expected_in_at`, `in_at`, `out_at`, `retention_policy` (enum), `retention_expires_at`, `entry_mode` (enum), `day_blocked` (bool), `authorized_by`, `created_at`

**`device`**
`id`, `name`, `serial_no`, `ip`, `role` (`IN` / `OUT` / `BOTH`), `timezone_offset_minutes`, `max_faces`, `faces_used`, `normal_group_id` (default 1), `blocked_group_id` (default 100), `firmware_version`, `algorithm_version`, `last_seen_at`, `online`, `last_stamp`, `last_op_stamp`

> `max_faces`, `faces_used`, `serial_no`, `firmware_version` are all populated from the device's `INFO` response — never hardcoded, never typed from a label. Three spec-sheet claims have already proven wrong.
>
> `normal_group_id` / `blocked_group_id` are configuration because group numbering may vary across devices and firmware.

**`sync_command`** — the device command queue
`id`, `entry_id` (nullable), `vendor_id` (nullable), `type` (enum: `PROVISION`, `PUSH_PHOTO`, `DEPROVISION`, `BLOCK`, `UNBLOCK`, `QUERY_USER`, `DEVICE_INFO`, `CLEAR_LOGS`), `target_device_id`, `status` (`PENDING` / `SENT` / `SUCCESS` / `FAILED` / `RETRY`), `device_cmd_id` (the numeric ID sent as `C:<id>:`), `initiated_by` (nullable FK to `app_user` — the operator who triggered this command; `null` = system-initiated, e.g. the expiry sweeper or daily reset job), `attempts`, `last_error`, `payload` (JSONB), `idempotency_key`, `created_at`, `sent_at`, `completed_at`

> The protocol supplies a correlation ID and a return code natively — `device_cmd_id` and `status` map straight onto it. No tracking mechanism needs inventing. `initiated_by` gives command-level attribution directly on the row — every device write is traceable to the operator or job that caused it, without parsing `audit_log` JSON.

**`punch_event`**
`essl_user_id`, `device_id`, `punched_at_device` (as reported, device-local), `punched_at_utc` (normalised), `status_code` (ATTLOG field 3), `verify_mode` (15 = face), `work_code`, `raw_line` (keep the original for debugging), `raw_record_hash` (dedup), `processed`, `entry_id` (nullable)

> Store both timestamps. The device reports local time; normalising on ingest while keeping the original makes timezone bugs debuggable instead of mysterious.

**`audit_log`** — every authorization, revocation, block/unblock, push, delete, login, config change
`actor_id`, `action`, `entity_type`, `entity_id`, `detail` (JSONB), `created_at`

> **Photo updates are a required audit action, not optional.** Every time `vendor_biometric.photo_path` changes — device auto-push on enrollment (§2.5 BIOPHOTO ingestion) or manual UI upload (§3.2) — write a row with `action = PHOTO_UPDATED`, `entity_type = vendor_biometric`, `entity_id = vendor_id`, `detail = { source: 'DEVICE_PUSH' | 'UI_UPLOAD', deviceId?, photoSizeBytes }`, `actor_id` = the operator for a UI upload or `null` for a device-initiated push. This is deliberately timestamps-only: the current photo is the only one kept on disk, no photo history table. Querying `audit_log` by `entity_type = vendor_biometric AND action = PHOTO_UPDATED` for a vendor gives the full timeline of when their photo changed and by what path.

**`app_user`** — `email`, `password_hash`, `role` (`ADMIN` / `AUTHORIZED_PERSON`), `is_active`

**`app_config`** — `key`, `value` (JSONB), `updated_at`, `updated_by`

**`admission_queue`** — dormant safety valve per PRD §7; alert if ever non-empty

### Enums

```
EntryState:      REGISTERED, PENDING_PROVISION, PROVISIONED, INSIDE, PENDING_DEPROVISION
RetentionPolicy: ONE_DAY, ONE_WEEK, ONE_MONTH, QUARTERLY, CUSTOM
EntryMode:       SINGLE_ENTRY, MULTI_ENTRY
CommandStatus:   PENDING, SENT, SUCCESS, FAILED, RETRY
CommandType:     PROVISION, PUSH_PHOTO, DEPROVISION, BLOCK, UNBLOCK, QUERY_USER, DEVICE_INFO, CLEAR_LOGS
UserRole:        ADMIN, AUTHORIZED_PERSON
DeviceRole:      IN, OUT, BOTH
```

### Notes

- Index `punch_event.raw_record_hash` (unique, for dedup), `sync_command.status`, `entry.state`, `vendor.essl_user_id`
- Photos on disk under `PHOTO_STORAGE_PATH`, path in the DB. Simpler backups, lighter database. Encryption at rest is a Phase 6 concern but leave the seam.
- **PIN allocation strategy:** `essl_user_id` must be unique on the device and must not collide with any employee IDs if the client uses the same terminals for staff. Reserve a range (e.g. vendors start at 10000) and make the range configurable.

### Verify

`npx prisma migrate dev`, then `npx prisma studio` and confirm the shape. Write a seed script creating one admin user and one device record.

> **Status:** the initial schema is migrated and seeded (migration `20260802161403_init`). `sync_command.initiated_by` has since been added (migration `20260802162545_add_command_attribution`) — nullable, indexed, FK to `app_user` with `ON DELETE SET NULL`. The `PHOTO_UPDATED` audit action needs no schema change (it's a row shape in the existing `audit_log` table) — it becomes real once Milestone 2's BIOPHOTO ingestion (§2.5) and Milestone 3's photo upload (§3.2) are implemented and write it.

---

## Milestone 2 — ADMS device layer

The most important milestone. Promote the Phase 0 test server into production-shaped code. Much of the logic exists and is proven — the work is structure, persistence and error handling, not discovery.

### 2.1 Endpoints

`src/adms/routes.ts` — register all four endpoints in **both** plain and `.aspx` forms:

```
/iclock/cdata      /iclock/cdata.aspx
/iclock/getrequest /iclock/getrequest.aspx
/iclock/devicecmd  /iclock/devicecmd.aspx
/iclock/fdata      /iclock/fdata.aspx
```

Raw-buffer content-type parser (the device sends unusual or absent content types). Catch-all logging for unknown paths — never silently 404 a device request.

### 2.2 Record parsers

`src/adms/parsers.ts` — pure functions, straightforward to unit test:

- `parseAttlog(line)` → `{ pin, timestamp, statusCode, verifyMode, workCode }`
- `parseUserRecord(line)` → `{ pin, name, pri, grp, tz, verify, startDatetime, endDatetime }`
- `parseBiophoto(line)` → `{ pin, fileName, type, size, contentBase64 }`
- `parseBiodata(line)` → `{ pin, type, majorVer, minorVer, template }`
- `parseDeviceInfo(body)` → key/value map from the `INFO` response

Write unit tests using the real captured payloads in `VMS_PROJECT_CONTEXT.md` §4.5 as fixtures. Cheap, and it locks in the formats that took a day to establish.

### 2.3 Command builders

`src/adms/commands.ts` — one function per command, TAB-joining fields:

```ts
buildCreateUser({ pin, name, pri, grp })
buildPushPhoto({ pin, jpegBuffer })     // Size = base64 char count, not byte count
buildDeleteUser({ pin })
buildSetGroup({ pin, grp })             // block = blockedGroupId, unblock = normalGroupId
buildQueryUser({ pin })
buildDeviceInfo()
```

**Validate every field before building.** The device accepted the literal string `EndDatetime=<value>` with `Return=0` — it will not protect you from nonsense.

### 2.4 Command queue

`src/adms/queue.ts` — DB-backed (`sync_command`), not in-memory:

- `enqueue(type, deviceId, payload, idempotencyKey)` → creates a `PENDING` row
- On `getrequest`: claim the oldest `PENDING` for that device in a transaction, mark `SENT`, record `device_cmd_id`, return `C:<id>:<command>`
- On `devicecmd`: parse `ID=&Return=`, mark `SUCCESS` or `FAILED`, record `last_error`
- Timeout sweep: `SENT` rows with no response after N minutes → `RETRY` with backoff; N failures → `FAILED` plus an alert
- Idempotency: re-enqueuing the same key while one is in flight is a no-op

Claim commands with `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent polls (once there are two devices) can't hand out the same command twice.

### 2.5 Ingestion

`src/adms/ingest.ts`:

- **ATTLOG** → `punch_event` rows, deduped on `raw_record_hash`, both timestamps stored, `processed=false` (Phase 2 consumes these)
- **BIOPHOTO** → write JPEG to `PHOTO_STORAGE_PATH`, upsert `vendor_biometric`
- **BIODATA** → store template as a cache, record `algorithm_version`
- **USER** → reconcile against expected state, log drift
- **INFO** → update the `device` record: `max_faces`, `faces_used`, `firmware_version`, `algorithm_version`, `last_seen_at`, `online`

Track `Stamp` / `OpStamp` on the device record. Mishandling these risks replayed or dropped punches.

### 2.6 Device registry

An unknown serial checking in should be logged and visible in the UI as an unregistered device rather than silently accepted. In Phase 6 the setup wizard adopts devices explicitly; for now, allow manual adoption from the UI.

### Verify

Point the real device at the backend. Confirm check-ins update `last_seen_at`, punches land in `punch_event`, and `INFO` populates the device record — all persisted, surviving a restart.

---

## Milestone 3 — Vendor registration

### 3.1 API

```
POST   /api/vendors              create (name, company, mobile)
GET    /api/vendors              list, paginated, searchable
GET    /api/vendors/:id          detail with biometric + entry history
PATCH  /api/vendors/:id          update details
POST   /api/vendors/:id/photo    upload/replace enrollment photo
GET    /api/vendors/:id/photo    serve the photo
DELETE /api/vendors/:id          soft delete (is_active=false) — NEVER hard delete
```

### 3.2 Photo acquisition

Two routes, both needed:

**Device-first (proven in Phase 0):** enroll the vendor on the terminal, the device auto-pushes the photo, ingestion stores it. Good for first registration at a manned gate.

**Upload:** accept a JPEG from the UI (file picker now; webcam capture later). Necessary when no device is at hand, and it is also the fallback if a client's registration desk is nowhere near a terminal.

Validate on upload: JPEG, reasonable dimensions, under a size cap. Reference: device-produced photos are ~44 KB. Photo quality determines template quality — a bad photo means unreliable recognition later, so reject obviously poor input early.

### 3.3 PIN allocation

Assign `essl_user_id` at registration from the configured reserved range. Must be unique and stable — it is the join key between the database and the device forever.

### Verify

Register a vendor, attach a photo, see it in the list and detail views, and confirm the photo file lands on disk with the DB path correct.

---

## Milestone 4 — Manual device operations

Wire the UI to the command queue. Every operation is asynchronous — enqueue, then reflect status as it changes.

### 4.1 Provision
1. Create `entry` in `PENDING_PROVISION`
2. Enqueue `PROVISION` (`DATA UPDATE USERINFO` with `Grp = normal_group_id`)
3. Enqueue `PUSH_PHOTO` (`DATA UPDATE BIOPHOTO`)
4. On both succeeding → `PROVISIONED`, increment `faces_used`
5. On failure → surface the error, leave the entry in `PENDING_PROVISION`

Order matters: the user must exist before the photo can attach to it.

### 4.2 Block / Unblock
Enqueue `SetGroup` with `blocked_group_id` / `normal_group_id`. Set `entry.day_blocked` accordingly. Biometric is untouched — this is a pure authorization change.

### 4.3 De-provision
1. `entry` → `PENDING_DEPROVISION`
2. Enqueue `DEPROVISION` (`DATA DELETE USERINFO`)
3. On success → `REGISTERED`, decrement `faces_used`
4. **Never de-provision a vendor whose entry state is `INSIDE`** — enforce in the service layer, not just the UI

### 4.4 Query / refresh
Enqueue `QUERY_USER` to pull the device's view of a vendor. Useful for debugging and the seed of Phase 3's reconciliation.

### 4.5 Command visibility
Expose queue state in the API and UI: pending, in flight, failed, with error text and a retry action. This is the primary debugging surface for the whole product — build it properly rather than as an afterthought.

### Verify

The full definition-of-done cycle against real hardware. ✅ **Passed 3 Aug 2026** — every step 1–6 behaved as specified on the terminal: provision → barrier opens; block → denied; unblock → admitted; de-provision → gone from the device while the vendor, photo and history stayed in the database; re-provision → recognised again with **no re-enrollment**. That last step is the product's founding premise, now demonstrated on hardware rather than argued. Milestone 6 re-runs the cycle under stress (restarts, disconnects, a remote database).

---

## Milestone 5 — Basic UI

Functional, not polished. Theming via CSS variables from config, so Phase 6 branding is a config change and not a refactor.

- **Vendor list** — search, status, provisioned/not
- **Vendor detail** — details, photo, entry history, action buttons
- **Register vendor** — form plus photo upload
- **Device status** — online, last seen, faces used/capacity, firmware, serial
- **Command queue** — recent commands with status and errors
- **Live punch feed** — SSE, useful for testing and the seed of the Phase 2 dashboard

Auth can be a single hardcoded admin login for now; full RBAC is Phase 4. Do not build screens Phase 2–4 will own.

---

## Milestone 6 — End-to-end verification

Split deliberately into what a machine can prove and what only the hardware can.

### Automated — `npm run verify:e2e` (41 checks, all passing 3 Aug 2026)

`backend/scripts/verify-e2e.ts` drives the **real application** through `app.inject()` — the same routes, hooks and error handling that run in production, not a parallel test path — against a simulated terminal. `src/app.ts` was extracted from `index.ts` to make that possible; `index.ts` is now just startup.

It **refuses to run unless the database name ends in `_test`**. It creates and destroys data freely, and a mis-set `DATABASE_URL` must never be able to reach a real installation.

```bash
psql -U postgres -c 'CREATE DATABASE vms_test OWNER vms_app'
DATABASE_URL=postgresql://vms_app:...@localhost:5432/vms_test npx prisma migrate deploy
DATABASE_URL=... DATABASE_LOG_QUERIES=true npm run verify:e2e
```

What it proves: provision ordering (user before photo) and that an entry stays `PENDING_PROVISION` until *both* halves are acknowledged · `faces_used` up and back down · punch timestamps kept device-local **and** normalised through the +05:30 offset · replayed punches deduplicated · block/unblock as a group swap that only takes effect on device confirmation · `INSIDE` refusing de-provision · **the application torn down and rebuilt mid-cycle with the queued command still delivered** · commands queueing while the device is away and flushing oldest-first · the timeout sweep retrying a stranded command · re-provision from stored data alone · photos on disk with only a path in the database.

**The hot-path query budget is now asserted, not assumed.** With `DATABASE_LOG_QUERIES=true` the harness counts the SQL a `getrequest` actually issues: an idle poll costs ≤ 1 query, a poll that claims a command costs exactly 1, and that one is a single `UPDATE … RETURNING` rather than select-then-update. This is the property that decides whether a remote database is usable at all (CLAUDE.md #4), and it is the one most likely to be broken silently by a later change.

Two failures on the first run were both in the harness, not the product — and the second was instructive: `/query-device` buckets its idempotency key to the minute, so calling it twice inside one minute correctly queues nothing. The test had assumed a second command.

> **Caveat worth knowing:** `PHOTO_STORAGE_PATH` is a single setting and is *not* swapped for the test run, so the harness shares the real photo directory. It removes the one file it writes, on both the success and crash paths — otherwise it would leave a phantom unclaimed enrollment on a live system.

### Hardware — only a person at the barrier can confirm these

- [ ] Register → provision → **recognized at the barrier**
- [ ] Block → **denied with `Invalid time period`** (and the face still recognised first — blocking does not remove the biometric)
- [ ] Unblock → recognized again
- [ ] De-provision → **gone from the device's own user list**, still in the database
- [ ] Re-provision the same vendor → recognized, **no re-enrollment** — the core product promise
- [ ] `faces_used` matches what the device reports after `INFO`
- [ ] Device physically unplugged and reconnected → queued commands flush, `last_seen_at` recovers

> Items 1–5 already passed on the terminal during Milestone 4 (3 Aug 2026).

**Clean-install run, 3 Aug 2026 — evidence from the audit trail:** vendor enrolled on the terminal → photo auto-pulled (`QUERY_USER` SUCCESS) → registered from the **unclaimed enrollments panel** with the photo attached and no upload → provisioned, `ENTRY_PROVISIONED` five seconds after the request → **punch recorded with `verify=15`, device-local 23:46:01 normalised to 18:16:01 UTC**, which is the barrier recognising them → blocked and unblocked, both device-confirmed → de-provisioned, `faces_used` back to 0 with the vendor record and photo retained.

**Re-provision from the clean install passed (4 Aug 2026)** — the vendor was recognised again from the stored photo with no re-enrollment. The founding premise now holds from a genuinely empty system.

**The physical unplug test surfaced two UI problems, both fixed:**

1. **The green dot was read as device status. It is not.** On the dashboard and the command queue that dot reports *the browser's event stream*, which stays connected while a terminal sits unplugged. Renamed to "Live updates on / reconnecting…" with a tooltip saying explicitly that it is not the device's connection (`web/src/components/stream-status.tsx`). Device liveness has always been the separate online/offline badge on the device card; the two are no longer confusable.
2. **Offline detection took nearly three minutes.** The threshold was a hardcoded 150 s, and detection is really that plus up to 20 s of `last_seen_at` write throttling, plus the 15 s UI poll. Now `DEVICE_OFFLINE_AFTER_SECONDS`, default **90** — three missed polls at the ~30 s idle rate. Verified at 89 s → online, 95 s → offline. Configuration rather than a constant because poll behaviour varies by firmware.

   The throttle itself was deliberately left alone: writing `last_seen_at` on every poll would spend the `getrequest` query budget (CLAUDE.md #4) to make a status badge twitchier.
3. The command queue now says so directly — when a device is offline and commands are waiting, a banner explains they will be delivered on reconnect and nothing is lost. That is the question the page exists to answer.

### Remote database — DEFERRED (decision, 4 Aug 2026)

**Decision: shipping Phase 1 on local PostgreSQL only.** The remote-database check is postponed, not cancelled.

What is already proven without it: swappability by connection string is exercised on *every* verification run (the harness uses a different database from the one the app normally uses, changed by `DATABASE_URL` alone, no code change), and the latency assumption underneath the requirement is asserted directly — `getrequest` costs exactly one query, and it is a single `UPDATE … RETURNING`.

**Residual risk this leaves, to pick up in Phase 6 if a client ever supplies their own database:**
- Managed providers impose low connection limits and often require a *pooled* endpoint; `DATABASE_POOL_SIZE` exists for this but has never been tuned against a real one.
- TLS parameters pass through untouched by design, but that path has not been exercised.
- pg-boss (Phase 3) polls Postgres; its polling interval against a remote instance is unmeasured, and is listed in §0.3 as needing verification.
- Batch sizes in ingestion and reconciliation are sized by reasoning, not by measurement against real round trips.

None of these block a local deployment, which is the default and the only one currently planned. Re-run `npm run verify:e2e` unchanged against a remote `DATABASE_URL` when the question becomes real.

---

## Sequencing advice

Milestones 0–2 are the substantial work and should be done in order — everything depends on the schema, and the schema depends on the environment. Milestones 3–5 are conventional CRUD and can overlap.

**Do not start Phase 2** (automated lifecycle, retention windows, entry modes) until Milestone 6 passes cleanly. Automation on top of an unreliable device layer produces bugs that are extremely hard to attribute.

## Open items carried from Phase 0

Not blocking, but worth resolving when the chance arises:

- **Does group 100 exist on a factory-fresh device?** This unit can no longer answer it — eTimeTrackLite has touched it. **Test on the second device while it is still factory-fresh.** If the blocked group is not a factory default, device onboarding must create or verify one.
- **Can denied attempts be retrieved?** They are not pushed. `Get ATTLOG By Datetime` (or its raw equivalent) may retrieve them. If so, SINGLE_ENTRY violations become auditable.
- ~~**ATTLOG field 3 (per-punch status code)**~~ — **ANSWERED 4 Aug 2026: field 3 is the device's attendance-state code, and it is controllable.** It always read `1` because this unit ships pinned to `Punch State Mode = Fixed Mode` with `Fixed Punch State = Check-Out`, and `1` is the Check-Out code. Full menu paths, the code table and the product implications are in `VMS_PROJECT_CONTEXT.md` §4.9.

  **`altinout` is dead as a concept** — it was an eTimeTrackLite device-record setting (middleware labelling punches after the fact), never something switchable on the terminal. Its actual replacement is `Manual Mode`, which lets F1/F2 select Check-In or Check-Out before the face scan, producing both directions from a single device. That is a device-side fact rather than a middleware convention.

  Phase 2 therefore gets **per-punch direction**. In production each terminal sits in `Fixed Mode` with its own state (IN gate → Check-In, OUT gate → Check-Out), so direction arrives stamped on the record *and* corroborates device identity — a disagreement between the two becomes a detectable misconfiguration rather than a silent wrong answer. `punch_event.status_code` already stores it; no schema change needed.

  **Confirmed on hardware 5 Aug 2026.** `Manual Mode` + F1/F2 produced field 3 = `0` then `1` on consecutive punches by the same user, both `verify=15`. Check-In = 0 and Check-Out = 1 are now observed rather than inferred, and a single terminal yields a full IN/OUT cycle — Phase 2's state machine can be built and tested without the second device. Codes `2`–`5` remain inferred; nothing depends on them.

- **The device suppresses repeat punches at source** (found 4 Aug 2026, scope settled 5 Aug 2026). `Duplicate Punch Period(m) = 1` on this unit: a second punch by the same user within the window is refused *on the terminal*, with **no record sent to the server at all**. This is not our `raw_record_hash` dedup — the punch never reaches us. **Suppression is per user, not per punch state** — changing Check-In to Check-Out does not evade it, so a quick in-and-out yields only the IN.

  **Consequence for Phase 2:** `Duplicate Punch Period(m) = 0` is a **correctness precondition for single-terminal deployments**, not a preference — SINGLE_ENTRY's day-block triggers on the OUT, and a suppressible OUT degrades single-entry to multi-entry silently. Two-gate deployments are largely immune (the window is enforced against each device's own log). The state machine must surface entries stuck `INSIDE` past their window regardless. See `VMS_PROJECT_CONTEXT.md` §4.10.
- **`MainTime=1970-01-01`** in the `INFO` response, despite correct punch timestamps. Unexplained.
- **PRD v4** — the correction list is in `VMS_PROJECT_CONTEXT.md` §9. Worth doing while Phase 0 is fresh.

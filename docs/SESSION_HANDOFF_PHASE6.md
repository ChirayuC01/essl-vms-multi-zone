# Phase 6 packaging — session handoff (verified, replaces the earlier fabricated version)

> **Historical record of Phase 6 (packaging), kept for the reasoning and the traps it documents.** For what is installed today, and how to build or upgrade it, use `docs/VERSIONS.md` and `docs/INSTALL_GUIDE.md`. Ports moved in 0.2.0 (backend `47102`, web `47101`) — this file predates that.


**Read this before anything else.** This file replaces a previous
`docs/SESSION_HANDOFF_PHASE6.md` that was discovered, early in this session,
to describe code changes and "locked-in decisions" that did not exist
anywhere in the actual repository — no trace of them in `schema.prisma`,
`config/index.ts`, `package.json`, or `backend/scripts/`. That file was
treated as unreliable and its claims were verified against the real
codebase before any of it was trusted. Everything below is different: it
describes only what was actually done and actually verified in this
session, with an honest account of what was tested versus what was not.

If you're a fresh session picking this up: read `CLAUDE.md` first, then this
file end to end, then continue from **"Where to pick up"** at the bottom.

---

## Where things actually stand

Phases 0–4 are complete (per `CLAUDE.md` and `docs/PHASE_4_PLAN.md`).
`docs/DEPLOYMENT_READINESS.md` recommends doing Phase 5 (a supervised
client-site pilot) *before* building an installer. **The user made a
deliberate, explicit decision to do Phase 6 packaging first anyway**,
overriding that recommendation, and confirmed this after being shown the
discrepancy — this is not an oversight, it's a known deviation.

Phase 6 is an 8-task packaging effort:

1. **Backend production bundle + Prisma Windows binaries — ✅ done, verified on real Windows**
2. **Portable Postgres + first-run data dir init — ✅ done, verified on real Windows**
3. **Windows service registration (WinSW) — ✅ done, verified on real Windows**
4. **First-run setup wizard — ✅ done, verified end-to-end (see below)**
5. **License enforcement — ✅ done, verified end-to-end (see below)**
6. **Persistent web console service (VmsWeb) — ✅ done, verified end-to-end (see below). Originally scoped as a Tauri desktop shell — redirected with the user's explicit sign-off; see the task 6 section for why.**
7. **Single Windows installer — ✅ done, verified end-to-end (see below)**
8. **End-to-end verification — ✅ done, verified end-to-end (see below)**

**Phase 6 packaging is complete.** All 8 tasks done and verified on real
Windows. See "Where to pick up" at the bottom for what comes next.

Everything below explains tasks 1–8 in enough detail that no re-deriving
should be necessary.

---

## Task 1 — Backend production bundle + Prisma Windows binaries

**Goal:** bundle `backend/src/index.ts` into a single file that runs under
plain `node` on a client's Windows machine, with a Prisma query engine for
Windows.

### Files changed

**`backend/prisma/schema.prisma`** — `generator client` block gained:
```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "windows"]
}
```
Without this, `prisma generate` only produces a query engine for whatever OS
runs the command, and the packaged backend can't talk to Postgres on a
different OS.

**`backend/src/config/index.ts`** — `backendRoot` now checks
`process.env.VMS_APP_ROOT` first:
```ts
const backendRoot = process.env.VMS_APP_ROOT
  ? path.resolve(process.env.VMS_APP_ROOT)
  : typeof import.meta.url === "string"
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
    : (() => {
        throw new Error(
          "VMS_APP_ROOT must be set: import.meta.url is unavailable in the bundled (CommonJS) build.",
        );
      })();
```
Reason: a single-file bundled backend sits at an arbitrary depth, so the old
"two directories up from this file" trick breaks. **A real bug was found and
fixed here during testing**: esbuild does *not* shim `import.meta.url` when
bundling to CommonJS — it silently becomes `undefined`. The original version
of this change (from the discarded fake handoff doc) would have crashed with
an opaque `fileURLToPath(undefined)` error. The `typeof import.meta.url ===
"string"` guard makes it fail with a clear, actionable message instead. Fully
unaffected: `npm run dev` and `npm test` (both real ESM, `import.meta.url` is
always defined there).

**`backend/scripts/build-package.mjs`** — new file. esbuild bundles
`src/index.ts` into `backend/dist-package/server.cjs`. Key specifics:
- **Output format is CJS, not ESM.** Prisma's generated client is
  CommonJS; bundling to ESM and leaving `@prisma/client` external throws
  `Named export 'X' not found` at runtime — Node's static named-export
  detection for an external CJS module imported from ESM is unreliable.
  CJS avoids this entirely.
- `@prisma/client` and `.prisma/client` are marked `external`; the real
  generated files (including the query engine binary) are copied into
  `dist-package/node_modules/` after the build, because the generated
  client resolves its engine binary by walking the filesystem at runtime —
  that lookup doesn't survive being inlined into the bundle.
- No source maps, minified.
- `VMS_PACKAGE_OUT` env var overrides the output directory.

**`backend/package.json`** — added `"package": "node scripts/build-package.mjs"`
and `esbuild` as a devDependency.

### Verification (this session, on the user's real Windows machine)

Full sequence run successfully:
```
cd backend
npm install
npx prisma generate
npm run package
cd dist-package
$env:VMS_APP_ROOT = "C:\...\backend"
node server.cjs
```
Result: server reached Postgres (`"database reachable"`), resolved config,
listened on `http://127.0.0.1:8080` (and LAN interfaces), started all
scheduled jobs including the expiry sweeper. This is the actual "task 1
done" milestone.

### Real problems hit and fixed along the way (useful if similar issues recur)

1. **`esbuild` warnings about `import.meta`** — expected and harmless; this
   is exactly the case the `typeof import.meta.url === "string"` guard
   above handles. Confirmed safe to ignore.
2. **PowerShell vs cmd.exe**: `set VMS_APP_ROOT=...` does **not** set an
   environment variable in PowerShell — `set` there is an alias for
   `Set-Variable`, a PowerShell-only variable with zero effect on the
   child process's environment. Must use `$env:VMS_APP_ROOT = "..."` in
   PowerShell, in the same window, before `node server.cjs`.
3. **`Invalid configuration: DATABASE_URL: Required / JWT_SECRET: Required`**
   — there was no `backend/.env` file yet (only `.env.example`). Fixed by
   copying `.env.example` to `.env` and filling in real values.
4. **`Authentication failed against database server`** — `.env`'s
   `DATABASE_URL` didn't match a real Postgres role/password. Fixed by
   creating the `vms_app` role and `vms` database on a real local Postgres
   (this was *before* task 2's bundled Postgres existed — see below).

### Sandbox-only limitation (not relevant to the user's Windows machine)

While iterating on this in the Linux Cowork sandbox used for
development/testing, two sandbox-specific issues showed up and are **not**
expected to affect Windows:
- `binaries.prisma.sh` returns `403 Forbidden` in that sandbox's network
  allowlist, blocking `prisma generate`'s engine download entirely. This is
  why several things could only be verified up to a point in-sandbox and
  had to be confirmed for real on the user's machine.
- The sandbox's mounted folders (including a Windows-folder-via-Linux mount)
  had a FUSE quirk that silently refused to delete files, breaking `npm
  install`'s ability to reconcile packages after an interrupted run. Worked
  around by testing in `/tmp` instead. Irrelevant to a native Windows
  environment — noted here only so it isn't mistaken for a real bug if
  seen again.

---

## Task 2 — Portable Postgres + first-run data dir init

**Goal:** a bundled Postgres that a client site never has to install
themselves, standing up its own data directory on first run.

### Approach

Used the npm package **`embedded-postgres`** (pinned to `17.10.0-beta.17` —
matches the Postgres major/minor version already validated against this
project's migrations). This was chosen over manually downloading and
scripting EnterpriseDB's portable Windows zip because `embedded-postgres`
republishes real Postgres binaries as ordinary per-platform npm
`optionalDependencies` (`@embedded-postgres/windows-x64`, `linux-x64`,
etc.) — resolved automatically by `npm install` exactly like `esbuild`
does, with no separate download step and no dependency on a
`binaries.prisma.sh`-style domain that might be blocked on a given network.

### Files changed

**`backend/package.json`** — added `embedded-postgres` (`17.10.0-beta.17`)
and `pg` (`^8.13.1`) as real dependencies (not devDependencies — needed at
runtime), plus two scripts:
```json
"db:bundled:init": "node scripts/bundled-postgres.mjs init",
"db:bundled:start": "node scripts/bundled-postgres.mjs start"
```

**`backend/scripts/bundled-postgres.mjs`** — new file, two subcommands:
- **`init`** — one-shot: initializes the data directory if new, starts the
  cluster, ensures the `vms_app` role and `vms` database exist (checks
  before creating — safe to rerun), runs `prisma migrate deploy`, stops.
  Prints the resulting `DATABASE_URL` on success.
- **`start`** — same initial setup, but stays in the foreground and shuts
  down cleanly on `SIGINT`/`SIGTERM`. This is what the Windows service
  wrapper (task 3) invokes so Postgres runs as its own long-lived process.

Config (all overridable via env vars, sensible defaults):
- Data dir: `backend/data/pgdata`
- **Port 5433, not 5432** — deliberately chosen because the user's own dev
  machine already runs a separate, unrelated Postgres instance on 5432 for
  `npm run dev`. The bundled cluster must never contend for the standard
  port.
- Superuser: `postgres` / `postgres` (fine for a cluster that only ever
  listens on localhost; should become a randomly generated, persisted
  password before this goes anywhere near a real client site — not done
  yet, flagged as a known gap).
- App role: `vms_app` / `devpassword`, database `vms` — matches the
  convention already used in `.env.example`.

### A real bug found and fixed during testing

`start()`'s error handling did not stop the Postgres cluster if `prisma
migrate deploy` failed partway through — unlike `init()`, which had a
`finally` block guaranteeing cleanup. This would have left an orphaned
`postgres.exe` process holding port 5433 after a failed startup attempt,
so a Windows service manager retrying the start would fail confusingly
against an already-occupied port instead of failing cleanly. Fixed by
wrapping `start()`'s setup logic in try/catch and calling `pg.stop()`
before rethrowing. Verified by deliberately triggering a failure and
confirming (via `ps aux`) no leftover Postgres process remained.

### Verification

Tested twice, independently:
1. **In the Linux Cowork sandbox**, using the Linux/x64 build of
   `embedded-postgres` as a stand-in (same library, different platform
   binary) — full cycle confirmed for real: data dir init, cluster start,
   idempotent role/database creation (ran `init` twice; second run
   correctly skipped what already existed and printed "Reusing existing
   data directory"), and clean shutdown on both success and the
   deliberately-triggered failure path. `prisma migrate deploy` itself
   failed in-sandbox for the same `binaries.prisma.sh`-blocked reason noted
   in task 1 — expected, not a new issue.
2. **On the user's real Windows machine** — `npm run db:bundled:init`
   completed successfully end-to-end, including `prisma migrate deploy`
   against the bundled cluster, printing:
   ```
   DATABASE_URL=postgresql://vms_app:devpassword@localhost:5433/vms
   ```
3. **Tasks 1 + 2 confirmed working together**: pointed `backend/.env`'s
   `DATABASE_URL` at the bundled instance above, ran `npm run
   db:bundled:start` in one terminal and the packaged `dist-package/server.cjs`
   (with `VMS_APP_ROOT` set) in another — this is the realistic client-site
   shape: packaged backend talking only to the bundled Postgres, nothing
   manually installed. (Confirm the `/health` check was actually hit if
   picking this up fresh — the user was told to try it but the explicit
   "yes it returned 200" confirmation wasn't captured in this doc; worth a
   quick re-check if in doubt.)

---

## Task 3 — Windows service registration (WinSW) — ✅ done, verified on real Windows

**Goal:** register two independent Windows services — `VmsPostgres` and
`VmsBackend` (dependent on `VmsPostgres`, so Windows starts/stops them in
the right order) — both set to start automatically on boot. This directly
serves `docs/DEPLOYMENT_READINESS.md`'s #1 hard requirement: the machine
must never be effectively off, because the expiry sweeper is the *only*
thing that removes a lapsed vendor from the device, and it only runs while
the backend process is alive.

### Files created

- `backend/scripts/windows-services/install-services.ps1`
- `backend/scripts/windows-services/uninstall-services.ps1`

Both require `winsw.exe` (WinSW — https://github.com/winsw/winsw/releases,
the `WinSW-x64.exe` asset) to be manually downloaded and placed at
`backend/scripts/windows-services/winsw.exe` first. **This was a deliberate
choice, not an oversight** — auto-downloading and silently running a
fetched executable as part of an install script felt like a step that
deserved a visible, deliberate action rather than automation.

`install-services.ps1`:
- Requires Administrator PowerShell (`#Requires -RunAsAdministrator`).
- Resolves `node.exe`'s full path via `Get-Command` and bakes it into each
  service's XML config — a Windows service does not reliably inherit an
  interactive user's `PATH`, so this is resolved once at install time.
- Generates `vms-postgres.xml` (next to `bundled-postgres.mjs`, in
  `backend/`) and `vms-backend.xml` (in `backend/dist-package/`), copies
  `winsw.exe` to `vms-postgres.exe` and `vms-backend.exe` respectively
  (WinSW's convention: it looks for a same-named `.xml` next to its own
  renamed `.exe`), and runs `install` on both.
- `VmsBackend`'s XML declares `<depend>VmsPostgres</depend>`.
- Both services: `<startmode>Automatic</startmode>`, restart on failure
  (5s then 30s backoff), rolling logs.
- Starts both services at the end and prints their status.

`uninstall-services.ps1` stops and removes both (backend first, reverse of
install order), leaving data directories untouched.

### Two real bugs found and fixed on the first real run

As predicted ("expect the first real run to surface at least one issue"),
it did — two, both fixed and re-verified in the same session:

1. **`VmsPostgres` crash-looped: "Execution of PostgreSQL by a user with
   administrative permissions is not permitted."** A Windows service
   defaults to running as `LocalSystem`, which PostgreSQL treats as an
   administrative account and refuses to start under, on principle (not a
   config option — it's a hard-coded startup check). WinSW's restart-on-
   failure policy (5s then 30s backoff) meant `Get-Service` still reported
   `Running` — that's the WinSW wrapper process, not Postgres — masking the
   failure until the actual log was read. `VmsBackend`'s simultaneous
   failure (`Can't reach database server at localhost:5433`) was pure
   downstream fallout, not a separate bug.

   **Fix** (`install-services.ps1`): after installing `VmsPostgres`, grant
   `NT AUTHORITY\NetworkService` write access to `backend\data` (recursive)
   and `backend\` itself (for WinSW's own log files) via `icacls`, then
   `sc.exe config VmsPostgres obj= "NT AUTHORITY\NetworkService"` to move
   the service off `LocalSystem`. `NetworkService` is a built-in low-
   privilege account — no password needed, no new user account to create or
   manage. `VmsBackend` was deliberately left on `LocalSystem`: it isn't
   the account PostgreSQL is objecting to, and CLAUDE.md doesn't call for
   least-privilege hardening at this stage — only fix the actual bug.

2. **Both `.ps1` scripts failed to parse at all on a second run**
   (`uninstall-services.ps1`, when first exercised): cascading "missing
   terminator" / "missing closing brace" errors. Cause: the scripts
   contained em dashes (`—`, U+2014) in comments and one string literal,
   saved as UTF-8 **without a BOM**. Windows PowerShell 5.1 (not PowerShell
   Core) reads BOM-less `.ps1` files using the legacy system codepage, not
   UTF-8 — the 3-byte em dash sequence gets misread byte-by-byte and
   corrupts parsing downstream of it. Fixed by replacing every em dash with
   a plain hyphen in both scripts (not by adding a BOM — plain ASCII is
   more portable and removes the whole class of bug rather than one
   instance of it). **Any future edits to these two files must stick to
   plain ASCII punctuation** — no em dashes, smart quotes, etc.

   A third, minor issue surfaced during uninstall: `Stop-Service` in
   `uninstall-services.ps1` intermittently throws `Collection was modified;
   enumeration operation may not execute` — a known .NET `ServiceController`
   race when a service has dependents. Harmless (`winsw.exe uninstall`
   stops the service itself regardless), but it printed an alarming red
   error block, so it's now wrapped in `try`/`catch` to swallow it silently.

### Verification (this session, on the user's real Windows machine)

After both fixes, a clean `.\uninstall-services.ps1` followed by
`.\install-services.ps1` (as Administrator) produced:
- `vms-postgres.out.log`: `database system is ready to accept connections`,
  `prisma migrate deploy` found all 10 migrations already applied,
  `Bundled Postgres ready on port 5433`.
- `vms-backend.out.log`: `"database reachable"`, resolved config log line,
  `Server listening at http://127.0.0.1:8080`, `scheduled jobs started`
  (including the expiry sweeper — the load-bearing one).
- `Invoke-WebRequest http://127.0.0.1:8080/health` → `200
  {"status":"ok","database":"reachable","postgres":"17.10"}`.
- `vms-backend.wrapper.log` showed no restart after the post-fix start —
  confirmed not crash-looping, unlike the first (broken) attempt.
- `Get-Service VmsPostgres, VmsBackend` → both `Running`, checked more than
  a minute after start (not just immediately, which is what made the
  original broken run look healthy at a glance).

### If picking this up on yet another machine

`install-services.ps1` and `uninstall-services.ps1` are idempotent and
safe to rerun. If `VmsPostgres` ever again shows `Running` but
`vms-postgres.out.log` doesn't end in `Bundled Postgres ready on port
5433`, don't trust the service status alone — read the log.

---

## Task 4 — First-run setup wizard

**Goal:** close the gaps that stood between a freshly-packaged install and a
usable system. Investigation (not the outdated `VMS_PRD_Technical_Plan.md`
§13.1, written before Phase 0) found the actual gap was narrower than a full
multi-step PRD wizard: no `JWT_SECRET` generator, no way to create the first
admin except a dev seed script with a published password, and **no API to
create a `Device` at all** — the Devices page already had a stub comment
promising this "arrives with the setup wizard in Phase 6." License key
collection and branding/retention config were deliberately left out —
`License` enforcement is task 5, not started, and branding/retention already
have working `.env` defaults, so collecting either now would be speculative.

### What was built

1. **`backend/scripts/first-run-env.mjs`** (new) — idempotent: creates
   `.env` from `.env.example` if missing, generates a random `JWT_SECRET`
   if the value is still the literal placeholder, and — if `DATABASE_URL`
   is still the placeholder too — runs the existing `bundled-postgres.mjs
   init` and writes its real connection string in. Never touches a
   `DATABASE_URL` that's been customised to a client-supplied database.
   Wired into `install-services.ps1`, right after the existing prerequisite
   checks — unlike the WinSW download, this is safe to automate (local,
   idempotent, only ever fills in placeholders).
2. **`backend/src/api/setup.ts`** (new) — `GET /setup/status` →
   `{needsSetup}` from `appUser.count() === 0`; `POST /setup/admin` creates
   the first `ADMIN` (re-checking the count inside a transaction
   immediately before insert), then refuses with 409 forever after. This is
   the only route in the API reachable without a token — everything else
   requires an authenticated admin to create the *next* operator, which is
   exactly the chicken-and-egg problem this closes.
3. **`POST /devices`** (new, in `devices.ts`, behind the existing
   `DEVICE_CONFIGURE` permission) — adopts a serial into the roster.
   `registry.ts` gained `dropUnknownDevice()` so an adopted serial
   immediately stops showing as unregistered rather than waiting for the
   in-memory cache to age out.
4. **`web/src/app/setup/page.tsx`** (new) — the wizard screen itself, a
   near-exact mirror of `login/page.tsx`'s structure. Checks
   `GET /setup/status` on mount and bounces to `/login` if setup is already
   done (so it can never be used to re-create or add a second admin).
   `login/page.tsx` now does the same check in reverse — a fresh install
   lands on `/setup` automatically instead of a login form for an account
   that doesn't exist. `devices/page.tsx` gained an inline "Register" button
   + optional name field next to each unregistered serial.

### Verification (this session)

Backend: `npm run typecheck` and `npm test` (50/50) both green; `web`:
`npx tsc --noEmit`, `npm run lint`, and `npm run build` all clean, including
`/setup` compiling as a new static route.

Live end-to-end, run for real against the bundled Postgres cluster (not
mocked) — but in **two throwaway databases** (`vms_setup_test`,
`vms_setup_test2`, both created in the same bundled cluster on port 5433,
migrated, exercised, then dropped) rather than the real `vms` database, so
none of this touched the actual install:

- `curl` against a `tsx watch` dev backend on an alternate port: confirmed
  `needsSetup: true` → create admin → `needsSetup: false` → a second
  `POST /setup/admin` correctly 409s.
- Confirmed the unknown-device path (`GET /iclock/getrequest.aspx?SN=...`)
  populates the unregistered list, `POST /devices` adopts it, and it
  disappears from `unregistered` and appears in `items` — all via curl with
  a real bearer token from `/auth/login`.
- Then the same flow for real in a browser (Claude's own Browser pane,
  pointed at a `next dev` instance wired to a second fresh throwaway
  database): loaded `/login`, confirmed it redirected to `/setup`, filled
  and submitted the form, confirmed it signed in and landed on the
  dashboard. Reloaded `/setup` directly afterward — confirmed it bounced
  away (to `/login`, then immediately to `/` since already authenticated)
  rather than re-showing the form. Triggered an unknown device, went to
  `/devices`, typed a name, clicked **Register** — confirmed it became a
  real device row and the "unregistered" section emptied.
- Afterward: dropped both throwaway databases, confirmed via
  `Get-Service` and `/health` that the real `VmsPostgres` / `VmsBackend`
  services were undisturbed throughout.

### Rolling the new code onto the live services — what actually happened

Getting today's code onto the real Windows services was not clean, and the
two things that went wrong are worth recording so they aren't rediscovered:

1. **A second em-dash-in-`.ps1`-file regression.** The line added to
   `install-services.ps1` in this same session (`throw "first-run-env.mjs
   failed — see output above."`) used an em dash, the exact bug task 3
   fixed and documented as "any future edits to these two files must stick
   to plain ASCII punctuation." It slipped through anyway and broke
   PowerShell 5.1 parsing again (`Unexpected token 'see'...` cascading into
   unrelated-looking errors further down the file, same signature as
   before). Fixed by replacing it with a plain hyphen; both `.ps1` files
   re-confirmed pure ASCII (`grep` for non-ASCII bytes, zero matches).
2. **`Stop-Service VmsBackend`/`VmsPostgres` came back "Cannot find any
   service"** — both had been fully deregistered (not just stopped) by the
   time the user tried to restart them, most likely from `uninstall-
   services.ps1` having been run at some point (its own "Collection was
   modified" `Stop-Service` flakiness, fixed in task 3, no longer got in
   the way — this time it fully tore both services down). `npm run package`
   hit a transient `EBUSY` on `dist-package` from the old process still
   exiting, which cleared itself on retry. Net effect: nothing was actually
   broken, just fully torn down — the fix was simply to run
   `install-services.ps1` fresh (idempotent) once the em-dash bug above was
   fixed, which re-registered and started both services from scratch.

**Bonus finding from the same run:** `first-run-env.mjs` reported
`.env updated: generated a new JWT_SECRET.` — this was correct, expected
behavior, not a bug. It turns out `JWT_SECRET` had silently stayed at the
literal `change-me-to-a-long-random-string` placeholder since task 1's very
first session: the value is 34 characters, well past the config schema's
16-character minimum, so it never once failed validation and nobody
noticed. `first-run-env.mjs` checking for the *exact* placeholder string
(not just "is it long enough") caught this for the first time. No real
operators or tokens existed yet, so regenerating it had zero practical
impact — this is exactly the class of gap task 4 was built to close.

### Final verified state — the real wizard, run for real, on the real install

With today's code confirmed live (`/api/setup/status` → `{"needsSetup":true}`
on the real `vms` database), the user ran the actual first-run flow through
the browser at `http://localhost:3000` (backend on its real port 8080, no
overrides) end to end:

1. Loaded `/` → redirected straight to `/setup` (no login form for an
   account that didn't exist yet).
2. Created the real administrator account, signed in automatically, landed
   on the dashboard.
3. Reloaded `/setup` directly afterward — bounced away, form did not
   reappear.
4. Confirmed server-side, not just client-side: a direct
   `POST /api/setup/admin` call after this returns `409` — `"setup has
   already been completed — sign in instead"`.
5. Registered the real device (the Phase 0 test unit, serial
   `NCD8252500406`) from the Devices page's "Unregistered devices" list —
   moved into the managed list, disappeared from unregistered.
6. Confirmed via `GET /api/reports/audit-trail` (**note:** not
   `/api/audit-log` — that path doesn't exist and 404s; the audit log is
   exposed through the generic reports registry under the `audit-trail`
   report key) — both `SETUP_ADMIN_CREATED` and `DEVICE_REGISTERED` rows
   present, correctly attributed to the real admin.
7. `Get-Service VmsPostgres, VmsBackend` and `/health` reconfirmed healthy
   throughout, unaffected by any of the above.

Task 4 is done, not just code-complete — verified against the actual
production-track database this install will use.

---

## Task 5 — License enforcement — ✅ done, verified end-to-end

**Goal:** the `License` Prisma model existed but nothing referenced
`prisma.license` anywhere — confirmed by repo-wide grep before starting.
The project's own docs flagged this as genuinely undecided rather than a
settled spec: `docs/VMS_PRD_Technical_Plan.md` §13.2 called for a license
"cryptographically bound to a machine fingerprint... a defined grace period
before lockout," while `docs/DEPLOYMENT_READINESS.md` said outright
*"Licensing model — Not built yet... What happens if a licence lapses —
does the gate stop working?"* and flagged internet availability as
**"decide first."**

Three real decisions were made with the user (not guessed) before writing
any code:
1. **Fully offline** — no heartbeat to any remote server, ever.
2. **Warn only, never lock** — no operator lockout, no blocked device sync.
   License state is visible and audited; nothing is technically gated. This
   was chosen specifically because CLAUDE.md #9 (a VMS outage must never
   strand authorized vendors) makes a licensing-driven lockout a bad trade.
3. **Build the generic mechanism only** — no real commercial terms yet.
   Real keys get issued once a business model exists.

Because enforcement is warn-only, this needed **no new scheduled job** and
**no changes to `requireAuth`** — it plugs entirely into the existing
computed-alerts system (`services/alerts.ts`, same "computed, never stored"
philosophy already documented there) plus one small admin surface.

### What was built

1. **Ed25519 via `node:crypto`** (stdlib, no new dependency) — a license key
   is `base64url(JSON payload) + "." + base64url(signature)`. The backend
   ships only the **public** key (`LICENSE_PUBLIC_KEY` env var, PEM) — it
   can verify but never mint a valid key. `backend/scripts/license/
   generate-keypair.mjs` and `issue-license.mjs` (new) are vendor-side
   tooling, run offline, never shipped to a client, not part of
   `build-package.mjs`'s bundle.
2. **Installation fingerprint reuses `AppConfig`** — like `License`, this
   table existed doing nothing since the schema was written.
   `getInstallationId()` (`backend/src/services/license.ts`, new) generates
   a `crypto.randomUUID()` once and persists it — "machine-bound" in the
   sense that matters for a single-tenant on-prem install (bound to *this
   database*), deliberately not true OS-hardware fingerprinting, which
   would be fragile across Windows editions/VMs and isn't worth it when
   nothing is actually locked by it.
3. **`GET/POST /api/license`** (`backend/src/api/license.ts`, new) — status
   is `Permission.READ` (any operator); installing a key is the new
   `Permission.LICENSE_MANAGE` (ADMIN-only). `AuditAction.LICENSE_INSTALLED`
   added.
4. **`collectAlerts()` gained one more computed block** — missing license →
   `info`, expired → `warning`, expiring within 14 days (the PRD's own
   figure, reused purely as a warning threshold, never a lockout trigger) →
   `info`. No new UI surface needed for this part — it rides the existing
   alerts panel/badge, visible to every operator regardless of role.
5. **A License card on `web/src/app/(app)/operators/page.tsx`** — status
   visible to whoever can reach this already-ADMIN-gated page, install form
   gated further by `can("license:manage")`. No new page, no new nav entry.

### Verification (this session)

Backend: `npm run typecheck` and `npm test` (50/50) both green throughout.
`web`: `npx tsc --noEmit`, `npm run lint`, `npm run build` all clean.

Live, in a throwaway database (`vms_license_test`, same bundled Postgres
cluster, dropped afterward) exactly like task 4's verification:
- Generated a real keypair, confirmed `GET /api/license` → `installed:
  false` and the `license-missing` info alert appears.
- Issued and installed a key with a **past** expiry date → `expired: true`,
  a `warning` alert appears with the exact "not a lockout" wording — while
  `/health` and `/api/vendors` stayed completely unaffected, confirmed
  directly.
- Re-issued the same installation id with a future date (upsert) →
  `expired: false`, alert clears.
- Confirmed three rejection paths all return clean `400`s, never a `500`:
  a key signed for a **different** installation id, a garbage string with
  no `.`, and a syntactically-shaped but non-matching-signature string.
- Then the same install-expired-key flow again, this time through the
  actual browser UI (Claude's own Browser pane) against a `next dev`
  instance: logged in, opened the Operators page, confirmed the License
  card showed **active/pilot**, pasted the expired key into the install
  form, submitted, watched the badge flip to **expired** live, then
  navigated to the dashboard and confirmed the same warning appears in the
  Alerts panel with the correct copy.
- One real snag hit and fixed along the way, worth remembering: **this
  Next.js version refuses to run two `next dev` servers from the same
  project directory at once**, even on different ports — the second
  instance prints "Another next dev server is already running" and exits,
  while an *orphaned* first instance keeps serving stale content on its
  original port. `taskkill /PID <pid> /F /T` on the orphan, confirmed via
  `netstat -ano`, fixed it. If a browser session ever seems to be hitting
  the wrong backend port during future throwaway-database testing, check
  for this before assuming a code bug.
- Afterward: dropped the throwaway database, confirmed via `Get-Service`
  and `/health` that the real `VmsPostgres`/`VmsBackend` services were
  undisturbed throughout — same discipline as task 4.

**Note:** unlike task 4, this was verified only in a throwaway database,
not rolled onto the real live services yet (no real `LICENSE_PUBLIC_KEY` is
configured on the real install's `.env`, and no real license has been
issued for it). That's expected — task 5 built the generic mechanism per
the user's explicit scope decision; issuing the real install's actual
license is a separate, later action once there's a real key to issue.

---

## Task 6 — Persistent web console service (VmsWeb) — ✅ done, verified end-to-end

**This was originally scoped as a Tauri desktop shell.** Before writing any
code, research turned up that `VMS_PRD_Technical_Plan.md` frames Tauri as
explicitly **optional and per-client** — "an app icon, kiosk feel" wrapper
around the same web UI, with zero bearing on security or function — and the
dev machine had **no Rust/MSVC toolchain installed at all** (a real,
multi-GB setup cost). This was put to the user directly rather than started
silently.

The more useful finding from that conversation: **regardless of the Tauri
decision, nothing kept the web console running persistently.** Task 3 only
ever registered `VmsPostgres` and `VmsBackend` — the operator console
(`web/`) had no service of its own and only ever ran via manual `npm run
dev`/`npm start`, exactly like this session's own throwaway-database
testing. Even a Tauri wrapper would still need that Next.js server running
behind it as a sidecar — Tauri doesn't remove the need, it only adds a
native window on top of it. The user chose, explicitly: **build the
`VmsWeb` service now, skip Tauri.** Tauri remains genuinely not started,
deferred until a client specifically wants the kiosk feel — nothing here
forecloses adding it later; it would sit on top of `VmsWeb` unchanged.

### What was built

`backend/scripts/windows-services/install-services.ps1` and
`uninstall-services.ps1` (already-established WinSW pattern from task 3,
extended rather than duplicated into a new script) now manage a third
service:

- **`VmsWeb`** — runs `node "web\node_modules\next\dist\bin\next" start -p
  3000` (the same "call the CLI's JS entry point directly via node.exe"
  pattern already used for Prisma's CLI in `bundled-postgres.mjs`), working
  directory `web\`, `<depend>VmsBackend</depend>`. No new packaging step
  needed beyond `npm run build` in `web\` — unlike the backend, Next's own
  build output is the production artifact; `next start` just needs
  `node_modules` + `.next` present, both already required for `npm run
  dev` anyway.
- New prerequisite checks: `web\.next` and `web\node_modules\next` must
  exist before the script proceeds (mirrors the existing `dist-package\
  server.cjs` check for the backend). **`NEXT_PUBLIC_API_URL` is baked into
  the client bundle at `next build` time, not read at runtime** — if it
  ever needs to change (e.g. backend on a non-default port), `web\` must be
  rebuilt, not just have its `.env` edited. The default (`http://localhost:
  8080`) already matches every real deployment so far, so nothing needed
  overriding for the pilot.
- `uninstall-services.ps1` now stops/removes `VmsWeb` before `VmsBackend`
  before `VmsPostgres` (reverse dependency order, same reasoning as before).

### A real bug found and fixed on the first live re-run

Re-running `install-services.ps1` on a machine where the three services
were **already registered and running** (exactly the situation after
adding `VmsWeb` to an existing task-3 install) failed immediately:
```
Copy-Item : The process cannot access the file '...\vms-postgres.exe'
because it is being used by another process.
```
The running service had its own `.exe` open; `Copy-Item -Force` can't
overwrite a locked file. My own earlier claim in this doc — "install-
services.ps1 and uninstall-services.ps1 are idempotent and safe to rerun"
— turned out to only be true *after* a full uninstall, not while services
were actively running. The user worked around it live by running
`uninstall-services.ps1` then `install-services.ps1` manually, which
worked and got all three services running — but that's exactly the
undocumented manual step a real redeploy (e.g. after `npm run package`
picks up new backend code) would silently need every time.

**Fixed properly, not just documented as a workaround.** Added
`Remove-ServiceIfRegistered` (stop, then uninstall via the still-in-place
`.exe`, before it gets overwritten) and call it for all three services
**up front, in full reverse-dependency order, before any fresh install
begins** — not inline per-service, which was tried first and is wrong:
stopping `VmsPostgres` before its dependent `VmsBackend` has been removed
gets refused by Windows (a running dependent still needs it), and the
existing `try/catch` around the known "Collection was modified" flake would
have silently swallowed that real error too. With the fix, `install-
services.ps1` is now genuinely safe to re-run at any time, live services or
not — confirmed by literally re-running it against the already-running
three-service install and watching it cleanly remove-and-reinstall all
three with no errors.

### Verification (this session, on the real live services)

1. `npm run build` in `web\` (fresh, confirmed via `npx tsc --noEmit`,
   `npm run lint`, `npm run build` all clean beforehand — no code changed
   here though, this task is packaging-only).
2. PowerShell syntax-checked both `.ps1` files via
   `[System.Management.Automation.PSParser]::Tokenize()` (no admin needed,
   catches parse errors without executing) before ever asking for a live
   run.
3. Ran the *exact* command `VmsWeb` would run (`node
   node_modules\next\dist\bin\next start -p 3000`) directly, non-elevated,
   confirmed it served `/login` with a real `200` against the real
   backend — before spending an elevated round-trip on it.
4. Live: `install-services.ps1` registered and started all three services
   — hit the Copy-Item bug above, fixed it, **then re-ran the same script
   again live** (the actual regression test for the fix) and confirmed a
   clean run with no manual uninstall needed.
5. `Get-Service VmsPostgres, VmsBackend, VmsWeb` → all three `Running`.
   `curl http://127.0.0.1:8080/health` → `200`. `curl http://localhost:
   3000/login` → `200`. `web\vms-web.out.log` shows a clean `next start`
   with no errors in `vms-web.err.log`.

---

## Task 7 — Single Windows installer — ✅ done, verified end-to-end

**Goal:** turn the manual sequence tasks 1–6 required (`npm install` +
`npm run package` in `backend\`, `npm install` + `npm run build` in
`web\`, hand-download WinSW, run `install-services.ps1` as Administrator)
into one double-clickable `.exe`. Two decisions made with the user first:
**Inno Setup, not MSI/WiX** (`DEPLOYMENT_READINESS.md` §7's own
recommendation for a single gate computer), and **proceed now** rather
than wait for the pilot, consistent with the earlier Phase 6-before-Phase
5 decision.

### Two real findings that shaped the design, before any code was written

1. **Node.js itself was never bundled.** Every script through task 6
   assumed `node.exe` was already on PATH — true on this dev machine,
   never true at a real client site. Windows' official Node build is a
   single ~83 MB self-contained `node.exe` (only needs the Universal C
   Runtime, present on any Windows 10+), so "bundling" is just copying one
   file — but `install-services.ps1` needed a small change to look for it.
2. **`prisma` is a hidden runtime dependency**, not just a dev one.
   `bundled-postgres.mjs`'s `prisma migrate deploy` step resolves
   `node_modules/prisma` from `backendRoot` (the top-level `backend\`
   folder `VmsPostgres` actually runs from), not `dist-package`'s already-
   trimmed copy. Rather than hand-curate exactly which "dev"-labeled
   packages are secretly load-bearing and risk missing another one, the
   installer ships `backend/node_modules` and `web/node_modules` **whole**
   — exactly what every task 4/5/6 verification this session already
   built and ran successfully. Costs installer size (final: **257 MB**
   compressed from ~1.3 GB staged), buys real confidence. A later, more
   surgical trim is a legitimate follow-up, not a fix for a bug.

### What was built

- **`installer/build-release.mjs`** (new) — stages a clean payload at
  `installer/release/`: `backend/dist-package`, `backend/node_modules`
  whole, `backend/prisma/schema.prisma` + `migrations/` (**not**
  `seed.ts`, which upserts a hardcoded published dev password and must
  never be reachable at a real site now that `/setup` exists),
  `backend/scripts/` **except** `backend/scripts/license/` (vendor-side-
  only, per `docs/LICENSING.md`), `backend/.env.example`, `web/.next` +
  `web/node_modules` whole, `winsw.exe`, and a bundled `node/node.exe`
  copied from `process.execPath` (whatever Node built the release, not a
  hardcoded path). Never copies `backend/data`.
- **`install-services.ps1`** — node discovery now checks
  `<repoRoot>\node\node.exe` first, falling back to the existing PATH
  lookup. Backward compatible: the real dev machine has no bundled
  `node\` folder, so it falls through to PATH exactly as before, proven
  by re-running the live services afterward with no change in behaviour.
- **`installer/vms-installer.iss`** (new) — Inno Setup script. Product
  name "Vendor Management System" / "VMS", no client name anywhere
  (CLAUDE.md hard rule #1). Default install path **`C:\VMS`**, not
  `C:\Program Files\VMS` — every script this whole project has run and
  verified uses a no-spaces path, and Program Files' spaces are an
  untested class of bug worth avoiding rather than discovering at a
  client site. `[Run]`: bundled `node.exe` runs `first-run-env.mjs`, then
  `install-services.ps1`, then (interactive installs only) opens
  `http://localhost:3000`. `[UninstallRun]`: `uninstall-services.ps1`
  runs **before** file removal, so service `.exe`s aren't locked (the
  exact failure mode task 6 already found and fixed, now also handled at
  the installer level). No `[UninstallDelete]` section — Inno Setup's
  generated uninstaller only ever removes files it tracked via `[Files]`;
  `backend\data` was never in that list, so it's never a candidate for
  removal. Confirmed by the actual live uninstall test below, not just by
  inspection.
- `SourceDir` / `AppDirName` / `OutputBaseFilename` are ISPP-overridable
  via `iscc /D...`, and a `TestBuild` flag switches to a separate `AppId`
  and faster `zip` (not solid `lzma2`) compression — this is what let an
  isolated test build get compiled repeatedly in ~90 seconds instead of
  ~9–11 minutes, without ever touching the real product's identity.

### A real bug found on the first live install attempt, and the actual fix

The first real test-variant install failed silently (`/VERYSILENT`
suppresses all UI, so both `[Run]` steps exiting non-zero produced no
visible error at all — files were copied, but no services were
registered). The installer's own log showed two `Process exit code: 1`
entries with no detail; running `first-run-env.mjs` directly by hand
revealed the actual cause: **`bundled-postgres.mjs init` actually starts
postgres.exe**, and when the elevated installer calls it (to learn the
`DATABASE_URL` to write into `.env`), the spawned postgres.exe inherits
the installer's Administrator token and refuses to run — the *exact same*
restriction task 3 already found and fixed for the `VmsPostgres`
*service* (moved to `NetworkService`), just newly reachable through a
plain child process that task fix never touched. `install-services.ps1`'s
own internal call to `first-run-env.mjs` hit the identical failure a
second later, which is why *both* `[Run]` steps failed.

**The root-cause fix, not a workaround:** `first-run-env.mjs` never
actually needed to start Postgres — the connection string is fully
deterministic from static config (host, port, user, password, database
name), no I/O required to know it. Added a third `bundled-postgres.mjs`
subcommand, **`print-url`**, which computes and prints the same string
`init`/`start` use, with zero side effects — no process spawned, safe at
any privilege level. `first-run-env.mjs` now calls that instead of
`init`. Real initialisation still happens exactly once, safely, when the
`VmsPostgres` *service* itself starts (as `NetworkService`, per task 3) —
this fix didn't just patch around the symptom, it removed a genuinely
unnecessary early Postgres start/stop cycle that was never Postgres's job
to begin with.

### Verification (this session, on the real machine)

1. `installer/build-release.mjs` run for real; every critical file
   confirmed present, every exclusion (`license/`, `seed.ts`, `data/`,
   `web/src`) confirmed absent, by direct inspection.
2. Compiled the real installer with `iscc.exe` (no GUI needed) — confirms
   the script itself is valid.
3. Prepared an isolated **test variant**: a full copy of the staged
   payload with service IDs sed-substituted to `VmsPostgresTest` /
   `VmsBackendTest` / `VmsWebTest`, and ports moved off the real ones
   (backend `8091`, Postgres `5434`, web `3001`) — the committed source
   was never touched, confirmed by diffing against it directly.
4. **First attempt failed** (the bug above) — diagnosed by running the
   failing step by hand, fixed at the root, backend `npm run
   typecheck`/`npm test` (50/50) reconfirmed green, both installers
   recompiled.
5. **Second attempt, live, fully succeeded**: `vms-setup-test.exe
   /VERYSILENT` → `Get-Service VmsPostgresTest, VmsBackendTest,
   VmsWebTest` all `Running` → `curl :8091/health` → `200` →
   `curl :3001/login` → `200`.
6. Ran the generated test uninstaller (`unins000.exe /VERYSILENT`) →
   confirmed via `Get-Service` that all three test services were gone,
   and via `Get-ChildItem C:\VMS-test` that `backend\data` and `.env`
   **survived** (never tracked by `[Files]`, so never removed) while
   `node_modules`/`dist-package`/`scripts` were cleanly gone.
7. Throughout steps 3–6: `Get-Service VmsPostgres, VmsBackend, VmsWeb` and
   `curl http://127.0.0.1:8080/health` reconfirmed the real, live
   services were completely undisturbed.
8. Cleaned up: `C:\VMS-test` fully removed, `installer/release-test/`
   deleted. The **real** installer (`installer/Output/vms-setup.exe`,
   257 MB) is built and available but was deliberately never run against
   this machine's real install — re-registering the already-correctly-
   running production services would prove nothing further.

---

## Task 8 — End-to-end verification — ✅ done, verified end-to-end

**Goal:** the last item in the 8-task plan, deliberately left undefined
beyond "End-to-end verification" in earlier sessions. Scope was picked with
the user rather than assumed, since the possible readings had very
different costs: run the real (non-test) installer for real, a full
functional regression pass with real hardware, and/or a genuine reboot
survival test. **All three, together** — the user's actual choice.

This task is the reason `docs/SESSION_HANDOFF_PHASE6.md` exists at the
length it does below: it surfaced two real, previously-latent bugs that
tasks 1–7's own (correctly rigorous) throwaway-database verification could
never have found, because both only manifest when the *real* install is
touched more than once in a row. Read this section before ever re-running
`install-services.ps1` against a live install.

### Consequential decision, made explicitly with the user first

Running the real `vms-setup.exe` uses the real service names
(`VmsPostgres`/`VmsBackend`/`VmsWeb`) and installs to `C:\VMS` — a
different location from the dev-repo-based install every prior task
verified against. This is not a side-effect-free test: it stops and
deregisters the dev-repo-based services and replaces them with fresh ones
at `C:\VMS`, with an empty database. The user chose explicitly: **keep
`C:\VMS` as the new ongoing live install** — this machine's real VMS
install is now at `C:\VMS`, not `C:\Work\essl-vms-main`. The dev checkout
remains the source repository (where all code changes are made and
committed) and the packaging build source, but is no longer where the
live services run from.

### Bug 1 (found before touching anything): `dist-package/server.cjs` was stale since task 4

`GET /api/license` 404'd immediately after the real install came up
healthy. `backend/dist-package/server.cjs` had never actually been
rebuilt since task 4 — tasks 5, 6, and 7 all layered new source code
(`api/license.ts`, `api/setup.ts` improvements, etc.) on top of a build
that predated all of it, and every task's own verification used either a
throwaway database against that same stale build (which still exercised
*some* real code, just not the newest routes) or didn't hit the missing
routes directly. Fixed with `npm run package`, then deployed onto the live
`C:\VMS` install.

**A note for next time**: after any task that touches `backend/src`,
verify the actual deployed `dist-package/server.cjs` reflects it —
`GET /api/license` (or any route added in the same session) returning
`404` is the tell. Don't assume "I edited the source" means "the running
service has it."

### Bug 2 (found deploying the fix for bug 1): service registrations can silently keep serving a stale binary path forever

This is the real finding of task 8, and it very nearly went unnoticed.

**What happened, in order:**
1. Redeploying the dist-package fix required a `Remove-Item -Recurse` +
   `Copy-Item` on `C:\VMS\backend\dist-package` — a mistake that also
   deleted `vms-backend.exe`/`vms-backend.xml` (WinSW's own generated
   files, which only ever exist at the install location, not in the
   source tree). Recovered by re-running `install-services.ps1` in place,
   which regenerates them — this part worked as designed.
2. That re-run's `Remove-ServiceIfRegistered` step (task 6's fix) called
   `Stop-Service` on the live `VmsPostgres`. `Stop-Service`'s known
   ".NET race" (`Collection was modified; enumeration operation may not
   execute` — the same one documented since task 3) threw, and the
   `catch` block around it — written to treat this as harmless, on the
   assumption that the subsequent `sc.exe delete` would clean up
   regardless — silently swallowed it. **The service was, in fact, still
   running when `sc.exe delete` ran.**
3. `sc.exe delete` on a *running* service reports `SUCCESS` but only marks
   it pending-deletion — the SCM entry, including its binary path, is not
   actually cleared until the process genuinely stops. The following
   fresh `install` call therefore never actually rebound the "VmsPostgres"
   service name to `C:\VMS`'s files; it silently kept pointing at
   `C:\Work\essl-vms-main\backend\vms-postgres.exe`.
4. This was **completely invisible** through every normal check:
   `Get-Service` and `sc.exe query` both reported `Running` (true — a
   process *was* running, just the wrong one). Only
   `sc.exe queryex VmsPostgres` (which includes the live `PID`) cross-referenced
   against `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` (or
   `Get-Process -Id <pid> | Select Path`) revealed the process's real exe
   path didn't match the service's own registered `BINARY_PATH_NAME`.
5. Compounding it: WinSW's `<onfailure action="restart" delay="..."/>`
   config is not just internal child-process monitoring — `sc.exe
   qfailure VmsPostgres` confirmed it becomes a **native Windows SCM
   recovery action**. So when this was first diagnosed and "fixed" by
   `Stop-Process -Force`-killing the stale process, Windows read that as
   an **unexpected crash**, not an intentional stop, and auto-restarted
   the service from its still-stale registration 5 seconds later — from a
   completely different, fresh PID, still running the old binary. This
   happened twice before the actual mechanism was understood.
6. It turned out **all three services**, not just `VmsPostgres`, had the
   identical stale binding — confirmed via `sc.exe qc <Id> | Select-String
   BINARY_PATH_NAME` on all three. The functional regression pass (device
   registration, vendor provisioning, real hardware commands — see below)
   had already completed successfully *before* this bug was introduced by
   the dist-package redeploy misstep, so none of that verification work
   was invalidated — confirmed afterward by the same data (device,
   vendor, entry) still being present once the real `C:\VMS` binding was
   restored, proving the underlying Postgres data directory was never
   touched by any of this, only the service *registration* was pointing
   at the wrong executable.

**The actual fix** (`backend/scripts/windows-services/install-services.ps1`
and `uninstall-services.ps1`, function `Remove-ServiceIfRegistered` /
`Remove-WinswService`): never call `sc.exe delete` on a service until its
stop is *confirmed*, not just attempted. Added `Wait-ServiceStopped`
(polls `Get-Service` until `Status -eq "Stopped"`, up to 15s), and if
`Stop-Service` didn't land within that window, falls back to `sc.exe stop`
— a graceful SCM-level stop that, unlike a process kill, does **not**
trigger the recovery-action restart, since it's understood by SCM as an
intentional stop rather than a crash. Only once genuinely stopped does it
call `sc.exe delete`, and even then it polls again afterward to confirm
the registration is actually gone before returning, since a lingering
pending-delete entry would make the following fresh `install` fail or
(worse, as observed) silently no-op against stale state.
`install-services.ps1` throws with a clear diagnostic hint if a service
truly won't stop (`$ErrorActionPreference = "Stop"`, so the whole script
aborts rather than proceeding into a broken state);
`uninstall-services.ps1` keeps its existing tolerant behavior (warns and
continues to the next service, since it's `$ErrorActionPreference =
"Continue"` by design).

**Verified live, twice**: once by re-running the fixed
`install-services.ps1` in place against the (by-then-corrected) live
`C:\VMS` services and confirming it completed cleanly with no manual
intervention (`sc.exe queryex` → `Get-Process -Id <pid> | Select Path` →
correctly `C:\VMS\backend\vms-postgres.exe`), and again implicitly by the
reboot survival test below, which depends on exactly this logic never
having run in a broken state at boot.

### Functional regression pass (real hardware, via the token-based API pattern)

Conducted through the actual REST API using a bearer token the user
retrieved from their own authenticated browser session and pasted in —
**not** by the assistant entering any password into a login or setup
form, in either case. (Creating the admin account, and signing in, were
both left to the user for exactly this reason.)

- `POST /api/devices` adopted the real Phase 0 test terminal
  (`NCD8252500406`) — it was already checking in against the new install
  with zero reconfiguration needed on the device side (same LAN address,
  same port 8080).
- `POST /devices/:id/refresh` pulled real firmware (`ZAM180-NF50VA-
  Ver3.4.10`), real capacity (3000 faces), real transaction count (108)
  from the physical device.
- A vendor was created, a photo uploaded (a generated placeholder image —
  see note below), and `POST /vendors/:id/provision` queued `PROVISION`
  and `PUSH_PHOTO` commands that the device collected and executed for
  real: both `SUCCESS`, entry state `PROVISIONED`.
- `GET /api/alerts` correctly surfaced a real `roster-excess` critical
  alert (the device had one more face loaded than the fresh database
  knew about — genuine residual state from earlier sessions' hardware
  testing, correctly detected as drift, not a bug) and, once the license
  routes were live, the `license-missing` info alert.
- Reports registry (20 reports), reconciliation sweep, and the inside-now
  board all responded correctly.
- **Real face-matched punch was explicitly skipped**, by the user's own
  choice: the uploaded vendor photo was a generated placeholder (a blue
  square with a beige ellipse, made via PowerShell's `System.Drawing`
  since no real photo was on hand), which cannot face-match a real
  person. Punch *ingestion* itself is unchanged Phase 0–4 code, already
  hardware-verified before this session, so this isn't new Phase 6
  surface area — provisioning already proved the full real-hardware
  command round-trip (ADMS dispatch, device polling, command completion)
  through the new install.

### Reboot survival test

`Restart-Computer`, for real. All three services (`Automatic` startmode)
came back with zero manual intervention. Verified afterward: `/health`
200, web console 200, `/api/license` 200 (proving the fixed dist-package
survived), the same `installationId` as before the reboot (proving the
same database, not a fresh one), and `sc.exe qc <Id>` on all three
confirming they're still correctly bound to `C:\VMS` — directly testing
that bug 2's fix holds at boot, not just under manual re-runs.

### Where things stand now

- The real, live install is at `C:\VMS`, all three services healthy,
  correctly bound, survived a reboot.
- It has one real administrator (`chirayuchawande01@gmail.com`) and one
  real registered device (`NCD8252500406`, "Main Gate"), created during
  this task's own verification — this is now genuinely in-use, not a
  throwaway.
- One test vendor ("Regression Test Vendor", PIN 10000) is provisioned on
  the real device with a placeholder (non-face-matching) photo. Fine to
  leave, or de-provision via the API/UI if a truly clean roster is
  wanted before real use.
- No license is installed (shows the `info` alert, as designed — see
  `docs/LICENSING.md` if one is ever wanted).
- The dev checkout (`C:\Work\essl-vms-main`) is unaffected code-wise —
  all fixes described above are committed there and were *deployed* onto
  `C:\VMS`, not developed there. Any future code change still needs
  `npm run package` / `npm run build` in the dev checkout, then either a
  fresh installer build-and-run or a manual dist-package/`.next` copy onto
  `C:\VMS` followed by a service restart.

---

## Environment facts worth remembering

- **PowerShell vs cmd.exe**: always use `$env:VAR = "value"`, never `set
  VAR=value`, when setting an environment variable for a single command in
  PowerShell.
- **Two separate Postgres instances now exist** on the user's dev machine:
  the pre-existing system Postgres (port 5432, used historically for `npm
  run dev`) and the new bundled one from task 2 (port 5433, `backend/data/pgdata`).
  Don't confuse the two `DATABASE_URL`s.
- **`binaries.prisma.sh` is blocked in the Cowork Linux sandbox** used for
  development iteration — any `prisma generate`/`migrate deploy` step will
  fail there with a `403 Forbidden`. This is sandbox-specific and has never
  been an issue on the user's real Windows machine, which has normal
  internet access.
- ~~**The project currently has no `.git` repository**~~ — **no longer true.**
  The repo is version-controlled and every release since 0.2.0 is recorded in
  `docs/VERSIONS.md` against the commit it was built from. This file is a
  historical account of Phase 6, not the continuity mechanism it once was.

---

## What's safe to delete before zipping this folder to move machines

Confirmed by inspecting the actual folder contents in this session:

**Safe to delete, fully regenerable:**
- `installer/release/` and `installer/Output/` — regenerate with `node
  installer/build-release.mjs` then `iscc installer/vms-installer.iss`
  (task 7). Together these were ~1.5 GB in this session; genuinely worth
  deleting before zipping, not just a technicality.
- `backend/node_modules` — regenerate with `npm install`
- `backend/dist-package` — regenerate with `npm run package` (after `npm install`)
- `backend/data/pgdata` — the bundled Postgres data directory. Confirmed
  it currently contains no real vendor data (this session only tested
  infrastructure, never the vendor-registration flow). Regenerate with
  `npm run db:bundled:init`. Postgres data directories are not something
  to casually carry between machines even on the same OS — let it
  reinitialize fresh.
- `backend/scripts/windows-services/winsw.exe`, and if task 3/6 was run
  before zipping: `backend/vms-postgres.exe`, `backend/vms-postgres.xml`,
  `backend/dist-package/vms-backend.exe`, `backend/dist-package/vms-backend.xml`,
  `web/vms-web.exe`, `web/vms-web.xml`,
  and any `*.wrapper.log` / `*.out.log` / `*.err.log` files WinSW creates.
  All regenerable (re-download WinSW, rerun `install-services.ps1` — now
  safe to rerun even with services already registered, see task 6's bug
  fix) — and the generated `.xml` files bake in absolute paths anyway, so
  they'd need regenerating on the new machine regardless of whether the
  extraction path matches.
- `web/node_modules` — regenerate with `npm install` (installed for the
  first time this session, to typecheck/lint/build task 4's frontend
  changes).
- `web/.next` — regenerate with `npm run build` (produced this session by
  the same verification).

**Do NOT delete:**
- `backend/.env` — contains the real `DATABASE_URL`/`JWT_SECRET` already
  configured and working. Not committed anywhere (gitignored), so this is
  the only copy. Deleting it means redoing the "create `.env`, fill in
  credentials" step from task 1.
- `backend/prisma/migrations/**` — the actual schema history.
- `backend/data/photos` — currently empty, confirmed in this session, but
  this is the one folder that must never be casually deleted if it ever
  does contain vendor photos: per `CLAUDE.md`, the photo is the durable
  artifact, more valuable than the software itself.
- All source code, `docs/`, `CLAUDE.md`, `.gitignore`.

---

## Where to pick up

**Phase 6 packaging is complete — all 8 tasks done and verified on real
Windows**, including a genuine reboot survival test. There is no task 9.
A fresh session should:

1. Read `CLAUDE.md`, then this file, in full.
2. **The real, live install moved to `C:\VMS` during task 8 — it is no
   longer at `C:\Work\essl-vms-main`.** This is deliberate (see task 8's
   "consequential decision" note), not a mistake to fix. The dev checkout
   remains where code is written, built, and committed; `C:\VMS` is where
   it actually runs. Don't assume `C:\Work\essl-vms-main`'s services are
   the live ones — check `sc.exe qc VmsBackend | Select-String
   BINARY_PATH_NAME` if ever in doubt.
3. `C:\VMS` has a real admin (`chirayuchawande01@gmail.com`) and a real
   registered device (`NCD8252500406`, "Main Gate") with one test vendor
   provisioned (PIN 10000, placeholder photo) — see task 8's "Where
   things stand now" for the full detail.
4. If `backend/src` or `web/src` ever changes, the live `C:\VMS` install
   needs a real redeploy, not just a rebuild in the dev checkout:
   - `npm run package` in `backend/` (or `npm run build` in `web/`), then
   - **either** rebuild and rerun the installer (`node
     installer/build-release.mjs` then `iscc installer/vms-installer.iss`
     — needs Inno Setup, already installed at `C:\Program Files (x86)\Inno
     Setup 6\ISCC.exe` — then run the resulting `installer/Output/
     vms-setup.exe` for real; this reinstalls in place cleanly, see task 6
     and task 8's `Remove-ServiceIfRegistered`/`sc.exe delete` fixes)
   - **or** a manual copy onto `C:\VMS` + service restart (what task 8
     actually did for speed) — **read task 8's "Bug 2" section first if
     you do this.** Stopping a service before overwriting its files is not
     optional, and `Stop-Process -Force` on a stuck one is actively
     dangerous (triggers the service's own crash-recovery auto-restart
     from a stale binary path) — always prefer `Stop-Service` /
     `sc.exe stop`, never a process kill, for any of these three services.
   - Confirm the deployed code actually changed: `GET /api/license` (or
     whatever route you just touched) returning what you expect, not a
     stale `404` or old behavior.
5. If you want the real install to actually enforce/show a real license:
   see `docs/LICENSING.md` for the full runbook. Entirely optional — the
   system works identically with no license installed, just shows an
   `info` alert.
6. **Next up, per `docs/DEPLOYMENT_READINESS.md`**: a supervised pilot
   install at an actual client site (Phase 5) — the thing Phase 6 packaging
   was deliberately done ahead of. Tauri (the desktop shell originally
   planned for task 6) remains not started, deferred until a client
   specifically wants the kiosk feel — see the task 6 section for why.

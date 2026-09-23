# VMS — People and Visitor Management System

On-premise product managing Employees and Visitors through eSSL face-recognition terminals driving flip barriers.

**The problem:** people must be enrolled on the biometric device to enter. Device rosters drift or get purged, so returning Visitors otherwise re-register from scratch and Employees can lose access.

**The solution:** register each Person **once** in PostgreSQL with a durable face photo. Employees have permanent desired device access until an Admin removes it. Visitors are loaded for time-bounded Entries and removed when their window lapses. In both cases the Person record and photo remain available for reuse.

**Phase 0 is complete.** Every device capability the product needs is proven on real hardware over the raw ADMS protocol. See `docs/VMS_PROJECT_CONTEXT.md`.

**Phases 1–4 are complete**, all hardware-verified. **Phase 6 (productization/packaging) is also complete** — installer, bundled PostgreSQL, Windows services, setup wizard, offline license enforcement — built ahead of Phase 5 by deliberate decision (packaging before the pilot, not after). See `docs/PHASE_4_PLAN.md` for what Phase 4 established and `docs/SESSION_HANDOFF_PHASE6.md` for Phase 6. **Next: Phase 5** — the supervised pilot at the first client site, now run through the installer Phase 6 built rather than a by-hand setup. See `docs/DEPLOYMENT_READINESS.md`.

**Current packaged artifact: 0.4.19 (17 Sep 2026).** It normalises enrollment photos to the terminal's 480×640 portrait shape (fixing `PUSH_PHOTO` `Return=-1001`), allows replacing an existing photo, and ships the operator-PC webcam policy script. The earlier 0.4.14 artifact is defective and must not be deployed because its frontend was built with the development backend URL `localhost:48102`. See `docs/VERSIONS.md` and `docs/KNOWN_ISSUES.md`.

---

## Hard rules

These are non-negotiable and cheap now, expensive to retrofit.

1. **No client names anywhere.** Not in code, config keys, comments, table names, UI strings, or commit messages. This is a multi-client product from day one.
2. **No client-specific conditionals.** `if (client === '...')` is banned. Any client difference must be expressible as configuration. The moment a conditional appears, the product forks and dies slowly.
3. **The database is the source of truth; the device is a working set.** People are never deleted from Postgres. De-provisioning removes device access only; Employees remain desired until explicit Admin removal.
4. **The database must be swappable by connection string alone.** Default is bundled local PostgreSQL, but a client may supply their own — including a managed cloud provider. Never assume sub-millisecond latency: no N+1 queries, no per-row loops in ingestion or reconciliation, and the `getrequest` handler must claim a command in one round trip (it fires every 1–3 s per device). Pool size configurable; connection string passed through untouched so provider-specific parameters and TLS settings survive. **Photos always stay on local disk** — only metadata and history live in the database.
5. **The photo is the durable artifact.** Face templates are algorithm-bound (`Face VX3.9`) and must never be treated as portable. Store the photo; treat any cached template as a same-device optimisation.
6. **Never write to any eSSL SQL database.** Read-only at most.
7. **One owner per managed device roster.** Employee and Visitor ID spaces must use distinct, non-overlapping patterns. Two roster managers cause mystery deletions.
8. **Every device write goes through the command queue.** Idempotent, retried, status-tracked. No ad-hoc device calls from request handlers.
9. **The VMS is never in the real-time barrier path.** The device opens the barrier itself on face match. The VMS controls *who is loaded and unblocked* — that provisioning decision *is* the authorization. A VMS outage must never strand authorized People.
10. **Validate before sending to the device.** `Return=0` means "processed", not "valid" — the device accepted the literal string `EndDatetime=<value>` without complaint.

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js + TypeScript + **Fastify** — operator API *and* device ADMS endpoints, plus jobs |
| Frontend | Next.js + React + TypeScript, Tailwind (hand-rolled components — no shadcn) |
| Database | PostgreSQL + Prisma |
| Jobs/queue | **pg-boss** (Postgres-backed — no Redis, minimal on-prem footprint) |
| Live updates | SSE |
| Auth | JWT + RBAC (`ADMIN`, `AUTHORIZED_PERSON`) |

**Why a separate backend rather than Next.js API routes:** the device POSTs 24/7 and scheduled jobs (expiry sweeper, daily entry-mode reset, reconciliation) must run unattended. The backend has to run independently of the UI, and now does — as a Windows service.

**Deployment reality (Phase 6, complete):** a single Inno Setup installer (`installer/vms-installer.iss`) bundles Node.js, PostgreSQL, the backend and the web console, and registers three WinSW-managed Windows services — `VmsPostgres`, `VmsBackend`, `VmsWeb` — plus a first-run setup wizard. No Tauri: the web console runs as its own persistent service instead of a desktop shell (see `docs/SESSION_HANDOFF_PHASE6.md` task 6). No nssm — WinSW only.

---

## Repo structure

```
vms/
  backend/          Fastify service
    src/
      adms/         device protocol layer (endpoints, parsers, command queue)
      api/          operator REST API (every route declares a permission)
      services/     lifecycle rules (provision/block/de-provision, entry modes,
                    punch state machine, reconciliation) — shared by api/ and jobs/
      jobs/         expiry sweeper, daily reset, reconcile sweep, retention
      reports/      report definitions (one registry, not one route per report)
      db/           Prisma client wrapper + audit helpers
      config/       config loading and validation
    prisma/
      schema.prisma
  web/              Next.js frontend
  docs/             PRD, project context, phase plans
```

---

## Commands

```bash
# backend
cd backend
npm run dev              # dev server with reload
npm run build
npx prisma migrate dev   # create + apply migration
npx prisma studio        # inspect data

# web
cd web
npm run dev
```

---

## The device — quick reference

**Test unit:** serial `NCD8252500406`, platform `ZAM180_TFT`, firmware `ZAM180-NF50VA-Ver3.4.10`, ADMS `Ver 2.0.33S`, face algorithm `Face VX3.9`. Capacity **3,000 faces** (the spec sheet's 6,000 is wrong), 150,000 transaction log.

Full protocol reference in `docs/VMS_PROJECT_CONTEXT.md` §4. Essentials:

### Conversation shape
The device initiates everything. It POSTs data and polls for commands; the server never connects to it. Polling is **adaptive**: ~30s idle, but 1–3s immediately after activity.

### Endpoints — note the `.aspx` suffix
This firmware calls them **with `.aspx`**. Serve both forms defensively.

```
POST /iclock/cdata.aspx?SN=&table=&Stamp=     device pushes data
GET  /iclock/getrequest.aspx?SN=              device polls for commands
POST /iclock/devicecmd.aspx?SN=               device reports results
POST /iclock/fdata.aspx?SN=                   biometric/photo uploads
```

### Command format — the `C:<id>:` prefix is mandatory
Return commands in the `getrequest` response body as `C:<CmdID>:<COMMAND>`. **A bare command is silently discarded** — no error, no acknowledgement.

The device replies on `devicecmd`: `ID=<n>&Return=0&CMD=DATA`. `Return=0` = processed. The correlation ID maps directly onto `sync_command` tracking.

Fields within commands are **TAB-separated**.

### Confirmed working commands

```
INFO                                                    device capabilities + counts
DATA QUERY USERINFO PIN=<pin>                           returns USER + BIODATA + BIOPHOTO
DATA UPDATE USERINFO PIN=<pin><TAB>Name=<n><TAB>Pri=0   create/update user
DATA UPDATE BIOPHOTO PIN=<pin><TAB>FileName=<pin>.jpg<TAB>Type=9<TAB>Size=<b64len><TAB>Content=<base64>
DATA DELETE USERINFO PIN=<pin>                          remove user
DATA UPDATE USERINFO PIN=<pin><TAB>Grp=100              BLOCK
DATA UPDATE USERINFO PIN=<pin><TAB>Grp=1                UNBLOCK
REBOOT
```

### Record formats

**Punch** (`table=ATTLOG`), tab-separated:
```
9001 <TAB> 2026-07-28 22:40:21 <TAB> 1 <TAB> 15 <TAB> 0 <TAB> 0 ...
PIN        timestamp (DEVICE LOCAL)  status  verify(15=face)  workcode...
```

**User** (`table=OPERLOG`):
```
USER PIN=9001 Name=TEST ONE Pri=0 Passwd= Card= Grp=1
     TZ=0000000100000000 Verify=-1 ViceCard= StartDatetime=0 EndDatetime=0
```

**Photo** (`table=OPERLOG`) — the durable artifact, full JPEG ~44 KB:
```
BIOPHOTO PIN=9001 FileName=9001.jpg Type=9 Size=<base64 length> Content=<base64>
```
**`Size` is the base64 character count, not the decoded byte count.**

**Template** (`table=BIODATA`) — algorithm-bound, cache only:
```
BIODATA Pin=9001 No=0 Index=0 Valid=1 Duress=0 Type=9 MajorVer=39 MinorVer=3 Tmp=<base64>
```

### Behaviours that will bite you

- **Access control is by `Grp`, not `TZ`.** Group 1 = allowed, group 100 = denied (`Invalid time period`). Personal `TZ` writes are accepted and ignored. Group IDs must be **per-device config**, not constants — numbering may vary.
- **`StartDatetime` / `EndDatetime` are stored but NOT enforced.** No device-native expiry. **The expiry sweeper is load-bearing**, and reconciliation is a security control, not housekeeping.
- **Blocking does not remove the biometric.** The device identifies the user, then denies. `DATA UPDATE USERINFO` never disturbs BIODATA or BIOPHOTO.
- **Denied attempts are NOT pushed to the server.** A blocked Person's entry attempt leaves no trace.
- **Timestamps are device-local.** Store each device's timezone and normalise on ingest.
- **`Stamp` / `OpStamp`** are incremental-sync markers. Mishandling risks replayed or dropped punches.
- **Bodies arrive with unusual or absent content-types.** Parse as raw buffers or requests get rejected.

---

## Domain model in one paragraph

A **Person** is either an `EMPLOYEE` or `VISITOR`. Employees use `EmployeeDeviceAccess`: reconciliation restores them while `desiredAccess=true`, and only an Admin removal prevents restoration. Visitors use an **Entry** authorization cycle with a retention window and `SINGLE_ENTRY` or `MULTI_ENTRY` mode. Visitor de-provisioning is triggered by window expiry, not merely by an OUT punch, and never removes the durable Person/photo/history.

**The device user ID is text, not a number.** It is validated as `[A-Za-z0-9]{1,20}`, unique case-insensitively, and stored with original casing. Each device has separate `employeeIdPatterns` and `visitorIdPatterns`; empty patterns classify nobody, overlapping patterns are rejected, and unmatched/ambiguous IDs remain untouched for Admin review.

Classified USER/BIOPHOTO records auto-create a Person with `needsDetails`; the available name and photograph are attached without manual registration. Visitors are deleted from the terminal only after their JPEG and biometric metadata are durable. Employees stay on the terminal and gain permanent desired access. Known People remain managed even if patterns later change.

---

## Working practices

- **Verify against physical hardware; trust nothing printed.** Every spec-sheet assumption checked so far has been wrong in some way.
- **Record exact working syntax verbatim.** Firmware variability is the biggest ongoing risk.
- **Log unrecognised requests rather than 404ing silently.** A silent 404 is indistinguishable from a dead network — this is how the `.aspx` suffix was found.
- **When something already works, observe it rather than guessing.** Two hypotheses about `TZ` bit layout were both accepted by the device and both did nothing; diffing what eTimeTrackLite actually wrote answered it in five minutes, and the answer was a different field entirely.

---

## Reference documents

- `docs/VMS_PRD_Technical_Plan.md` — full product and technical plan. **v4, with corrections layered in as later phases and releases diverged from it.** Where it conflicts with `VMS_PROJECT_CONTEXT.md`, `API_REFERENCE.md` or `VERSIONS.md`, those reflect reality and it does not.
- `docs/VMS_PROJECT_CONTEXT.md` — everything actually established: hardware, network, full protocol reference, all Phase 0 results.
- `docs/KNOWN_ISSUES.md` — defects and unproven assumptions, with what each costs at a live site and how to check it. Read before diagnosing anything odd in the field, and before a first install.
- `docs/VERSIONS.md` — release register: what each shipped installer contains, which commit it was built from, upgrade hazards, and how to cut a release.
- `docs/LICENSING.md` — current offline trial, expiry enforcement, private request collection, and renewal runbook.
- `docs/INSTALL_GUIDE.md` — step-by-step install procedure for a Windows machine with nothing pre-installed, for the person running the installer.
- `docs/DEPLOYMENT_READINESS.md` — what has to be true at a client site before installing, for non-technical stakeholders.
- `docs/DPDP_SHARED_TERMINAL_RISK.md` — historical shared-terminal risk analysis plus the current separate Employee/Visitor pattern rule.
- `docs/SESSION_HANDOFF_PHASE6.md` — how the packaging was built, and the Windows-service traps it cost to find.
- **Phase plans — historical records, not current behaviour.** Each carries a banner saying so. `PHASE_4_PLAN.md` (RBAC, reports), `PHASE_3_PLAN.md` (reconciliation, retention, alerting), `PHASE_2_PLAN.md` (lifecycle automation), `PHASE_1_PLAN.md` (the hardware-verification record), `PHASE_0_CHECKLIST.md` (test-by-test protocol discovery).

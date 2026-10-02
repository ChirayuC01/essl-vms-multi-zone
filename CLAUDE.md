# VAMS — Two-Zone Visitor Access System

An on-premise product that controls who can pass eSSL face-recognition terminals driving flip barriers, across a site divided into **zones**.

**The problem:** people must be enrolled on the terminal to pass it. Rosters drift or get purged. Visitors would otherwise re-register from scratch every time, and Employees can lose access.

**The solution:** register each Person **once** in PostgreSQL with a durable face photo. The system loads that face onto the right terminals at the right time and removes it again:
- Employees have permanent access to the terminals of their zones.
- Visitors hold time-bounded passes. A pass is loaded per terminal, per rule:
  - entry gates load just before the visit
  - a single-entry visitor needs an exit code before exit gates load
  - faces are removed after use or at pass end

**Status:** rebuilding from the single-entrance 0.4.19 product (Phases 0–4, 6 of the old plan all complete and hardware-verified) into the two-zone product. The rebuild runs phase by phase. **Stop after each phase for the owner's verification.** See `docs/PLAN.md` for status and `docs/PRODUCT.md` for the target behaviour. The packaged artifact in the field is still **0.4.19** (`docs/VERSIONS.md`); 0.4.14 is defective and must not be deployed.

---

## Hard rules

These are non-negotiable and cheap now, expensive to retrofit.

1. **No client names anywhere.** Not in code, config keys, comments, table names, UI strings, or commit messages. This is a multi-client product from day one.
2. **No client-specific conditionals.** `if (client === '...')` is banned. Any client difference must be expressible as configuration: zones, pass types, field rules, timings and toggles are data or settings, never code. The moment a conditional appears, the product forks and dies slowly.
3. **The database is the source of truth; the device is a working set.** People are never deleted from Postgres. Removing a face from a terminal removes access only; history, photo and documents remain.
4. **The database must be swappable by connection string alone.** The default is bundled local PostgreSQL, but a client may supply their own, including a managed cloud provider.
   - Never assume sub-millisecond latency.
   - No N+1 queries. No per-row loops in ingestion, reconciliation or jobs.
   - The `getrequest` handler must claim a command in one round trip; it fires every 1–3 s per device.
   - Pool size is configurable. The connection string is passed through untouched, so provider-specific parameters and TLS settings survive.
   - **Photos and documents always stay on local disk.** Only metadata and history live in the database.
5. **The photo is the durable artifact.** Face templates are algorithm-bound (`Face VX3.9`) and must never be treated as portable. Store the photo; treat any cached template as a same-device optimisation. Every photo sent to a terminal is normalised to a 480×640 portrait JPEG.
6. **Never write to any eSSL SQL database.** Read-only at most.
7. **One owner per managed device roster.** Employee and Visitor ID spaces must use distinct, non-overlapping patterns. IDs matching neither pattern (including the terminal's admin card holder) are never touched. Two roster managers cause mystery deletions.
8. **Every device write goes through the command queue.** Idempotent, retried, status-tracked. No ad-hoc device calls from request handlers.
9. **The VMS is never in the real-time barrier path.** The device opens the barrier itself on face match. The VMS controls *who is loaded and unblocked*; that loading decision *is* the authorization. A VMS outage must never strand authorized People.
   - **Amended (client, 23 Sep 2026):** a single-entry visitor's exit gate is loaded only after the exit code is verified, or after a Security override with a mandatory reason. During a VMS outage, site staff release people with the terminal's admin card and keep a manual register. When the system comes back, it releases the outage-affected passes automatically and audits each release.
10. **Validate before sending to the device.** `Return=0` means "processed", not "valid": the device accepted the literal string `EndDatetime=<value>` without complaint.
11. **Every state change is audited**, through `auditRow` / `AuditAction` (`backend/src/db/audit.ts`). This covers every request, query (with its text), decision, override, blacklist, setting change and gate load/unload.
12. **Saved ID numbers are only ever shown redacted** (first 2 and last 2 characters, e.g. `CI******7b`). This applies to Govt ID, Aadhaar, PAN and credential numbers, in every API response, report, CSV and print view. The full value stays server-side for uniqueness and matching.

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js + TypeScript + **Fastify**: operator API, public visitor-portal API, device ADMS endpoints, plus jobs |
| Frontend | Next.js + React + TypeScript, Tailwind (hand-rolled components, no shadcn). The operator console and the visitor portal (`/v/*`) live in one app |
| Database | PostgreSQL + Prisma |
| Jobs/queue | **pg-boss** (Postgres-backed; no Redis, minimal on-prem footprint) |
| Live updates | SSE |
| Auth | JWT + RBAC. Routes declare permissions; roles map to permissions in one table (`api/permissions.ts`) |
| Messaging | Outbox table + console transport until the SMS/email provider is confirmed |
| Public access | Cloudflare Tunnel exposing only the visitor portal routes |

**Why a separate backend rather than Next.js API routes:** devices POST 24/7, and scheduled jobs (gate-load engine, expiry, reconciliation, retention) must run unattended. The backend runs independently of the UI, as a Windows service.

**Deployment:** a single Inno Setup installer (`installer/vms-installer.iss`) bundles Node.js, PostgreSQL, the backend and the web console. It registers three WinSW-managed Windows services (`VmsPostgres`, `VmsBackend`, `VmsWeb`) plus a first-run setup wizard. No Tauri, no nssm. Packaging traps are recorded in `docs/ARCHITECTURE.md` §6.

---

## Repo structure

```
backend/          Fastify service
  src/
    adms/         device protocol layer (endpoints, parsers, command queue)
    api/          operator REST API (every route declares a permission)
    services/     lifecycle rules shared by api/ and jobs/
    jobs/         scheduled jobs (pg-boss)
    reports/      report definitions (one registry, not one route per report)
    db/           Prisma client wrapper + audit helpers
    config/       config loading and validation
  prisma/
    schema.prisma
web/              Next.js console (+ visitor portal from Phase 5)
installer/        Inno Setup installer and release staging
docs/             current docs; docs/legacy/ = the 0.4.x product, never edited
```

---

## Commands

```bash
# backend
cd backend
npm run dev              # dev server with reload (port 48102)
npm run typecheck && npm test
npm run verify:e2e       # needs DATABASE_URL to a *_test database
npx prisma migrate dev   # create + apply migration
npx prisma studio        # inspect data

# web
cd web
npm run dev              # port 48101
npm run lint && npm run build
```

---

## The device — quick reference

**Verified unit:** serial `NCD8252500406`, platform `ZAM180_TFT`, firmware `ZAM180-NF50VA-Ver3.4.10`, ADMS `Ver 2.0.33S`, face algorithm `Face VX3.9`. Capacity is **3,000 faces** (the spec sheet's 6,000 is wrong), with a 150,000 transaction log. All four terminals at a two-zone site must be checked against `docs/DEVICE_PROTOCOL.md` §9.

The full protocol reference is in `docs/DEVICE_PROTOCOL.md`. Essentials:

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
Return commands in the `getrequest` response body as `C:<CmdID>:<COMMAND>`. **A bare command is silently discarded**: no error, no acknowledgement.

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

**Photo** (`table=OPERLOG`), the durable artifact, a full JPEG of ~44 KB:
```
BIOPHOTO PIN=9001 FileName=9001.jpg Type=9 Size=<base64 length> Content=<base64>
```
**`Size` is the base64 character count, not the decoded byte count.**

**Template** (`table=BIODATA`), algorithm-bound, cache only:
```
BIODATA Pin=9001 No=0 Index=0 Valid=1 Duress=0 Type=9 MajorVer=39 MinorVer=3 Tmp=<base64>
```

### Behaviours that will bite you

- **Access control is by `Grp`, not `TZ`.** Group 1 = allowed, group 100 = denied (`Invalid time period`). Personal `TZ` writes are accepted and ignored. Group IDs must be **per-device config**, not constants; numbering may vary.
- **`StartDatetime` / `EndDatetime` are stored but NOT enforced.** There is no device-native expiry. **The system's unload and expiry jobs are load-bearing**, and reconciliation is a security control, not housekeeping.
- **Blocking does not remove the biometric.** The device identifies the user, then denies. `DATA UPDATE USERINFO` never disturbs BIODATA or BIOPHOTO.
- **Denied attempts are NOT pushed to the server.** A refused person (expired, blacklisted, wrong zone) leaves no trace.
- **Timestamps are device-local.** Store each device's timezone and normalise on ingest.
- **`Stamp` / `OpStamp` are inert constants (`9999`)** on this firmware. Dedup is by `raw_record_hash`.
- **`PUSH_PHOTO` returns `-1001` for un-normalised webcam/phone photos.** Always send 480×640 portrait JPEGs.
- **`getrequest` hands out one command per poll.** Bulk work must meter itself.
- **Bodies arrive with unusual or absent content-types.** Parse as raw buffers or requests get rejected.

---

## Domain model in one paragraph

A **site** is a tree of **zones**. Each zone has IN and OUT terminals, and access to a zone implies its ancestors.

A **Person** is an `EMPLOYEE` or a `VISITOR`.
- **Employees** have permanent desired access (`EmployeeDeviceAccess`) to their zones' terminals until an Admin removes it. Reconciliation restores them.
- **Visitors** hold **passes** of a configured **pass type**, which decides the required fields, host approval and maximum validity.
- A pass names its zones and its entry mode:
  - **SINGLE_ENTRY:** each IN terminal drops the face 10 min after its own punch. The code-gated exit gates load only after an exit code or a Security override.
  - **MULTI_ENTRY:** IN and OUT load together, there is no exit code, and faces stay for the whole pass.
- Planned visits start as a **visit request** raised by a host. The visitor completes it through the portal, and the host Clears, Queries or Rejects it, with full history.

**The device user ID is text, not a number.** It is validated as `[A-Za-z0-9]{1,20}`, unique case-insensitively, and stored with its original casing. Visitor IDs are issued by the system with a configured prefix. A returning visitor is matched by their OTP-verified mobile number and keeps the same ID and photo.

---

## Working practices

- **Deliver phase by phase** (`docs/PLAN.md`). Record every material change in `docs/EXECUTION_LOG.md`, and every decision in `docs/DECISIONS.md`, in the same session. Then stop for the owner's verification.
- **Verify against physical hardware; trust nothing printed.** Every spec-sheet assumption checked so far has been wrong in some way.
- **Record exact working syntax verbatim.** Firmware variability is the biggest ongoing risk.
- **Log unrecognised requests rather than 404ing silently.** A silent 404 is indistinguishable from a dead network; this is how the `.aspx` suffix was found.
- **When something already works, observe it rather than guessing.** Two hypotheses about the `TZ` bit layout were both accepted by the device and both did nothing. Diffing what eTimeTrackLite actually wrote answered it in five minutes, and the answer was a different field entirely.

---

## Reference documents

- `docs/README.md`: index and reading order.
- `docs/PRODUCT.md`: target behaviour (zones, pass types, flows, gate-loading rules, controls, roles, settings, privacy).
- `docs/DEVICE_PROTOCOL.md`: hardware and raw ADMS protocol as verified, plus the new-terminal checklist.
- `docs/ARCHITECTURE.md`: code layout, queue and jobs, database rules, packaging traps.
- `docs/PLAN.md`: phased rebuild plan and status.
- `docs/DECISIONS.md`: every decision, with date and source, plus questions still open with the client.
- `docs/EXECUTION_LOG.md`: what each phase changed and how it was verified.
- `docs/KNOWN_ISSUES.md`, `docs/VERSIONS.md`, `docs/DEVELOPMENT_SETUP.md`: live registers and the dev runbook.
- `docs/legacy/`: the 0.4.x single-entrance product's documents, kept unchanged. Install, licensing and people-transfer runbooks there remain valid for 0.4.19 until a phase replaces them (`docs/legacy/README.md`).

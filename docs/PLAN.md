# Rebuild Plan — Two-Zone Visitor Access

> Approved 2 October 2026. One phase at a time; each phase stops for the
> owner's verification before the next begins. Status changes and results are
> recorded in `EXECUTION_LOG.md`.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Docs baseline and legacy split | `ACCEPTED` (commit `33da17e`) |
| 1 | Zones and gates | `ACCEPTED` — verified by owner (commit `1cb2c8f`) |
| 2 | Roles and settings | `ACCEPTED` (owner, 2026-10-05) |
| 2b | Configurable access: custom roles, feature × action grid, per-user allow/deny | `ACCEPTED` (owner, 2026-10-05) |
| 3 | Pass types, visitor profile, documents, ID redaction | `ACCEPTED` (owner, 2026-10-05) |
| 4 | Gate-load engine | `ACCEPTED` — verified by owner (2026-10-05) |
| 5 | Messaging outbox and visitor portal (+ the visit-request core) | `ACCEPTED` — verified by owner (2026-10-06) |
| 6 | Visit requests, host review, walk-ins | `ACCEPTED` — verified by owner (2026-10-08) |
| 7 | Exit code, out-pass, outage recovery | `ACCEPTED` — verified by owner (2026-10-08) |
| 8 | Reports and audit coverage | `ACCEPTED` — verified by owner (2026-10-08) |
| 9 | Tunnel, hardening, packaging, acceptance | `IMPLEMENTED_AWAITING_VERIFICATION` — owner: build, upgrade and terminal acceptance |

States: `NOT_STARTED → IN_PROGRESS → IMPLEMENTED_AWAITING_VERIFICATION → ACCEPTED` (or `BLOCKED`, with the blocker in the log).

---

## Context

The existing VMS was built for a site with one entrance: one IN terminal and one OUT terminal. Visitors are loaded onto every selected device at once. There is no approval workflow and no visitor-facing side.

The new client has:
- **4 terminals**: Outer IN/OUT at the premise boundary, and Yard IN/OUT inside it.
- **Two zones.** Office access means the outer gates only. Yard access means all four.
- **Host-driven planned visits.** The visitor pre-registers through a link (mobile OTP, details, live selfie, optional documents). The host can Clear, Query or Reject.
- **Staged face loading:**
  - IN terminals load 5 min before the expected time.
  - For SINGLE entry, the face is removed from each IN terminal 10 min after that terminal's own punch.
  - **Exit code applies to SINGLE entry only** (client, 23 Sep).
    - A single-entry face reaches the OUT terminals only after the exit OTP is verified, and is removed 10 min after the exit punch.
    - **Multi-entry passes get no exit code.** Their OUT terminals load together with their IN terminals and stay for the whole pass.
  - **Which exits the code opens is chosen per pass.** The office (outer) exit is always included and is the default. The yard exit is an optional tick on a yard pass.
- **Long-term passes** have no host. A long-term pass that is single-entry sends its exit OTP to the Security desk; a multi-entry one has none.
- **Controls:**
  - blacklist
  - host zone-widening during a visit
  - a Security exit override with a mandatory reason, shown in a report
- **Outage fallback:** while the system is down, visitors are released physically with an admin card and noted in a manual register. When the system comes back online, the people and passes affected by the outage are released automatically, and the release is recorded.
- **ID numbers are redacted after saving.** A saved Govt ID, Aadhaar, PAN or credential number is only ever displayed masked, e.g. `CI******7b`.
- **Full audit** of every request, query and decision.

The client's decisions are recorded in memory (`new-vams-spec-decisions`, `new-vams-client-answers`) and in `~/Downloads/Visitor-Access-Confirmation-Points.pdf`.

**Outcome:** the same codebase, re-shaped around zones, per-gate loading and a request workflow. We keep everything that already works: the ADMS layer, queue, reconciliation, Employees, attendance, reports, licensing and the installer.

**Delivery rule:** one phase at a time. After each phase I stop and report what changed and how to verify it. The next phase starts only on your go-ahead. Every phase appends to `docs/EXECUTION_LOG.md`.

## Standing decisions (apply to every phase)

**Hard rules.** All the old hard rules still apply, with one recorded amendment to #9. A single-entry visitor inside can exit through the system only by OTP or the Security override. During a VMS outage, site staff release them physically with an admin card and keep a manual register. On recovery, the system releases the outage-affected passes automatically (Phase 7). This was confirmed by the client on 23 Sep 2026.

**Terminal admin card holder.** The card holder's user ID must match neither the Employee nor the Visitor ID patterns. The VMS then never manages, deletes or reports on that user, and reconciliation already leaves unmatched IDs alone. This goes on the Phase 9 device checklist.

**ID redaction.** Govt ID number, Aadhaar, PAN and credential number are stored in full, which is needed for uniqueness and returning-visitor checks. Every API response, report, CSV, pass and print view returns them masked: the first 2 and last 2 characters are kept and the rest become `*`. There is one shared `maskId()` helper. No UI or API path returns the full number after it is saved. The vehicle number stays visible, because Security has to check it.

**Everything client-specific is configuration, never code:**
- zone names and structure
- pass types and their required fields
- which pass types need host approval
- each zone's default for whether its exit needs the exit code (the per-pass choice starts from it)
- the 5/10-minute timings
- the visitor ID prefix
- document limits
- the DPDP notice text

No CHA/BCBA/customs strings in code. The client's pass types are seed data.

**Settings live in one typed `app_config` service** (`services/settings.ts`), with zod defaults. Changing one is Admin-only and audited.

**Every state change writes `audit_log`** through `auditRow` (`backend/src/db/audit.ts`). New actions are added to `AuditAction`.

**Returning visitors are matched by the OTP-verified mobile number** (`Person.mobile`). They reuse the same Person, photo and device user ID.

**SMS and email:** a `messages` outbox table plus a `console` transport for now. Local testing reads links and OTPs from an Admin "Outbox" page. msg91 and nodemailer are added only when the client confirms.

**Documents:** optional. Allowed types are JPEG/PNG/WebP/PDF, checked by magic bytes, at most 10 MB each and 5 per visit (all settings). Files are stored on local disk next to photos, always served as attachments, and never rendered inline as HTML.

## Reuse map (existing code to build on, not replace)

- Command queue and builders: `adms/queue.ts` (`enqueue`, `enqueueIn`, `claimNext`, `resolveDeviceReply`) and `adms/commands.ts` (`buildCreateUser`, `buildPushPhoto`, `buildDeleteUser`).
- Ack-driven state: `services/entries.ts` → `onCommandResolved` / `completeProvisionIfReady`. Face counting moves from per-entry to per-gate.
- Punch direction and batching: `services/punches.ts` (`resolveDirection`, `processPunches`, fixed query shape).
- The expiry sweeper pattern (one read and a few writes, no per-row loop): `jobs/expiry.ts`. Job scheduling: `jobs/index.ts` (pg-boss).
- Reconciliation: `services/reconcile.ts`. Its "who should be on this device" query changes to read the new gate table.
- Employee access per device: `services/employee-access.ts` and `EmployeeDeviceAccess`. The zone picker maps onto device lists.
- RBAC: `api/permissions.ts` (`ROLE_PERMISSIONS`, `requirePermission`).
- Photo handling:
  - JPEG validation in `api/jpeg.ts`
  - storage path via `photoPathFor` (`user-id.ts`)
  - 480×640 normalisation in `web/src/lib/photo.ts`
  - webcam capture in `web/src/components/webcam-capture.tsx`
- Report registry: `reports/registry.ts`. The e2e harness: `backend/scripts/verify-e2e.ts` (simulated terminal via `app.inject`).
- Hand-rolled UI kit: `web/src/components/ui.tsx`. API client and SWR: `web/src/lib/api.ts`, `web/src/lib/swr.ts`.

## Upgrade from 0.4.19 (applies to every phase)

The 0.5.0 installer must upgrade an existing single-zone 0.4.19 site in place, keeping all its data, and that site must keep working the way it did. A one-zone site is a zone tree with a single node, and the product supports that as a normal case, not a legacy mode.

**Rules every phase follows:**
- **Migrations are additive and backfill in SQL.** Nothing is dropped while old rows still need reading. Every migration header says what an upgraded site sees afterwards.
- **No behaviour change until an Admin opts in.** Phase 1 already does this: an existing device keeps `zone_id` NULL, which zone-based access never selects.
- **Upgraded sites get 0.4.19-compatible defaults:**
  - `Zone.exitCodeDefault` defaults to false. A single-entry pass at a site whose zones are all false loads its OUT gates together with its IN gates, which is the 0.4.19 behaviour.
  - Passing through a gate never starts to need an exit code just because the site upgraded.

**Per phase:**

| Phase | Upgrade obligation |
|---|---|
| 1 | Existing devices start with no zone (done). After the upgrade, an Admin creates one zone and places both terminals in it before issuing passes (Phase 4 refuses a pass with no placed gates). |
| 2 | Existing `ADMIN` / `AUTHORIZED_PERSON` accounts keep their roles and their exact permissions. New roles are additions. `visitorIdPrefix` must default to a value that existing visitor IDs already match. Check this against the site's `visitorIdPatterns`, or reconciliation will treat existing visitors as foreign. |
| 2b | Every existing operator keeps exactly the access they had. The migration creates one role row per old enum value, assigns every user, and seeds each role's grid from the Phase 2 matrix. No user overrides exist after upgrade. |
| 3 | Existing Persons with no pass type remain valid. A seeded default pass type covers rows migrated from `Entry`. Existing ID numbers are masked on display, and no stored value changes. |
| 4 | `Entry` → `Pass` is extended in place. The migration backfills `validFrom` from the entry start and `validUntil` from `retentionExpiresAt`. **Active passes:** a migration creates `PassGate` rows for every live entry on the devices it is currently provisioned to, in state `LOADED`, so no loaded face is lost or re-pushed. If that cannot be made exact, the upgrade precondition is "no visitors inside, no active passes" and the installer runbook says so. |
| 5–8 | New tables only. Existing reports keep their columns, and new columns are appended. |
| 9 | Upgrade acceptance (below). |

**Before any upgrade at a site:** back up the database (`pg_dump`) and the photo/document folders. The installer does not do this today.

---

## Phase 0: Docs baseline and legacy split

**Goal:** a clean documentation base before any code changes. No behaviour changes.

1. You make a baseline commit of the current tree first. The repo has no commits yet, and I only commit when you ask.
2. `git mv` every file in `docs/` to `docs/legacy/`, content untouched. Add `docs/legacy/README.md` explaining that these files are historical and pointing to their replacements.
3. New current docs, importing only knowledge that is still true:
   - `docs/README.md`: index and reading order.
   - `docs/PRODUCT.md`: the two-zone spec, covering zones, visitor/pass types, the planned/walk-in/long-term flows, gate-loading timings, the controls, roles, the configurable toggles, and the DPDP notice/consent requirement.
   - `docs/DEVICE_PROTOCOL.md`: the verified ADMS/firmware knowledge from `legacy/VMS_PROJECT_CONTEXT.md` §2–4 and PRD §4.1. That covers the quirks, commands, record formats, `Grp` blocking, no native expiry, denials not pushed, duplicate-punch period, PUSH_PHOTO `-1001` and the 480×640 fix, plus a "verify on each of the 4 new terminals" checklist.
   - `docs/ARCHITECTURE.md`: current system shape (services, queue, jobs, installer), carried from AGENTS.md, PRD §3/§10/§12–13 and SESSION_HANDOFF_PHASE6's traps list.
   - `docs/PLAN.md`: this plan, with a status table per phase.
   - `docs/EXECUTION_LOG.md`: dated entries per phase (change, files, verification result, issues, next action).
   - `docs/DECISIONS.md`: one row per decision. It includes every client answer so far and the 23 Sep confirmations: code for single entry only, per-pass exit selection, admin-card outage release with automatic release on recovery, and ID redaction. It also records the rule #9 amendment and the memory notes brought up to date.
   - Still-operational runbooks (`INSTALL_GUIDE`, `LICENSING`, `VERSIONS`, `KNOWN_ISSUES`, `PEOPLE_TRANSFER`): keep the originals in legacy, and copy each forward into `docs/` only when a phase changes that area. `KNOWN_ISSUES.md` and `VERSIONS.md` are copied forward now, since they're live registers.
4. Rewrite `CLAUDE.md` and `AGENTS.md` for the two-zone product:
   - keep the hard rules and add the #9 amendment (OTP/override exit, admin-card release during outages, automatic release on recovery)
   - keep the device quick reference
   - update the domain paragraph and the doc pointers to the new set

**Verify:** `npm test` (backend) passes, `npm run lint && npm run build` (web) pass, and `git status` shows renames only plus new docs. Read `docs/README.md` → `PRODUCT.md` and check it matches what you told the client.
**Stop.**

## Phase 1: Zones and gates

**Goal:** the system knows the site topology. Employees get access by zone.

**Schema:**
- `Zone` table: `id`, `name`, `parentZoneId?`, `isActive`, `exitCodeDefault`. Hierarchical, so access to a child zone implies its ancestors (Yard → Premise).
  - `exitCodeDefault` is true on the office zone and false on Yard. That default is what pre-ticks each zone's exit on a pass. It's config, not code.
- Nullable `Device.zoneId`.
- `Device.role` is reused. IN/OUT is the gate direction.

**Service:**
- Add `zoneDevices(zoneIds)` in `services/zones.ts`. It returns the IN and OUT devices for those zones plus their ancestors, in one query.
- Validation: a zone with devices needs at least one IN and one OUT device before a pass can target it. This is a warning, not a block.

**API and UI:**
- Admin zone CRUD (Directory-style).
- A zone selector on the Devices page.
- Employee access panel: choose zones, which expands to devices and reuses `assignEmployeeDevices` / `removeEmployeeDevice`. Per-device overrides stay possible.

**Audit:** `ZONE_CREATED/UPDATED`, `DEVICE_ZONE_CHANGED`.

**Verify:**
- New unit test for zone expansion.
- e2e section for 4 simulated devices, 2 zones, and an office-only vs yard employee landing on the correct devices.
- UI walk-through.

**Stop.**

## Phase 2: Roles and settings

**Goal:** the new roles exist, and every toggle the client may flip is a setting.

**Roles:**
- `UserRole` gains `HOST`, `SECURITY`, `SECURITY_INCHARGE`, `HR`, `HOD`, alongside `ADMIN` and `AUTHORIZED_PERSON`.
- New permissions:
  - `VISIT_REQUEST` (host)
  - `VISIT_REVIEW` (the host of that request)
  - `WALKIN_REGISTER`, `LONGTERM_ISSUE`, `EXIT_OVERRIDE` (Security)
  - `BLACKLIST_MANAGE` (Security In-charge)
  - `ZONE_WIDEN` (host)
  - `SETTINGS_MANAGE` (Admin)
- The permission matrix is documented in `PRODUCT.md`.

**Settings (`services/settings.ts`, typed with zod defaults):**

| Setting | Default |
|---|---|
| `entryLoadLeadMinutes` | 5 |
| `unloadAfterPunchMinutes` | 10 |
| `walkInRequiresHostClear` | true |
| `outageGapMinutes` | 10 (a heartbeat gap longer than this counts as an outage, see Phase 7) |
| `visitorIdPrefix` | e.g. `V` |
| `linkExpiryHours` | |
| `otpTtlMinutes` | |
| `otpMaxAttempts` | |
| document limits | as in standing decisions |
| `dpdpNoticeText` | |
| `dpdpNoticeVersion` | |

The exit-code rule is not a setting. It follows the client's confirmed rule: single entry gets a code, multi entry doesn't. Which exits the code opens is chosen per pass (Phase 4). The earlier `longTermExitOtpRequired`, `exitOtpScope` and `exitOtpEveryExit` settings are dropped.

- Settings page (Admin) plus the `SETTINGS_CHANGED` audit with old/new values.

**Verify:**
- `permissions.test.ts` extended with the new role matrix.
- Settings round-trip and audit in e2e.
- Log in as each role and confirm what's visible.

**Stop.**

## Phase 2b: Configurable access (custom roles, feature grid, per-user overrides)

**Goal:** an Admin decides what each role may do, and can adjust any single
operator, without a code change. Access is a grid of **feature × action**
(View / Create / Update / Delete), as in the owner's existing product. Decided
2026-10-02: custom roles, and per-user overrides that can both **allow** and
**deny**.

**Schema:**
- `Role`: `key`, `name`, `description`, `isSystem`, `isActive`.
  - One row per former enum value: Admin, Authorized person, Host, Security,
    Security in-charge, HR, HOD.
  - Admins can add custom roles.
- `AppUser.roleId` replaces the `role` enum column. The backfill maps every
  existing user before the old column is dropped.
- `RolePermission` (role, resource, action): a row present means allowed.
- `UserPermissionOverride` (user, resource, action, `effect` = `ALLOW` | `DENY`):
  no row means the user inherits from their role.

**Resource catalogue (code, `services/access.ts`):**
- Each feature is listed with its group, label and **the actions that apply to
  it**. A cell for an action that doesn't apply is not shown.
- Features that don't fit view/create/update/delete get their own row with
  only the actions that make sense: exit override, blacklist, command retry,
  device refresh, maintenance.
- **Delete never deletes data** (hard rule #3). Where Delete appears it means
  deactivate or remove from terminals, and the grid labels it that way. Audit,
  punches and history have no Delete.
- Later phases add their own features to the catalogue, so they appear in the
  grid automatically.

**Resolution:**
- Effective access = (role grants ∪ user ALLOW) − user DENY.
- The **Admin** system role always has everything. It cannot be edited,
  deactivated or overridden, so nobody can lock the site out.
- Saving is refused if it would leave no active user able to manage access.
- Resolved per user and cached briefly in process. The cache is invalidated
  immediately on any role, grant or override change, so revocation still
  takes effect on the next request (as today).
- `/api/auth/me` returns the effective `resource:action` list. The console's
  `can()` is unchanged in shape.
- **Ownership rules stay in code.** For example, a host reviews only their own
  visitors' requests. The grid decides *whether* a role may review at all; the
  code decides *which* records.

**Route guards:**
- Every `requirePermission(...)` moves to a `resource:action` key, e.g.
  `people:view` or `passes:create`. This is mechanical, across roughly 80
  routes.
- The Phase 2 matrix becomes the seed data that reproduces today's behaviour
  exactly.

**API (Admin; audited old → new):**
- Roles:
  - `GET /api/access/catalogue`
  - `GET/POST/PATCH /api/roles` (create, rename, deactivate; system roles
    can't be renamed or deactivated)
  - `GET/PUT /api/roles/:id/permissions`
- Per operator: `GET/PUT /api/operators/:id/permissions`, where each cell is
  inherit, allow or deny.
- Audit actions: `ROLE_CREATED`, `ROLE_UPDATED`, `ROLE_PERMISSIONS_CHANGED`
  (cells added/removed), `USER_PERMISSIONS_CHANGED` (cells and effects).

**Console:**
- **Access → Role defaults:** role dropdown, resource search, grouped grid,
  ✓/✗ per applicable cell, Save. Admin shows read-only.
- **Access → Roles:** list, add a custom role, rename, deactivate.
- **Operators → (operator) → Access:** the same grid. Each cell is
  Inherit (shows the role's value) / Allow / Deny, and overridden cells are
  highlighted.
- The operator role picker lists active roles from the database.

**Verify:**
- Unit tests:
  - effective-access resolution (inherit, allow adds, deny removes, Admin
    immune)
  - the seed reproduces the Phase 2 matrix cell for cell
  - every route key exists in the catalogue
- e2e:
  - create a custom role with a few cells, assign a user, and confirm the
    allowed and refused calls
  - a user ALLOW override grants one extra action; a DENY override revokes
    one the role has
  - a change takes effect on the next request with no re-login
  - lock-out protection: Admin is immune, and the last access manager can't be
    stripped
  - every change is audited
- Manual: `VERIFICATION.md` § Phase 2b, together with § Phase 2.

**Stop.**

## Phase 3: Pass types, visitor profile and documents

**Goal:** per-type validation, and documents stored safely.

**`PassType` table** (config, seeded with the client's 5 types):
- `name`
- `kind` (`SHORT_TERM` | `LONG_TERM`)
- `entryModes` allowed
- `requiresHostClear`
- `maxValidityDays`
- `fieldRules` JSON (each field: required/optional/hidden)
- optional external credential: label, plus whether its expiry caps the pass (the BCBA case, generically)

**Person fields added (all nullable):**
- `email`, `designation`
- `govtIdType`, `govtIdNumber`
- `vehicleNumber`
- `policeClearance` (bool)
- `credentialNumber`, `credentialExpiresAt`

The old fixed completion rule (Company + Department + Aadhaar/PAN) is replaced by the pass type's `fieldRules`. It stays in force for Employees.

**ID redaction:**
- A `maskId()` helper keeps the first 2 and last 2 characters and turns the rest into `*` (e.g. `CI******7b`). Values of 4 characters or fewer are fully masked.
- It applies to Govt ID number, Aadhaar, PAN and credential number, in every Person DTO (`api/people.ts`), in entry and pass views, and in reports/CSV (`reports/registry.ts`).
- The existing Aadhaar/PAN "present" badges stay.
- Edit forms show the masked value. Typing a new value replaces it; leaving it untouched keeps the stored value.
- Uniqueness and returning-visitor checks keep running server-side against the full stored value.
- The admin-only people transfer script keeps full values, because it's a backup format. That's documented.

**Documents:**
- `PersonDocument` table (`personId`, `visitRequestId?`, `kind`, `fileName`, `mime`, `size`, `path`, `uploadedBy`/`source`).
- Storage under `data/documents/`.
- Upload validated by magic bytes and the size/count settings. Download served as `Content-Disposition: attachment`.

**UI:** a pass-type admin screen; person forms driven by `fieldRules`; a documents panel on the person page.

**Audit:** `PASS_TYPE_*`, `DOCUMENT_UPLOADED/DOWNLOADED`.

**Verify:**
- Unit tests for `fieldRules` validation (customs passes with name + designation only; CHA fails without the credential expiry).
- `maskId` unit test, plus an e2e check that no API or CSV response contains a saved full ID number.
- Document magic-byte, size and count rejection tests.

**Stop.**

## Phase 4: Gate-load engine (the core refactor)

**Goal:** faces are loaded per terminal, per rule, on time. Exercised first through Security-issued passes, before the portal exists.

**Schema:**
- `Pass`: this is today's `Entry`, extended in place so the old history stays valid:
  - `passTypeId`, `zoneIds`
  - `exitCodeZoneIds`: which zones' exits need the code. Only meaningful for SINGLE entry. It's pre-filled from `Zone.exitCodeDefault`, so the office exit is always included and Yard is an optional tick.
  - `validFrom`, `validUntil` (replacing retention policies; existing rows are kept)
  - `hostId?`, `location` (`OUTSIDE` | `PREMISE` | `YARD` zone id)
  - `blacklist` handled at Person level
- `PassGate`, one row per (pass, device):
  - `direction`, `loadAt`, `unloadAt`
  - `state` (`PENDING` → `LOADING` → `LOADED` → `UNLOADING` → `DONE`)
  - `reason` (`SCHEDULE` | `EXIT_OTP` | `OVERRIDE` | `WIDEN`)
- Unique on (pass, device, cycle).

**Engine (`services/gate-engine.ts` plus a one-minute pg-boss job):**
- Rows due to load (`loadAt ≤ now`, `PENDING`): queue `PROVISION` + `PUSH_PHOTO` through `enqueueIn`.
- Rows due to unload (`unloadAt ≤ now`, `LOADED`): queue `DEPROVISION`.
- Both happen in one batched read and one transaction (rule #4, same shape as `jobs/expiry.ts`).
- Acks drive `LOADING→LOADED` and `UNLOADING→DONE`, plus per-device `facesUsed`. This refactors `completeProvisionIfReady` / `completeDeprovision` to key on `PassGate`.
- Duplicate-safety: a person already loaded on a device from another active row is never double-provisioned or deleted early. The engine checks for other live rows before unloading.

**Rules wired to events:**
- Pass issued: IN gates of the zones (plus ancestors) get `loadAt = validFrom − entryLoadLeadMinutes` and `unloadAt = validUntil`. OUT gates are then scheduled as follows:
  - **MULTI entry:** every OUT gate gets the same `loadAt`/`unloadAt` as the IN gates. There is no exit code.
  - **SINGLE entry:** OUT gates of zones **not** in `exitCodeZoneIds` load with the IN gates, for example Yard OUT when Yard isn't ticked. OUT gates of zones in `exitCodeZoneIds` are created only on a verified exit code (Phase 7) or a Security override.
- IN punch on device X, SINGLE entry: `X.unloadAt = punch + unloadAfterPunchMinutes`. MULTI entry is untouched.
- OUT punch on device Y, SINGLE entry: `Y.unloadAt = punch + unloadAfterPunchMinutes`. MULTI entry is untouched. `location` is updated from the gate's zone.
- `validUntil` reached: IN rows unload. A SINGLE-entry visitor still inside keeps their already-loaded OUT rows and is listed as "overstayed" for Security. MULTI-entry OUT rows follow the old rule: if the visitor is inside, they unload only after the OUT punch.
- Security override (mandatory reason) for a SINGLE-entry visitor: creates the missing code-gated OUT rows (`reason = OVERRIDE`, `loadAt = now`). It's used when the exit-code route fails (host unreachable, phone dead, SMS down). Audit `EXIT_OVERRIDE` records operator, visitor, time and reason.
- Zone widening: adds IN rows for the new zone (`reason = WIDEN`, `loadAt = now`). Its OUT rows follow the same SINGLE/MULTI rule. Audit `ZONE_WIDENED` against the host.
- Blacklist:
  - `Person.blacklistedAt/By/Reason` is set.
  - All live rows get `unloadAt = now`.
  - Issuing any pass is refused while blacklisted.
  - Audits: `BLACKLISTED`, `BLACKLIST_LIFTED`.

**Security console:** issue a long-term pass (per `PassType`), a live board of passes by location, Release (override), Blacklist.

**Retire** the SINGLE_ENTRY day-block and daily reset, and the old retention-policy provisioning UI. The deletions are listed in the log. Code stays only where old rows still need reading.

**Reconciliation:** "who should be on device D" becomes live `PassGate` rows for D plus desired `EmployeeDeviceAccess`. Everything else is healed as today.

**Verify:**
- An e2e section on 4 simulated terminals. Time is advanced by setting `loadAt`/`unloadAt` in the past. It covers:
  - lead-time load
  - per-gate single-entry unload
  - multi-entry: IN and OUT loaded together, no code, and persistent for the whole pass
  - single-entry office pass: Outer OUT absent until override
  - single-entry yard pass: Yard OUT is free when Yard isn't ticked and code-gated when it is
  - override → code-gated OUTs → unload 10 min after exit
  - widening
  - blacklist purge
  - expiry while inside → overstayed
  - facesUsed accuracy
  - the query budget for the engine tick
- On real hardware (as many terminals as are available): a long-term pass walk-through.

**Stop.**

## Phase 5: Messaging outbox and visitor portal

**Goal:** a visitor can receive a link, verify their mobile, consent, submit details, a selfie and documents.

**Messaging:**
- `Message` table (to, channel, template, body, status, relatedEntity).
- `services/notify.ts` with a `console` transport, selected by env.
- Admin Outbox page to read links and OTPs locally.

**OTP and links:**
- `Otp` table: hashed code, purpose, target, expiry, attempts, consumedAt. The limits come from settings.
- Link tokens: 32 random bytes, stored hashed, with expiry. One live token per request.

**Public API** under `/public-api/*`, unauthenticated but token-scoped. It gets its own rate limit (a small in-memory limiter, no new dependency), and no operator data is reachable from it.
- A Next.js route handler (`web/src/app/public-api/[...path]/route.ts`) proxies `/public-api` to the backend, reading `API_BASE_URL` at request time, so the portal is same-origin. (Not `rewrites()`: those are fixed at build time, and the installer sets the backend port after the build.)

**Moved forward from Phase 6:** a portal needs something for the link to point at, so the core of `VisitRequest` lands here: a host raises a request (which sends the link), the visitor completes and submits it, the host can see it, resend the link or cancel. Phase 6 adds Clear / Query / Reject, walk-ins and turning a cleared request into a pass.

**Portal pages** under `web/src/app/v/[token]/`:
1. mobile OTP
2. DPDP notice plus consent checkbox (`ConsentRecord`: person/request, noticeVersion, timestamp)
3. form driven by the pass type's `fieldRules`
4. live selfie with a face-guide overlay (reuses `webcam-capture.tsx` and the `photo.ts` 480×640 normalisation; camera only, no gallery)
5. document upload
6. submitted screen

A returning visitor (matched by mobile) is prefilled from their existing Person.

**Verify:**
- API tests for token expiry/reuse, OTP attempts/expiry, the rate limit, and field rules.
- Full portal run on a phone over LAN HTTPS (mkcert or a temporary tunnel), because the camera needs a secure origin.

**Stop.**

## Phase 6: Visit requests, host review, walk-ins

**Goal:** the complete request → decision → pass flow, with full history.

**Schema:**
- `VisitRequest`:
  - host, visitor contact, company, purpose
  - `zoneIds`, `passTypeId`, `entryMode`, `expectedAt`, `validUntil`
  - `exitCodeZoneIds`: the Yard-exit tick appears on the request form only for single entry with Yard selected
  - `status` (`SENT` | `SUBMITTED` | `QUERIED` | `CLEARED` | `REJECTED` | `CANCELLED` | `EXPIRED`)
  - `personId?`, `passId?`, `origin` (`PLANNED` | `WALK_IN`)
- `VisitRequestEvent`: an append-only history row for every transition (actor, from→to, query text, reason, snapshot of the submitted fields). Nothing is ever deleted.

**Host flow:**
- create a request → the link is messaged
- review screen: details, selfie, documents, and a returning-visitor badge
- Clear: find or create the Person by mobile; assign a unique device ID (`visitorIdPrefix` + a sequence, validated against the devices' `visitorIdPatterns`); save the selfie as the enrollment photo; create a `Pass` → the engine
- Query: requires text; a new link is sent showing the query
- Reject: the visitor is messaged

**Walk-in (Security):** the same form at the gate. The mobile OTP is typed by Security. The face is captured on the gate PC. A host is picked.
- If `walkInRequiresHostClear` is on, it waits for the host's Clear.
- If it's off, the pass is issued straight away.

**Security retake:** replace the photo on an active pass, re-queue `PUSH_PHOTO` on its loaded gates, and audit it.

**Verify:**
- e2e for every transition: query loop ×2, reject, clear → gates scheduled; walk-in in both setting modes; a returning visitor keeps the same device ID.
- UI walk-through as Host and as Security.

**Stop.**

## Phase 7: Exit code, out-pass, and outage recovery

**Goal:** the code-gated exit for single entry, plus automatic release after a system outage.

**Exit code (SINGLE entry only; MULTI entry never gets one):**
- The first IN punch on a single-entry pass messages the host an arrival note with the exit code, and messages the visitor the out-pass link.
- A single-entry long-term pass (no host) sends the code to the Security desk. It's shown on the Security console, and also messaged to Security In-charge if they have a phone.
- The out-pass page takes the code. A verified code creates the code-gated OUT `PassGate` rows for `exitCodeZoneIds` (`reason = EXIT_OTP`).
- Audit: `EXIT_OTP_ISSUED/VERIFIED/FAILED`.

**Outage recovery (the client's admin-card procedure):**
- The backend writes a heartbeat (`app_config`) every minute from the engine tick.
- On startup, and on every tick, a heartbeat gap longer than `outageGapMinutes` creates an `Outage` row (`startedAt` = last heartbeat, `endedAt` = now).
- On recovery, the system automatically releases every pass affected by the outage:
  - it's a SINGLE-entry pass with a visitor still inside, and was active during the outage window
  - it's marked `location = OUTSIDE`, `releasedBy = OUTAGE`, linked to the outage
  - its remaining gate rows unload (MULTI-entry passes that are still valid are untouched)
- Each release writes an `OUTAGE_RELEASE` audit row. Actor is the system, detail is the outage id.
- A Security page lists the outage and its released people, so the manual admin-card register can be reconciled against it.
- Passes whose `validUntil` fell inside the outage are closed by the normal sweeper on the first tick.

**Verify:**
- e2e for the full single-entry visit: request → clear → load → IN → code → OUT gates → exit → unload.
- e2e: a multi-entry visit never gets a code; wrong/expired code; Yard-exit tick on/off.
- e2e: simulated outage (heartbeat set in the past) → the affected single-entry insiders are released and audited, multi-entry passes untouched.
- A hardware walk-through on the real terminals.

**Stop.**

## Phase 8: Reports and audit coverage

**New registry reports:**
- visit requests (every status, with query history)
- exit overrides (operator, visitor, time, reason)
- outages and outage releases (for reconciling the manual admin-card register)
- blacklist history
- zone presence / overstayed
- pass-type utilisation
- messages sent

**Audit sweep:** every new route declares a permission and writes audit. There's a test that fails if a mutating route lacks an audit row.

**Verify:** report fixtures and CSV output; the audit-coverage test.

**Stop.**

## Phase 9: Tunnel, hardening, packaging, acceptance

- **Cloudflare Tunnel runbook** in `docs/INSTALL_GUIDE.md`:
  - installs `cloudflared` as a Windows service
  - ingress exposes only `^/(v/|_next/|public-api/)` on the web port; the console and `/iclock` are never exposed
- **Hardening:** public-route rate limits, token/OTP brute-force checks, upload fuzzing, and a CORS/Host header check.
- **Installer:** version bump (0.5.0), the new env keys, and the updated `VERSIONS.md`.
- **Upgrade acceptance from 0.4.19,** on a disposable Windows machine:
  1. Install 0.4.19 and restore a copy of a real 0.4.19 database plus its photo folder, with at least one active visitor pass and one Employee.
  2. Install 0.5.0 over it. It must upgrade in place (same `AppId`), and migrations apply on service start.
  3. Check that Persons, photos, Employees and their device access, punches, attendance, audit history, operators and settings are all intact.
  4. The active pass's face is neither deleted nor re-pushed. Reconciliation removes nothing it shouldn't.
  5. Create one zone, place both terminals, and issue a single-entry pass. It behaves like 0.4.19: IN and OUT load together, with no exit code.
  6. Record the result and the upgrade runbook in `VERSIONS.md` (0.5.0 upgrade notes) and `INSTALL_GUIDE.md`.
- **Real-terminal acceptance on all 4 devices:** firmware identity, blocked-group existence, PUSH_PHOTO of phone selfies, and the timings. Also:
  - the admin card opens each barrier during an outage
  - the card holder's user ID matches neither ID pattern and is never touched by reconciliation
  - whether a card release produces a punch record (recorded verbatim)
  - Results recorded in `DEVICE_PROTOCOL.md` and `KNOWN_ISSUES.md`.

**Stop.** Then release.

---

## Verification commands (every phase)

```bash
cd backend && npm run typecheck && npm test
DATABASE_URL=postgresql://…/vms_test npx prisma migrate deploy && npx tsx scripts/verify-e2e.ts
cd ../web && npm run lint && npm run build
```

Each phase adds its own e2e section, plus the manual UI/hardware checks listed above, and ends with a report and a pause for your go-ahead.

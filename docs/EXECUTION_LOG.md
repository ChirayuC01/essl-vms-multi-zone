# Execution Log — Two-Zone Rebuild

Append-only. One entry per material change or verification, per phase. A
failed check stays recorded after it is fixed; append the resolution.

Entry shape: date · phase · status · change · files · verification (exact
result) · issues · next action.

---

### 2026-10-02 — Phase 0 — Docs baseline and legacy split

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`.
- **Baseline:** commit `0bd3080` ("replicated vms for one zone") exists. The
  working tree also shows ~117 files modified before this phase began; the
  diff is **line endings only** (`git diff --ignore-cr-at-eol` is empty). Left
  untouched — not part of this phase.
- **Change:**
  - `git mv` of every file under `docs/` (22 documents plus `deliverables/`,
    `postman/`, `reference/`) into `docs/legacy/`, content unchanged.
  - Added `docs/legacy/README.md` mapping each legacy file to its replacement.
  - New current docs: `README.md`, `PRODUCT.md`, `DEVICE_PROTOCOL.md`,
    `ARCHITECTURE.md`, `PLAN.md`, `DECISIONS.md`, this log.
  - Copied forward unchanged (live registers/runbooks): `KNOWN_ISSUES.md`,
    `VERSIONS.md`, `DEVELOPMENT_SETUP.md`, each with a carry-forward note.
  - Rewrote `CLAUDE.md` and `AGENTS.md` for the two-zone product: hard rules
    kept, rule #9 amended (exit code / override, admin-card outage release,
    automatic release on recovery), doc pointers moved to the new set.
- **Not changed:** no source, schema, config or installer file.
- **Verification (2026-10-02):**
  - Backend `npm run typecheck`: PASS.
  - Backend `npm test`: **82/82 PASS**. Run through Windows Node
    (`cmd.exe /c … npm test`): `node_modules` is installed for Windows, so
    `tsx` under WSL fails with "esbuild installed for another platform". This
    is environmental, not a test failure.
  - Web `npm run lint` and `npm run build`: PASS (Windows Node), all 20 routes
    built.
  - `verify:e2e`: not run. No source changed in this phase, and it needs a
    `*_test` database.
  - `git status`: only renames into `docs/legacy/`, new files under `docs/`,
    and `CLAUDE.md`/`AGENTS.md`. Apart from the pre-existing line-ending noise,
    `git diff --ignore-cr-at-eol` touches only those two files.
- **Next action:** owner reviews `docs/README.md` → `PRODUCT.md` against what
  the client was told; on acceptance, Phase 1 (zones and gates) begins.

### 2026-10-02 — Phase 0 — accepted

- Owner approved and asked for the commit. Committed as `33da17e` with only
  the Phase 0 files. The pre-existing line-ending-only modifications were left
  out of the commit.

### 2026-10-02 — Phase 1 — Zones and gates

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`.
- **Change:**
  - Schema: new `Zone` (tree via `parentZoneId`, `isActive`,
    `exitCodeDefault`) and nullable `Device.zoneId`. Migration
    `20261002120000_zones` is additive only. Zone names are unique
    case-insensitively, through a functional index (same as companies and
    departments). Every existing terminal stays unplaced, so behaviour is
    unchanged until an Admin places terminals.
  - `services/zones.ts`:
    - `expandZoneIds` (a zone plus its ancestors; bounded so a stored cycle
      cannot hang)
    - `wouldCreateCycle`
    - `zoneDevices` (two small queries whatever the number of zones; inactive
      zones refused)
  - `api/zones.ts`:
    - `GET /api/zones` returns each zone with its IN/OUT/BOTH terminal counts
      and a warning when entry or exit is missing.
    - `POST /api/zones` and `PATCH /api/zones/:id` cover rename, re-parent
      (cycle refused), `exitCodeDefault` and active.
    - Gated by the existing `device:configure` permission, since topology is
      gate configuration. No new permission was added.
  - `PATCH /api/devices/:id` accepts `zoneId` (null = unplaced). The device
    list returns `zoneId`.
  - Employee access (`POST /people/:id/device-access` and `/rehire`) accepts
    `zoneIds` as well as `deviceIds`. Zones expand at grant time and storage
    stays per device, so reconciliation and removal are unchanged.
  - Audit actions: `ZONE_CREATED`, `ZONE_UPDATED` (with before/changes),
    `DEVICE_ZONE_CHANGED` (from/to). The device PATCH route previously audited
    nothing; it now audits zone moves only.
  - Web:
    - a Zones card at the top of the Devices page (`components/zones-card.tsx`)
    - a Zone selector on each terminal card
    - a Zones picker beside "Add devices" and "Rehire on devices" on an
      employee's page
- **Decision:** zone management reuses `device:configure` rather than a new
  permission (ladder: reuse what exists). Role work is Phase 2.
- **Verification (2026-10-02):**
  - `prisma migrate diff` (migrations vs schema, shadow database): "No
    difference detected."
  - Backend typecheck PASS. Unit tests **88/88 PASS**, of which 6 are new in
    `services/zones.test.ts`: expansion through three levels, union, unknown
    zone refused, stored cycle bounded, re-parent cycle detection.
  - `verify:e2e` against `vms_test`: **284 passed, 0 failed**. New section 26
    (18 checks) covers:
    - creating a root zone and a child zone
    - case-insensitive duplicate refused
    - cycle refused
    - 4 terminals placed in their zones, with every placement audited
    - gate counts, and the warning on an empty zone
    - an office-zone employee getting the outer IN/OUT only
    - a yard-zone employee getting all 4 terminals
    - an inactive zone grant refused (409)
    - zone audits present
  - Web lint and production build PASS.
  - The UI was not exercised in a browser in this session. That is the
    owner's walk-through.
- **Issues hit and resolved:**
  1. The first e2e run returned `LICENSE_EXPIRED` everywhere. This machine's
     trial (in Windows ProgramData, outside the database) expired on
     28 Sep 2026. Fixed for the run by pointing `PROGRAMDATA` at a scratch
     folder. Not a product defect.
  2. That crashed run left the harness's synthetic `data/photos/90001.jpg`
     (228 bytes, created 17:18 IST by the run itself). The next run refused to
     start because of it. The file was deleted, and later runs use
     `PHOTO_STORAGE_PATH=./data/photos-e2e`. Both isolation steps are now
     documented in `DEVELOPMENT_SETUP.md` § Verify the source tree.
- **Environment:**
  - Dev PostgreSQL (port 48103) was started for this work and is still
    running.
  - The new migration was also applied to the dev `vms` database.
  - `vms_test` and `vms_test_shadow` exist on it.
- **Next action:** owner walk-through:
  1. Devices page: create "Office/Premise" (exit code by default ticked), then
     "Yard" inside it.
  2. Place each terminal into its zone.
  3. On an employee, tick a zone and Assign. Check the device access table
     lists the expected terminals.
  4. Then accept, or report issues.

## 2026-10-02 — Plan: upgrade path from 0.4.19

- Added "Upgrade from 0.4.19" to `PLAN.md` (per-phase upgrade obligations)
  and a 0.4.19 → 0.5.0 trial-upgrade acceptance step to Phase 9.
- Four decisions recorded in `DECISIONS.md`. Docs only; no code changed.

### 2026-10-02 — Docs — testing with two terminals

- Added `docs/TESTING_WITH_TWO_TERMINALS.md`, linked from `docs/README.md`. It
  explains, in plain language, how to develop and test the two-zone system
  with only two physical terminals:
  - one zone at a time on real hardware
  - a real pair plus a virtual pair, played by hand over HTTP for flows that
    cross both zones
  - the automated four-terminal e2e suite
  - what still needs the client's real four terminals
  - common problems
- The doc notes that a one-line terminal simulator is planned for Phase 4.

### 2026-10-02 — Phase 1 — accepted

- Owner asked for the commit and for Phase 2 to start. Phase 1 is marked
  `ACCEPTED`. The manual walk-through steps are recorded in
  `docs/VERIFICATION.md` (new: the per-phase manual verification tracker).
  Individual step results were not reported, and the status table there says
  so.

### 2026-10-02 — Phase 2 — Roles and settings

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`.
- **Change:**
  - **Roles:** `UserRole` gains `HOST`, `SECURITY`, `SECURITY_INCHARGE`, `HR`
    and `HOD`. Migration `20261002130000_access_roles` is additive (`ALTER TYPE
    … ADD VALUE`).
  - **Permissions:** eight new ones in `api/permissions.ts`: `visit:request`,
    `visit:review`, `walkin:register`, `longterm:issue`, `exit:override`,
    `blacklist:manage`, `zone:widen`, `settings:manage`. Matrix:
    - Admin: everything.
    - Security: the existing operator set, plus walk-in, long-term and exit
      override.
    - Security in-charge: Security, plus blacklist and audit read.
    - Host: request, review and widen only, with **no READ**.
    - HR and HOD: READ only.
    - Authorized Person: unchanged.
  - **Settings:** `services/settings.ts` stores one `app_config` row
    (`site_settings`); each field has a zod default and a corrupt field falls
    back alone. `PATCH` is strict: unknown keys are refused and the notice
    version is server-set. Only changed keys are written to the
    `SETTINGS_CHANGED` audit row, old → new, and an unchanged patch writes
    nothing. `GET /api/settings` needs `read`; `PATCH` needs `settings:manage`.
  - **Web:**
    - Operators page: role picker with every role (`ROLE_LABELS` in
      `lib/format.ts`); your own role isn't editable. The old Make
      admin/operator toggle is replaced.
    - Navigation: pages are now gated by `read` / `entry:manage`. A role
      without `read` (Host) gets a welcome card instead of the dashboard,
      which would otherwise fail with 403s.
    - Settings page: new System settings card
      (`components/site-settings-card.tsx`).
- **Verification (2026-10-02):**
  - Backend typecheck PASS. Unit tests **97/97 PASS**, of which 9 are new:
    settings defaults, per-field fallback, patch validation, plus the role
    matrix (host, security, in-charge, HR/HOD, settings admin-only).
  - `verify:e2e` against `vms_test`: **297 passed, 0 failed**. New section 27
    (13 checks) covers:
    - defaults
    - admin change, with the audit holding old/new and changed keys only
    - an unchanged patch is not audited
    - invalid and unknown keys refused
    - notice version stamped
    - real sign-in as Host, Security, Security in-charge and HR: the host
      can't browse people, Security reads but can't change settings, the
      in-charge holds blacklist and exit override, HR can't configure
    - refusals audited
  - Web lint and production build PASS.
  - The migration was applied to dev `vms` and to `vms_test`.
- **Next action:** owner walk-through, `VERIFICATION.md` § Phase 2.

### 2026-10-02 — Phase 1 — verified

- Owner confirmed the Phase 1 manual verification. `VERIFICATION.md` and
  `PLAN.md` are updated. Phase 2 is still awaiting verification; the owner is
  considering a configurable permission model before verifying it.

### 2026-10-02 — Plan — Phase 2b added (configurable access)

- Owner asked for Admin-configurable access, like their existing product.
  Decisions: **custom roles**, and **per-user overrides that both allow and
  deny**.
- Added **Phase 2b** to `PLAN.md`, between Phase 2 and Phase 3. It covers:
  - a Role table replacing the enum
  - a role × feature × action grid
  - per-user ALLOW/DENY overrides
  - a resource catalogue in code
  - lock-out protection (Admin immutable)
  - `resource:action` route keys
  - Admin screens for role defaults, roles and per-operator access
- Phase 2 will be verified together with 2b.
- Upgrade obligation recorded: existing operators keep exactly their current
  access.
- **No code changed yet.** Awaiting owner go-ahead.

### 2026-10-02 — Phase 2b — Configurable access

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION` (to be verified together with
  Phase 2).
- **Change:**
  - **Schema / migration `20261002140000_configurable_access`:**
    - new tables `role`, `role_permission` (role + `resource:action` cell) and
      `user_permission_override` (user + cell + `ALLOW`/`DENY`)
    - `app_user.role` enum becomes `role_key`, a foreign key to `role.key`;
      the `UserRole` enum is dropped
    - seed: seven roles (Administrator is the only system role, with no grant
      rows because it always holds everything). Each other role's cells were
      generated from the Phase 2 matrix through an explicit old→new mapping.
  - **`services/access.ts`:**
    - the feature catalogue: 26 features, each listing only its applicable
      actions, with notes such as "delete = deactivate"
    - `resolvePermissions`: (role grants ∪ ALLOW) − DENY; Admin always has all
    - a per user+role cache, cleared on every access-affecting write
  - **Route guards:** every `requirePermission` moved to a typed cell key. The
    old `READ` was split per feature (people, devices, commands, reports, …).
    A route-by-route mapping script reported no unmapped route. The compiler
    now rejects any unknown key.
  - **`api/access.ts`** (all audited):
    - `GET /access/catalogue`
    - `GET /roles` (access or operators view), `POST /roles` (with
      copy-from), `PATCH /roles/:key` (system role refused; deactivation
      refused while active operators remain)
    - `GET/PUT /roles/:key/permissions` (cells validated)
    - `GET/PUT /operators/:id/permissions` (Admins refused)
    - new audit actions: `ROLE_CREATED`, `ROLE_UPDATED`,
      `ROLE_PERMISSIONS_CHANGED`, `USER_PERMISSIONS_CHANGED`
  - **Operators API:** a role must be an existing, active role key.
    Role/active changes clear the access cache.
  - **Web:**
    - new **Access** page: role defaults grid with search, plus a Roles
      table (add with copy-from, rename inline, deactivate)
    - new **Operators → Access** page: per-cell Inherit/Allow/Deny,
      overrides highlighted
    - operator role picker loads roles from the database
    - every `can()` and nav key moved to cells; Settings is viewable
      read-only by `settings:view` holders, and branding is gated on
      `branding:update`
- **Upgrade check on the real dev database:** both existing operators kept
  their roles (Administrator, Authorized person). The grids were seeded:
  Authorized person 23 cells, Security 26, Security in-charge 28, Host 4,
  HR/HOD 13.
- **Verification (2026-10-02):**
  - `prisma migrate diff`: no difference.
  - Unit tests **93/93 PASS**. The old role tests were replaced by
    `services/access.test.ts`:
    - the seed equals the Phase 2 matrix for every role, read from the
      migration file
    - Admin has no rows and ignores DENY
    - inherit, ALLOW adds, DENY removes, unknown cells ignored
    - every `can()` / nav key in `web/src` names a real cell
  - e2e **321 passed, 0 failed**. The new section 28 (24 checks) covers:
    - the catalogue and seeded roles
    - custom role creation and copy-from
    - duplicate name refused, bad cell refused, Admin grid refused
    - a grid change applying without re-login
    - ALLOW and DENY overrides taking effect
    - effective access reported in `/auth/me`
    - Admin not overridable
    - deactivation rules, inactive or unknown role assignment refused
    - all audits
  - Web lint and build PASS.
- **Issues found by e2e and fixed:**
  1. A role change made directly in the database (not through the API) was
     hidden by the permission cache. The cache is now keyed by user **and**
     role, so it is picked up immediately, because requireAuth re-reads the
     role every request.
  2. The refusal message had lost the operator's role name. Restored.
- **Next action:** owner verifies Phase 2 and Phase 2b together
  (`VERIFICATION.md`).

### 2026-10-05 — Phase 2b — Settings Administrator-only by default

- Owner decision: by default only an Admin sees and can open Settings.
- Change: migration `20261005090000_settings_admin_only` removes the
  `settings:view` cell from every seeded role. It came from the old "view
  everything" mapping. Administrators always hold it; an Admin can still grant
  it to a role from the Access page, in which case that role sees settings
  read-only. No 0.4.19 operator loses anything, because settings didn't exist
  then. Applied to dev `vms` and `vms_test`.
- Tests:
  - Unit **94/94**, including a new check that the migration covers every
    seeded role.
  - e2e **321/321**. The section 27 check now expects Security to be refused
    both reading and changing settings.
- Docs: `VERIFICATION.md` Phase 2 Steps 2 and 4, `PRODUCT.md` §8 and
  `DECISIONS.md` updated.

### 2026-10-05 — Phases 2 and 2b — accepted

- Owner asked for the commit and for Phase 3 to start. Both phases are marked
  `ACCEPTED`. Individual manual-verification step results were not reported;
  `VERIFICATION.md` says so.

### 2026-10-05 — Phase 3 — Pass types, visitor profile, documents, ID redaction

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`.
- **Change:**
  - **Migration `20261005100000_pass_types_documents`:**
    - new `pass_type` table: name unique case-insensitively, kind, entry
      modes, host Clear, max days, `field_rules` JSON, credential label and
      "caps validity"
    - person columns: email, designation, Govt ID type/number, vehicle
      number, police clearance, credential number/expiry, pass type, and a
      stored `details_complete` backfilled with the existing rule
    - new `person_document` table
    - access cells `documents:*` and `pass_types:view`, granted to the roles
      that already hold the matching `people:*` cell
  - **`services/pass-types.ts`:** the field catalogue and per-type rules
    (required / optional / hidden, unlisted = optional, credential fields
    hidden without a credential label). It also holds `profileGaps`, under
    which employees and untyped visitors keep the old rule, and a batched
    `recomputeDetails`.
  - **People API:**
    - only name, category and ID are schema-required; everything else is
      checked against the person's rules, and refusals name the missing
      fields
    - new fields
    - masking in the single DTO (`services/redact.ts` `maskId`); masked
      echoes ignored on save (`isMasked`)
    - the needs-details filter uses the stored flag
    - provisioning checks the stored flag
  - **Pass types API** (`api/pass-types.ts`): list (with the field catalogue),
    create, edit and deactivate. All audited; rule changes recompute that
    type's people.
  - **Documents API** (`api/documents.ts`, `services/documents.ts`):
    - type detected from the bytes against the enabled types
    - size and count limits from settings (size max now 20 MB, matching the
      server's request limit)
    - stored under a generated name in `DOCUMENT_STORAGE_PATH` (default
      `./data/documents`)
    - downloads are attachments with `nosniff` + sandbox CSP + `no-store`
    - removal is soft
    - upload, download and removal are audited against the person
  - **Directory bulk assignment** now recomputes completeness for the affected
    people.
  - **`transfer-people.mjs`:** export reads full identity numbers from the
    database (`--database-url`, required) because the API masks them. It also
    carries the new fields and the pass type by name; import maps the pass
    type by name. `PEOPLE_TRANSFER.md` is carried forward from legacy with
    this change.
  - **Web:**
    - shared `components/profile-fields.tsx` (fields shown, hidden and
      starred by the rules)
    - new-person and edit forms gain a Visitor type picker; masked numbers
      are never pre-filled ("On file: 23********23 — type a new one to
      replace it")
    - a read-only profile summary on the person page
    - `components/documents-card.tsx`
    - new **Pass types** page with a rules editor
    - nav entry
- **Upgrade check on the dev database:** 4 existing people (2 employees, 2
  visitors) all stay complete. Document and pass-type cells were granted to
  Authorized person, Security, Security in-charge, HR and HOD; Host got none.
- **Verification (2026-10-05):**
  - `prisma migrate diff`: no difference.
  - Unit tests **106/106**. New suites: `pass-types.test.ts`,
    `redact.test.ts`, `documents.test.ts`. Two people schema tests were
    rewritten to check the default rule where it is now enforced.
  - e2e **347/347**. New section 29 (26 checks) covers:
    - official type with name + designation only; credential type refusing a
      missing credential; untyped visitor keeping the old rule
    - masked numbers in create, detail, list, by-pin, the audit report and
      its CSV, with no full number anywhere
    - a masked echo ignored and a typed value replacing it
    - stricter rules re-flagging existing people into needs-details
    - PDF accepted; HTML named `.pdf` refused (415); oversize refused (413);
      count limit (409)
    - download headers; soft removal
    - audits; documents need their own access cell
  - Web lint and build PASS.
- **Next action:** owner walk-through, `VERIFICATION.md` § Phase 3.

### 2026-10-05 — Phase 3 — accepted

- Owner asked for the commit and for Phase 4 to start. Phase 3 is marked
  `ACCEPTED`; manual step results were not reported.

### 2026-10-05 — Phase 4 — Gate engine

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`.
- **Change:**
  - **Migration `20261005120000_gate_engine`:**
    - enums `GateState`, `GateReason`
    - `entry` gains `pass_type_id`, `zone_ids`, `exit_code_zone_ids`,
      `location_zone_id` (an entry IS the pass)
    - `person` gains blacklist fields
    - new `pass_gate` table, unique per (entry, device)
    - backfill: every live entry gets gate rows for exactly the terminals it
      was provisioned to, in the matching state (`MIGRATED`)
  - **`services/gates.ts`:**
    - pure rules: `planGates` (exit-code gating for single entry only),
      `usedUpByPunch`, `locationAfter`
    - `gateTick`, a fixed query count per run: end passes (keeping the
      exits of anyone inside), drop never-loaded gates past their removal,
      queue due loads (PROVISION + PUSH_PHOTO in order), queue due unloads,
      close finished passes; batched audits `GATE_LOAD_QUEUED` /
      `GATE_UNLOAD_QUEUED`
  - **`services/entries.ts`:**
    - issuing creates the entry plus its gates (by zones, or by the old
      device list) and runs the tick
    - validation for a pass type's entry modes and max validity, credential
      expiry capping the pass, blacklist refusal, and single entry limited to
      one day
    - close (de-provision) schedules every gate out
    - acknowledgements advance gates per terminal and move face counts; a
      pass becomes provisioned only when no due terminal is still loading
  - **`services/punches.ts`:**
    - location follows the zone tree
    - single entry schedules the used terminal's removal +10 min (one
      batched statement; `GATE_UNLOAD_SCHEDULED`)
    - an overstaying holder walking out closes the pass at once
    - the day-block is gone
  - **`services/passes.ts`:**
    - exit override (reason required; `EXIT_OVERRIDE`)
    - zone widening (`ZONE_WIDENED`)
    - blacklist and lift (visitors only; ends every pass through the normal
      pass-end path, so someone inside keeps their exit)
  - **Retired:**
    - `runDailyReset`, `blockSingleEntryOnExit`, `assertSingleEntrySupported`
    - the expiry batch code
    - `DAILY_RESET_*` config, and `EXPIRY_SWEEP_CRON` (replaced by
      `GATE_TICK_CRON`, every minute)
    - `/entries/daily-reset`
    - the old queues are unscheduled at start-up
  - **`jobs/expiry.ts`** is now a thin wrapper over the tick, plus the
    overstayed list.
  - **Reconciliation:**
    - per-terminal: a face on a terminal whose gate isn't loading or loaded
      is removed, even while the pass is active
    - expected face counts come from the gates
  - **API:**
    - issue body gains `zoneIds`, `exitCodeZoneIds`, `passTypeId`,
      `validUntil`
    - pass detail includes gates
    - new routes: `POST /entries/:id/exit-override`,
      `POST /entries/:id/widen`, `POST /people/:id/blacklist` and `/lift`
  - **Web:**
    - shared `IssuePassForm`: zones, exit-code ticks, pass type, visit time,
      valid until with presets, used on the person and Provision pages
    - `PassGates`: per-terminal state, location, overstayed, override and
      widen
    - `BlacklistControl`
    - Inside Now: Location column, "overstayed", and manual-block wording
  - **`scripts/sim-terminal.mjs`:** virtual terminal one-liners (hello,
    drain, fail, in, out). Smoke-tested against the running dev backend.
- **Verification (2026-10-05):**
  - `prisma migrate diff`: no difference.
  - Unit tests **104/104**. New `gates.test.ts`: planning, use-up, location.
    `entry-modes.test.ts` was reduced to the date helper; the day-block and
    reset tests were retired with the feature.
  - e2e **381/381**:
    - section 6c was rewritten from the day-block to the new single-entry
      rule
    - the per-device daily-reset checks were retired
    - the sweep query-budget test now backdates after issuing (issuing runs
      the engine)
    - the two-gate test cleans up gate rows
    - new section 30 (44 checks on 4 zoned terminals) covers:
      - lead-time scheduling, then all 4 loading in one tick; face counts +1
        each
      - location through yard and premise
      - multi entry never schedules removal
      - single-entry office pass holding back the exit
      - +10 min removal after each use
      - override (reason, audit, no double)
      - yard exit free vs ticked
      - widening
      - blacklist outside (all removed, pass closed, refused, lifted)
      - blacklist inside (exit kept, closes on walking out)
      - pass ending inside (overstayed, listed, exit kept, closes on exit)
      - per-terminal reconciliation removal
      - face counts matching gates
      - the tick's query count flat for 2 vs 4 due gates
  - Web lint and build PASS.
- **Issues found and fixed during the phase:**
  1. The first design advanced a pass to PROVISIONED on its first loaded
     terminal. The existing two-gate e2e check caught it: the person could
     walk in before the exit had their face. A pass is now provisioned only
     when no due terminal is still loading.
  2. Blacklisting someone inside removed their exit too (rule #9). Blacklist
     now ends passes through the pass-end path.
  3. Test-harness artefacts: a deleted terminal still referenced by gates;
     punches in the same second deduplicated; a crashed run leaving its scratch
     photo (the runner now clears `photos-e2e` first).
- **Upgrade evidence:** the dev `vms` database has no entries, so its backfill
  was a no-op. On `vms_test` the backfill created gate rows from leftover
  entries (seen when the first e2e reset hit their foreign key).
- **Next action:** owner walk-through, `VERIFICATION.md` § Phase 4.

### 2026-10-05 — Phase 4 — verified and accepted

- Owner verified Phase 4 end to end ("verified everything and works as
  expected"). Marked `ACCEPTED`; committed. Phase 5 begins.

### 2026-10-05 — Phase 5 — Messaging outbox, visitor portal, visit-request core

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`.
- **Change:**
  - **Migration `20261005140000_visit_requests_portal`:** enums
    `VisitRequestStatus`, `VisitOrigin`, `MessageChannel`, `MessageStatus`;
    tables `visit_request`, `visit_request_event`, `link_token`, `otp`,
    `message`, `consent_record`; `person_document.person_id` becomes optional
    and gains `visit_request_id`. Additive only.
  - **Config:** `PUBLIC_PORTAL_URL` (links), `MESSAGE_TRANSPORT` (`console`).
  - **`services/notify.ts`:** every message is a `message` row; the console
    transport sends nothing.
  - **`services/codes.ts`:** link tokens (32 bytes, SHA-256 stored) and
    6-digit codes (hashed, expiry, attempt limit burns the code).
  - **`services/rate-limit.ts`:** fixed-window in-memory limiter (+ unit test).
  - **`services/visit-requests.ts`:** create (validates type, entry mode,
    validity, zones), send/resend link (revokes the old one), cancel, portal
    state, send/verify mobile code with returning-visitor match on the last
    10 digits, consent against the notice version, save details (hidden fields
    dropped, masked IDs keep the stored value), selfie, documents, submit
    (consent + required fields + selfie; host notified).
  - **`api/portal.ts`** (`/public-api`, outside auth and the licence gate,
    60 req/min per client): `GET /v/:token`, `POST otp`, `POST otp/verify`,
    `POST consent`, `PUT details`, `POST selfie` (480×640 JPEG only),
    `POST|DELETE documents`, `POST submit`.
  - **`api/visit-requests.ts`:** `POST /visit-requests`, `GET` list (own unless
    `passes:view`), `GET /options` (types and zones for hosts), `GET /:id`,
    `POST /:id/resend`, `POST /:id/cancel`, `GET /:id/selfie`,
    `GET /:id/documents/:docId/file` (audited), `GET /messages`.
  - **Access:** new cell `messages:view` (Administrator only by default).
  - **Audit actions:** `VISIT_REQUEST_CREATED/CANCELLED/SUBMITTED`,
    `VISIT_LINK_SENT`, `VISITOR_OTP_SENT/FAILED`, `VISITOR_MOBILE_VERIFIED`,
    `VISITOR_CONSENTED`, `VISITOR_DETAILS_SAVED`, `VISITOR_SELFIE_SAVED`;
    document actions reused against the request.
  - **Web:** `/public-api/[...path]` proxy route; portal page `/v/[token]`
    (code → notice → rules-driven form → camera with face oval → documents →
    submit); console pages **Requests**, request detail, **Outbox**; nav
    entries; `AuthProvider` skips the session check on `/v/`.
  - **Plan change:** the visit-request core moved here from Phase 6
    (`DECISIONS.md`).
- **Verification (2026-10-05):**
  - `prisma migrate diff`: no difference. Migration applied to `vms` and
    `vms_test`.
  - Unit tests **105/105** (new: rate limiter).
  - e2e **435/435**; new section 31 (54 checks): entry-mode refusal; SMS +
    email link; token stored only hashed; pre-verification page shows nothing
    personal; unknown link 404; details refused before verification; code
    metering; wrong codes, burn at the limit, expired code; verification;
    field rules; consent version check; Aadhaar format; hidden field dropped;
    required field named at submit; selfie size check; document type check;
    submit, status, host notified, locked afterwards; host view masked, with
    photo, document download and history; every step audited, no code or
    token in the audit; resend/cancel/expiry of links; returning visitor
    matched and prefilled masked, masked echo keeps the full number; host
    sees only own requests, can load form options, cannot read the outbox;
    portal per-client rate limit.
  - Web lint and build PASS.
  - Smoke test against the running dev servers: `GET
    localhost:48101/public-api/v/<junk>` → 404 "this link is not valid" from
    the backend, through the proxy.
- **Issues found and fixed during the phase:**
  1. The first test JPEG for the selfie check had an APP0 length 4 bytes
     longer than its data, so its size could not be read; the fixture was
     corrected.
  2. A Host holds no pass-type or zone permission, so the request form could
     not load them; it now has its own `GET /visit-requests/options`.
  3. Owner testing (2026-10-06): Submit said "still needed: Name, Govt ID
     type, Govt ID number" although the form was filled. The form had never
     been saved, and Submit only checked what was saved. Submit now saves
     the form first, then submits.
- **Not in this phase (Phase 6):** Clear / Query / Reject, walk-ins, request
  → person and pass, request expiry status.
- **Next action:** owner walk-through, `VERIFICATION.md` § Phase 5.

### 2026-10-06 — Phase 5 — verified and accepted

- Owner verified Phase 5, including the phone run through a Cloudflare quick
  tunnel. Two fixes from that testing are in the phase: Submit saves the form
  first, and the web dev server allows `*.trycloudflare.com`
  (`allowedDevOrigins`). Marked `ACCEPTED`; committed. Phase 6 begins.

### 2026-10-06 — Phase 6 — Host review, walk-ins, photo retake

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`.
- **Change:**
  - **Migration `20261006090000_visitor_id_sequence`:** `visitor_id_seq`
    (additive; not a Prisma model, read with `nextval`).
  - **`services/visit-review.ts`:**
    - `clearRequest`: checks the submission against the visitor type (with
      an optional department), matches or adds the company, refuses before
      using a number if any of the pass's terminals would not classify the
      ID as a visitor, creates or updates the person (returning visitors keep
      their record and terminal ID; new ones get `<prefix><5 digits>`),
      copies the selfie to the enrollment photo, moves the documents to the
      person, issues the pass through `provisionPerson` (host = person to
      meet), marks the request CLEARED, messages the visitor.
    - `queryRequest` (text; new link quoting it), `rejectRequest` (internal
      reason; link withdrawn; visitor told), `expireRequests` (batched; on
      the gate-engine tick).
    - `submitAndDecide`: submit, then issue at once when no host Clear is
      needed (visitor type + walk-in setting), else notify the host.
  - **`services/visit-requests.ts`:** walk-in origin (no link sent),
    `requestById`, visitor steps take an operator actor (audited as
    OPERATOR), `messageHost`.
  - **`api/portal.ts`:** the visitor steps became `visitorStepRoutes`, mounted
    on the portal and on `/api/walk-ins/:id` (walkins:create). The portal's
    submit answer never includes why an automatic pass failed.
  - **`api/visit-requests.ts`:** `POST /:id/clear|query|reject` (host only,
    visit_requests:update); detail adds the pass and `canReview`; options add
    departments and hosts (open to request, review and walk-in cells);
    `POST /walk-ins`, `GET /walk-ins`.
  - **`services/passes.ts` + `api/entries.ts`:** `POST /entries/:id/photo`
    (passes:update, 480x640) re-pushes to LOADED terminals; widening limited
    to the visitor's own host unless the operator holds passes:update.
  - **Audit actions:** `VISIT_REQUEST_CLEARED/QUERIED/REJECTED/EXPIRED`.
  - **Web:** shared `components/visitor-flow.tsx` (portal and walk-in desk),
    shared `components/visit-request-form.tsx` (request and walk-in), new
    **Walk-in** page, request page **Decision** and **Pass** cards (Clear /
    Query / Reject, widen), retake on the pass panel, nav entry.
- **Verification (2026-10-06):**
  - `prisma migrate diff`: no difference; migration applied to `vms` and
    `vms_test`.
  - Unit tests **105/105**.
  - e2e **474/474**; new section 32 (36 checks): query needs text; only the
    host decides; two query rounds (new link quoting the question, old link
    withdrawn, resubmit) with exact history; Clear refused when terminals'
    visitor patterns don't cover the ID (no person created); Clear → person
    with full details, company, selfie as photo, pass with zones/host/
    validity and scheduled gates, CLEARED, visitor told, no double Clear;
    host widens own pass but not another's; retake refused at the wrong size,
    re-pushed to every loaded terminal, pass stays loaded; returning visitor
    cleared onto the same person and terminal ID; reject (reason needed,
    link withdrawn, visitor told, reason not in the SMS); walk-in sends no
    link, desk closed to a host, waits for the host with the setting on
    (host told "at the gate"), desk steps audited as the operator, host
    clears it; setting off → issued at once, host told, history notes it;
    expiry; all four decisions audited.
  - Web lint and build PASS.
- **Issues found and fixed during the phase:**
  1. The first widen check ran before the pass was loaded; widening is (by
     the Phase 4 rule) for loaded passes only, so the check moved after
     loading, and the "not your visitor" check was made deterministic.
- **Next action:** owner walk-through, `VERIFICATION.md` § Phase 6.

### 2026-10-08 — Phase 6 — numeric visitor IDs for development

- The owner's test terminal accepts only numeric user IDs (the client's
  accept letters). No code path needed changing: the visitor ID prefix is a
  setting, and `9` gives `900001`… with terminal pattern `9*`.
- Tightened: the prefix is now 1–8 characters and may not start with `0`
  (a numeric terminal drops leading zeros, so the ID would no longer match).
  Clear's "pattern doesn't match" message now suggests `<prefix>*`.
- Tests: unit **106/106** (new prefix test); e2e section 32 now also issues a
  walk-in under prefix `9` and checks the ID is all digits.
- Noted: the e2e suite cannot pass when run in the last hour or so before IST
  midnight — single-entry passes end at IST midnight and several sections
  book visits an hour or more ahead. Run it at other times.

### 2026-10-08 — Phase 6 — company from the directory; Admin decides any request

- **Owner findings:** (1) the portal's free-text company created duplicates
  ("Test-Company" and "Test Company"), which split reports; (2) Admin must be
  able to Clear any request, not only their own.
- **Change:**
  - **Migration `20261008090000_visit_request_company`:** `visit_request`
    gains `company_id` (FK to `company`); `company_name` stays as a display
    snapshot. Additive.
  - The portal no longer has a Company field (and refuses one). The host /
    Security picks the company from the Directory on the request form; the
    Decision card can pick or change it at Clear. Clear no longer creates
    companies.
  - New grid cell `visit_requests_all:update` ("Decide any host's visit
    requests"): Admin holds it; grantable to other roles. Clear / Query /
    Reject and the Decision panel accept the host or a holder of this cell.
  - Options endpoint returns active companies.
- **Verification:** unit **106/106**; e2e **478/478** (new: visitor cannot
  send a company; another host can't see the request; Admin rejects a host's
  request; a type needing a company can't be cleared without one, then
  clears with the company picked at Clear; no company created from a visit);
  migration applied to `vms` and `vms_test`, no drift; web lint and build PASS.
- **Existing duplicates** already created during testing (e.g.
  "Test-Company") are left for the owner to tidy in **Directory** (move the
  people across, deactivate the duplicate); nothing is deleted automatically.
- **Owner decision (same day):** a planned request needs a host Clear only if
  its visitor type requires one (unchanged behaviour). The history note for
  an automatic issue now names the reason — `the visitor type "<name>" does
  not require one` or `walk-ins do not require one (site setting)` — instead
  of always saying "site setting". e2e **478/478**.

### 2026-10-08 — Phase 6 — verified and accepted

- Owner verified Phase 6 (with numeric visitor IDs on the test terminal,
  directory companies, Admin deciding any request). Marked `ACCEPTED`;
  committed. Phase 7 begins.

### 2026-10-08 — Phase 7 — Exit code, out-pass, outage recovery

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`.
- **Change:**
  - **Migration `20261008120000_exit_code_outage`:** `outage` table;
    `entry.exit_code_sent_at`, `entry.released_by_outage_id`;
    `link_token.request_id` nullable + `entry_id` (out-pass links belong to a
    pass); seeds `outages:view` to the Security and Security In-charge roles.
    Additive.
  - **`services/exit-codes.ts`:** `issueDueExitCodes` (single-entry passes
    with a code-gated exit whose holder is inside and has no code yet; each
    claimed first; host SMS/email with the code, visitor SMS with the
    out-pass link; `EXIT_OTP_ISSUED`), `reissueExitCode` (console, returned
    once), `outPassState` / `verifyExitCode` (wrong → `EXIT_OTP_FAILED`;
    right → `EXIT_OTP_VERIFIED` and `loadExitGates(EXIT_CODE)`).
  - **`services/outages.ts`:** `outageCheck` (heartbeat in `app_config`; a
    gap over `outageGapMinutes` creates an `outage`, releases single-entry
    insiders live during it through the normal pass-end path, audits
    `OUTAGE_DETECTED` + `OUTAGE_RELEASE`), `listOutages`.
  - **Wiring:** engine job = outage check → gate tick → due exit codes →
    request expiry; ingestion issues due codes after a punch moves someone
    inside.
  - **Routes:** public `GET /public-api/out/:token`, `POST …/verify`;
    `POST /api/entries/:id/exit-code` (exit override cell, or the visitor's
    own host); `GET /api/outages` (`outages:view`, new cell).
  - **Web:** out-pass page `/v/out/[token]` (inside the tunnel's `/v/` path);
    **Outages** page; "Issue exit code" on the pass panel; "New exit code" on
    the request's Pass card.
- **Verification (2026-10-08):**
  - `prisma migrate diff`: no difference; applied to `vms` and `vms_test`.
  - Unit **106/106**; e2e **504/504**; new section 33 (26 checks): exit held
    back; first IN sends host the code and visitor the link (once); code
    stored hashed; out-pass shows first name only; wrong code refused and
    audited; right code opens the exit (EXIT_CODE gate), loads, walk out
    schedules removal; multi entry gets no code; host/Security issue a new
    code (replaces the old; host refused for another's visitor; multi refused);
    short gap not an outage; long gap recorded; single-entry insiders
    released and linked; multi untouched; audits; outage list; heartbeat
    resumes; released pass closes.
  - Web lint and build PASS.
- **Issues found and fixed during the phase:** the first test assumed one
  host message; the host gets the code by SMS **and** email.
- **Next action:** owner walk-through, `VERIFICATION.md` § Phase 7.

### 2026-10-08 — Phase 7 — verified and accepted

- Owner verified Phase 7. Marked `ACCEPTED`; committed. Phase 8 begins.

### 2026-10-08 — Phase 8 — Reports and audit coverage

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`.
- **Change:**
  - **Reports** (`reports/registry.ts`, new group "Visits"): `visit-requests`
    (queries counted with their texts, last decision and note; host and
    company filters), `pass-type-usage`, `zone-presence` (overstayed flag),
    `exit-overrides`, `blacklist-history`, `outage-releases`,
    `messages-sent` (no message text). Each follows its own access cell.
  - **Audit sweep:**
    - `src/api/route-guards.test.ts` scans every route file: a route without
      a `preHandler` permission fails unless it is a named exception with a
      reason (login, own password, public branding, self-authenticating SSE,
      first-run setup, reports that check per report, the token portal).
    - e2e wraps `app.inject`: every successful non-GET `/api` or
      `/public-api` call must add an audit row; section 34 fails on any that
      didn't, apart from named no-change cases (login, an identical settings
      patch).
  - **Gaps it found and fixed:** device setting changes (`PATCH
    /api/devices/:id`) now write `DEVICE_UPDATED` with each field's old and
    new value; retention runs write `RETENTION_RUN` (always for a manual run,
    with the operator; for a scheduled run when anything was deleted).
- **Verification (2026-10-08):**
  - Unit **107/107** (new route-guard test).
  - e2e **518/518**; new section 34 (audit coverage over every exercised
    state-changing route) and section 35 (13 checks: query history, decision
    note, walk-in origin, host filter, overrides with reasons, blacklist and
    lift, outage releases, zone presence, type usage, messages without text
    and no codes in CSV, no ID numbers in the visit export, Host sees no
    control reports). Section 21 still runs and exports every report.
  - No migration this phase; web unchanged (the Reports page renders the
    catalogue it is given).
- **Next action:** owner walk-through, `VERIFICATION.md` § Phase 8.

### 2026-10-08 — Phase 8 — verified and accepted

- Owner verified Phase 8. Marked `ACCEPTED`; committed. Phase 9 begins.

### 2026-10-08 — Phase 9 — Tunnel, hardening, packaging (acceptance pending)

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`; parts C (build + upgrade
  acceptance) and D (four terminals) are the owner's.
- **Change:**
  - **`docs/INSTALL_GUIDE.md`** carried forward from legacy with three new
    sections: upgrading 0.4.19 → 0.5.0 (backup of `backend\data` and
    `%ProgramData%\VMS`, in-place install, rollback), two-zone setup after
    install (patterns, zones, exit-code default, pass types, settings,
    admin card), and the Cloudflare Tunnel runbook (dashboard tunnel,
    `cloudflared service install <token>`, public hostname with path
    `^/(v/|_next/|public-api/)` → `localhost:47101`, `PUBLIC_PORTAL_URL`,
    checks from mobile data).
  - **Hardening:** web proxy refuses path segments that could leave
    `/public-api` (`..`, `.`, empty, slashes) and re-checks the target path;
    `next.config.ts` headers on `/v/*` and `/public-api/*` (no-referrer,
    no-store, DENY framing + `frame-ancestors 'none'`, nosniff, noindex,
    camera-only permissions policy). A probe of the running dev proxy before
    the change showed traversal was already blocked by per-segment
    re-encoding; the guard makes it explicit.
  - **Packaging:** `AppVersion=0.5.0`; `PUBLIC_PORTAL_URL` defaults to the
    installed console `http://localhost:47101` (config and `.env.example`);
    `VERSIONS.md` 0.5.0 entry (migrations, new keys, release gate) marked
    not yet built. Confirmed the installer never removes `backend\data`, so
    documents and selfies survive upgrades like photos.
- **Verification (2026-10-08):**
  - e2e **523/523**; new section 36 (fuzzing, 5 checks): 8 hostile uploads ×
    selfie / document / retake, 6 hostile JSON bodies × 5 portal and
    out-pass routes, 6 hostile tokens × 2 routes — no 5xx; none blocked by the
    rate limiter (so every input reached its validator); no prototype
    pollution; hostile file names never reach the disk path; no selfie from
    fuzzed bytes.
  - Unit **107/107**; web lint and build PASS.
- **Not done here (owner):** building the 0.5.0 installer (needs the
  production licence public key), the upgrade acceptance on a disposable
  machine, and the four-terminal acceptance — `VERIFICATION.md` § Phase 9.

### 2026-10-11 — Phase 9 — simpler verification

- Owner found the Phase 9 steps hard to follow. Rewrote `VERIFICATION.md`
  § Phase 9 as four checks in order of effort, with plain checklists.
- New **`backend/scripts/check-portal.mjs`**: read-only checks of the
  portal's protections, printing PASS/FAIL in words; given an https tunnel
  address it also checks that the console, backend, `/health` and `/iclock`
  are not published. Run against the dev servers (started for the purpose
  and stopped after): **all checks passed**.
- Found while doing so: Next.js ignores a `Cache-Control` header set in
  `next.config.ts` for pages (dev sends `no-cache, must-revalidate`;
  production dynamic pages send `no-store` on their own). Removed the
  ineffective entry; the check accepts either value.
- Starting the dev backend after days off recorded an outage and released one
  test visitor — expected (Phase 7).
- **Owner ran Check 2 through a quick tunnel (2026-10-11):** the portal and
  backend checks passed, but `/login`, `/` and `/people` answered **200** —
  a quick tunnel has no path filter, so the console pages were published
  (they still require sign-in). Fixed in the app rather than relying on the
  tunnel: `web/src/proxy.ts` answers 404 to any request carrying
  `CF-Connecting-IP` (i.e. arrived through Cloudflare) unless it is a portal
  path. Probed the dev server: via-Cloudflare `/login`, `/`, `/people` → 404;
  `/v/…` → 200; LAN `/login` → 200. Web lint and build PASS. Owner to re-run
  `check-portal.mjs` through the tunnel.
- **Multi-client tunnel model (2026-10-11, owner):** `INSTALL_GUIDE.md` gains
  "Whose Cloudflare account, and which domain": the client-owned account
  with us as a member, the client's pre-installation checklist (domain on
  Cloudflare, account, member invite, SMS whitelisting), and the exception of
  hosting on our account with one tunnel per client. Recorded in
  `DECISIONS.md`.
- **Owner's named-tunnel test passed (2026-10-11)** on his own domain through
  the dev web server. `next.config.ts` now takes extra dev hosts from
  `DEV_ALLOWED_ORIGINS` (set only in the owner's ignored `web/.env.local`),
  so no domain is hard-coded. `INSTALL_GUIDE.md` gains *New client: what to
  do after the installer* — the per-client checklist, including setting
  `PUBLIC_PORTAL_URL` (the installer cannot know the domain) and the
  installed route URL `localhost:47101`.

### 2026-10-12 — 0.5.0 installer built; F1 — exit code decided by the visitor type

- **0.5.0 installer built** from `ae66f29` after `npm test` 107/107 and
  `verify:e2e` 514/514; recorded in `VERSIONS.md`. A one-month test licence
  was issued for the owner's PC (private ledger only).
- **F1 (owner, 12 Oct): the visitor type is final, no Security override.**
  - Schema: `pass_type.exit_code_required` (default true; migration
    `20261012090000_pass_type_exit_code`, additive — existing types keep
    today's behaviour). `visit_request.exit_code_zone_ids` kept, no longer
    written.
  - Backend: `provisionPerson` derives `exitCodeZoneIds` from the pass type
    (required → the covered zones with `exitCodeDefault`; not required → none;
    no type → zones' defaults). The `exitCodeZoneIds` input is gone from the
    provision, visit-request and walk-in APIs (an old client's field is
    ignored) and from `clearRequest`. `widenZone` follows the type too. The
    pass-type API accepts `exitCodeRequired`; the request options carry it.
  - Console: Pass types gains an *Exit code* setting and column; the request,
    walk-in and issue-pass forms replace the exit-code tick boxes with a
    read-only line showing what the type decides.
  - Tests: e2e section 29 checks the default; section 30 drops the per-pass
    tick cases and adds a required type (outer exit waits) and a not-required
    type (every exit loads, a ticked field is ignored).
- **Verified:** typecheck PASS; `npm test` 107/107; `verify:e2e` **516 passed,
  0 failed**; web lint + build PASS.
- Dev note: after the owner installed 0.5.0 + a licence on this PC, an e2e run
  without the documented scratch `PROGRAMDATA` failed with `LICENSE_EXPIRED`
  (shared `%ProgramData%\VMS`); re-run per `DEVELOPMENT_SETUP.md` §8 passed.
- Owner verification: `VERIFICATION.md` § F1. Then 0.5.1 is packaged.

### 2026-10-12 — 0.5.2: production licence key in the installer

- **Found on a client clean install:** a correctly issued production key was
  refused ("not valid for this installation or is corrupted"). 0.5.0 and
  0.5.1 had been staged with `VMS_LICENSE_PUBLIC_KEY_FILE` pointing at a
  development key pair, so they accept only dev-signed keys.
- **Fix:** the production public key is committed at
  `installer/license-public.pem`; `build-release.mjs` always embeds it (no env
  var). `INSTALL_GUIDE.md` and `VERSIONS.md` updated; 0.5.0/0.5.1 marked do
  not deploy. Field workaround for a 0.5.1 site: replace `LICENSE_PUBLIC_KEY`
  in `backend\.env`, restart `VmsBackend`.
- e2e section 32 booked a single-entry visit ending now + 8 h, which crosses
  IST midnight from 16:00 IST; capped at 23:59 IST (`KNOWN_ISSUES.md`).
- **Verified:** `npm test` 107/107; `verify:e2e` 516/516; staged
  `LICENSE_PUBLIC_KEY` = the production key. `AppVersion` 0.5.2.


### 2026-10-14 — F2 step 1: small fixes from the first client demo

Plan: `PLAN.md` § F2 (items 3, 4, 7, 11, 12, 13, A). Decisions recorded the
same day in `DECISIONS.md`.

- **#7 Dark mode date picker:** `color-scheme: light dark` on `:root`
  (`globals.css`), so native date/time controls follow the dark palette.
- **#4 "Pass type" everywhere:** console labels (Register person, person page,
  request form and page), the report *Pass type usage* (column key
  `pass_type`), the Clear history note, comments. Nothing in the schema.
- **#3 Register person:** Category is the first field and takes focus.
- **#11, #12 Valid until:** new `components/valid-until-field.tsx`, used by
  the Issue pass and Request forms. Shortcuts today / 1 week / 1 month /
  3 months / 6 months / 1 year, counted in IST calendar days as the server
  does (they used the browser's local day, wrong on a PC set to UTC); a
  shortcut longer than the type or entry mode allows is disabled. The field
  shows "Latest allowed: …", sets `max`, and flags a later value.
- **#13 The pass takes its holder's pass type:** the Issue pass form (person
  page and Provision) no longer offers a type; it shows the person's.
  `provisionPerson` refuses a `passTypeId` other than the person's (400) and
  an inactive one says to edit the person. Clear already stored the
  request's type on the person first, so it is unaffected.
- **A One length rule:** `passLengthProblem` (`services/entries.ts`) holds the
  max-validity (calendar days) and single-entry-same-day rules; the request
  path (`services/visit-requests.ts`) used 24-hour blocks and skipped the
  same-day rule, so a request could be accepted and refused at Clear.
- Also fixed in both forms: when the pass type doesn't allow the default
  entry mode, the form now submits a mode the type allows (it sent the
  hidden default and was refused).
- Tests: e2e section 30 gives the person the type instead of the pass and
  checks a different type is refused; the request section checks a
  single-entry request over two days and a 1-day type 10:00 → 09:00 next day
  (under 24 h) are refused. Its default visit end is capped at 23:59 IST.
- **Verified:** typecheck PASS; `npm test` 107/107; `verify:e2e` **519
  passed, 0 failed**; web lint + build PASS.
- Owner verification: in the console, light and dark mode — Register person
  field order; a request and an issued pass with a 90-day type (latest
  allowed shown, 6 months enabled, 1 year disabled); single entry allows
  only "today"; the person page shows the pass type read-only.

### 2026-10-14 — F3 step 1: resigned-employee removal, sweep rotation, alert clearing, field docs

Plan: `PLAN.md` § F3 (B1, B2, B3, B4, D1–D3), ported from 0.4.20 and later
field notes in `essl-vms-main`.

- **B1 Resigned employees stay removed** (`services/employee-access.ts`,
  `adms/ingest.ts`, `services/reconcile.ts`):
  - Resign targets every access row and every terminal with a punch from the
    ID; terminals with no row get a not-desired one. Commands in one bulk insert.
  - `removeRevokedEmployeesFromPunches`: at ATTLOG ingest, a punch from a
    resigned Employee, or one whose access to that terminal was removed, made
    after the revocation, queues a DEPROVISION there, writes
    `RECONCILE_HEALED` (`REVOKED_EMPLOYEE_PUNCHED`). One read, three bulk writes.
  - Alert `revoked-employee-punched` (critical), derived from the audit rows;
    clears when a strict removal on that terminal succeeds.
  - Adoption from a terminal USER record never gives a resigned Employee
    access; reconciliation always removes them and fixes a stale desired row.
  - Migration `20261014090000_revoked_employee_reconcile`: index
    `sync_command(person_id, target_device_id, type, created_at)` (IF NOT
    EXISTS) and repair of desired rows of resigned people.
- **B2 Sweep** (`reconcileSweep`): candidates are visitor `pass_gate` rows
  (loaded, or cleared within `RECONCILE_REMOVED_DAYS`) and Employee access
  rows (desired, or removed/resigned within the window); ordered by the last
  QUERY_USER per pair, so it rotates; removed Employees get a best-effort
  DEPROVISION before the query; the employee self-heal rotates by last
  PROVISION; all commands in bulk (`createManyAndReturn`). The employee
  in-flight check ignores QUERY_USER, so the sweep's own reply is no longer
  dropped. New setting `RECONCILE_REMOVED_DAYS` (default 30, 0 = off).
- **Best-effort removals** (`adms/queue.ts`): a DEPROVISION marked
  `bestEffort` that gets `Return≠0` is SUCCESS with the code in `last_error`.
- **B4** (`services/alerts.ts`): failed-commands alert counts only failures
  under 7 days old with no later success of the same type for the same person
  on that terminal.
- **B3:** checked, not affected (gate counts only after both commands
  succeed; only LOADED gates give a face back). e2e pins it.
- **D1–D3:** `INSTALL_GUIDE.md` § Terminal attendance log (cyclic deletion,
  unverified on our units) and a licence-revocation note; `DEVICE_PROTOCOL.md`
  §9 two checklist items; `KNOWN_ISSUES.md` rows for the full-log refusal,
  non-revocable keys, the untested delete-absent-PIN reply, and B1/B4 fixed.
  `ARCHITECTURE.md`, `.env.example` updated.
- Tests: unit `employee-access.test.ts` (4, from 0.4.20). e2e section 37
  (revoked employees across terminals, failed removal → best-effort re-send →
  strict removal, alerts raised and cleared, 7-day window, adoption, rotation);
  section 30 B3 checks (refused photo not counted; retry counts once; closing
  gives it back).
- **Verified:** typecheck PASS; `npm test` **111/111**; `verify:e2e` **552
  passed, 0 failed** (after clearing `data/photos-e2e`, left by a run that
  crashed on a test typo).
- Owner verification: on the hardware terminal, (1) D3: delete an ID that is
  not enrolled and record the reply; (2) B1: register an employee on one
  terminal only, enrol the same ID by hand on the other, punch there, resign,
  punch again → removal queued, critical alert, cleared once it succeeds.

### 2026-10-14 — F2 step 2: exit-code exits on the pass type, zone edit/delete, searchable dropdowns

Plan: `PLAN.md` § F2 (items 5, 6, 8, 9, 10, B, C).

- **#10 Exit-code exits on the pass type:** new `pass_type.exit_code_zone_ids`
  (migration `20261014120000_pass_type_exit_code_zones`: types requiring the
  code take today's `exit_code_default` zones; nothing changes at the gate
  for typed passes). Issuing, Clear, walk-ins and widening use the type's
  zones ∩ the pass's zones; **no type = no code** (was: zones' defaults).
  `zone.exit_code_default` is no longer read or written. The pass-types API
  refuses a single-entry type requiring the code with no exits named (when
  the site has zones); a new type needs the code only if it names exits.
  PATCH returns `livePasses`; the console says they keep the old rule. Each
  pass panel shows "Exit code: needed at … — as issued".
- **#9 Zones:** Edit (rename, move under another; cycle-checked, as before)
  and Delete (new cell `zones:delete`; refused if the zone has sub-zones,
  terminals, passes, requests or pass-type exit settings; audited
  `ZONE_DELETED`). Deactivating a zone a live pass names is refused (409).
  The Zones card loses "Exit code by default".
- **#8 + B:** `components/zone-picker.tsx` used by Issue pass, Request /
  Walk-in, employee access and rehire on the person page, and Register
  person: a ticked zone shows the zones around it ticked and locked ("with
  Yard"); only ticked zones are sent. `POST /api/people` accepts `zoneIds`
  for employees, expanded to terminals (zones with no terminals → 400).
- **#5 + #6:** `SearchSelect` in `components/ui.tsx` (type to filter,
  arrows/Enter/Escape, ARIA combobox) for companies, departments, pass types,
  hosts / person to meet, zones (parent, terminal placement, widening), the
  Directory bulk assignment and the report filters. "+ Add …" for companies
  and departments wherever the operator holds `directory:create`
  (`addToDirectory`, audited by the existing routes). Migration
  `20261014130000_host_directory_create` grants it to the seeded Host role.
- **C:** one-line "when to use this" on Requests, Walk-in, Provision and the
  person page's Device authorization (visitors).
- Dev note: `prisma generate` could not replace the engine DLL while the dev
  backend (`npm run dev`) held it; the generated client was written and the
  engine is byte-identical, so the leftover `.tmp` copy was removed. Restart
  the dev backend and run `npx prisma migrate deploy` on the dev database
  before trying the console.
- Tests: e2e section 26 (zone flag ignored, employee registered by zone,
  empty zone refused), 29 (exit-rule validation), 30 (no type = no code; the
  type names the office exit; live pass keeps its rule and `livePasses`;
  zone deactivation guard, delete never-used / refuse used, move), 33 (pass
  type names the exit; a host adds a company).
- **Verified:** typecheck PASS; `npm test` 111/111; `verify:e2e` **568
  passed, 0 failed**; web lint + build PASS.
- Owner verification (light and dark mode): Pass types → tick "The exit
  needs the exit code", choose the premise exit, save; edit it while a pass
  is live → notice. Devices → Zones: Edit (rename, move), Delete a fresh
  zone, try deleting a used one, try deactivating one in use. Tick Yard in
  any zone picker → Premise shows "with Yard". Register person: employee by
  zone. Type in Company: filter, "+ Add" (also as a host on a request).

### 2026-10-14 — F3 step 2: remove someone still inside, discard a hand enrolment, field-named errors

Plan: `PLAN.md` § F3 (F-a, F-j, F-m), ported from 0.4.21 / 0.4.24.

- **F-a** (`services/entries.ts` `deprovisionEntry`, `api/entries.ts`):
  `POST /api/entries/:id/deprovision` with `{ force: true, reason }` ends the
  pass of someone marked INSIDE: location cleared, every gate (exits
  included) unloaded through the normal path, audit
  `ENTRY_DEPROVISION_REQUESTED` with `forcedWhileInside` and the reason. New
  cell `passes_force_end:update` (Administrator only by default); no reason
  → 400; without `force` INSIDE is still 409. Person page: "Remove although
  inside" (confirm + reason prompt) for those holding the cell.
- **F-j** (`api/enrollments.ts`): `DELETE /api/enrollments/unclaimed/:pin`,
  new cell `unclaimed:delete` (Administrator only). Refused for a registered
  person's ID. Deletes the stored photo; queues best-effort DEPROVISIONs in
  one insert, only on terminals whose Employee/Visitor patterns cover the ID
  (rule #7); audit `UNCLAIMED_DELETED`. Unregistered panel: Delete button.
- **F-m** (`web/src/lib/api.ts`, `lib/swr.ts`): validation refusals show
  "Field: message" per issue instead of "validation"; `refresh()` revalidates
  without clearing the cache, so a page no longer collapses and jumps to the
  top after an action.
- Tests: e2e section 38 (inside: refused without force, 403 for Security,
  400 without reason, forced by Admin → location cleared, audited, every
  gate cleared and pass closed; enrolment: 403 for Security, covered
  terminals only, best-effort, photo deleted, audited, ID outside patterns
  sent nowhere, registered ID refused).
- **Verified:** typecheck PASS; `npm test` 111/111; `verify:e2e` **584
  passed, 0 failed**; web lint + build PASS. No migration in this step.
- Owner verification: as Admin, a visitor marked inside → "Remove although
  inside" (reason) → pass ends, terminals cleared; the same button is absent
  for Security. Enrol an ID by hand on a terminal → it appears under
  Unregistered people → Delete → removed from the terminal, photo gone. Any
  form with a missing field now names it.

### 2026-10-14 — F3 step 3: zone on every punch, new reports, person movement, Monthly Status

Plan: `PLAN.md` § F3 (F-z, F-h, F-g, F-f), ported from 0.4.24.

- **F-z:** `punch_event.zone_id` set at ingest from the cached terminal row
  (cache is invalidated on a zone change); migration
  `20261014150000_punch_zone` backfills existing punches from each
  terminal's current zone and indexes it. A zone with punches can no longer
  be deleted.
- **F-h** (`reports/registry.ts`): `search` filter (name or ID, LIKE
  metacharacters escaped) on Attendance and the new reports. New reports:
  **Punch log** (`punches:view`, with zone), **Person details** (new cell
  `people_export:view`, Administrator only; Govt ID / Aadhaar / PAN masked in
  SQL), **Device roster** (employee access + visitor gates loading/loaded,
  with zone). CSV already exported every row up to the cap. Reports page:
  search box and terminal filter.
- **F-g:** person page panels `components/person-movement.tsx` (ins and outs
  for a date range: per-day Attendance + each punch with terminal and zone,
  CSV) and `components/person-reports.tsx` (every report with a person
  filter; Monthly Status for employees).
- **F-f:** `services/monthly-status.ts` (no shifts: P / A, first in, last
  out, paired duration; punches from top-level or unset zones only; summary
  fallback) and `reports/monthly-status-render.ts` (Excel via exceljs, PDF via
  **pdfkit 0.17**, new dependency + `@types/pdfkit`);
  `GET /api/reports/monthly-status` (`reports:view`, ≤ 31 days). Reports page
  card. `build-package.mjs` copies pdfkit's `data` next to the bundle and
  skips stale `query_engine-*.tmp<N>` files.
- **Bug found in 0.4.24 while porting:** the Excel layout put "Printed On"
  7 columns from the right edge, so ranges under 8 days asked for a negative
  column and failed. Two-zone always lays out 31 day columns (as the PDF
  does). Recorded in `KNOWN_ISSUES.md` for the single-zone product.
- Tests: unit `monthly-status.test.ts` (7). e2e section 39 (punch zone stamp;
  outer IN → yard trip → outer OUT = one 8 h day; Excel `PK` and PDF `%PDF`
  downloads; 31-day cap; Punch log search with zones; Person details masked
  in table and CSV and Administrator-only; Device roster with zone;
  case-insensitive search; a typed `%` matches itself).
- **Verified:** typecheck PASS; `npm test` **118/118**; `verify:e2e` **596
  passed, 0 failed**; web lint + build PASS. Migration applied to the dev
  database.
- Owner verification: Reports → Monthly status → Excel and PDF for this
  month and for a single day (open both); Punch log / Person details / Device
  roster with a search; a person's page → Ins and outs (zone column) and
  Reports downloads. An employee who visits the yard should still show one
  working day from the outer gate.

### 2026-10-14 — F2 step 3: deactivate / reactivate, erasure on request, automatic visitor IDs

Plan: `PLAN.md` § F2 (items 1 and 2). Hard rule #3 amended in `CLAUDE.md`.

- **#1a:** person page "Deactivate" (existing `DELETE /api/people/:id`,
  refused while a pass is live) and "Reactivate" (new
  `POST /api/people/:id/reactivate`, `people:delete`, audit
  `PERSON_REACTIVATED`; refused for resigned or erased people). Visitors
  only; employees keep Resign / Rehire.
- **#1b Erasure** (`services/erasure.ts`, `POST /api/people/:id/erase`, new
  cell `people_erasure:delete`, Administrator only by default, reason
  mandatory): wipes identity fields (name → "Erased person"), the biometric
  row and photo file, document files (rows kept as "erased"), the person's
  visit requests' name / mobile / email / submission / selfie, and messages
  addressed to their mobile or email; best-effort removal on terminals whose
  patterns cover the ID. Row, ID, passes, punches, consents and audit kept.
  Migration `20261014170000_person_erasure` (`person.erased_at`). Erased
  people can't be edited, given a photo, reactivated or erased again.
- **#2 Automatic visitor IDs:** `POST /api/people` issues `<prefix>` + the
  next number when a visitor has no ID (`issueVisitorId`, shared with Clear
  and now exported; checked with `assertVisitorIdFits` against every
  terminal that takes visitors). `issueVisitorId` now also skips a number
  whose photo is waiting as a hand enrolment. Register person: no visitor ID
  field, no terminal-claim route (`?pin=`); employees type their own code.
  The Unregistered panel loses "Register" (Delete remains, F3 F-j).
- Tests: e2e section 40 (ID issued; next number skips a hand enrolment;
  employee still needs an ID; deactivate / reactivate audited; erase: 403
  for Security, reason required, identity wiped with ID kept, photo gone,
  audit without the name, no edit / reactivate / second erase, employee
  must be resigned). Unit `people.test.ts` updated for the optional visitor ID.
- **Verified:** typecheck PASS; `npm test` 118/118; `verify:e2e` **612
  passed, 0 failed**; web lint + build PASS. Migration applied to the dev
  database.
- Owner verification: Register person as a visitor (no ID field; the page
  then shows e.g. `V00012`) and as an employee (own code). A visitor:
  Deactivate → hidden, Reactivate. As Admin, Erase a test visitor with a
  photo and a document → name "Erased person", photo and document gone,
  history still listed; as Security the button is absent.
- **Follow-up (same day):** pass type "Kind" removed from the Pass types
  form and table (label only; owner). Erasure kept (owner). Moving Zones to
  their own page is deferred to the UI redesign.

### 2026-10-14 — Console: sidebar navigation, Zones page

Owner-approved design (Claude Design canvas "Sidebar Navigation").

- `web/src/app/(app)/layout.tsx`: the top tab bar becomes a left sidebar —
  organisation logo / name and version on top; Overview, Visitors, People,
  Site setup, Administration groups with icons; the operator (→ profile) and
  Sign out at the bottom. Collapse to a 72 px icon rail (labels as tooltips
  and aria-labels; remembered per browser in `localStorage`, ignored if
  storage is blocked). Under 768 px a top bar with a menu button opens the
  sidebar as a drawer over the dimmed page (closes on a page choice, the
  backdrop, the close button or Escape). Entries still follow the access
  grid; a group with no visible entry is hidden. The header shows the
  current group and page (orientation only; each page keeps its own h1)
  and the alerts badge. New tokens `--active-bg` / `--active-text`.
- **Zones page** (`/zones`, `zones:view`): the Zones card moves out of
  Devices; terminals are still placed into zones on the Devices page.
  Install guide, product spec and the pass-type hint updated.
- The live-updates indicator stays on the pages that open a live stream
  (Dashboard, Inside now, Command queue), as before.
- **Verified:** web lint + build PASS. No backend change.
- Owner verification: desktop expanded and collapsed (reload keeps it),
  light and dark mode, as Admin, Security and Host (groups trim); a phone
  width (browser dev tools) opens and closes the drawer; Zones page works
  and is gone from Devices.

### 2026-10-14 — Pre-demo console sweep

Every page reviewed for each role against: one name per thing, dead buttons,
buttons of no use, repeated steps, anything else a client would trip on.
Owner chose the vocabulary (Devices; provision-focused) and kept Block, both
Unregistered panels and the "verified" badges.

- **One wording** (`web/src/lib/format.ts`): request statuses (Details
  pending, Awaiting decision, Queried, Cleared, …), provisioning states
  (Provisioning, Provisioned, Inside, De-provisioning, Ended), category,
  entry mode, device command types and statuses; used on every page and, in
  `api/reports.ts`, in every report's table and CSV.
- **Names:** ID (not PIN / Device ID / Terminal ID / Reference); Device (not
  terminal); "Provisioning" / "Device access" cards, Provision button,
  "De-provision (still inside)", "Provisioning history"; Overstayed; Pass
  type; Valid until; Entry; "Issue new exit code"; "Add zone"; ID card and
  "Print visitor pass"; report titles Provisions issued / Currently
  provisioned / Provisioned but never arrived / Overstayed; person history
  actions in plain words.
- **Fixed:** a photo uploaded on the person page now re-sends to devices
  already holding the face (`api/people.ts`); the printed visitor pass shows
  the visit start (not the provision time) and "Printed" (not "Issued"); the
  out-pass page names "your host (or Security)"; the add-operator form keeps
  its input on failure; operator phone hint says hosts need it; the Blocked
  stat describes manual blocks; the device-scan text no longer offers
  registration from the device; Directory bulk assignment is searchable.
- **Removed:** "Query device" (asked one device, showed nothing), the
  Retention field, the portal's "Save details" (Submit saves), the duplicate
  Retake and history "Visitor pass" link; reports "On site now" and
  "Single-entry blocks". The request page offers New link / Cancel while
  waiting on the visitor and Clear / Query / Reject once submitted, never both.
- **Plain wording:** developer text on the photo card, provisioning
  messages, hand-enrolled warning, unregistered-device warning, Host
  dashboard (links to Requests), walk-in desk cards (Visitor's details /
  photo / mobile), portal end messages ("was not approved"), about a dozen
  server errors (no "entry", "PIN", "INSIDE", raw states).
- Tests: e2e check that a person-page photo upload re-sends to the loaded
  device; report value checks use the labels.
- **Verified:** typecheck PASS; `npm test` 118/118; `verify:e2e` **613
  passed, 0 failed**; web lint + build PASS. No migration.

### 2026-10-14 — 0.5.3 release preparation and upgrade check

- `AppVersion` 0.5.3 (`installer/vms-installer.iss`; same AppId, so it
  upgrades 0.5.2 in place). `build-release.mjs` skips stale
  `query_engine-*.tmp<N>` files when staging `node_modules` (eight were
  present in the dev tree, ~160 MB).
- **Upgrade 0.5.2 → 0.5.3 checked on a database:** a throwaway database was
  migrated with 0.5.2's own schema (commit `368ecf2`, git worktree), seeded
  with site-shaped data (zones with and without the exit-code default,
  devices placed and unplaced, pass types requiring and not requiring the
  code, a resigned employee carrying the 0.4.19 re-adoption bug, punches),
  then migrated with 0.5.3: all five migrations applied; pass types took the
  default exits, the resigned access was repaired, punches took their
  device's zone, hosts gained `directory:create`, indexes created; a second
  run was a no-op. Database, worktree and scratch files removed afterwards.
- **Packaging checked:** `npm run package` into a scratch folder built 0.5.3
  with pdfkit's 15 font files beside `server.cjs` and no `.tmp` engine
  copies; Monthly Status PDF (`%PDF`) and Excel (`PK`) rendered from a
  bundle built with the package's esbuild settings.
- Notes: `VERSIONS.md` § 0.5.3 (to be completed at build time),
  `INSTALL_GUIDE.md` § Upgrading 0.5.2 → 0.5.3.

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

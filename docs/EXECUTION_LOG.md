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

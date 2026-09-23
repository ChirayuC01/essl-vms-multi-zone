# Session Handoff — People, Attendance, Branding, and Offline Licensing Upgrade

**Date:** 27 August 2026  
**Working tree:** implementation in progress; not committed  
**Source plan:** [`PEOPLE_ATTENDANCE_BRANDING_LICENSING_UPGRADE_PLAN.md`](./PEOPLE_ATTENDANCE_BRANDING_LICENSING_UPGRADE_PLAN.md). It is now organized into gated phases and remains the acceptance specification.  
**Living phase record:** [`PEOPLE_UPGRADE_EXECUTION_LOG.md`](./PEOPLE_UPGRADE_EXECUTION_LOG.md)

> **Current-status note, 10 September 2026:** this is a historical session checkpoint. Packaged 0.4.14 is defective; 0.4.18 is the current packaged artifact. The later verification/pending sections below preserve earlier history; current truth is the plan roadmap, execution log, licensing runbook, known issues, release register, and [`PEOPLE_UPGRADE_VERIFICATION_GUIDE.md`](./PEOPLE_UPGRADE_VERIFICATION_GUIDE.md).

## Purpose of this document

This records exactly what was implemented during the session, what was verified, and what still needs work. A new session should read, in order:

1. `AGENTS.md`
2. `docs/PEOPLE_ATTENDANCE_BRANDING_LICENSING_UPGRADE_PLAN.md`
3. `docs/PEOPLE_UPGRADE_EXECUTION_LOG.md`
4. This handoff
5. The current Git diff

Do not restart the feature or repeat the broad rename. Continue from the current uncommitted working tree, work on one phase at a time, and update the execution log after every material change or decision.

## Current position

The repository implementation and local release payload are complete. Fresh PostgreSQL migration has zero drift; backend tests pass 75/75; the complete E2E harness passes 252/252; backend/web production builds and release staging pass. The remaining release gate is environmental acceptance: compile/install on a disposable Windows VM and verify the physical eSSL terminal using [`PEOPLE_UPGRADE_VERIFICATION_GUIDE.md`](./PEOPLE_UPGRADE_VERIFICATION_GUIDE.md).

No commit was created. `AGENTS.md` is an untracked user-owned file and must not be deleted or overwritten.

## Work completed

### 1. Vendor-to-Person active-domain rename

The active backend and web source was mechanically renamed, then corrected by hand:

- `Vendor` / `VendorBiometric` became `Person` / `PersonBiometric`.
- `/api/vendors` became `/api/people`.
- Backend API moved from `backend/src/api/vendors.ts` to `backend/src/api/people.ts`.
- Web routes moved from `web/src/app/(app)/vendors/` to `web/src/app/(app)/people/`.
- Avatar and history components became `person-avatar.tsx` and `person-history.tsx`.
- Entry, command, punch, event, alert, backfill, job, and report references now use Person terminology.
- Installer and Windows service display strings were changed to **Visitor Management System**.

Historical migrations and historical phase/release documents still contain old terminology by design. The new bundled-Postgres legacy guard necessarily queries the old table name.

### 2. Prisma domain model and migration

`backend/prisma/schema.prisma` now includes:

- `PersonCategory`: `EMPLOYEE | VISITOR`
- `PunchDirection`: `IN | OUT`
- `AttendanceQuality`: `EXACT | LEGACY_COUNTS_ONLY`
- `Person`
- `PersonBiometric`
- `Company`
- `Department`
- `EmployeeDeviceAccess`
- `AttendanceDaySummary`
- Person relations on `Entry`, `SyncCommand`, and `AdmissionQueue`
- Category-specific Device fields: `employeeIdPatterns`, `visitorIdPatterns`
- Signed-license `licenseId`
- Punch direction on `PunchEvent`

Important Person fields now include category, mobile, company/department foreign keys, Aadhaar, PAN, eSSL text ID, active state, and device-adoption state.

New migration:

`backend/prisma/migrations/20260827120000_people_attendance_branding_license/migration.sql`

It renames legacy tables/columns, renames the main legacy indexes/constraints, creates directories and Employee access, replaces `punch_day_summary` with `attendance_day_summary`, and adds licensing/direction fields.

`AttendanceDaySummary` also contains `devicePunchCounts` JSON. This is needed because a Person’s day can cross devices; retaining only a list of device IDs would make punch-loss detection incorrectly count the entire day against every device.

### 3. People API and validation

`backend/src/api/people.ts` now supports:

- Person list/detail/create/update/deactivate.
- Category, company, department, and `needsDetails` filters.
- Directory objects in Person responses.
- Profile completion calculation.
- PAN normalization to uppercase.
- PAN regex: `^[A-Z]{5}[0-9]{4}[A-Z]$`.
- Aadhaar-or-PAN validation.
- Duplicate Aadhaar/PAN conflict handling.
- Admin-only category changes.
- Visitor-to-Employee conversion with required device selection.
- Employee-to-Visitor conversion that first revokes permanent assignments.
- Employee deactivation refusal while permanent desired access exists.
- Existing photo attachment when registering a Person whose device photo arrived first.

Visitor Entries are now rejected for Employees and for incomplete profiles.

### 4. Company and Department directories

Added `backend/src/api/directories.ts` with:

- List Company/Department.
- Admin create/edit/activate/deactivate.
- Case-insensitive database uniqueness via functional indexes.
- Bulk Person assignment.
- Inactive values retained on existing profiles but rejected for new assignments.

Added the admin web directory page at `web/src/app/(app)/directory/page.tsx`.

### 5. Employee permanent device access

Added:

- `backend/src/services/employee-access.ts`
- `backend/src/api/employee-access.ts`
- `/api/people/:id/device-access` routes for list, assignment, removal, and restoration.

Behavior implemented:

- Assignment and restoration queue all device writes through the existing command queue.
- Removal records optional reason and who/when removed it.
- `desiredAccess=false` is preserved if the Employee is unexpectedly observed on the terminal again; automatic adoption must not undo an Admin removal.
- Reconciliation treats desired Employee access as permanent and periodically re-sends user/photo state to repair a device purge.
- Employees are excluded from Visitor entry expiry and daily blocking flows.
- Command acknowledgements update Employee provisioning state.

The Person detail UI now has an Employee access panel with assignment, removal reason, and restore actions.

### 6. Device classification and automatic registration

`backend/src/user-id.ts` now provides:

- Empty patterns mean unclassified.
- Exact single-category classification.
- Runtime double-match guard: overlapping match returns `null`.
- Exact overlap detection for the supported `*`-only glob language.

Device API and UI now edit separate Employee and Visitor patterns and reject overlapping configurations.

ADMS ingestion now:

- Automatically creates a classified Person from either USER or BIOPHOTO traffic.
- Preserves original eSSL ID casing.
- Uses the device-reported name when available; if BIOPHOTO arrives first, the placeholder name is later replaced by the USER name.
- Leaves unmatched/double-matched IDs unclaimed.
- Pulls photos only for known or safely classified IDs.
- Creates permanent desired access for a newly adopted Employee on the originating device.
- Leaves Employees on the terminal even with missing details/photo.
- Stores a Visitor JPEG and biometric database row before queuing device removal.
- Does not queue Visitor removal if photo persistence fails.

### 7. Attendance and retention

Added `backend/src/services/attendance.ts`:

- Sorts normalized UTC punches across devices.
- Pairs an IN with the next OUT.
- Sums only completed intervals.
- Counts IN, OUT, total, unmatched IN, and unmatched OUT.
- Records first IN and last OUT.
- Retains per-device punch counts.

Punch processing now stores the resolved direction on each `PunchEvent`.

Retention was refactored so it:

- Selects whole Person/local-day groups only.
- Summarizes each complete group.
- Upserts summaries and deletes raw punches in one database transaction.
- Never splits one Person/day between raw and retained data.
- Preserves per-device counts for baseline and punch-loss reconciliation.

The report registry now includes an `attendance` report with date, Person, device, category, Company, and Department filters. It combines raw and summarized days and exposes worked duration and unmatched warnings. The web Reports page has Today, current-week, current-month, and custom date controls plus directory/category filters.

CSV exports were changed to prepend organization name and report title.

### 8. Organization branding

Added:

- `backend/src/services/branding.ts`
- `backend/src/api/branding.ts`
- Public branding/name/logo endpoints.
- Admin branding update endpoints and permission.
- Persistent logo storage under backend data.
- PNG/JPEG/WebP magic-byte validation, 2 MB limit, no SVG.
- Setup wizard organization name and optional logo.
- Branding settings page at `web/src/app/(app)/settings/page.tsx`.

Branding is applied to login, setup, navigation/header, fallback product metadata, runtime browser title, passes/print shell, and CSV report metadata.

Logo validation now runs before the first Admin is created, so an invalid logo cannot silently complete setup.

### 9. Offline trial and v2 licenses

`backend/src/services/license.ts` was replaced with a v2 implementation:

- Starts a 30-day trial after first-Admin setup completes.
- Stores earliest trial start and latest observed time in PostgreSQL and a ProgramData marker.
- Uses `ProgramData\VMS\license-state.json` on Windows, outside the installer directory.
- Never moves latest observed time backward; future time therefore exposes basic clock rollback.
- Derives v2 Machine ID from a namespaced SHA-256 hash of Windows `MachineGuid`.
- Verifies Ed25519-signed v2 payloads with license ID, machine ID, exact UTC expiry, and plan.
- Requires timezone-aware v2 expiry timestamps.
- Keeps v1 verification compatibility, including legacy date-only expiry parsing.
- Mirrors a paid key to ProgramData and automatically imports a valid mirrored key after reinstall/upgrade.
- Uses unique temporary marker filenames for safer atomic writes.

License middleware now:

- Allows authentication, password change, license status/install, health, and public branding after expiry.
- Returns HTTP 402 with `LICENSE_EXPIRED` for other operator APIs.
- Leaves ADMS endpoints and background jobs outside the license guard.
- Rejects or closes SSE operator streams after expiry.

The client-facing License page and API no longer expose `machineId`, `installationId`, or an equivalent binding identifier. Offline binding remains internal and is collected only by an owner technician during an attended session.

New issuance now uses v3: the readable signed-key payload omits the binding entirely, and the Ed25519 signature covers the payload plus the privately collected binding. The verifier retains v1/v2 compatibility. Standard issuer inspection reconstructs v3 signing input from the private ledger and does not print the binding.

The web API helper redirects HTTP 402 responses to the new renewal page at `web/src/app/(app)/license/page.tsx`.

### 10. Issuer-only tools

Updated/added:

- `backend/scripts/license/issue-license.mjs`
- `backend/scripts/license/inspect-license.mjs`
- `backend/scripts/license/create-license-request.mjs` (the only license helper copied into the client as `C:\VMS\tools\create-license-request.mjs`)
- `backend/scripts/license/license-tools.test.mjs`

The owner-only read command writes the Windows-derived binding directly to a secured file without printing its value. The issue command accepts that binding file, private key, ledger, client name, exact expiry, and plan. It normalizes expiry to UTC, signs only non-client identity data, writes client identity to the private issuer ledger, and prints the key.

The inspection command verifies the signature, decodes the signed payload, and resolves the client name from the private ledger. This is verification plus ledger lookup, not encryption/decryption.

`installer/build-release.mjs` excludes issuer tools, keys, and ledger material. The sole exception is the request-only collector, copied to `C:\VMS\tools\create-license-request.mjs`; it cannot sign or inspect licenses.

### 11. Clean-reinstall protection

`backend/scripts/bundled-postgres.mjs` now checks a reused bundled database for the old identity table before applying migrations. If found, startup/install fails with instructions to archive and relocate/remove the old pgdata and photos. This prevents a normal uninstall—which deliberately preserves data—from silently becoming a “clean” install.

The actual deletion/archive workflow was **not** automated. That is intentional because those photographs and database records may be valuable.

## Verification completed

The following checkpoints succeeded:

- `npx prisma generate`
- Backend `npm run typecheck`
- Web `npm run build` after the main route/type migration
- Backend `npm test`: **73 tests passed, 0 failed**

Those 73 tests include the existing suite plus new tests for:

- Person registration requirements
- Aadhaar normalization
- PAN uppercase normalization and regex
- Aadhaar-or-PAN requirement
- Empty/unmatched/double-matched patterns
- Pattern-overlap detection
- Cross-device attendance pairing
- Consecutive/unmatched attendance anomalies

## Verification that must be rerun first

Some small edits were made after the last green checkpoints. The next session should immediately run:

```powershell
cd C:\Work\essl-vms-main\backend
npx prisma generate
npm run typecheck
npm test
npm run build

cd C:\Work\essl-vms-main\web
npm run lint
npm run build
```

Why rerun:

- The issuer-tool tests were added to `npm test` after the 73-test run and have not yet executed.
- The SSE license guard, branding pre-validation, branded CSV header, and latest license fixes were added after the last backend type-check.
- Web lint previously reported one React `setState`-in-effect error and three image warnings. Fixes were applied, but lint was not rerun.
- The Person edit/device-selection fix and dynamic browser title were applied after the last successful web build.

## Known unfinished or risky areas

### Database migration must be tested against real PostgreSQL

Prisma generation validates the schema, not the SQL migration. Create a disposable database and run all migrations from empty. Also test the legacy-data refusal using a disposable old cluster. Specifically inspect:

- Renamed legacy constraints/indexes.
- Dropping `punch_day_summary` after its `vendor_id` column rename.
- Functional case-insensitive indexes for Person ID, PAN, Company, and Department.
- `AttendanceDaySummary.devicePunchCounts` JSON upsert SQL.
- Raw/summarized attendance report SQL.

The supported rollout is still a clean reinstall; do not turn this into a silent production data migration.

### Attendance report SQL needs integration data

The pure pairing function is tested, but the registry SQL is not yet run against PostgreSQL with realistic cross-device, consecutive-IN, unmatched-OUT, raw-plus-summary, and late-punch cases. Verify pagination and CSV too.

### Automatic registration needs integration tests

Add tests/mocks for:

- USER first and BIOPHOTO first.
- Employee, Visitor, unmatched, and runtime double-match.
- Visitor removal only after disk + DB success.
- Existing intentionally removed Employee being deleted again rather than re-adopted.
- Device name arriving after a placeholder was created.

### License service needs database/ProgramData integration tests

The issuer-tool test exists but is not yet run. Still add or perform verification for:

- Trial survives DB recreation when ProgramData remains.
- Earliest trial start wins.
- Latest observed time never decreases.
- Mirrored v2 key imports into a fresh database.
- Wrong Machine ID, malformed, altered, expired, and replacement keys.
- Later software version adopts the existing ProgramData key.
- Expired license blocks operator APIs while ADMS and jobs continue.

A determined Windows Admin can erase ProgramData/DB or restore a VM snapshot; this limitation is expected and must remain documented.

### Public signing key provisioning is not fully productized

The private key is correctly absent from the installer. However, release creation still needs a defined step that places the product owner’s **public** Ed25519 key into the client configuration (`LICENSE_PUBLIC_KEY`). The next session should make this an explicit release-build input or a clearly enforced preflight. Never generate or commit a production private key.

### UI requires browser testing

Use the actual web app to test:

- Company/Department creation, deactivation, and bulk assignment.
- Manual Employee registration with devices.
- Visitor ↔ Employee category changes.
- Employee device remove/reason/restore.
- Inactive directory values on existing profiles.
- Needs-details filters and warnings.
- Pattern editing and overlap errors.
- Attendance presets/filter combinations/CSV.
- Setup name/logo, fallback branding, and later branding update.
- Trial/paid/expired renewal screen.

### Product documentation is not yet updated

The requested current documentation work remains. Update at least:

- `docs/API_REFERENCE.md`
- `docs/INSTALL_GUIDE.md`
- `docs/LICENSING.md`
- `docs/DEPLOYMENT_READINESS.md`
- `docs/KNOWN_ISSUES.md`
- `docs/VERSIONS.md`
- Current project/context documentation where behavior changed

Historical phase/release records may retain old language when describing old versions.

### Release and physical hardware verification remain

Still required:

- Build backend package and web production bundle.
- Stage installer and confirm issuer scripts are absent.
- Compile/install/uninstall/reinstall on Windows.
- Confirm ProgramData trial/key survival.
- Confirm old persistent pgdata refusal is readable in service/installer logs.
- Verify real terminal alphanumeric Employee and Visitor IDs.
- Verify Employee permanence, Admin removal, Visitor capture-before-delete, command acknowledgements, and reconciliation on hardware.

No claim of hardware verification should be made for this upgrade until those tests happen.

## Recommended next sequence

1. Run all commands in **Verification that must be rerun first** and fix failures only.
2. Inspect `git diff` for accidental mechanical-rename damage, especially comments, report SQL, reset scripts, and `verify-e2e.ts`.
3. Run a fresh PostgreSQL migration from empty and validate schema/index names.
4. Add focused ADMS automatic-registration and license persistence tests.
5. Exercise attendance SQL with seeded raw and summarized data.
6. Browser-test the new web flows.
7. Define and enforce public-license-key injection during release staging.
8. Update all current docs and the clean-install runbook.
9. Build and test the installer on a disposable Windows machine/VM.
10. Perform real terminal verification.
11. Only then update the release version/register and commit.

## Working-tree notes

- The changes are broad: dozens of modified files plus new API/service/pages and the new migration.
- Git may print warnings about being unable to read the user-level global ignore file; use:

```powershell
git -c safe.directory=C:/Work/essl-vms-main status --short
```

- Do not use destructive reset/checkout commands; all current changes are the unfinished implementation.
- Do not delete `backend/data`, ProgramData licensing state, or photographs while validating unless working in an explicitly disposable test environment.

## Definition of done

[`PEOPLE_ATTENDANCE_BRANDING_LICENSING_UPGRADE_PLAN.md`](./PEOPLE_ATTENDANCE_BRANDING_LICENSING_UPGRADE_PLAN.md) remains the authority. In particular, completion requires all listed acceptance tests, updated current documentation, installer verification, and real-terminal alphanumeric Employee/Visitor testing. The present state is a substantial implementation checkpoint, not a completed release.

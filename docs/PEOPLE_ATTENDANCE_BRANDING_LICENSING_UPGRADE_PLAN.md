# People, Attendance, Branding, and Offline Licensing Upgrade

**Plan status updated:** 3 September 2026
**Execution record:** [`PEOPLE_UPGRADE_EXECUTION_LOG.md`](./PEOPLE_UPGRADE_EXECUTION_LOG.md)  
**Session checkpoint:** [`SESSION_HANDOFF_PEOPLE_LICENSING_UPGRADE.md`](./SESSION_HANDOFF_PEOPLE_LICENSING_UPGRADE.md)
**Installation/acceptance guide:** [`PEOPLE_UPGRADE_VERIFICATION_GUIDE.md`](./PEOPLE_UPGRADE_VERIFICATION_GUIDE.md)

> **Field addendum, 1 September 2026:** release candidate 0.4.5 adds Aadhaar-present badges, immutable ID placement before Name, durable all-device Employee resignation, a resigned-employees report, and explicit IST UI/CSV presentation. The implementation decision and verification evidence are recorded in `PEOPLE_UPGRADE_EXECUTION_LOG.md`; the original phased acceptance specification below remains intact.
>
> **LAN-console addendum, 1 September 2026:** release candidate 0.4.6 makes a browser opened from another device use the VMS server hostname/IP for backend traffic and migrates the old localhost-only installed CORS default. Field verification must cover remote login, photos, CSV, and SSE.
>
> **Rehire/time addendum, 1 September 2026:** release candidate 0.4.7 displays terminal-local punch time in the live feed and adds an Admin-only rehire transition requiring explicit device selection. Resignation and rehire are both retained in audit history.
>
> **IST/login/device-label addendum, 2 September 2026:** release candidate 0.4.8 bases live relative age on server receipt time, applies IST to UI/report/export presentation and report filter boundaries, preserves invalid-credential login feedback, and uses Admin device names throughout operator-facing surfaces with serial fallback.

> **Post-build IST correction, 2 September 2026:** the source began serializing every report timestamp to explicit IST at the shared JSON/CSV API boundary, including timezone-less values returned by PostgreSQL raw queries. The existing 0.4.8 installer predated it; it was subsequently packaged in 0.4.9 and later releases.

> **Device-offset correction, 3 September 2026:** adopted terminals now default to IST offset `+330`, Admin can correct the per-device offset, and a migration repairs historical punch-derived timestamps for devices left at the old zero default. This ingestion root fix was absent from 0.4.9 and was packaged in 0.4.10 and later releases.

> **0.4.10–0.4.15 update, 8 September 2026:** 0.4.10 packaged the device-offset correction; 0.4.11 added inclusive IST retention. The 0.4.14 artifact added version visibility and registration UI improvements but is defective because it baked in the development backend URL. Corrected 0.4.15 replaced it.
>
> **0.4.18 update, 10 September 2026:** the current packaged artifact adds consistently styled summarized dashboard accordions, operator self-profile editing and password visibility controls, while retaining the 0.4.16 operator/visitor workflow additions.

## Delivery method

This upgrade is delivered through gated phases. We work on only one active phase at a time. Existing code written before this phased plan is assigned to the appropriate phase, but it is not considered complete merely because code exists.

Each phase moves through these states:

```text
NOT_STARTED → IMPLEMENTED_UNVERIFIED → VERIFYING → ACCEPTED
                                      ↘ BLOCKED
```

- **NOT_STARTED:** no implementation should be assumed.
- **IMPLEMENTED_UNVERIFIED:** code exists but the phase gate has not passed.
- **VERIFYING:** focused tests, review, documentation, or hardware checks are in progress.
- **BLOCKED:** the phase cannot pass its gate; the execution log must identify the blocker and next action.
- **ACCEPTED:** every gate item passed and the execution log was updated. Only then should the next phase begin.

### Documentation rule for every change

After every material code change or product decision, update [`PEOPLE_UPGRADE_EXECUTION_LOG.md`](./PEOPLE_UPGRADE_EXECUTION_LOG.md) in the same working session with:

- Date and phase.
- What changed and why.
- Files or subsystems affected.
- Decision taken and alternatives considered, where applicable.
- Verification performed and its exact result.
- Issue encountered, root cause, and solution/workaround.
- Remaining work and the next action.
- Future scope explicitly deferred outside this release.

Do not mark a phase `ACCEPTED` while its documentation, automated verification, migration check, UI check, or required hardware check is outstanding. A failed check stays recorded even after it is fixed; append the resolution rather than erasing the history.

## Phase roadmap and current state

| Phase | Scope | Current state | Why |
|---|---|---|---|
| 0 | Baseline, safeguards, and execution records | `ACCEPTED` | Fresh schema, builds, tests, and working-tree review completed. |
| 1 | Person schema rename and Company/Department directories | `ACCEPTED` | Fresh PostgreSQL migration and zero-drift comparison passed. |
| 2 | Person profiles, validation, APIs, and UI | `ACCEPTED` | Unit, API, production build, and E2E verification passed. |
| 3 | Device classification and automatic registration | `IMPLEMENTED_UNVERIFIED` | Pattern logic and ADMS ingestion exist; ingestion failure-order and real-device verification remain. |
| 4 | Permanent Employee device access | `IMPLEMENTED_UNVERIFIED` | Access model/API/UI/reconciliation exist; queue, removal, conversion, and purge-recovery integration tests remain. |
| 5 | Attendance summaries and reports | `ACCEPTED` | PostgreSQL raw/summary/retention/report paths pass the E2E suite. |
| 6 | Organization branding and first-admin setup | `IMPLEMENTED_UNVERIFIED` | Branding storage/API/UI/setup exist; persistence, invalid-upload, reinstall, and browser/print checks remain. |
| 7 | Trial, paid licenses, and issuer tools | `IMPLEMENTED_UNVERIFIED` | v3 binding-hidden signing, ledger, ProgramData mirroring, expiry guard, and UI exist; integration/security/reinstall gate remains. |
| 8 | Installer, legacy-data refusal, and upgrade adoption | `IMPLEMENTED_UNVERIFIED` | Release staging and public-key preflight pass; installed-Windows acceptance is in Phase 10. |
| 9 | Cross-feature hardening and current documentation | `ACCEPTED` | 252-check E2E suite and all local build gates pass; acceptance guide added. |
| 10 | Release candidate and real-terminal acceptance | `IMPLEMENTED_UNVERIFIED` | 0.4.14 is packaged but defective; 0.4.15 source fixes release/runtime API configuration. Clean Windows/reinstall/expiry and the remaining real-terminal matrix require acceptance. |

## Phases

### Phase 0 — Baseline, safeguards, and execution records

**Objective:** establish a reproducible starting point and protect the current uncommitted implementation before accepting feature behavior.

**Already done:**

- Original requirements saved in this plan.
- Detailed prior-session checkpoint saved in `SESSION_HANDOFF_PEOPLE_LICENSING_UPGRADE.md`.
- Current work preserved in the working tree; no destructive reset or schema/data deletion performed.
- Active source was scanned for remaining Vendor terminology; the only known deliberate runtime reference is the legacy-table detection query.

**Remaining work:**

- Rerun Prisma generation, backend type-check/build/tests, and web lint/build.
- Review the complete diff for accidental mechanical-rename damage.
- Record exact results in the execution log.
- Confirm `AGENTS.md` remains user-owned and untouched.

**Gate to acceptance:**

- Current code reaches a known reproducible build/test state.
- Every failure is either fixed or logged as a blocker assigned to its owning phase.
- No unexplained file changes remain.

### Phase 1 — Person schema rename and directories

**Objective:** establish the clean Person-centered database and independent Company/Department directories.

**Already implemented:**

- Active `Vendor`/`VendorBiometric` domain renamed to `Person`/`PersonBiometric`.
- Person foreign keys and active API/source/UI naming changed.
- `PersonCategory`, `Company`, `Department`, and directory relations added.
- Case-insensitive directory uniqueness and active/inactive behavior added.
- Admin directory CRUD and bulk assignment API/UI added.
- Migration `20260827120000_people_attendance_branding_license` added.

**Remaining work:**

- Run all migrations against a new disposable PostgreSQL database.
- Inspect final table, column, index, enum, and constraint names.
- Test case-insensitive duplicates and inactive selection rules at database and API levels.
- Decide whether the supported release remains clean-install-only after migration testing; it must never silently become an unsupported data migration.

**Gate to acceptance:**

- Fresh migration succeeds with zero drift relevant to this phase.
- No active schema/API/UI/permission/report terminology uses Vendor naming, except explicit legacy detection/history.
- Directory CRUD, deactivation, retained display, and bulk assignment pass integration tests.
- Schema and API documentation are updated for this phase.

### Phase 2 — Person profiles, validation, APIs, and UI

**Objective:** provide complete Employee/Visitor profiles and replace the former Company text field with governed directory selections.

**Already implemented:**

- `/api/people` list/detail/create/update/deactivate routes.
- Category, Company, Department, and `needsDetails` filters.
- Company/Department dropdowns in create/edit screens.
- PAN uppercase normalization and `^[A-Z]{5}[0-9]{4}[A-Z]$` validation.
- Aadhaar normalization and Aadhaar-or-PAN completion rule.
- Database indexes for identifier uniqueness.
- Admin-only category changes; ordinary profile edits remain available to authorized operators.
- Employee deactivation blocked while desired device access remains.

**Remaining work:**

- Add API integration tests for create/edit/filter/conflict/inactive-directory behavior.
- Verify clear/replace behavior for Aadhaar and PAN fields.
- Browser-test all Person list, create, edit, profile-completion, and error states.
- Confirm audit entries are complete for directory bulk assignment and profile/category changes.

**Gate to acceptance:**

- All completion and uniqueness rules pass at API and PostgreSQL layers.
- Authorized-person versus Admin permissions pass tests.
- New and automatically registered People can be completed entirely through the UI.
- Person API reference and operator-facing documentation are updated.

### Phase 3 — Device classification and automatic registration

**Objective:** safely classify device users and create People automatically without touching unclaimed or ambiguous terminal records.

**Already implemented:**

- Per-device `employeeIdPatterns` and `visitorIdPatterns`.
- Empty-pattern, unmatched, and runtime double-match behavior.
- Exact overlap detection for the supported `*` glob language.
- Automatic Person creation from USER or BIOPHOTO.
- Original eSSL ID casing preservation and later device-name enrichment.
- Known People remain managed after pattern changes.
- Visitor photo persistence precedes queued terminal removal.
- Employee creation establishes originating-device permanent desired access.

**Remaining work:**

- Add mocked ADMS tests for USER-first, BIOPHOTO-first, duplicate/concurrent ingest, disk failure, DB failure, and command-queue failure.
- Verify unmatched/double-matched users appear in the review workflow without photo overcollection or deletion.
- Browser-test pattern editing and the unclaimed roster.
- Verify alphanumeric Employee and Visitor patterns on a real terminal.

**Gate to acceptance:**

- A Visitor is never removed unless JPEG and biometric metadata are durable.
- An Employee remains on the terminal and receives desired access even with incomplete details.
- Ambiguous/unmatched users remain untouched.
- Real-device USER/BIOPHOTO behavior and exact command results are recorded in the execution log and project context.

### Phase 4 — Permanent Employee device access

**Objective:** separate permanent Employee access from time-bounded Visitor Entry lifecycle behavior.

**Already implemented:**

- `EmployeeDeviceAccess` model with desired/provisioned state, actor/time, removal reason, and restoration.
- Admin API and Person-detail UI for assign/remove/restore.
- Manual Employee and Visitor-to-Employee device selection.
- Employee-to-Visitor assignment revocation.
- Queue-only device writes.
- Reconciliation restoration for desired Employees.
- Automatic observation does not undo an intentional `desiredAccess=false` removal.
- Employees excluded from Visitor expiry and daily block flows.

**Remaining work:**

- Integration-test command acknowledgements and provisioning-state transitions.
- Test Employee device purge recovery, intentional removal, restoration, conversion in both directions, offline device retries, and missing-photo alerts.
- Confirm face counts and reconciliation do not double increment/decrement.
- Browser-test optional removal reason and command-status display.

**Gate to acceptance:**

- Desired Employees self-heal after a simulated purge.
- Removed Employees remain removed until explicit restoration.
- No Employee enters Visitor retention/expiry/daily-block paths.
- Audit/removal history survives every conversion and access change.

### Phase 5 — Attendance summaries and reports

**Objective:** provide durable daily attendance with correct cross-device IN/OUT pairing and filters.

**Already implemented:**

- Punch direction persisted during processing.
- Pure attendance pairing service and unit tests.
- Cross-device day summaries with first IN, last OUT, worked seconds, counts, anomalies, and per-device counts.
- Transactional whole-Person/day retention summarization before raw deletion.
- Attendance report registry definition and web presets/filters.
- Organization/report title included in CSV output.

**Remaining work:**

- Run raw, summarized, and mixed report SQL against PostgreSQL fixtures.
- Test late punches, consecutive IN/OUT, unmatched events, multiple intervals, multiple devices/timezones, pagination, filters, and CSV.
- Verify retention cannot split a Person/day and punch-loss baseline remains correct.
- Check whether `AttendanceQuality.LEGACY_COUNTS_ONLY` behavior and late-summary merging require refinement.
- Browser-test daily/current-week/current-month/custom presets and duration formatting.

**Gate to acceptance:**

- Report values match hand-calculated fixtures.
- Retention and punch-loss detection remain accurate before and after pruning.
- All specified filters and CSV export pass.
- Attendance behavior and retention design are documented.

### Phase 6 — Organization branding and first-admin setup

**Objective:** make the installation organization-aware while keeping customer organization separate from the Company directory.

**Already implemented:**

- Organization name and optional logo in first-admin setup.
- Persistent branding configuration and local logo storage.
- PNG/JPEG/WebP magic validation and 2 MB limit; SVG rejected.
- Public branding endpoints and Admin update endpoints/UI.
- Login, setup, navigation/header, browser title, print shell, and CSV branding.
- Logo validation before first Admin creation.

**Remaining work:**

- Test invalid/truncated/spoofed/oversized images and storage failures.
- Test fallback name/no-logo behavior and updates.
- Verify branding survives service restart, upgrade, and ordinary uninstall/reinstall.
- Browser/print-test layout at practical logo dimensions.

**Gate to acceptance:**

- Setup and later Admin updates persist correctly.
- Unsupported images never become active branding.
- Login, application shell, title, reports/exports, and print views display correct fallback or configured branding.
- Install guide documents branding storage and backup.

### Phase 7 — Trial, paid licenses, and issuer tools

**Objective:** deliver a persistent 30-day offline trial and machine-bound, exact-expiry paid licenses without shipping the private signing key or client names.

**Already implemented:**

- Trial start/latest-seen reconciliation across PostgreSQL and ProgramData.
- Namespaced MachineGuid hash for Machine ID.
- v3 Ed25519 signature bound to the private installation value while omitting that value from the readable key payload; exact timezone-aware expiry, license ID, and plan.
- ProgramData paid-key mirroring/import.
- Basic clock rollback resistance.
- v1 verification compatibility.
- Expiry guard for operator APIs and SSE while ADMS/jobs remain operational.
- Renewal screen and Admin-only key installation.
- Issuer issue/inspect scripts and private client ledger.
- Issuer folder excluded from client release staging.

**Remaining work:**

- Run issuer-tool tests added after the last green suite.
- Add service integration tests for malformed, altered, expired, wrong-machine, replacement, v1/v2 compatibility, and v3 keys.
- Test trial/key survival across DB recreation and ordinary uninstall/reinstall.
- Test clock rollback and VM/MachineGuid change behavior.
- Define an enforced release-build input/preflight for the public Ed25519 key.
- Review ProgramData file permissions, concurrent marker writes, and service-account access.

**Gate to acceptance:**

- Exact signed expiry is enforced and cannot be edited.
- Client name resolves only through the private issuer ledger.
- Trial and paid key survive supported reinstall/upgrade flows.
- Expiry blocks only operator functions specified by this plan; ADMS/jobs and existing barrier authorization continue.
- Licensing runbook documents key generation, ledger backup, renewal, replacement, and limitations.

### Phase 8 — Installer, legacy-data refusal, and upgrade adoption

**Objective:** safely package the schema-changing release and distinguish clean install, ordinary reinstall, and later upgrade behavior.

**Already implemented:**

- Bundled PostgreSQL refuses a reused cluster containing the legacy identity table.
- Error text explains that uninstall preserves data and old pgdata/photos must be archived or relocated deliberately.
- Installer/service product strings use Visitor Management System.
- License issuer scripts remain excluded from client payload.

**Remaining work:**

- Test legacy refusal on a disposable old installation.
- Test a genuinely empty install and later ordinary reinstall/upgrade.
- Verify ProgramData trial/key adoption and persistent branding/photos.
- Add a release preflight for the configured public signing key.
- Update the clean-install archive/removal runbook without automating destructive deletion.

**Gate to acceptance:**

- Installer never silently initializes this release against old persistent schema data.
- Empty install, uninstall/reinstall, and later-version upgrade follow documented behavior.
- Private issuer materials are absent from the installed machine.
- Installer logs/errors give an operator a recoverable next step.

### Phase 9 — Cross-feature hardening and current documentation

**Objective:** prove combined behavior and bring every current document in line with reality.

**Required work:**

- Run end-to-end flows combining automatic registration, profile completion, Employee access, Visitor Entry, punches, attendance, branding, and license states.
- Review authorization and audit coverage across all new routes.
- Review performance for remote PostgreSQL constraints and eliminate N+1/per-row database behavior on hot paths.
- Update `API_REFERENCE.md`, `INSTALL_GUIDE.md`, `LICENSING.md`, `DEPLOYMENT_READINESS.md`, `KNOWN_ISSUES.md`, `VERSIONS.md`, and relevant current context documents.
- Reconcile this plan, execution log, and handoff with the final implementation.

**Gate to acceptance:**

- Complete automated/backend/web verification is green.
- Current docs describe the code actually shipping.
- All known issues have impact, workaround/check, owner/next action, and release disposition.
- No unresolved high-risk security, data-loss, access-control, or installer issue remains.

### Phase 10 — Release candidate and real-terminal acceptance

**Objective:** build and verify the release on the deployment environment and physical eSSL hardware.

**Required work:**

- Build backend package, production web bundle, staged installer, and installer executable.
- Install on a disposable clean Windows machine/VM and exercise first setup.
- Verify uninstall/reinstall, ProgramData licensing persistence, and legacy-data refusal.
- Verify alphanumeric Employee and Visitor IDs on the real terminal.
- Verify Visitor photo-before-delete, Employee permanence, Admin removal/restore, reconciliation, punch ingestion, attendance, and behavior after software-license expiry.
- Record exact firmware syntax/results and update known issues/project context.
- Cut the release only after all acceptance results are documented.

**Gate to acceptance:**

- All acceptance items at the end of this plan pass or have an explicitly approved release disposition.
- Installer contents and version/register are correct.
- Physical hardware evidence is recorded.
- The phase execution log is complete and the release is reproducible.

## Scope control and future work

Anything intentionally excluded must be added to the execution log’s Future Scope section instead of being silently forgotten. Current known exclusions include:

- Historical Company/Department transfer tracking in attendance reports.
- Reliable protection against a determined Windows Administrator deleting PostgreSQL and ProgramData or restoring a VM snapshot; that requires online activation or hardware-backed licensing.
- Automatic migration of legacy production identity data in this clean-install release.
- Treating face templates as portable across algorithms/devices.

## Summary

Replace the Vendor domain with a clean People model containing Employees and Visitors. Because this release can use a clean reinstall, remove legacy naming rather than maintaining compatibility aliases.

The release will add:

- Employee and Visitor categories.
- Company and Department directories.
- Automatic device registration.
- Permanent Employee device access.
- Attendance reporting.
- Organization branding.
- A persistent 30-day trial and machine-bound paid licenses.
- Issuer-only tools for generating and inspecting licenses.

## People and Directory Model

### Complete Vendor-to-Person rename

Rename active schema, source code, APIs, permissions, UI, reports, variables, and documentation:

- `Vendor` → `Person`
- `VendorBiometric` → `PersonBiometric`
- `vendor` table → `person`
- `vendor_biometric` → `person_biometric`
- `vendor_id` foreign keys → `person_id`
- `/api/vendors` → `/api/people`
- Vendor permissions, services, audit entity types, UI routes, labels, and TypeScript types → Person equivalents
- `vendorIdPatterns` → category-specific patterns

Historical phase and release documents may retain “Vendor” where they describe old releases, but all current product documentation will use “Person”, “Employee”, or “Visitor”.

The fresh schema will include:

```text
Person
PersonBiometric
Company
Department
EmployeeDeviceAccess
Entry
PunchEvent
AttendanceDaySummary
```

The installer must detect an old persistent PostgreSQL data directory and refuse to silently initialize against it. The clean-install runbook will explicitly archive or remove the old database and photographs after confirming no production data is needed. A normal uninstall alone is insufficient because the current uninstaller deliberately preserves its data directory.

### Person fields

Add:

- `category`: `EMPLOYEE | VISITOR`
- `name`
- `mobile`
- `companyId`
- `departmentId`
- `aadharNumber`
- `panNumber`
- `esslUserId`
- `isActive`
- `adoptedFromDevice`
- Created/updated timestamps

A completed profile requires:

- Name
- Mobile number
- Company
- Department
- Category
- Either Aadhaar or PAN

Aadhaar and PAN are each unique when provided.

Normalize PAN by trimming and converting it to uppercase before validation and storage. Validate with:

```regex
^[A-Z]{5}[0-9]{4}[A-Z]$
```

Example: `ABCDE1234F`.

Enforce uniqueness in PostgreSQL as well as application validation. Aadhaar remains a normalized 12-digit value.

### Company and Department

Company and Department remain independent directories.

- Case-insensitively unique names.
- Active/inactive instead of destructive deletion.
- One Company and one Department per Person.
- Each directory record can have multiple Employees and Visitors.
- Admin interfaces support create, edit, deactivate, and bulk person assignment.
- Inactive values remain visible on existing profiles but cannot be newly selected.

The customer organization used for branding is separate from the Company directory.

## Device Registration and Access Rules

### Classification patterns

Each device receives:

- `employeeIdPatterns`
- `visitorIdPatterns`

Rules:

- Empty patterns mean no automatic classification.
- Configurations whose Employee and Visitor globs can overlap are rejected.
- A runtime double-match guard leaves the ID unclaimed and untouched.
- IDs matching neither list remain available for admin review.
- Known People remain managed even if patterns later change.

### Automatic registration

When a classified USER or BIOPHOTO arrives:

1. Look up the Person case-insensitively by eSSL ID.
2. Create them automatically if they do not exist.
3. Preserve the device’s original ID casing.
4. Store the available device name and category.
5. Mark missing administrative fields as `needsDetails`.
6. Persist the photograph locally and attach the PersonBiometric record.

For Visitors:

- Remove them from the device only after the JPEG and database record are safely stored.
- If photo storage fails, do not remove them.
- Completing their profile does not automatically restore access.
- An operator must create a normal Entry containing purpose, mode, and retention window.

For Employees:

- Create permanent desired access for the originating device.
- Leave them on the device even if their administrative profile is incomplete.
- Alert the admin about missing profile details or photographs.
- Never process them through Visitor retention, expiry, or daily blocking.

### Employee device access

`EmployeeDeviceAccess` records:

- Person and device.
- `desiredAccess`.
- Assigned by/at.
- Removed by/at.
- Optional removal reason.
- Current provisioning status.

Behavior:

- Manual Employee registration requires selecting one or more devices.
- Visitor-to-Employee conversion also requires device selection.
- Reconciliation restores missing Employees when `desiredAccess=true`.
- Admin removal sets `desiredAccess=false` and queues terminal deletion.
- Reconciliation must not restore an intentionally removed Employee.
- Access can be restored later from the permanent photo.
- Employee-to-Visitor conversion revokes every permanent assignment first.
- Database identity, photograph, punches, audit history, and removal reason are never deleted.

Every device write continues through the existing command queue.

## API, Permissions, and UI

Add or replace APIs for:

- `/api/people`
- `/api/companies`
- `/api/departments`
- `/api/people/:id/device-access`
- Device Employee/Visitor patterns
- `/api/branding`
- Attendance reports
- License status and installation

Add admin-only permissions for:

- Directory management.
- Category changes.
- Employee device access.
- Branding configuration.
- License installation.

Existing authorized operators may edit ordinary Person information but cannot change category, create directory values, or alter permanent Employee access.

UI changes:

- “People” navigation replacing “Vendors”.
- Employee, Visitor, Company, Department, and profile-completion filters.
- Company and Department dropdowns.
- Admin directory screens with bulk assignment.
- Employee device-access panel with remove, optional reason, restore, and command status.
- Unclaimed device roster for unmatched IDs.
- “Needs details” warning for incomplete automatically registered People.

## Attendance Reporting

Create one Attendance report with presets:

- Daily
- Current week
- Current month
- Custom date range

Filters:

- Employee/Visitor category
- Company
- Department
- Person
- Device

Default includes Employees and Visitors.

Each person/day row contains:

- Name and device ID.
- Category, Company, and Department.
- First IN.
- Last OUT.
- Worked duration.
- IN, OUT, and total punch counts.
- Unmatched-punch warning.

Worked duration uses paired events:

- Combine a Person’s punches across devices for the device-local date.
- Sort by normalized UTC timestamp.
- An IN opens an interval.
- The next OUT closes it.
- Sum only completed intervals.
- Consecutive or unmatched events are flagged and excluded from duration.

Add a durable `AttendanceDaySummary` containing paired duration, first/last times, counts, and anomalies.

Refactor retention to summarize complete person/day groups transactionally before deleting raw punches. No person/day may be split between raw and summarized data.

Reuse the current report registry, pagination, CSV export, and SSE patterns. Reports use the Person’s current Company and Department; organization-transfer history is outside this release.

## Organization Branding

During first-admin setup:

- Collect organization name.
- Optionally upload a logo.
- Create the initial 30-day trial.

Store the organization name in application configuration and the logo under persistent backend data storage.

Accept PNG, JPEG, or WebP with content validation and a size limit. Do not accept SVG.

Apply branding to:

- Login and setup screens.
- Navigation and headers.
- Browser title.
- Report and print views.
- Relevant exports.

If no logo is supplied, use the organization name with the existing VMS fallback branding. Admin can update branding later.

## Licensing

### Where license keys are generated

License keys are generated only on the product owner’s secured computer using issuer-only Node scripts. The private signing key must never be included in the client installer.

The existing issuer script will be expanded and packaged separately from the installer:

```powershell
node backend/scripts/license/issue-license.mjs `
  --private-key "C:\Secure\VMS-Licensing\vms-license-private.pem" `
  --ledger "C:\Secure\VMS-Licensing\vms-license-ledger.json" `
  --machine-id-file "X:\license-request.txt" `
  --client-name "<client-name>" `
  --expires-at "2027-08-01T18:30:00+05:30" `
  --plan "standard"
```

The client-facing UI/API does not expose the internal binding. The installer includes only `C:\VMS\tools\create-license-request.mjs`; during an attended session it writes the value directly to `license-request.txt` on secured media without printing it. The issuer command consumes that file and prints the license key for delivery.

The exact date, time, and timezone supplied to `--expires-at` are normalized to UTC and signed into the key. When the client installs the key, the VMS:

1. Verifies the Ed25519 signature.
2. Reconstructs the signed bytes using the installation's private binding and rejects a key issued for another installation.
3. Reads the signed expiry instant.
4. Stores that expiry.
5. Immediately reports the resulting active/expired status.

A client cannot edit the expiry without invalidating the signature.

Require a complete ISO-8601 timestamp containing either `Z` or an explicit timezone offset. Reject ambiguous local timestamps.

### Client identification and issuer ledger

Use a private issuer ledger instead of embedding the client name in the key.

The signed key contains:

```json
{
  "v": 3,
  "licenseId": "random-uuid",
  "expiresAt": "2027-08-01T13:00:00.000Z",
  "plan": "standard"
}
```

The Ed25519 signature is calculated over these payload bytes plus the privately collected installation binding. The key therefore remains installation-bound without placing that binding in the decodable payload.

The private issuer ledger stores:

- License ID.
- Client name.
- Machine ID.
- Expiry.
- Plan.
- Issued timestamp.
- Issued key or key fingerprint.

This keeps client names out of the repository, installer, and client-visible license payload.

Add an issuer-only inspection command:

```powershell
node backend/scripts/license/inspect-license.mjs `
  --public-key "C:\Secure\VMS-Licensing\vms-license-public.pem" `
  --ledger "C:\Secure\VMS-Licensing\vms-license-ledger.json" `
  "<license-key>"
```

It will:

- Verify the key signature.
- Decode the license ID, plan, and expiry without displaying the private binding.
- Look up and display the client name from the private ledger.

This is verification and ledger lookup, not decryption. The issuer ledger must be backed up; the client name cannot be recovered from the key if that ledger is lost.

### Trial and reinstall prevention

- Start a 30-day trial when first-admin setup completes.
- Store trial start and latest observed time in PostgreSQL and Windows ProgramData.
- Derive the Machine ID from a namespaced hash of Windows `MachineGuid`.
- Keep the ProgramData licensing marker outside the installer directory.
- Do not remove it during uninstall.
- Store a valid paid key in PostgreSQL and mirror it in ProgramData.
- A reinstalled or upgraded version verifies and imports the ProgramData key automatically.
- Trial reconciliation always keeps the earliest trial start and latest observed time.
- Never move `latestObservedAt` backwards, providing basic clock-rollback detection.

A clean reinstall of this schema-changing development release may require reissuing an old v1 key once. Existing v2 keys remain compatible, and all v3 keys issued by this release survive later upgrades and ordinary reinstalls.

A full Windows reinstall, changed `MachineGuid`, or hardware/VM replacement requires a replacement license key.

A determined Windows administrator can still erase PostgreSQL and ProgramData or restore a VM snapshot. Reliably preventing that would require online activation or hardware-backed licensing.

### Expiry behavior

After expiry:

- Allow login needed for renewal, password change, branding display, health, license status, and license installation.
- Block all other operator APIs with `LICENSE_EXPIRED`.
- Display a renewal screen where an Admin can install the new key.
- Continue device ADMS communication, punch ingestion, command dispatch, retention, reconciliation, and existing barrier access.
- Never block or remove authorized People merely because the software license expired.

## Verification and Release

Acceptance testing must cover:

- No active schema, API, source, UI, permission, or report references using Vendor terminology.
- Clean-install detection of legacy persistent data.
- PAN normalization, regex, and uniqueness.
- Aadhaar-or-PAN completion validation.
- Company/Department management and bulk assignment.
- Pattern overlap and unmatched-ID behavior.
- Visitor photo persistence before removal.
- Permanent Employee access, reconciliation, removal reason, and restoration.
- Cross-device IN/OUT pairing and unmatched punches.
- Daily, weekly, monthly, custom, filtered, and CSV reports.
- Branding setup, fallback, persistence, and updates.
- Exact timezone-aware license expiry.
- Issuer ledger creation and inspection.
- Altered, malformed, expired, wrong-machine, and replacement keys.
- Trial persistence across uninstall/reinstall and clock rollback.
- License adoption by later versions.
- Continued ADMS/jobs behavior after software-license expiry.
- Real terminal verification with alphanumeric Employee and Visitor IDs.

Update the install guide, API reference, licensing runbook, deployment checklist, known issues, and release register before shipping.

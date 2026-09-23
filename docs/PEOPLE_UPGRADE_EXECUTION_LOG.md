# People Upgrade — Execution Log

**Plan:** [`PEOPLE_ATTENDANCE_BRANDING_LICENSING_UPGRADE_PLAN.md`](./PEOPLE_ATTENDANCE_BRANDING_LICENSING_UPGRADE_PLAN.md)  
**Initial checkpoint:** [`SESSION_HANDOFF_PEOPLE_LICENSING_UPGRADE.md`](./SESSION_HANDOFF_PEOPLE_LICENSING_UPGRADE.md)  
**Created:** 29 August 2026

## How to maintain this log

Append to this document after every material implementation change, decision, verification run, or discovered issue. Do not rewrite failed attempts out of history. Use the change-record template below and update the phase status table.

### Change-record template

```markdown
### YYYY-MM-DD — Phase N — Short title

- Status: IMPLEMENTED_UNVERIFIED | VERIFYING | BLOCKED | ACCEPTED
- Change:
- Reason/decision:
- Alternatives considered:
- Files/subsystems:
- Verification and exact result:
- Issue/root cause:
- Solution/workaround:
- Pending/next action:
- Future scope:
```

Use `Not applicable` instead of omitting a field when there was no decision, issue, or future-scope item.

## Phase status

| Phase | Status | Last update | Next gate action |
|---|---|---|---|
| 0 — Baseline and safeguards | `ACCEPTED` | 2026-08-30 | Preserve green generation/type-check/test/lint/build/release gates. |
| 1 — Schema and directories | `ACCEPTED` | 2026-08-29 | Preserve fresh-migration and zero-drift evidence. |
| 2 — Person profiles | `ACCEPTED` | 2026-08-29 | Preserve API/browser/E2E coverage. |
| 3 — Classification/auto-registration | `IMPLEMENTED_UNVERIFIED` | 2026-08-29 | ADMS failure-order tests and real terminal verification. |
| 4 — Employee device access | `IMPLEMENTED_UNVERIFIED` | 2026-08-29 | Queue/reconciliation/removal/conversion integration tests. |
| 5 — Attendance | `ACCEPTED` | 2026-08-29 | Preserve PostgreSQL report/retention E2E coverage. |
| 6 — Branding | `IMPLEMENTED_UNVERIFIED` | 2026-08-29 | Persistence, upload validation, browser, and print testing. |
| 7 — Licensing | `IMPLEMENTED_UNVERIFIED` | 2026-08-29 | Run issuer tests and add ProgramData/database integration tests. |
| 8 — Installer/reinstall | `IMPLEMENTED_LOCAL_VERIFIED` | 2026-08-30 | Run clean install/reboot/reinstall/legacy-refusal testing on Windows Server 2016. |
| 9 — Hardening/docs | `ACCEPTED_LOCAL` | 2026-08-30 | Preserve the release audit and obtain an Authenticode certificate before external distribution. |
| 10 — Release/hardware | `IMPLEMENTED_UNVERIFIED` | 2026-09-03 | Install current candidate on disposable Windows, verify runtime version/LAN/IST/visitor lifecycle behavior, and complete the remaining physical-terminal acceptance. |

## Existing implementation assigned to phases

The code below was written before phase gating was introduced. It is recorded as implementation evidence, not phase acceptance.

### 2026-08-27 — Phase 1 — Person schema and directories implemented

- Status: `IMPLEMENTED_UNVERIFIED`
- Change: Renamed the active identity domain to Person; added Person category, Company, Department, directory APIs/UI, permissions, bulk assignment, and the schema migration.
- Reason/decision: The release permits clean reinstall, so compatibility aliases and a mixed Vendor/Person domain were rejected.
- Alternatives considered: In-place compatibility layer; rejected because it prolongs legacy terminology and complexity. The migration SQL still needs disposable-database verification.
- Files/subsystems: Prisma schema/migration, People/directory APIs, permissions, directory UI, active backend/web references.
- Verification and exact result: Prisma client generation succeeded; backend type-check later passed. PostgreSQL migration was not applied during the session.
- Issue/root cause: Existing uninstall preserves pgdata, so “uninstall and reinstall” is not automatically clean.
- Solution/workaround: Phase 8 legacy-schema refusal plus an explicit archive/removal runbook.
- Pending/next action: Fresh PostgreSQL migration and directory integration tests.
- Future scope: Legacy production-data migration is excluded from this release.

### 2026-08-27 — Phase 2 — Person profile validation and UI implemented

- Status: `IMPLEMENTED_UNVERIFIED`
- Change: Added category, directory fields/dropdowns, needs-details behavior, Aadhaar-or-PAN validation, PAN normalization/regex, uniqueness handling, filters, and Person create/edit/list/detail UI.
- Reason/decision: Automatically registered device identities can exist incomplete, but manual Visitor authorization requires a completed administrative profile.
- Alternatives considered: Keeping Company as free text; rejected in favor of governed directories.
- Files/subsystems: `backend/src/api/people.ts`, People web routes/components, Prisma Person fields/indexes.
- Verification and exact result: Unit tests for Aadhaar, PAN, and completion validation passed in the 73-test backend run.
- Issue/root cause: Mechanical rename left several UI sites treating Company as text.
- Solution/workaround: Corrected Person detail/pass/card/provision references to directory objects; web production build subsequently passed at that checkpoint.
- Pending/next action: API integration, browser testing, and identifier replacement/clear behavior review.
- Future scope: Historical organization-transfer reporting is excluded.

### 2026-08-27 — Phase 3 — Device classification and automatic registration implemented

- Status: `IMPLEMENTED_UNVERIFIED`
- Change: Added separate patterns, overlap detection, runtime ambiguity guard, automatic USER/BIOPHOTO Person creation, name enrichment, and Visitor capture-before-removal behavior.
- Reason/decision: Empty or ambiguous classification cannot safely choose permanent Employee versus expiring Visitor lifecycle.
- Alternatives considered: Empty patterns meaning “claim all”; rejected as unsafe for shared terminals and ambiguous categories.
- Files/subsystems: user ID utilities/tests, Device API/UI, ADMS ingestion, reconciliation.
- Verification and exact result: Pattern unit tests passed. ADMS integration and physical terminal tests remain.
- Issue/root cause: BIOPHOTO can arrive before USER, which initially left only a file and no automatically registered Person/name.
- Solution/workaround: BIOPHOTO now invokes automatic registration; a later USER replaces the generated placeholder name.
- Pending/next action: Failure-order tests and real-terminal alphanumeric verification.
- Future scope: None recorded.

### 2026-08-27 — Phase 4 — Permanent Employee access implemented

- Status: `IMPLEMENTED_UNVERIFIED`
- Change: Added EmployeeDeviceAccess model/service/API/UI, assignment/removal/restore, category conversion handling, queue integration, and reconciliation self-heal.
- Reason/decision: Employees must remain permanently desired on selected terminals and must never use Visitor expiry/daily-block lifecycle.
- Alternatives considered: Permanent synthetic Entry; rejected because it would mix distinct lifecycle and reporting semantics.
- Files/subsystems: Prisma model/migration, employee access service/API, queue acknowledgements, reconciliation, expiry/entry services, Person detail UI.
- Verification and exact result: Backend type-check passed at the implementation checkpoint; focused integration tests remain.
- Issue/root cause: Initial automatic adoption could have reset an Admin’s intentional `desiredAccess=false` removal.
- Solution/workaround: Existing access observations now update provisioning state only; they never restore desired access. Explicit restore remains Admin-only.
- Pending/next action: Test device purge, removal, restore, conversion, retries, and face counts.
- Future scope: None recorded.

### 2026-08-27 — Phase 5 — Attendance and durable summaries implemented

- Status: `IMPLEMENTED_UNVERIFIED`
- Change: Added direction persistence, attendance pairing service, whole-Person/day transactional retention, AttendanceDaySummary, report definition, web presets/filters, and branded CSV metadata.
- Reason/decision: Worked time requires chronological pairing across terminals, while retention must preserve complete days and punch-loss accounting.
- Alternatives considered: Per-device day summaries; rejected because an IN and OUT may occur on different devices.
- Files/subsystems: punch processing, attendance service/tests, retention, report registry/API/UI, Prisma schema/migration, punch baseline reconciliation.
- Verification and exact result: Pure attendance unit tests passed in the 73-test run. Report/retention SQL has not been integration-tested against PostgreSQL.
- Issue/root cause: Storing only `deviceIds` would count a combined day’s total punches against every participating device.
- Solution/workaround: Added `devicePunchCounts` JSON and changed baseline/reconciliation aggregation to use per-device retained counts.
- Pending/next action: PostgreSQL fixtures for raw/summarized/mixed days, late punches, anomalies, filters, CSV, and pruning.
- Future scope: Historical Company/Department transfer attribution is excluded.

### 2026-08-27 — Phase 6 — Branding and setup implemented

- Status: `IMPLEMENTED_UNVERIFIED`
- Change: Added organization name/logo during setup, persistent branding service/API, Admin settings, supported-image validation, and branded UI/title/export behavior.
- Reason/decision: Customer organization identity is installation configuration and must remain separate from the Person Company directory.
- Alternatives considered: SVG upload; rejected because active/vector content adds unnecessary security risk.
- Files/subsystems: setup API/UI, branding service/API/settings, application layout/login/title, report CSV.
- Verification and exact result: Web build passed before the final title/lint adjustments; latest changes require rerun.
- Issue/root cause: Setup originally validated/saved the optional logo only after creating the Admin, allowing an invalid logo to complete setup silently.
- Solution/workaround: Logo content validation now occurs before the Admin transaction.
- Pending/next action: Rerun lint/build; test persistence, invalid files, restart/reinstall, browser, and print layouts.
- Future scope: None recorded.

### 2026-08-27 — Phase 7 — Offline trial and licenses implemented

- Status: `IMPLEMENTED_UNVERIFIED`
- Change: Added 30-day trial, ProgramData marker, MachineGuid hash, v2 Ed25519 licenses, exact expiry, key mirroring/import, expiry guard, renewal UI, issuer ledger, and issue/inspect tools.
- Reason/decision: Client name is private issuer metadata and is not embedded in the signed client-visible key.
- Alternatives considered: Encrypted client name inside the key; rejected because signing plus a private ledger is simpler, avoids distributing a decryption secret, and keeps client names off client systems.
- Files/subsystems: license service/API/UI, setup, app/SSE guards, issuer scripts/tests, config, release exclusion.
- Verification and exact result: Core backend type-check passed before the last edits. Issuer-tool tests were added after the 73-test run and have not yet run.
- Issue/root cause: v2 strict timezone parsing would have rejected legacy v1 date-only keys during reinstall adoption.
- Solution/workaround: Strict exact timestamps apply to v2; a separate legacy parser retains v1 compatibility.
- Pending/next action: Full tests, ProgramData/database persistence, clock rollback, wrong-machine/replacement keys, permissions, and public-key release preflight.
- Future scope: Strong protection against Administrator deletion or VM snapshots requires online/hardware-backed activation.

### 2026-08-27 — Phase 8 — Legacy-data refusal and installer adjustments implemented

- Status: `IMPLEMENTED_UNVERIFIED`
- Change: Bundled PostgreSQL now refuses the legacy identity table, installer/service product text was updated, and issuer scripts remain excluded from staging.
- Reason/decision: The existing uninstaller preserves runtime data, so a clean-schema release must not silently reuse it.
- Alternatives considered: Automatic destructive deletion; rejected because database and photographs may be valuable and deletion must remain deliberate.
- Files/subsystems: bundled Postgres bootstrap, installer definition, release staging, Windows service descriptions.
- Verification and exact result: Source inspection only; no disposable Windows install/reinstall test yet.
- Issue/root cause: A normal uninstall is insufficient for a clean install.
- Solution/workaround: Fail early with archive/relocate instructions and document the clean-install procedure.
- Pending/next action: Test empty install, legacy refusal, reinstall/upgrade adoption, ProgramData persistence, and installer contents.
- Future scope: Automated legacy data migration is excluded.

### 2026-08-27 — Phase 0 — Verification checkpoints before phased planning

- Status: `VERIFYING`
- Change: Generated Prisma client, ran backend type-check, backend tests, web build, and an initial web lint.
- Reason/decision: Establish basic compile/test evidence during broad implementation.
- Alternatives considered: Not applicable.
- Files/subsystems: Entire backend and web application.
- Verification and exact result: Prisma generation passed; backend type-check passed; backend tests passed 73/73; web production build passed at its checkpoint. Web lint later found one state-in-effect error and image warnings; fixes were applied but lint was not rerun. Later backend/web edits also require all checks to rerun.
- Issue/root cause: Stale Next `.next` route types referenced removed `/vendors` pages; later Company object/type assumptions and a React lint rule also failed.
- Solution/workaround: Removed the generated `.next` directory, corrected Company references, moved edit-form initialization to the Edit action, and documented intentional runtime `<img>` use.
- Pending/next action: Run the complete Phase 0 command set and log exact results.
- Future scope: Not applicable.

### 2026-08-29 — Phase 8 — Windows Server 2016 PostgreSQL service ACL failure

- Status: `FIELD_VERIFIED_WITH_WORKAROUND`.
- Change: Added the confirmed 0.4.0 Windows Server recovery procedure to the production install guide and recorded the installer defect in the known-issues and release documents.
- Reason/decision: The installed PostgreSQL service repeatedly terminated with Windows error 1067, leaving the backend stopped and the web console unable to reach port 47102.
- Alternatives considered: Install the Visual C++ runtime or replace PostgreSQL; rejected after `initdb --version` returned PostgreSQL 17.10 with exit code 0 and `VCRUNTIME140.dll` was present.
- Files/subsystems: Windows service installer, bundled PostgreSQL wrapper, production install guide, known-issues register, release register.
- Verification and exact result: On Windows Server 2016, `VmsPostgres` was correctly configured as `NT AUTHORITY\NetworkService`, its data path existed, and port 47103 was free. The error log showed repeated `EPERM: operation not permitted, chmod ...postgres.exe`. Granting `NetworkService` Modify permission on `postgres.exe` and `initdb.exe` allowed `VmsPostgres`, `VmsBackend`, and `VmsWeb` all to remain running.
- Issue/root cause: `embedded-postgres` checks executable mode and calls `chmod` for `postgres.exe`/`initdb.exe`. The installer grants `NetworkService` rights to the data path and only the backend root itself; restrictive inherited ACLs do not give that account Modify permission on the nested binaries.
- Solution/workaround: For 0.4.0, grant `(M)` on the two executable files and start services in dependency order. A corrected installer must create the data directory first, apply the file ACLs automatically, check `icacls`/`sc.exe` exit codes, and fail visibly if setup is incomplete.
- Pending/next action: Implement the installer correction, rebuild the installer, and repeat clean-install/reboot verification on Windows Server 2016.
- Future scope: Add Windows Server 2016 and a restrictive-ACL clean VM to the installer release matrix.

### 2026-08-30 — Phase 8 — Terminal firewall rule restored to setup documentation

- Status: `FIELD_VERIFIED_WITH_WORKAROUND`.
- Change: Restored an explicit Windows Firewall step to the production installation procedure, including the default backend/ADMS port, a scoped inbound rule, listener verification, and a remote reachability test.
- Reason/decision: All three Windows services and local `/health` were healthy, but the physical terminal could not check in or appear on the Devices page until inbound TCP 47102 was allowed.
- Alternatives considered: Rely on service health or outbound ping; rejected because neither proves that a terminal can initiate an inbound ADMS connection. Leave the rule unrestricted; rejected in favor of `LocalSubnet` by default with explicit routed-VLAN CIDRs when required.
- Files/subsystems: Production installation guide, Windows Firewall, installer known-issues and release records.
- Verification and exact result: Field report confirmed the terminal connectivity failure was caused by the missing firewall opening. Repository inspection confirmed the backend binds to `0.0.0.0`, while the 0.4.0 Inno Setup definition and service script create no firewall rule.
- Issue/root cause: The People-upgrade production guide compressed networking into “configure the terminal and verify traffic” and did not carry forward the explicit firewall action. The installer also never automated it.
- Solution/workaround: Add a named inbound TCP rule for the actual backend/ADMS port, scoped to the terminal network, then verify with `Test-NetConnection` from that network before configuring the terminal.
- Pending/next action: Make installer setup create/update the named firewall rule using its selected backend port and uninstall remove only that owned rule; rebuild and retest on Windows Server 2016.
- Future scope: Support an installer-entered list of routed terminal CIDRs if clients commonly separate terminals into dedicated VLANs.

## Decisions register

### 2026-08-29 — Phases 0 and 10 — Fresh-clone development and pattern setup documentation

- Status: IMPLEMENTED.
- Change: The production install guide now explicitly requires distinct non-overlapping Employee/Visitor ID patterns. Added `DEVELOPMENT_SETUP.md`, a clean-Windows-clone guide for dependencies, environment files, bundled PostgreSQL, backend, web, first setup, physical-terminal configuration, verification, updates, persistence, and troubleshooting. Corrected the obsolete Vendor-pattern comment in `backend/.env.example`.
- Reason/decision: A future development machine must be recoverable from the repository without relying on session memory, and pattern classification is a safety boundary that must be configured before device enrollment.
- Alternatives considered: Put development commands in the production installer guide; rejected because source/IDE startup and installed Windows services are different operating procedures.
- Files/subsystems: Installation documentation, development documentation, backend environment template.
- Verification and exact result: Every command and port was checked against current package scripts, bundled PostgreSQL/first-run scripts, environment examples, setup API, and installer port configuration. Documentation-only change; no runtime test required.
- Issue/root cause: The old `.env.example` comment incorrectly said empty patterns claim all Vendors; current behavior intentionally classifies nobody when patterns are empty.
- Solution/workaround: One authoritative development runbook plus a production-guide cross-reference; both state `1*`/`9*` only as examples, not hard-coded client policy.
- Pending/next action: Follow the new guide on the next genuinely clean Windows development machine and record any machine-specific prerequisite omitted by the repository scripts.
- Future scope: Add Linux/macOS variants only if those development environments become supported.

### 2026-08-29 — Phase 3 — Missing Visitor photo recovery after automatic discovery

- Status: IMPLEMENTED_AND_HARDWARE_VERIFIED.
- Change: OPLOG/ATTLOG discovery and missing-photo retrieval now use separate idempotency keys. A punch from an already-created Person with no biometric also queues a photo-recovery query, regardless of whether category patterns later change.
- Reason/decision: PINs 9002 and 9005 were classified and auto-created as Visitors, but the first `QUERY_USER` returned USER without BIOPHOTO. The USER handler attempted the required retry with the same idempotency key as discovery, so the queue silently reused the already-successful command and no second device query occurred.
- Alternatives considered: Allow manual photo upload only (rejected: defeats automatic registration); repeatedly query every known Person (rejected: unnecessary device traffic); delete the Visitor without a photo (rejected: violates the durable-photo safety rule).
- Files/subsystems: OPLOG/ATTLOG discovery and recovery ingestion, device-ID candidate selection, regression test.
- Verification and exact result: Live `vms_dev` inspection first found Person 9002 and then Person 9005 (`VISITOR`, `adoptedFromDevice=true`) with no PersonBiometric row and exactly one successful QUERY_USER. A second normal queued QUERY_USER for 9005 was collected by terminal NCD8252500406 and returned a 36,124-byte JPEG. The biometric row/file was committed, then and only then `auto-visitor-remove` was queued and completed; `adoptedFromDevice` became false. Backend type-check PASS; backend tests 77/77 PASS, including a regression check that unknown discovery and known-photo retrieval keys differ.
- Issue/root cause: Discovery and photo retry both used `autopull-photo:<serial>:<pin>:<10-minute-bucket>`.
- Solution/workaround: Initial unknown-person discovery uses `auto-discover-person`, the USER-triggered follow-up uses `autopull-photo`, and a later punch for a known missing photo uses `recover-photo-from-punch`. Duplicate punches remain bounded to one command per purpose per ten-minute bucket.
- Pending/next action: Refresh the People page and complete 9005's administrative profile; no photo recovery work remains for this terminal behavior.
- Future scope: Capture exact behavior separately if another firmware does not return BIOPHOTO on the second query.

### 2026-08-29 — Phase 4 — Auto-registered Employee detail page repaired

- Status: IMPLEMENTED_AND_VERIFIED locally.
- Change: The primary Person detail API now returns Company, Department, and ordered EmployeeDeviceAccess relations; the Employee authorization UI also treats an absent access array as empty instead of crashing.
- Reason/decision: The frontend contract declared `employeeAccess` as mandatory, but `GET /api/people/:id` omitted it while the by-PIN endpoint included it. An automatically registered Employee therefore reached `undefined.map()` as soon as its detail page rendered.
- Alternatives considered: UI fallback only; rejected as the sole fix because it would hide the broken API contract and leave the Employee access panel incomplete.
- Files/subsystems: Person detail API and Person detail web page.
- Verification and exact result: Authenticated Fastify route check against `vms_dev` returned HTTP 200 with `employeeAccess` as an array (one record for PIN 1001), `needsDetails: true`, and null Company/Department as expected for an incomplete automatic profile. `/api/alerts` returned HTTP 200 in both direct service and authenticated-route checks. Backend type-check PASS; backend tests 76/76 PASS; web lint PASS; web production build PASS.
- Issue/root cause: The observed `/api/alerts` 500 could not be reproduced after the running services settled; it was separate from the render crash and likely occurred during development hot reload. The confirmed page failure was the missing `employeeAccess` response property.
- Solution/workaround: Keep API response relations aligned with `PersonDetail`, and retain a cheap empty-array boundary in the UI.
- Pending/next action: Refresh the running detail page after backend/web hot reload; if alerts alone returns 500 again, preserve the matching backend `unhandled error` log before restarting so its independent exception can be traced.
- Future scope: Add a route-contract integration test for `GET /api/people/:id` when the broader authenticated API fixture is introduced.

### 2026-08-29 — Phase 3 — Existing terminal enrollment discovered from punch

- Status: IMPLEMENTED_UNVERIFIED on physical terminal.
- Change: Classified unknown ATTLOG IDs now batch-queue `QUERY_USER`; the returned USER/BIOPHOTO enters the existing automatic Person registration flow and produces a `Needs details` profile.
- Reason/decision: A person enrolled before VMS integration normally sends only ATTLOG when scanned, so USER/BIOPHOTO-only discovery left them requiring manual registration.
- Alternatives considered: Create a Person directly from ATTLOG (rejected: no device name/photo and unsafe without classification); query every unknown ID (rejected: shared-terminal biometric overcollection).
- Files/subsystems: ADMS punch ingestion, ID classification helper, tests.
- Verification and exact result: backend type-check PASS; backend tests 76/76 PASS.
- Issue/root cause: Existing terminal enrollments do not volunteer USER/BIOPHOTO on an ordinary face scan.
- Solution/workaround: One batched known-Person lookup and one batched command insert per ATTLOG body; only IDs matching exactly one category are queried.
- Pending/next action: Configure the device’s Employee/Visitor pattern, scan a previously enrolled ID again, and record the physical response/result.
- Future scope: None currently.

### 2026-08-29 — Phase 3 — Attach a photo received before later classification

- Status: IMPLEMENTED_UNVERIFIED on physical terminal.
- Change: When a later USER response auto-creates a classified Person, any photo already stored for that eSSL ID is attached immediately; Visitor removal then follows the same photo-durable safety rule.
- Reason/decision: An unclassified BIOPHOTO is intentionally retained for review. After an Admin configures patterns, the stored artifact must be consumed by automatic registration rather than requiring the Register card.
- Alternatives considered: Delete unclassified photos (data loss); default every unknown ID to Visitor/Employee (unsafe on shared terminals).
- Files/subsystems: ADMS automatic registration and biometric attachment.
- Verification and exact result: backend type-check PASS; backend tests 76/76 PASS; live database confirmed PIN 1001 has no Person and device TEST 1 has both category pattern lists empty.
- Issue/root cause: The device category was unknowable with empty patterns, and the later USER path did not attach a photo received before classification.
- Solution/workaround: Configure PIN 1001 in exactly one category pattern and scan again; the batched query creates the incomplete Person and attaches the existing JPEG.
- Pending/next action: Physical retest for PIN 1001.
- Future scope: Improve the unclaimed card copy to name missing/ambiguous device classification if operators need more guidance.

### 2026-08-29 — Phase 10 — 0.4.0 installer compiled

- Status: IMPLEMENTED_UNVERIFIED.
- Change: Incremented AppVersion to 0.4.0, created the production Ed25519 issuer keypair outside the repository, staged with the public key only, and compiled `installer/Output/vms-setup.exe`.
- Reason/decision: This feature set is a minor release, and paid keys need one stable issuer identity.
- Alternatives considered: Reuse 0.3.0 (rejected: indistinguishable release); build without licensing key (rejected by preflight).
- Files/subsystems: installer version/release payload, issuer key generator, release register.
- Verification and exact result: Inno Setup 6.7.3 compile PASS; ProductVersion 0.4.0; 258,938,814 bytes (246.94 MiB); SHA-256 `0CA9DB83BFC6677BA7BE1C092D8F7BFF9ABF35B75F0A2267FD54D20244941EA8`; issuer scripts absent; one public key present; no private-key marker present.
- Issue/root cause: Installer is not Authenticode-signed because no code-signing certificate was configured.
- Solution/workaround: Safe for internal testing; sign before external distribution when a certificate is available.
- Pending/next action: Clean-VM install/reinstall and physical-terminal acceptance.
- Future scope: Trim development-only dependency files from the payload if installer size becomes material.

### 2026-08-29 — Phases 0, 1, 5, 9, and 10 — Local completion gates

- Status: Phase 9 ACCEPTED; Phase 10 IMPLEMENTED_UNVERIFIED.
- Change: Updated the E2E harness for Person/Attendance schema, persisted unmatched terminal observations for Admin review without touching the roster, enforced release-time public-key injection, built the production payload, and added the complete acceptance guide.
- Reason/decision: An unmatched ID must be reviewable, but shared-terminal safety forbids a photo pull, mutation, or removal. Paid licensing must not depend on a manually uncommented sample setting.
- Alternatives considered: Silently ignore unmatched IDs (fails the new review requirement); package issuer tooling or private material (rejected); allow a release with no verification key (paid activation would fail at the client).
- Files/subsystems: reconciliation/alerts, E2E harness, release staging, plan/handoff, acceptance documentation.
- Verification and exact result: Prisma generation PASS; backend type-check/build PASS; backend tests 75/75 PASS; web lint/build PASS; all 16 migrations applied to disposable PostgreSQL; Prisma diff reported no difference; E2E 252/252 PASS; backend package PASS; release staging PASS and issuer folder absent.
- Issue/root cause: The old E2E harness referenced `PunchDaySummary` and numeric-only IDs after the domain/schema change; one mixed raw/summary fixture omitted persisted direction. Release staging had no enforced public signing key.
- Solution/workaround: Migrated fixtures to `AttendanceDaySummary`, string IDs, and explicit directions; added `VMS_LICENSE_PUBLIC_KEY_FILE` preflight and public-key injection.
- Pending/next action: Compile the Inno Setup executable, run clean/reinstall/legacy tests on a disposable Windows VM, and execute real-terminal acceptance using `PEOPLE_UPGRADE_VERIFICATION_GUIDE.md`.
- Future scope: Reliable defense against an administrator erasing both PostgreSQL and ProgramData or restoring an old VM snapshot requires online or hardware-backed activation.

### 2026-08-30 — Phase 8 — Windows Server installer corrections implemented

- Status: `IMPLEMENTED_LOCAL_VERIFIED`.
- Change: Service setup now creates the data directory before applying ACLs, grants `NetworkService` Modify permission on embedded PostgreSQL's `postgres.exe` and `initdb.exe`, checks `icacls`/`sc.exe` exit codes, and creates the named `VMS-Backend-ADMS` inbound TCP firewall rule for the selected backend port. Uninstall removes only that owned rule. The web service now starts the Next.js standalone server.
- Reason/decision: Both defects were reproduced through field evidence on Windows Server 2016: the PostgreSQL wrapper crash-looped on `chmod`, and locally healthy services were unreachable by the terminal because no inbound rule existed.
- Alternatives considered: Keep manual installation commands (rejected because every client install would remain error-prone); open the port to all remote addresses (rejected in favor of `LocalSubnet`).
- Files/subsystems: `backend/scripts/windows-services/install-services.ps1`, `uninstall-services.ps1`, installer documentation.
- Verification and exact result: Both service scripts pass the PowerShell parser. Release staging contains the corrected scripts. Actual clean-machine execution remains pending because local development services must not be replaced by an installer test.
- Issue/root cause: `embedded-postgres` invokes `chmod` even on Windows, so its service account requires Modify access to the two executable files. Windows Firewall separately blocks terminal-initiated ADMS traffic even when localhost health is green.
- Solution/workaround: Automated ACLs and a scoped, installer-owned firewall rule in 0.4.1; 0.4.0 manual recovery remains documented for existing installations.
- Pending/next action: Fresh 0.4.1 install, reboot, upgrade/reinstall, uninstall/persistence, and terminal check-in on Windows Server 2016.
- Future scope: Allow approved routed terminal CIDRs during setup if client deployments commonly place terminals outside `LocalSubnet`.

### 2026-08-30 — Phase 9 — Client runtime hardening and technology decision

- Status: `ACCEPTED_LOCAL`.
- Change: Next.js now builds a standalone production runtime with browser source maps disabled; staging allowlists runtime scripts, prunes backend development dependencies, removes all `.map` files, and fails on source maps, first-party TypeScript, issuer tools, or private-key material. The backend remains the existing minified `server.cjs` bundle.
- Reason/decision: The 0.4.0 payload exposed original first-party source through server source maps and shipped development/E2E scripts that the installed product never used. Removing those direct leaks is the highest-value immediate correction.
- Alternatives considered: Node Single Executable Applications were deferred because the feature is still active-development and mainly wraps JavaScript rather than creating a strong protection boundary. A Go backend could provide a more opaque native executable and simpler service deployment, but a rewrite now would add protocol, database, job, report, and hardware-regression risk immediately before the pilot. Rust and .NET were rejected for now because they add still more migration cost without removing the browser-visible frontend or the fundamental limits of offline on-premise software.
- Files/subsystems: `web/next.config.ts`, `installer/build-release.mjs`, backend package metadata, Windows web-service startup.
- Verification and exact result: Frontend production build and lint PASS; backend package, typecheck, and 77/77 tests PASS. Staging removed 1,512 maps; zero `.map` and zero first-party `.ts`/`.tsx` files remain. The standalone `/login` route returned HTTP 200, and the staged Prisma CLI and bundled-Postgres URL command executed successfully.
- Issue/root cause: Source maps embedded `sourcesContent` containing original application source; broad directory copies also included development tools. A client administrator still controls the machine and can inspect runtime code and data.
- Solution/workaround: Ship only compiled/minified production artifacts, retain the signing private key and issuer ledger only on the product owner's secured computer, and treat licensing plus commercial controls as the enforcement boundary.
- Pending/next action: Authenticode-sign external releases and complete clean-machine acceptance.
- Future scope: Revisit a Go backend after the pilot only if native-binary protection, memory footprint, or simpler deployment justifies a separately planned compatibility migration. Strong offline anti-tamper would additionally need hardware-backed licensing; no technology rewrite can make client-side browser JavaScript secret.

### 2026-08-30 — Phase 10 — Hardened 0.4.1 installer compiled

- Status: `IMPLEMENTED_UNVERIFIED`.
- Change: Incremented installer ProductVersion to 0.4.1 and compiled the hardened staged runtime.
- Reason/decision: A patch version distinguishes the corrected installer from 0.4.0 installations that require manual ACL/firewall recovery.
- Alternatives considered: Overwrite 0.4.0 without a version change (rejected because field diagnostics and upgrade history would become ambiguous).
- Files/subsystems: `installer/vms-installer.iss`, `installer/Output/vms-setup.exe`, release register.
- Verification and exact result: Inno Setup 6.7.3 PASS; ProductVersion 0.4.1; 183,287,685 bytes (174.80 MiB); SHA-256 `EC35AF718B59253664A15B76573F06348B19EF063858F01A889D7CC08FDFC745`.
- Issue/root cause: No Authenticode certificate is configured, and the compiled installer has not yet been executed on a disposable clean Windows machine.
- Solution/workaround: Use for controlled internal acceptance only; sign and complete the Windows matrix before client distribution.
- Pending/next action: Execute the full `PEOPLE_UPGRADE_VERIFICATION_GUIDE.md` installer and hardware matrix.
- Future scope: Add automated clean-Windows installer testing when a suitable CI/VM environment exists.

### 2026-08-30 — Phases 2 and 10 — Inside Now Company object crash fixed

- Status: `IMPLEMENTED_LOCAL_VERIFIED`.
- Change: `/api/entries/board` now selects and returns the Company name as `string | null` for both current-inside and day-blocked rows. The corrected packaged backend was released as installer 0.4.2.
- Reason/decision: React error 31 showed that Inside Now was rendering an object with Company record keys, while the existing `BoardEntry` contract and JSX correctly expected a string.
- Alternatives considered: Change the page to render `company.name` (rejected because it would legitimize an accidental oversized API response and leave the existing contract false).
- Files/subsystems: `backend/src/api/entries.ts`, packaged backend, installer version/release payload, release register.
- Verification and exact result: Backend typecheck PASS; backend tests 77/77 PASS; frontend lint PASS; backend package PASS; release staging/audit PASS with 1,512 source maps removed. Inno Setup 6.7.3 PASS; ProductVersion 0.4.2; 183,295,853 bytes (174.80 MiB); SHA-256 `F273E11CB736D25DC682C85E9F8EBF498C03E992F387364F26421691748B483D`.
- Issue/root cause: The People schema migration replaced a text field with a relation, but this board query used `company: true` and bypassed the existing `entryDto` normalization used by other Entry endpoints.
- Solution/workaround: Normalize at the board API boundary so every consumer receives the established string/null shape; no frontend workaround is needed.
- Pending/next action: Refresh the development page after backend hot reload, then run the 0.4.2 clean-machine and hardware acceptance matrix.
- Future scope: Add an authenticated route-contract test for `/api/entries/board` when the shared API integration fixture is introduced.

### 2026-08-30 — Phase 7 — Client-visible license binding removed

- Status: `IMPLEMENTED_LOCAL_VERIFIED`.
- Change: Removed machine and installation identifiers from the License API, License page, Operators page, license audit exports, issuer output, and new v3 key payloads; bound v3 signatures to the privately collected installation value; retained v1/v2 verification; made runtime status derive expiry/plan from a freshly verified stored key instead of database copies; restricted key installation UI to Admins; added file-only owner issuance; and aligned expired-license password-change and alert behavior with the approved plan.
- Reason/decision: Customers do not need the offline binding identifier to use or renew VMS. Issuance can be performed during an attended owner-technician session without exposing the value through the product UI/API or command line.
- Alternatives considered: Display a copyable Machine ID (rejected by product decision); encrypt the identifier with a client-side secret (rejected because a determined local administrator can extract any shipped secret); online activation (future scope because it changes the offline deployment model).
- Files/subsystems: license API/UI/issuer scripts, license middleware, alert text, licensing/API/deployment/verification documentation.
- Verification and exact result: Backend typecheck PASS; tests 78/78 PASS, including identifier-exposure and binding-free v3 payload checks; frontend lint and production build PASS; backend package and hardened staging PASS. Inno Setup 6.7.3 PASS; ProductVersion 0.4.3; 183,282,130 bytes (174.79 MiB); SHA-256 `30FB6750B15598142045753719AA9A22A8463E76606339DD6969B41DF3D43531`.
- Issue/root cause: The earlier renewal workflow made the binding convenient by exposing it to every signed-in operator and returned it in `GET /api/license`.
- Solution/workaround: Collect the binding privately to a secured file with issuer-only tooling and keep the public status response limited to operational license state.
- Pending/next action: Complete automated verification and clean-machine expiry/renewal acceptance.
- Future scope: Online activation or hardware-backed licensing is required if resistance to a determined machine administrator becomes necessary; UI/API concealment is not DRM.

### 2026-08-30 — Phases 7 and 10 — Installed request collector and hidden License entry points

- Status: `IMPLEMENTED_LOCAL_VERIFIED`.
- Change: Installer 0.4.4 now copies only `create-license-request.mjs` to `C:\VMS\tools`; the License navigation entry and duplicate Operators-page license card were removed while `/license` remains available directly.
- Reason/decision: Technicians should not carry a separate harmless collector, while clients should not be presented with a normal navigation path to licensing administration.
- Alternatives considered: Package the whole issuer folder (rejected because it exposes unnecessary tooling); disable `/license` (rejected because renewal must remain possible after expiry).
- Files/subsystems: request helper, release allowlist/audit, application navigation, Operators page, installer and licensing documentation.
- Verification and exact result: Backend typecheck PASS; tests 79/79 PASS; frontend lint/build PASS; release staging PASS with collector present and issuer folder absent. Inno Setup 6.7.3 PASS; ProductVersion 0.4.4; 125,886,124 bytes (120.05 MiB); SHA-256 `7D301DF77CE846B35F7399606B6A952865763BB21C6709C237BD9AA39F1BCD00`.
- Issue/root cause: The safe collector lived only in the repository, so every site visit required carrying it separately; two visible frontend locations also advertised license administration.
- Solution/workaround: Ship only the collector under `tools` and rely on direct `/license` access for authorized renewal.
- Pending/next action: Execute clean-machine request creation and direct-route renewal acceptance.
- Future scope: Add an owner-authenticated online request exchange only if attended file transfer becomes operationally burdensome.

### 2026-08-30 — Phase 9 — Current-documentation consistency audit

- Status: `ACCEPTED_LOCAL`.
- Change: Updated repository instructions and current runbooks for the 0.4.4 Person domain, Employee/Visitor lifecycle, separate patterns, enforced expiry, hidden License navigation, secured issuer-key paths, current artifact status, and phase gates. Replaced the generated web README and added prominent historical-authority banners to the pre-0.4 PRD, project context, and shared-terminal privacy note.
- Reason/decision: Historical hardware and release evidence must remain intact, but readers must not mistake the former Vendor model or warn-only licensing design for current behavior.
- Alternatives considered: Rewrite every historical phase record to Person terminology; rejected because it would falsify the record of what those releases contained.
- Files/subsystems: Root agent instructions, current setup/API/licensing/acceptance/release documentation, historical-document banners, web README.
- Verification and exact result: Current-facing stale-term scan no longer finds the obsolete 0.3.0 shipped banner, warn-only license summary, old issuer path, 0.4.2 acceptance target, or generated Vercel README. `CLAUDE.md` and `AGENTS.md` remain byte-identical.
- Issue/root cause: The 0.4.4 implementation evolved faster than the original Phase 6 and 0.3.0 context documents; several later runbooks inherited obsolete paths/status text.
- Solution/workaround: Current sources now identify 0.4.4 explicitly; historical sources declare their authority boundary and link to current documents.
- Pending/next action: Keep the release register and execution log updated when installed-Windows acceptance is run or a new installer is built.
- Future scope: A full v5 PRD rewrite may replace the frozen historical v4 document after the pilot; it is not required for 0.4.4 acceptance.

### 2026-09-01 — Phases 2, 4, 5, and 10 — Client field fixes packaged as 0.4.5

- Status: `IMPLEMENTED_LOCAL_VERIFIED`.
- Change: Added Aadhaar-present profile/list badges; moved the immutable category-specific ID before Name in registration/profile editing; added durable Admin-only Employee resignation across every desired device; added the resigned-employees report; pinned UI and report CSV timestamps to `Asia/Kolkata`; added the resignation migration; built installer 0.4.5.
- Reason/decision: These gaps were observed during an installed client-system walkthrough. Resignation is a business event, not a sequence of manual per-device removals, and client Windows timezone configuration must not determine displayed business time.
- Alternatives considered: Derive resignation from inactive plus removed access (rejected because it loses who/when/why); format dates independently on each page (rejected in favor of the existing shared formatter); rewrite stored UTC timestamps to IST (rejected because storage must remain normalized).
- Files/subsystems: Person schema/migration/API types, Employee access service/routes, report registry/CSV serializer, People registration/detail/list UI, shared frontend formatting, E2E harness, installer and release docs.
- Verification and exact result: Migration applied to development and disposable PostgreSQL; Prisma generation PASS; backend typecheck PASS; tests 79/79 PASS; E2E 257/257 PASS including durable resignation, all-device desired-access removal/deletion queue, and report visibility; frontend lint/build PASS; backend package and hardened staging PASS. Inno Setup 6.7.3 PASS; ProductVersion 0.4.5; 125,891,031 bytes (120.06 MiB); SHA-256 `316A34E3B10CF835B095B33FDE2BBCBE8C2B8F7B94E184EBD833213ADD31D409`.
- Issue/root cause: Time helpers inherited the host/browser timezone, and Employee access exposed only per-device removal with no durable employment-end state.
- Solution/workaround: Explicit IST presentation plus one transactional resignation endpoint that updates all desired assignments and enqueues all terminal writes through the command queue.
- Pending/next action: Upgrade a client-style Windows installation to 0.4.5, reboot, and physically confirm removal from every selected terminal; Authenticode-sign before production distribution.
- Future scope: Rehire/reactivation is intentionally not implemented; add a separately audited workflow only when a real process is defined.

### 2026-09-01 — Phase 10 — Remote LAN console login fixed in 0.4.6

- Status: `IMPLEMENTED_LOCAL_VERIFIED`.
- Change: Rebound an installed loopback API URL to the hostname/IP used to open the web console; changed the fresh-install CORS default to reflect LAN origins; made the installer environment setup migrate only the exact old `http://localhost:47101` default while preserving custom allow-lists; incremented the installer to 0.4.6.
- Reason/decision: A remote browser loaded the login page from the VMS host but interpreted the injected backend `localhost:47102` as itself. Correcting only the API hostname would then expose the old localhost-only CORS restriction.
- Alternatives considered: Add a Next.js API/SSE proxy (rejected as needless infrastructure and a buffering risk); bake the server's current IP into the installer (rejected because DHCP/DNS/address changes would make it stale).
- Files/subsystems: Shared frontend API base, web/backend installer environment defaults, backend first-run configuration, installer version, setup and release documentation.
- Verification and exact result: Backend typecheck, tests 79/79 and production packaging PASS; frontend lint/build PASS; direct execution of the real API module under simulated browser hostname `192.168.10.25` resolved the backend to `http://192.168.10.25:47102`. Hardened staging PASS with 1,512 source maps removed, request collector present, issuer tools absent, CORS upgrade migration present, and secured public key matched. Inno Setup 6.7.3 PASS; ProductVersion 0.4.6; 125,896,039 bytes (120.06 MiB); SHA-256 `E7955B6AD95A0AFF2ECFB6D59EAA276EC7D1A4189467382F3213091935A2CD8A`.
- Issue/root cause: The server-side runtime configuration correctly avoided a build-time port, but it injected a server-relative loopback hostname into every browser.
- Solution/workaround: Preserve the configured protocol/port while replacing only `localhost`/`127.0.0.1` with `window.location.hostname`; allow LAN origins for the bearer-token API behind the existing `LocalSubnet` firewall boundary.
- Pending/next action: Upgrade the client host to 0.4.6, hard-refresh a second LAN device, verify `/health`, login, photos, CSV download, and SSE from that device.
- Future scope: If web and backend are ever deployed on different machines, set an explicit non-loopback `API_BASE_URL`; explicit hostnames are preserved unchanged.

### 2026-09-01 — Phases 4, 5, and 10 — Employee rehire and live punch time in 0.4.7

- Status: `IMPLEMENTED_LOCAL_VERIFIED`.
- Change: Switched the live dashboard from normalized UTC to the stored terminal-local wall clock; added Admin-only rehire with explicit device selection, permanent-access restoration, provisioning commands, and an `EMPLOYEE_REHIRED` audit event; incremented the installer to 0.4.7.
- Reason/decision: Gate operators need the time printed by the terminal, while normalized UTC remains correct for ordering and attendance arithmetic. A resigned Employee also needs a deliberate return-to-employment transition rather than direct database edits.
- Alternatives considered: Reuse `formatTime(punchedAtUtc)` (rejected because the installed feed still exposed UTC-derived presentation); rehire without devices (rejected because it creates an active Employee with no usable access); silently restore every former device (rejected because assignments may change on rehire).
- Files/subsystems: Shared time formatter, dashboard, Employee access service/API/UI, audit actions, E2E harness, installer and current documentation.
- Verification and exact result: Backend typecheck and tests 79/79 PASS; frontend lint/build PASS; E2E 260/260 PASS including resign→rehire and selected desired-access restoration; direct execution of the real formatter preserved `12:34:56` terminal time without a second shift. Backend package and hardened staging PASS with 1,512 source maps removed, rehire route/request collector present, issuer tools absent, and secured public key matched. The pre-upgrade service-stop hook compiled successfully. Inno Setup 6.7.3 PASS; ProductVersion 0.4.7; 125,893,006 bytes (120.06 MiB); SHA-256 `7DD346775F5A6AEF07ECA58D594867BE9A21203B26E286274E5C55E8E5E4360C`.
- Issue/root cause: The live feed chose `punchedAtUtc` even though `punchedAtDevice` exists specifically to preserve the terminal wall clock; resignation had no inverse business operation.
- Solution/workaround: Render the device timestamp as a UTC-shaped wall-clock container, make rehire an atomic audited transition with explicit device provisioning, and stop named VMS services in `PrepareToInstall` before upgrading locked application files.
- Pending/next action: Upgrade a client-style Windows installation to 0.4.7 and compare the feed with a real ATTLOG timestamp; physically confirm rehire restores only the selected terminal rosters.
- Future scope: Multiple employment periods could become a dedicated employment-history table if HR reporting later needs structured tenure ranges; audit history is sufficient for the current scope.

### 2026-09-02 — Phases 4, 5, and 10 — IST, login feedback, and device labels in 0.4.8

- Status: `IMPLEMENTED_LOCAL_VERIFIED`.
- Change: Based live-punch relative age on server receipt time with a one-second refresh; applied IST to report filtering/export filenames and all timestamp exports; preserved invalid-credential login errors; propagated Admin device names through punches, commands, reports, person provisioning state, and alerts; built installer 0.4.8.
- Reason/decision: Terminal timestamps can be ahead when device offset configuration is wrong and a relative label computed only during data fetch never ages. HTTP 401 also represents invalid credentials during login, not only an expired stored session. Operator-facing device identity should use the name assigned by the Admin.
- Alternatives considered: Continue deriving relative age from the terminal timestamp (rejected because terminal clock/configuration is not receipt time); fix each report/page independently (rejected in favor of shared format/export paths and common report SQL); expose serial/model as the primary label (rejected because it ignores the configured business name).
- Files/subsystems: Punch REST/SSE payloads, dashboard, shared API/time helpers, auth error handling, command API/UI, report registry/CSV serializer, reconciliation alerts, person device status, E2E harness, installer and current docs.
- Verification and exact result: Backend typecheck and tests 79/79 PASS; database E2E 253/253 PASS; frontend lint/build PASS; backend package and hardened staging PASS with 1,512 source maps removed, request collector present, issuer tools absent, punch name/receipt fields present, and the embedded public key matching the secured production public key. Inno Setup 6.7.3 PASS; ProductVersion 0.4.8; 125,901,028 bytes (120.07 MiB); SHA-256 `01B58CA9D56D514EC38BA14D7DCF3284104413EFE133EA12DFBEEF5867D5F9B4`.
- Issue/root cause: Negative relative durations matched the “under five seconds” branch forever; static relative text did not re-render; CSV only formatted `Date` objects and could leak ISO strings; report date filters used UTC calendar boundaries; login globally rewrote every 401; several device DTOs omitted `name`.
- Solution/workaround: Use immutable ingestion time for relative age, tick the feed clock, format timestamp strings and Dates in the shared CSV path, shift UTC report boundaries to IST dates, special-case only the login endpoint's 401 payload, and include device name alongside the serial.
- Pending/next action: Upgrade a client-style Windows installation to 0.4.8 and verify a live punch ages past “just now,” compare UI/CSV timestamps at a UTC-day boundary, try incorrect credentials, and confirm configured device names on each operator surface.
- Future scope: Make site timezone configurable if deployment expands outside India; for this product release IST is the explicit business timezone.

### 2026-09-02 — Phase 5 — Report-wide IST serialization correction (source only)

- Status: `IMPLEMENTED_LOCAL_VERIFIED_NOT_PACKAGED`.
- Change: Added one report-response serialization boundary that converts every timestamp in every JSON report row and CSV export to explicit `Asia/Kolkata` text ending in `IST`; timezone-less PostgreSQL timestamp strings are treated as the UTC values the schema stores. The shared web formatter now handles both `T`- and space-separated database timestamps, labels displayed times as IST, and the live feed uses normalized punch UTC through that formatter.
- Reason/decision: Formatting only JavaScript `Date` objects did not cover all raw-query results. Some PostgreSQL report values reached the response as timezone-less strings, so browsers or CSV serialization could preserve/reinterpret the UTC clock value instead of applying UTC+05:30.
- Alternatives considered: Add conversions to each report SQL query or each table column (rejected because twenty definitions and two output formats would drift); change stored timestamps to IST (rejected because UTC remains the correct storage and arithmetic representation).
- Files/subsystems: Backend report JSON/CSV presentation boundary and tests; shared frontend time formatter; dashboard punch-time presentation; verification/current-release documentation.
- Verification and exact result: Backend typecheck PASS; tests 80/80 PASS, including UTC `Date`, zoned ISO, timezone-less `T`, timezone-less space, and nested report values; database E2E 255/255 PASS, including direct JSON/CSV IST assertions; frontend lint and production build PASS. No package, release staging, installer compilation, version bump, or installer overwrite was performed, by explicit instruction.
- Issue/root cause: Raw-query timestamp representation was not uniform, while the earlier CSV helper recognized only a subset and JSON rows still relied on the browser to recognize and convert them.
- Solution/workaround: Normalize all report timestamps once at the API boundary, return explicit IST presentation strings to both UI and export paths, and retain UTC only in storage/internal calculations.
- Pending/next action: When explicitly requested, cut a later installer containing this source correction and perform installed-Windows UI/CSV checks at a UTC/IST date boundary. The existing 0.4.8 installer does not contain this post-build correction.
- Future scope: Make the business presentation timezone configurable only if deployments outside India are introduced.

### 2026-09-03 — Phases 1, 5, and 10 — Device-offset root fix and historical punch repair (source only)

- Status: `IMPLEMENTED_LOCAL_VERIFIED_NOT_PACKAGED`.
- Change: Changed newly adopted devices from the erroneous UTC offset default to IST `+330`; added an Admin-editable per-device offset; added migration `20260903090000_default_device_timezone_ist` to update existing zero-offset devices and repair their raw normalized punch instants, linked Entry crossing times, and attendance summaries whose contributing devices were all affected.
- Reason/decision: The On site now example displayed `03/09/2026 04:08:10 IST` instead of `02/09/2026 22:38:10 IST`. Command-created times were correct because they originate from the server. Punch-derived times were exactly 5h30 late because adopted terminals silently inherited offset `0`, so an IST terminal wall clock was stored as UTC and then correctly shifted again for display.
- Alternatives considered: Remove IST presentation conversion (rejected because it would make server-created timestamps wrong and merely hide bad ingestion); display `punchedAtDevice` everywhere (rejected because ordering, cross-device attendance, expiry, and duration require normalized instants); blindly shift every historical summary (rejected for mixed-device summaries whose pruned raw boundaries can no longer identify the source terminal).
- Files/subsystems: Device schema/API/UI, punch/Entry/attendance data-repair migration, E2E harness, setup/verification/current-release documentation.
- Verification and exact result: Migration applied successfully to disposable `vms_test` and local development `vms`; Prisma generation PASS; backend typecheck PASS; tests 80/80 PASS; database E2E 257/257 PASS including the `+330` adoption default and Admin offset correction; frontend lint and production build PASS.
- Issue/root cause: `Device.timezoneOffsetMinutes` defaulted to `0`, device adoption did not ask for or set an offset, and the Devices page exposed it as read-only. The formatter was blamed because it was the first correct layer to make the ingestion error visible.
- Solution/workaround: India deployments now adopt at `+330`, Admin can correct future ingestion per terminal, and the migration repairs safely attributable historical data while leaving original `punched_at_device` evidence unchanged.
- Pending/next action: Build a later-than-0.4.9 installer only when explicitly requested, then verify the client device shows `+05:30`, the example crossing renders `02/09/2026 10:38:10 pm IST`, and a fresh punch matches the terminal clock. The current 0.4.9 artifact was built before this correction and must not be deployed as its fix.
- Future scope: If non-India deployments are introduced, collect the site/device offset during setup instead of using the India product default.

### 2026-09-02 — Phases 1, 5, and 10 — Device-offset correction packaged as 0.4.10

- Status: `IMPLEMENTED_LOCAL_VERIFIED`.
- Change: Packaged the `+330` adoption default, Admin offset editing, safely attributable historical punch repair, and the related report/API corrections as 0.4.10.
- Reason/decision: The 0.4.9 artifact did not contain the ingestion root fix and could not be deployed as though it did.
- Alternatives considered: Reuse 0.4.9 (rejected because two different payloads with one version are operationally indistinguishable).
- Files/subsystems: Device settings, ingestion, migration, reports, alerts, web device/live views, packaging, and release documentation.
- Verification and exact result: Source and packaged backend committed as `b37c701`; migration `20260903090000_default_device_timezone_ist` included. The overwritten 0.4.10 installer size/hash were not recorded and must not be reconstructed.
- Issue/root cause: Release documentation was not completed before the next artifact overwrote 0.4.10.
- Solution/workaround: Record the missing evidence honestly and use 0.4.11 as the retained artifact.
- Pending/next action: Preserve build metadata before allowing a later compile to overwrite `installer/Output/vms-setup.exe`.
- Future scope: Not applicable.

### 2026-09-02 — Phases 2 and 10 — Inclusive IST retention packaged as 0.4.11

- Status: `IMPLEMENTED_LOCAL_VERIFIED`.
- Change: Made standard retention policies end at 23:59:59.999 IST on their inclusive final day, added custom inclusive IST end dates to both provisioning screens, and retained block-only behavior after a SINGLE_ENTRY OUT while the retention window remains open.
- Reason/decision: A duration measured from the authorization time did not match the business meaning of one/day 7/day 30/day 90 calendar windows.
- Alternatives considered: Keep rolling 24-hour durations (rejected because they cross the required IST day-end); de-provision on every SINGLE_ENTRY OUT (rejected because the visitor remains authorized for later days in a multi-day window).
- Files/subsystems: Entry lifecycle, single-entry idempotency, provisioning UI, tests, packaging.
- Verification and exact result: Backend tests 81/81, typecheck, frontend lint/build, packaging, staging, and Inno compile passed. Commit `9d7391c`; ProductVersion 0.4.11; 125,898,285 bytes; SHA-256 `0E25EE9B5966C5FE3E19FC676DC141B0CD4A0AC01D452730429A6D449471DBB0`.
- Issue/root cause: Retention used `now + days × 24h`, and the daily block key used the UTC date.
- Solution/workaround: Resolve inclusive IST calendar day-end once in the lifecycle service and use the IST date for block deduplication.
- Pending/next action: Run installed-Windows and physical-terminal acceptance.
- Future scope: Not applicable.

### 2026-09-03 — Phase 10 — Runtime version visibility for 0.4.13 source

- Status: `IMPLEMENTED_LOCAL_VERIFIED_NOT_PACKAGED`.
- Change: Made backend packaging read the installer `AppVersion`, exposed the injected value from `/health`, and placed a quiet `v<version>` label beside the organization name for every signed-in operator.
- Reason/decision: Installed versions could previously be identified only through Windows metadata, and rebuilding changed code under one version made field diagnosis ambiguous.
- Alternatives considered: Use either package.json version (rejected because both are unrelated `0.1.0` values); hardcode a frontend version (rejected because it creates another source of truth).
- Files/subsystems: Installer version, backend packaging/health, shared frontend API types, authenticated layout, release/install/API documentation.
- Verification and exact result: Backend tests 81/81 PASS; backend typecheck PASS; backend package PASS and reported `VMS 0.4.13 package built`; the generated bundle contains the injected 0.4.13 health value; frontend lint and production build PASS.
- Issue/root cause: `AppVersion` stopped at installer metadata and never reached the running application.
- Solution/workaround: Inject that existing single source into the packaged backend and let the frontend read the running backend.
- Pending/next action: Stage and compile the 0.4.13 installer when requested, then verify the installed console and `/health` agree with Windows `DisplayVersion`.
- Future scope: Add a commit/build identifier only if patch-version discipline proves insufficient.

### 2026-09-07 — Phases 3 and 10 — Webcam capture and unregistered-person accordion for 0.4.14 source

- Status: `PACKAGED_DEFECTIVE_SUPERSEDED`.
- Change: Added browser-native webcam capture beside JPEG upload on new-person registration and the missing-photo person detail state. Replaced the permanently expanded unclaimed-enrollment cards with a default-closed “Unregistered people” accordion whose header always shows the current total.
- Reason/decision: Registration desks need a direct camera path, while a potentially large device-first queue should remain visible without occupying the dashboard and People page until an operator opens it.
- Alternatives considered: Add a camera dependency (rejected because browser media and canvas APIs already provide the required JPEG); create a second upload endpoint (rejected because captured files can use the existing validated/audited endpoint); hide the accordion when empty (rejected because an explicit zero count communicates system state).
- Files/subsystems: Shared webcam component, new-person and person-detail photo controls, shared unclaimed-enrollment panel, installer version, current-source and operator documentation.
- Verification and exact result: Frontend lint PASS; Next.js production build and TypeScript validation PASS with all 18 routes generated successfully.
- Issue/root cause: The browser only exposes webcam media on secure contexts; `localhost` is allowed, but a plain-HTTP LAN IP normally is not.
- Solution/workaround: The UI reports camera permission/context failures inline and retains manual JPEG upload as the fallback. Streams stop on capture, cancel, and component teardown.
- Pending/next action: Package 0.4.14 only when requested, then verify camera permission, capture/upload, accordion default state/count, and installed version on the target browser and Windows host.
- Future scope: Configure HTTPS for remote-LAN webcam use if registration will not run locally on the VMS server.

### 2026-09-07 — Phase 10 — Development ports isolated from installed VMS

- Status: `IMPLEMENTED_LOCAL_VERIFIED_NOT_PACKAGED`.
- Change: Reserved web `48101`, backend/ADMS `48102`, and PostgreSQL `48103` for source development, with the development database and photos under `backend/.dev`. Installed defaults remain `47101–47103`.
- Reason/decision: An installed VMS 0.4.13 and the source stack must be able to run concurrently without binding to the same ports or database directory.
- Alternatives considered: Stop the installed services during development (rejected because it prevents concurrent comparison); change installed ports (rejected because this is development isolation only).
- Files/subsystems: Development environment examples and local ignored environment files, npm development commands, development guide, release register.
- Verification and exact result: All three development listeners started successfully: Next.js returned HTTP 200 on `48101`, `/health` returned `status=ok`, `database=reachable`, PostgreSQL `17.10` on `48102`, and the isolated PostgreSQL listener ran on `48103` after all 18 migrations applied. Installed Windows services remained Running and their `47101–47103` listeners remained active concurrently.
- Packaging safety correction: Development values remain only in ignored `.env` files and development npm commands. Shared release `.env.example` files retain `47101–47103`, and `installer/build-release.mjs` now refuses to stage a payload unless the backend database/API and web API template ports match the installed defaults. Syntax validation, template assertions, development `/health`, and development web HTTP 200 all passed after the correction.
- Pending/next action: Keep physical development terminals pointed at `48102`; installed terminals remain on their configured installed backend port.

### 2026-09-08 — Phase 10 — 0.4.14 frontend URL leak and 0.4.15 correction

- Status: `PACKAGED_PENDING_INSTALLED_VERIFICATION`.
- Change: Marked 0.4.14 as defective after installed login attempted `localhost:48102`. Made production web builds override ignored local development variables, forced the root shell to render installed `API_BASE_URL` dynamically, resolved the API base at use time, and made release staging reject a compiled development URL. Advanced the corrected payload to 0.4.15.
- Root cause: `next build` loaded `web/.env.local` and statically embedded its development URL into both client JavaScript and prerendered HTML. Correct release `.env.example` and installed `.env` files could not override those already-generated assets.
- Verification and exact result: Installed `C:\VMS\web\.env` correctly contained `47102`, installed generated assets incorrectly contained `48102`, and installed backend `/health` was healthy on `47102`, proving the mismatch. After correction, frontend lint and production build passed; every route is dynamic, generated assets contain no `localhost:48102`, and a standalone run with simulated `API_BASE_URL=http://localhost:49222` injected that value before hydration while the compiled client retained only the production `47102` fallback.
- Artifact evidence: Defective 0.4.14 installer is 137,195,181 bytes with SHA-256 `9772130032628E2CCDA2B3DFC350C2F06626250A1D9F1E5CFC7F8408589C4122`; do not deploy it.
- Corrected artifact evidence: 0.4.15 installer is 137,239,728 bytes with SHA-256 `F014F31F88AF7689968212A0226876E30858070CDCA460114D9AE8A03A859435`. Release staging and Inno Setup compilation passed; the staged frontend contains no `localhost:48102`, its templates use `47102`, and the staged backend reports 0.4.15.
- Pending/next action: Install 0.4.15 over 0.4.14, then verify login and `/health` on the installed system.

### 2026-09-09 — Phase 10 — 0.4.16 operator and visitor workflow update

- Status: `PACKAGED_PENDING_INSTALLED_VERIFICATION`.
- Change: Added optional operator name/phone editing, optional Person-to-meet selection from active operators during visitor provisioning, PAN verified badges, and Directory access for Authorized Persons while retaining Admin-only deactivate/reactivate enforcement.
- Upgrade safety: The migration only adds nullable columns, an index, and a nullable foreign key. Existing rows are not updated or deleted; the unchanged service-start path runs `prisma migrate deploy` during installer upgrades.
- Verification and exact result: Prisma generation, backend typecheck, 81/81 backend tests, web production build, web lint, backend packaging, release staging/audit, and Inno compilation passed. The staged payload contains `20260909120000_operator_details_person_to_meet`, generated Prisma types contain `personToMeetId`, and the packaged backend reports 0.4.16.
- Artifact evidence: 0.4.16 `vms-setup.exe` is 137,197,263 bytes with SHA-256 `501A08018E859495ADB2C6F501B13FFA83E5183E338EC090EA127EA442974A5D`; ProductVersion is 0.4.16.
- Pending/next action: Install 0.4.16 over a copy of an existing installation, verify row counts and operator/entry history before and after, then exercise the new fields in the UI.

### 2026-09-10 — Phase 10 — 0.4.17 dashboard and operator self-service update

- Status: `PACKAGED_PENDING_INSTALLED_VERIFICATION`.
- Change: Converted On Site Now, Alerts, Devices, and Live Punch Feed into summarized dashboard accordions with only On Site Now open by default; added operator self-profile editing, guarded password changes, password visibility controls, and modal operator edit/reset flows.
- Upgrade safety: No schema change is required. The installer retains its fixed AppId and existing `ignoreversion`, service-stop/start, ProgramData, and `prisma migrate deploy` behavior, so the upgrade replaces application payloads without deleting database rows, photos, configuration, or history.
- Verification and exact result: Backend typecheck and 82/82 tests, web lint and production build, backend packaging, release staging/audit, and Inno compilation passed. The packaged backend and installer report 0.4.17.
- Artifact evidence: 0.4.17 `vms-setup.exe` is 137,196,244 bytes with SHA-256 `F96982718000C59A2B0FC614AFAB8430C55507E7EB6CB3AD6B8C87B10EC60012`; ProductVersion is 0.4.17.
- Pending/next action: Install 0.4.17 over a copy of an existing installation, verify row/photo/history counts before and after, then complete UI acceptance for accordion state, self-profile editing, and password flows.

### 2026-09-10 — Phase 10 — 0.4.18 dashboard accordion consistency fix

- Status: `PACKAGED_PENDING_INSTALLED_VERIFICATION`.
- Change: Removed the Unregistered People warning border on the dashboard and moved its count to the right-side summary area. Retained its attention border on the People page, where it represents an actionable registration queue.
- Upgrade safety: UI-only change; no database migration or runtime-data operation.
- Verification and exact result: Web lint and production build, backend packaging, release staging/audit, and Inno compilation passed.
- Artifact evidence: 0.4.18 `vms-setup.exe` is 137,202,533 bytes with SHA-256 `72B66E90357A446B8E52C3BCCF5DE2339681403DB43C752110084FD94BFF582B`; ProductVersion is 0.4.18.
- Pending/next action: Install 0.4.18 and visually confirm both dashboard and People-page variants.

| Date | Phase | Decision | Reason | Revisit trigger |
|---|---|---|---|---|
| 2026-08-27 | 1 | Use a clean Person domain without compatibility aliases. | This release permits clean reinstall and should not carry two active vocabularies. | A real production dataset must be preserved/migrated. |
| 2026-08-27 | 3 | Empty patterns classify nobody. | Category cannot be inferred safely and shared-terminal biometric collection must be bounded. | A separate explicit per-device “claim all as category X” setting is designed. |
| 2026-08-27 | 4 | Employee permanence uses EmployeeDeviceAccess, not Entry. | Desired permanent roster state differs from Visitor authorization cycles. | None currently. |
| 2026-08-27 | 5 | Attendance summarizes across devices by Person/local day. | IN and OUT may occur on different terminals. | A site requires shift boundaries or timezone rules beyond device-local day. |
| 2026-08-27 | 7 | Client names stay only in the private issuer ledger. | No decryption secret is needed on clients and client identity stays private. | Online license management replaces the offline ledger. |
| 2026-08-27 | 8 | Refuse legacy persistent schema instead of deleting/migrating silently. | Identity/photos may be valuable; destructive behavior must be deliberate. | An approved migration product is scoped. |
| 2026-08-29 | 0 | Deliver and accept this upgrade phase by phase. | Keeps decisions, failures, verification, and remaining work traceable. | Only the user changes the delivery method. |
| 2026-08-30 | 9 | Harden the existing Node/Next product now; do not rewrite before the pilot. | Removes confirmed source leaks with low regression risk while preserving hardware-tested behavior. | Pilot evidence shows native deployment/protection benefits justify a planned Go migration. |
| 2026-08-30 | 7 | Do not expose the offline license binding in the client UI/API. | Clients only need status and a place to install a key; owner technicians can collect binding privately. | Online activation replaces attended offline issuance. |

## Open issues and pending work

| Owner phase | Issue/pending item | Risk | Next action |
|---|---|---|---|
| 0 | None in repository verification. | — | Preserve green gates. |
| 1 | None in fresh-database migration verification. | — | Test legacy refusal in Phase 10. |
| 3 | Automatic ingestion failure ordering lacks integration tests. | Visitor could be mishandled if an assumption is wrong. | Add storage/DB/queue failure tests. |
| 4 | Employee reconciliation and face-count transitions lack integration tests. | Unwanted restore/removal or incorrect capacity. | Simulate purge/remove/restore and acknowledgements. |
| 5 | Physical cross-device timestamps remain site-dependent. | Device configuration can still invalidate correct report code. | Verify terminal timezone/direction at acceptance. |
| 7 | ProgramData and reinstall behavior is not Windows-tested. | Trial/key reset or service permission failure. | Disposable Windows integration test. |
| 8 | The current 0.4.11 installer and legacy refusal have not been executed on a clean Windows Server machine. | ACL/firewall automation, migration, or upgrade behavior may still differ from local checks. | Install and test the current candidate on disposable Windows Server 2016. |
| 9 | Historical release/phase documents retain Vendor wording by design. | Readers may confuse history with current behavior. | Follow current upgrade plan and acceptance guide. |
| 10 | No physical terminal verification for the upgrade. | Firmware behavior remains unproven. | Execute recorded hardware acceptance matrix. |

## Future scope

- Historical Company/Department transfer records for attendance.
- Online activation or hardware-backed anti-reset licensing.
- Approved legacy production-data migration tooling.
- Shift/roster/payroll rules beyond paired daily attendance.
- Cross-algorithm portable biometric templates remain explicitly unsupported; photographs stay authoritative.

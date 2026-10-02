# People Upgrade — Installation and Acceptance Verification

**Updated:** 3 September 2026
**Applies to:** packaged VMS 0.4.11 through the current 0.4.19 artifact. Do not use defective 0.4.14 for acceptance.

Use a disposable Windows machine or VM and a non-production eSSL terminal. Record every result in `PEOPLE_UPGRADE_EXECUTION_LOG.md`. Do not mark terminal-dependent checks complete from simulator evidence.

## 1. Release-owner preparation

1. On the secured issuer computer, create an Ed25519 keypair once:
   `node backend/scripts/license/generate-keypair.mjs`
2. Keep the private PEM and license ledger offline and backed up. Never copy them into the repository, installer, client PC, email archive, or support bundle.
3. Build with the public half:
   `$env:VMS_LICENSE_PUBLIC_KEY_FILE='C:\Secure\VMS-Licensing\vms-license-public.pem'`
4. Run the release gates:
   - Backend: `npx prisma generate`, `npm run typecheck`, `npm test`, `npm run build`, `npm run package`.
   - Web: `npm run lint`, `npm run build`.
   - Root: `node installer/build-release.mjs`.
5. Confirm `installer/release/backend/scripts/license` does not exist. Confirm the staged backend `.env.example` contains one active `LICENSE_PUBLIC_KEY` and contains no private key.
6. Compile `installer/vms-installer.iss` with Inno Setup. Record installer filename, SHA-256, size, source commit, migration list, Node/PostgreSQL versions, and build date in `VERSIONS.md`.

Expected: all commands exit 0. The current backend E2E harness reports `253 passed, 0 failed`; any later count must also have zero failures.

## 2. Clean installation and first setup

1. Snapshot the disposable VM, then verify there is no prior VMS PostgreSQL or photo directory intended for reuse.
2. Install the release. Confirm `VmsPostgres`, `VmsBackend`, and `VmsWeb` are running and set to automatic startup.
3. Open the web console locally. The first-run screen must request Admin details, organization name, and optional logo.
4. From a second device on the same LAN, open `http://<VMS-server-IP>:47101`. In its browser network tools, confirm login and later API/photo/SSE/report requests target `<VMS-server-IP>:47102`, never `localhost:47102`.
5. Confirm `http://<VMS-server-IP>:47102/health` is reachable from the second device, sign in there, load a photo, download a CSV, and leave the page open long enough to observe a live event. No CORS error may appear.
6. Try an SVG, a renamed text file, and a file over 2 MB. Each must be rejected before the Admin is created.
7. Complete setup using a PNG/JPEG/WebP. Sign in and verify the organization name/logo on login, navigation, browser title, print/pass view, and report CSV header.
8. Open License and record trial start, expiry, and status. Confirm neither the page nor `GET /api/license` exposes a machine ID, installation ID, or equivalent identifier.

Expected: a 30-day trial starts only when setup completes. The Company directory is still empty; the customer organization name is not automatically a Person company.

## 3. Directories and People

1. As Admin, create two Companies and two Departments. Try a duplicate differing only by case; expect conflict.
2. Deactivate one of each. Existing assignments must still display; inactive values must not be selectable for new assignment.
3. Register a Visitor with Aadhaar only, then one with PAN only. Enter PAN in lowercase and confirm it stores uppercase.
4. Reject invalid PAN values; accepted syntax is `ABCDE1234F`. Reject duplicate PAN/Aadhaar.
5. Confirm a completed profile requires name, mobile, Company, Department, category, and either Aadhaar or PAN.
6. Use bulk assignment and verify only the selected People change. Check the audit report.
7. Sign in as `AUTHORIZED_PERSON`: ordinary profile edits should work, while category changes, directory creation, branding, licensing, and Employee access must return 403.
8. Open a profile with Aadhaar and confirm the Aadhaar verified badge appears. Open one with PAN only and confirm it does not.
9. Confirm the Visitor/Employee ID appears before Name in profile editing and is non-editable. A terminal-claimed ID must also be locked on the registration form.
10. Open Register person through `localhost`, select **Use webcam**, grant permission, confirm the live preview, capture a photo, and complete registration. Confirm the selected JPEG is stored and shown on the new Person.
11. Create or locate a Person with no photo and repeat webcam capture from the profile's Enrollment photo card. Confirm it uploads immediately and the camera indicator turns off after capture. Also verify **Cancel** stops the camera without changing the Person.
12. Open the console through a plain-HTTP LAN IP and select **Use webcam**. If the browser blocks insecure-context camera access, confirm the page explains the localhost/HTTPS requirement and ordinary JPEG upload still works.

## 4. Device patterns and automatic registration

1. Confirm every India terminal shows timezone `+05:30` / offset `330` on Devices. A newly adopted terminal must default to `330`; Admin must be able to correct the value. Then configure non-overlapping patterns, for example Employee `EMP*` and Visitor `VIS*`. Confirm overlapping patterns are rejected.
2. Enrol alphanumeric IDs `EMP001A` and `VIS001A` on real hardware with photos.
3. Confirm both People appear automatically with the device’s exact ID casing and name, plus `Needs details` until the administrative fields are completed.
4. Confirm the Employee stays on the terminal and receives permanent desired access for that device.
5. Confirm the Visitor is deleted only after its JPEG and PersonBiometric metadata exist. Temporarily make the photo path unwritable and repeat: the Visitor must remain on the terminal.
6. Send an ID matching neither pattern and one matching both at runtime. They must remain untouched and appear for Admin review; no photo pull or delete command may be queued.
7. Complete the Visitor profile. Verify this alone does not restore terminal access. Create an Entry with purpose, mode, retention, and device; only then should user and photo be queued.
8. On both Dashboard and People, confirm **Unregistered people** is collapsed by default and its badge equals the full API total. Open it and confirm every unclaimed enrollment, photo, PIN/name, and Register action appears. Claim one and confirm the count falls on the next refresh; when none remain, the closed header must still show `0`.

## 5. Permanent Employee access

1. Manually create an Employee and select one or more devices. A manual Employee without a device selection must be rejected.
2. Drain and acknowledge the command queue; verify provisioning status becomes current on every selected device.
3. Delete the Employee directly on a test terminal, then run reconciliation. The VMS must restore user and photo.
4. Remove access as Admin with a reason. Confirm a delete is queued, the reason/actor/time remain visible, and reconciliation does not restore them.
5. Restore access and confirm reprovisioning from the permanent photo.
6. Convert Visitor → Employee and verify device selection is required. Convert Employee → Visitor and verify every permanent assignment is revoked first.
7. Confirm Employee records, photos, punches, and audit history are never deleted and Employees never enter Visitor expiry or daily-block workflows.
8. Assign an Employee to at least two devices, select **Resign**, and confirm one action marks every assignment removed and queues one device deletion per assignment. A resigned Employee must be inactive and cannot be restored or assigned again.
9. Run **Resigned employees** with date, Person, Company, and Department filters. Confirm the resignation timestamp, reason, and Admin are present in JSON/UI and CSV.
10. Select one or more devices and choose **Rehire**. Confirm the Employee becomes active, resignation fields clear, permanent desired access returns only on the selected devices, provisioning is queued, and both resignation and rehire remain in audit history. The Employee must disappear from the current Resigned employees report.

## 6. Attendance

1. Create known IN/OUT fixtures across two devices: IN 09:00, OUT 13:00, IN 14:00, OUT 18:00. Expected worked time is 8 hours.
2. Test consecutive IN, consecutive OUT, leading OUT, and trailing IN. Only complete pairs contribute duration; anomalies must be flagged.
3. Verify Today, current week, current month, and custom range presets.
4. Verify category, Company, Department, Person, and Device filters separately and together.
5. Export CSV and confirm branding, columns, filters, timestamps, counts, duration, and formula-injection protection.
6. Run retention on old whole-day data. Confirm raw punches are summarized transactionally, reports remain identical, and no Person/day is split.
7. Set Windows to a non-IST timezone and confirm Inside Now, People detail/history, every report, alerts, and CSV timestamp cells still show IST (`Asia/Kolkata`, UTC+05:30). Test a record between 00:00 and 05:29 IST and confirm report date filtering uses the IST calendar day. Stored database instants must remain UTC.
8. Confirm the dashboard live punch feed displays the normalized punch instant in IST (`punchedAtUtc` rendered in `Asia/Kolkata`, with an `IST` suffix) and that its relative label advances from “just now” to seconds/minutes based on server receipt time. Compare the displayed clock with the expected UTC+05:30 conversion.
9. Exercise at least one timestamp column in every report and its CSV. Include UTC ISO text ending in `Z`, a raw-query timestamp without a zone, and a timestamp near the UTC/IST date boundary; UI and CSV must show the same explicit IST value and date.
10. On an upgraded database that previously stored an adopted device at offset `0`, confirm migration `20260903090000_default_device_timezone_ist` changes it to `330` and repairs its punch-derived Entry/report times by -05:30 without changing `punchedAtDevice`. Confirm an On site now crossing made at `02/09/2026 22:38:10` displays that same IST wall time, not `03/09/2026 04:08:10`.
11. Enter an incorrect email or password and confirm the login page says `invalid email or password`, while an expired token on a protected page still says `session expired — sign in again`.
12. Give a terminal an Admin name and confirm that name appears in live punches, command queue/history, reports, person provisioning state, and alerts; serial number is used only when no name exists.

## 7. Licensing and reinstall persistence

1. During an attended owner-technician session, run `C:\VMS\tools\create-license-request.mjs --output X:\license-request.txt` with bundled Node. Confirm the helper exists after install, writes a 64-character request without printing it, and the UI/API still expose no binding. On the issuer PC, issue a key from that private file:
   `node backend/scripts/license/issue-license.mjs --private-key C:\Secure\VMS-Licensing\vms-license-private.pem --ledger C:\Secure\VMS-Licensing\vms-license-ledger.json --machine-id-file X:\license-request.txt --client-name "Internal ledger label" --expires-at "2027-08-01T18:30:00+05:30" --plan standard`
2. Inspect it with `inspect-license.mjs`; verify signature, license ID, normalized UTC expiry, plan, and ledger-only client name. Confirm the inspection output does not display the private binding.
3. Install the key as Admin. Confirm the displayed expiry represents the exact signed instant.
4. Try malformed, altered, expired, and wrong-machine keys; all must fail without replacing the valid key.
5. Uninstall and reinstall without deleting ProgramData. The paid key must be imported automatically. Repeat with trial-only state and confirm the earliest trial start remains.
6. Move the system clock backward. `latestObservedAt` must not decrease and protected operator APIs must not gain time.
7. After expiry, login/password change/health/license/branding must remain available; normal operator APIs must return HTTP 402 `{ "error": "LICENSE_EXPIRED", "expiresAt": "..." }`. ADMS posting, command dispatch, retention, reconciliation, punch ingestion, and already-authorized barrier access must continue.
8. Change MachineGuid only in a disposable VM and confirm the old key is rejected. A full Windows reinstall, restored old snapshot, or administrator deletion of both DB and ProgramData remains outside reliable offline protection.

## 8. Installer safety and upgrade

1. Create a disposable old persistent cluster containing the legacy `vendor` table. Point the new bundled service at it.
2. Confirm startup refuses with an actionable message. It must not migrate, delete, or silently initialize the old data.
3. Archive the old PostgreSQL and photo directories manually after confirming no production data is needed; never automate this deletion.
4. Test an ordinary later-version upgrade over this new schema. Confirm PostgreSQL data, photos, branding, trial marker, and paid key survive.
5. Uninstall and verify persistent data/ProgramData remain. Reinstall and confirm adoption.

## 9. Final physical-terminal acceptance

Verify on the target firmware: exact alphanumeric casing, USER/BIOPHOTO order, Visitor photo-before-delete, Employee permanence, Admin removal/restore, purge recovery, cross-gate punches, command acknowledgements, face counts, and continued barrier behavior during backend restart and license expiry. Record terminal serial/platform/firmware/ADMS/face algorithm and exact command responses in `VMS_PROJECT_CONTEXT.md` and `KNOWN_ISSUES.md`.

## Pass/fail rule

A check passes only with observable evidence: API response, database row, stored file, queue acknowledgement, service log, exported report, or physical barrier result. Log failures with impact, root cause, fix/workaround, retest evidence, and release disposition. Do not ship with an unresolved security, data-loss, permanent-access, license-adoption, or installer-safety failure.

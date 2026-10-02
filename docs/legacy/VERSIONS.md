# Release register

What each shipped installer contains, and which commit it was built from.

This exists because an installer is an opaque 200 MB binary. Six months from
now, a site reports a bug and the only question that matters is *which build
are they running* — and the only honest answer has to come from a record kept
at build time. Reconstructing it afterwards from git is guesswork, as the
0.1.0 row below demonstrates.

---

## Where the version actually lives

**`installer/vms-installer.iss` → `AppVersion`.** That is the single product
version. It becomes the exe's `ProductVersion` and the entry in Add/Remove
Programs. `backend/scripts/build-package.mjs` also reads it and injects it into
the packaged backend; `/health` and the subtle console label therefore report
the version of the code actually running. Source/dev runs report `development`.

Two places lie about it, and both are traps:

| Place | Says | Reality |
|---|---|---|
| `backend/package.json` `version` | `0.1.0` | Never updated, never read at runtime. |
| `web/package.json` `version` | `0.1.0` | Same. |

Neither package version is surfaced anywhere. Starting with 0.4.13,
`GET /health` returns `{ status, version, database, postgres }`, and the
signed-in console shows `v<version>` quietly beside the organization name.
For 0.4.11 and earlier, use Add/Remove Programs or the installer's
`ProductVersion`.

> **Do not bump the `package.json` versions to "fix" this.** Two more numbers
> that can disagree with `AppVersion` is worse than one number that is
> obviously not the product version. Either wire one of them into `/health`
> so it has a job, or leave them alone.

`AppId` is a fixed GUID and **must not change between versions** — it is what
makes an install upgrade in place rather than appearing twice in Add/Remove
Programs. Only the test-build GUID differs, and only under `/DTestBuild`.

`AppVersion` is identification, not an upgrade safety gate. The `[Files]`
payload uses `ignoreversion`, so a same-version installer still replaces the
application files while Windows continues to show the old/shared version.
Never publish changed payloads under the same `AppVersion`; increment the
patch version for every changed installer.

---

## The register

> **Current boundary (10 September 2026):** 0.4.18 is the current packaged artifact. Do not deploy 0.4.14: its frontend baked in `localhost:48102`.

| Version | Date | Built from | Installer | Size | Migrations added |
|---|---|---|---|---|---|
| **0.4.18 (current packaged artifact)** | 2026-09-10 | current working tree | `vms-setup.exe` | 137,202,533 bytes | none beyond 0.4.16 |
| **0.4.17 (superseded)** | 2026-09-10 | current working tree before dashboard consistency fix | `vms-setup.exe` | 137,196,244 bytes | none beyond 0.4.16 |
| **0.4.16 (superseded)** | 2026-09-09 | current working tree | `vms-setup.exe` | 137,197,263 bytes | `20260909120000_operator_details_person_to_meet` |
| **0.4.15 (superseded)** | 2026-09-08 | current working tree after defective 0.4.14 build | `vms-setup.exe` | 137,239,728 bytes | none beyond 0.4.10 |
| **0.4.14 (defective; do not deploy)** | 2026-09-08 | uncommitted working tree after `a108f76` | `vms-setup.exe` | 137,195,181 bytes | none beyond 0.4.10 |
| **0.4.13 (superseded source candidate; not packaged)** | 2026-09-03 | source after `9d7391c` | — | — | none beyond 0.4.10 |
| **0.4.11 (superseded)** | 2026-09-02 | `9d7391c` | `vms-setup.exe` | 120.07 MB | none beyond 0.4.10 |
| **0.4.10 (superseded; artifact overwritten)** | 2026-09-02 | `b37c701` | overwritten by 0.4.11 | not recorded | `20260903090000_default_device_timezone_ist` |
| **0.4.9 (report serializer only; superseded before deployment)** | 2026-09-02 | uncommitted working tree before device-offset fix | `vms-setup.exe` | 120.06 MB | none beyond 0.4.5 |
| **0.4.8 (IST + login/device-label RC)** | 2026-09-02 | uncommitted working tree; record commit at release | `vms-setup.exe` | 120.07 MB | none beyond 0.4.5 |
| **0.4.7 (rehire + live time RC)** | 2026-09-01 | uncommitted working tree; record commit at release | `vms-setup.exe` | 120.06 MB | none beyond 0.4.5 |
| **0.4.6 (LAN console fix RC)** | 2026-09-01 | uncommitted working tree; record commit at release | `vms-setup.exe` | 120.06 MB | none beyond 0.4.5 |
| **0.4.5 (client field fixes RC)** | 2026-09-01 | uncommitted working tree; record commit at release | `vms-setup.exe` | 120.06 MB | `20260901090000_employee_resignation` |
| **0.4.4 (installed license request RC)** | 2026-08-30 | uncommitted working tree; record commit at release | `vms-setup.exe` | 120.05 MB | none beyond 0.4.0 |
| **0.4.3 (private licensing flow RC)** | 2026-08-30 | uncommitted working tree; record commit at release | `vms-setup.exe` | 174.79 MB | none beyond 0.4.0 |
| **0.4.2 (Inside Now fix RC)** | 2026-08-30 | uncommitted working tree; record commit at release | `vms-setup.exe` | 174.80 MB | none beyond 0.4.0 |
| **0.4.1 (hardened People upgrade RC)** | 2026-08-30 | uncommitted working tree; record commit at release | `vms-setup.exe` | 174.80 MB | none beyond 0.4.0 |
| **0.4.0 (People upgrade RC)** | 2026-08-29 | uncommitted working tree; record commit at release | `vms-setup.exe` | 246.94 MB | `20260827120000_people_attendance_branding_license` |
| **0.3.0** | 2026-08-13 | `7e07d2a` + the AppVersion bump in this commit | `vms-setup.exe` | 283.3 MB | `20260812120000_vendor_aadhar_number`, `20260812150000_entry_purpose_of_visit`, `20260813090000_user_id_text`, `20260813091000_device_vendor_id_patterns` |
| **0.2.0** | 2026-08-12 | `cb5d4ca` | `vms-setup.exe` | 222.3 MB | `20260811090000_vendor_adopted_from_device` |
| **0.1.0** | ~2026-08-12 | **unrecorded** — see below | `vms-setup.exe` (overwritten) | — | — |

> **0.1.0's exact build commit was never recorded**, and its binary has since
> been overwritten by the 0.2.0 build at the same output path. The changelog
> below reconstructs it as "the tree at `8cc3b8d`, the Phase 6 finalization
> commit", because that is the last plausible point at which 0.1.0 was cut.
> **Treat that as an inference, not a fact.** If a site is running something
> labelled 0.1.0, do not assume it matches `8cc3b8d` exactly.
>
> This is precisely the failure this document exists to prevent. Fill the row
> in *at build time*, not afterwards.

## 0.4.19 — Device-shaped enrollment photos, photo replacement, LAN webcam

Fixes `PUSH_PHOTO` failing with `device Return=-1001` for photos captured by
webcam or chosen from a file (observed on site 12 September 2026). The
terminal makes its own enrollment photos as ~45-60 KB portraits; the console
was sending raw camera frames at full resolution. Every photo is now
centre-cropped to a 480×640 portrait JPEG in the browser (`web/src/lib/photo.ts`)
before it reaches the existing validated, audited upload endpoint. The person
page now offers upload/webcam even when a photo already exists, so a rejected
photo can be replaced and the failed `PUSH_PHOTO` retried — the retry re-reads
the JPEG from disk. Each replacement is an audited `PHOTO_UPDATED` row.

Webcam capture from operator PCs on the LAN was blocked by the browser's
secure-context rule (plain-HTTP LAN address). Ships
`backend/scripts/windows-services/enable-webcam-on-operator-pc.ps1`, which
writes the Chrome/Edge `OverrideSecurityRestrictionsOnInsecureOrigin` policy
for the console origin on one PC, plus Install Guide steps for pushing the
same policy by Group Policy on domain-joined sites. The in-app camera error
names the script.

No schema or backend behavior changed. Backend tests 82/82; `verify:e2e`
255/257 with the two failures being the "healthy system raises no alerts"
assertions tripping on the build machine's own `license-expiring` info alert
(trial expires 28 September 2026) — unrelated to this release. Source commit `84b4b59` plus this
version bump (release commit `V-0.4.19`). Packaged as `vms-setup.exe` (148,493,921 bytes),
ProductVersion 0.4.19. SHA-256: `0514E5AC4E6B1A22A135B54418996A101CC2EE9E2706AADDC30B37257F3CAD80`.

---

## 0.4.18 — Dashboard accordion consistency fix

Removes the warning border from Unregistered People on the dashboard and
moves its count into the same right-aligned summary position used by every
other dashboard accordion. The People-page copy retains its warning border as
an intentional registration queue, while sharing the improved summary layout.
No schema or backend behavior changes are included.

---

## 0.4.18 — Dashboard accordion consistency fix

Removes the dashboard-only warning border from Unregistered People and moves
its count to the right-hand summary area beside the disclosure arrow, matching
the other dashboard accordions. The People page retains the warning border
because the same component is an actionable registration queue there, while
also using the consistent right-aligned count.

No schema or backend behavior changed. Web lint, production build, release
staging/audit, backend packaging, and Inno Setup compilation pass. Packaged as
`vms-setup.exe` (137,202,533 bytes), ProductVersion 0.4.18. SHA-256:
`72B66E90357A446B8E52C3BCCF5DE2339681403DB43C752110084FD94BFF582B`.

---

## 0.4.17 — Dashboard accordions and operator self-service

Reworks the dashboard into compact accordions. On Site Now is first and is the
only section open by default; Alerts, Devices, and Live Punch Feed start closed
and expose useful trigger summaries. The live-feed summary shows the latest
Person or PIN, relative time, visible event count, and stream connection state.

Adds My Profile for every signed-in operator. Operators can view their account,
edit their own optional name and phone, and change their password only after
providing the current password and confirming the replacement. Email and role
cannot be changed through self-service. Password fields across login, setup,
change-password, account creation, and password reset now have show/hide
controls. Operator detail editing and password reset use modal forms instead of
browser prompts.

This release adds no database migration. It reuses the nullable operator fields
introduced in 0.4.16, keeps the fixed installer AppId, preserves ProgramData,
and therefore upgrades existing installations without replacing or deleting
their database, photos, configuration, or history.

Local verification on 10 September 2026: backend TypeScript and 82/82 tests,
web lint and production build, backend packaging, release staging/audit, and
Inno Setup compilation pass. Packaged as `vms-setup.exe` (137,196,244 bytes),
ProductVersion 0.4.17. SHA-256:
`F96982718000C59A2B0FC614AFAB8430C55507E7EB6CB3AD6B8C87B10EC60012`.

---

## 0.4.16 — Operator details, visit hosts, and directory access

Adds optional operator name and phone fields, editable for accounts created by
older releases. Visitor provisioning can optionally record an active operator
as the Person to meet; the selection appears on the authorization and visitor
pass. PAN now receives the same verified badge treatment as Aadhaar.

Authorized Persons can open the Directory page, add directory values, and
bulk-assign People. Deactivation/reactivation remains Admin-only in both the UI
and API. The additive migration makes every new field nullable, so upgrading an
existing installation preserves all operator, Person, Entry, and device data.
The bundled database service applies it through the existing `prisma migrate
deploy` startup path.

Local verification on 9 September 2026: Prisma generation, backend TypeScript,
81/81 backend tests, web production build, and web lint pass.

Packaged as `vms-setup.exe` (137,197,263 bytes). SHA-256:
`501A08018E859495ADB2C6F501B13FFA83E5183E338EC090EA127EA442974A5D`.
Release staging verified that the new migration and generated Prisma client are
present, excluded runtime data, and Inno Setup reported ProductVersion 0.4.16.

---

## 0.4.15 — Release-safe runtime API configuration

Fixes the installed login failure in 0.4.14. Next.js had loaded the ignored
development `web/.env.local` during `npm run build`, then statically embedded
`http://localhost:48102` into the browser bundle and prerendered pages. The
installer correctly wrote `web/.env` with `47102`, but generated static files
could not be changed by that runtime environment.

The production build now explicitly supplies the installed API default, the
root layout is dynamically rendered from installed `API_BASE_URL`, and API
consumers resolve that value at use time. Release staging rejects any compiled
web payload containing the development backend URL. Lint, TypeScript and the
production build pass; a standalone runtime test injected a simulated custom
backend port before hydration, found no `48102` in generated assets, and found
the expected production fallback in the client chunk.

0.4.15 retains the webcam and unregistered-person UI from 0.4.14. It was
packaged on 8 September 2026 as `vms-setup.exe` (137,239,728 bytes). SHA-256:
`F014F31F88AF7689968212A0226876E30858070CDCA460114D9AE8A03A859435`.

---

## 0.4.14 — Webcam registration and compact unregistered review (defective)

The person registration form and the missing-photo state on person detail now
offer browser-native webcam capture next to JPEG upload. Captures are converted
to JPEG in the browser and sent through the existing validated, audited photo
endpoint; no new dependency, API, or storage path was added. Camera streams are
stopped after capture, cancellation, and component teardown. Browsers require
`localhost` or HTTPS for webcam permission, so file upload remains the fallback
when an operator opens the console over a plain-HTTP LAN address.

The unregistered-people panel now has an always-visible count and is collapsed
by default. Opening its accessible native accordion shows the complete current
list (or an empty/loading state). The existing 15-second refresh and registration
links are unchanged.

0.4.14 also includes 0.4.13 runtime version reporting. It was packaged on
8 September 2026, but must not be deployed because login targets the development
backend URL. Artifact SHA-256:
`9772130032628E2CCDA2B3DFC350C2F06626250A1D9F1E5CFC7F8408589C4122`.
The development commands and ignored local environment use web `48101`,
backend/ADMS `48102`, and PostgreSQL `48103` with data under `backend/.dev`.
Release environment templates and installed defaults remain `47101–47103`,
allowing both stacks to run together.

---

## 0.4.13 — Runtime version visibility (superseded source candidate)

The packaging step now reads `AppVersion` directly from the Inno definition
and injects it into the backend bundle. `/health` reports that value, and the
signed-in console displays it as quiet secondary text beside the organization
name. No package.json version is involved, so there remains one source of
truth. Backend tests 81/81, typecheck, backend packaging, frontend lint, and
the production web build pass; the generated backend reports that it was
built as VMS 0.4.13. The existing 0.4.11 installer does not contain this change.

This candidate was not packaged and was superseded by 0.4.14. Do not publish
either changed payload as 0.4.11 or 0.4.13.

---

## 0.4.11 — Inclusive IST visitor retention and custom end dates

Visitor retention now ends at 23:59:59.999 IST on the inclusive final day:
the provision date for one day, day 7 for one week, day 30 for one month, and
day 90 for quarterly. Both provisioning screens support a custom inclusive
IST end date. A SINGLE_ENTRY OUT continues to block rather than de-provision
while the window remains open; its daily idempotency key now uses the IST date.

Backend tests 81/81, backend typecheck, frontend lint/build, packaging, release
staging, and Inno Setup compilation passed before the artifact was committed as
`9d7391c`. ProductVersion is `0.4.11`; size is 125,898,285 bytes (120.07 MiB);
SHA-256 is `0E25EE9B5966C5FE3E19FC676DC141B0CD4A0AC01D452730429A6D449471DBB0`.

---

## 0.4.10 — Device-offset root correction

This release packaged the `+330` adopted-device default, Admin offset editing,
safe repair migration for attributable zero-offset punch history, and the
associated report/API corrections. It was committed as `b37c701` and then
superseded by 0.4.11. Its installer was overwritten before its size and hash
were recorded; do not claim or reconstruct those values.

---

## 0.4.9 — Report serialization build superseded by device-offset fix

This artifact contains the post-0.4.8 shared JSON/CSV IST serialization correction, but it was compiled before the remaining root cause was identified: adopted terminals still defaulted to timezone offset `0`. It therefore does not contain migration `20260903090000_default_device_timezone_ist`, the `+330` device default, historical punch repair, or the Admin offset control. Do not deploy it as the final time correction.

ProductVersion is `0.4.9`; size is 125,891,401 bytes (120.06 MiB); SHA-256 is `F69E98E14D6E6BCDCB86CA8D510AC2504229655609B536E65738250DE301A17E`.

---

## 0.4.8 — Consistent IST, correct login feedback, and device names

The live punch feed now calculates “ago” from server ingestion time rather than a potentially misconfigured terminal clock and refreshes that relative label every second. Operational timestamps continue to be stored as UTC, while the UI, report rows, report date-filter boundaries, alerts, CSV timestamp cells, and CSV filename dates are explicitly presented in `Asia/Kolkata`.

A failed login now preserves the backend's non-enumerating `invalid email or password` response instead of rewriting every HTTP 401 as an expired session. Registered device names now appear in live punches, command views, report device columns, person provisioning status, and device alerts; serial numbers remain the fallback when an Admin has not supplied a name.

Backend typecheck and tests 79/79 PASS; database E2E 253/253 PASS including the live-punch device name and ingestion timestamp; frontend lint and production build PASS; backend packaging and hardened staging PASS with 1,512 source maps removed, the installed request collector present, issuer tools absent, and the embedded public key matching the secured production public key. Inno Setup 6.7.3 PASS. ProductVersion is `0.4.8`; size is 125,901,028 bytes (120.07 MiB); SHA-256 is `01B58CA9D56D514EC38BA14D7DCF3284104413EFE133EA12DFBEEF5867D5F9B4`.

Use 0.4.8 instead of 0.4.7.

---

## 0.4.7 — Employee rehire and terminal-local live punch time

The dashboard live feed now renders `punchedAtDevice`, the terminal's original local wall-clock value, without applying another timezone conversion. Normalized UTC remains the source for storage, ordering, durations, and reports.

Admins can rehire a resigned Employee by explicitly selecting one or more devices. One transaction reactivates the Person, clears the current resignation fields, restores permanent desired access on only those devices, queues user/photo provisioning through the command queue, and records `EMPLOYEE_REHIRED`. The previous resignation remains in audit history; the current Resigned employees report no longer includes the rehired Employee.

Backend typecheck and tests 79/79 PASS; frontend lint/build PASS; E2E 260/260 PASS including resignation followed by rehire and desired-access restoration. Direct execution of the real formatter preserved terminal wall time `12:34:56` as `12:34:56 pm`. Backend package and hardened staging PASS; 1,512 source maps removed, rehire route and request collector present, issuer tools absent, and staged public key matches the secured production key. The installer stops existing VMS services before `[Files]` replaces locked native modules. Inno Setup 6.7.3 PASS. ProductVersion is `0.4.7`; size is 125,893,006 bytes (120.06 MiB); SHA-256 is `7DD346775F5A6AEF07ECA58D594867BE9A21203B26E286274E5C55E8E5E4360C`.

Use 0.4.7 instead of 0.4.6.

---

## 0.4.6 — remote LAN console login fix

The installed web configuration intentionally names the colocated backend as `localhost:<backend-port>`. A browser on another LAN device interpreted that literally as itself, so the login page loaded from the VMS server but authentication failed against the wrong machine. The shared frontend API base now replaces only loopback hostnames with the hostname/IP used to open the console, preserving the installer-selected backend port. This covers REST calls, photos, CSV downloads, branding, and SSE because all of them already use the same `API_BASE`.

The earlier installed default also restricted backend CORS to `http://localhost:47101`. Fresh installs now reflect LAN origins, and upgrades migrate only that exact old product default while preserving an administrator's custom CORS allow-list. API authentication remains bearer-token protected and inbound backend traffic remains limited by the installer-owned `LocalSubnet` firewall rule.

Backend typecheck, tests 79/79 and production packaging PASS; frontend lint/build PASS; direct execution of the real API module resolved `http://localhost:47102` to `http://192.168.10.25:47102` under a simulated LAN browser hostname. Hardened staging removed 1,512 source maps; request collector present, issuer tools absent, CORS upgrade migration present, and staged public key matches the secured production public key. Inno Setup 6.7.3 PASS. ProductVersion is `0.4.6`; size is 125,896,039 bytes (120.06 MiB); SHA-256 is `E7955B6AD95A0AFF2ECFB6D59EAA276EC7D1A4189467382F3213091935A2CD8A`.

Use 0.4.6 instead of 0.4.5 for any installation where operators open the console from other LAN devices.

---

## 0.4.5 — client field fixes: resignation, identity badges, and IST

Person profiles now display an **Aadhaar verified** badge whenever an Aadhaar number is present. The immutable Visitor/Employee ID is displayed before the name in profile completion/editing, and the registration form places the category-specific ID before the name (terminal-claimed IDs remain locked).

Admins can now **Resign** an Employee. One database transaction records who/when/why, marks the Employee inactive and resigned, sets every desired `EmployeeDeviceAccess` assignment to removed, and queues a `DEPROVISION` command for every assigned device. Resigned Employees cannot be assigned or restored. The new **Resigned employees** report supports date, Person, Company, and Department filters and CSV export.

All frontend date/time presentation is explicitly `Asia/Kolkata` rather than inheriting the Windows/browser timezone. CSV timestamp cells are also emitted in IST. Stored timestamps remain normalized UTC; only presentation changed.

Prisma generation, backend typecheck, backend tests 79/79, frontend lint/build, additive migration on development and disposable PostgreSQL, and E2E 257/257 PASS. Backend package and hardened release staging PASS; the resignation migration and request collector are present, issuer tools are absent, and the staged public key matches the secured production public key. Inno Setup 6.7.3 PASS. ProductVersion is `0.4.5`; size is 125,891,031 bytes (120.06 MiB); SHA-256 is `316A34E3B10CF835B095B33FDE2BBCBE8C2B8F7B94E184EBD833213ADD31D409`.

Use 0.4.5 instead of 0.4.4. It remains unsigned and needs an upgrade/reboot check on the client-style Windows host plus physical confirmation that resignation deletes the Employee from every selected terminal.

---

## 0.4.4 — installed license-request collector and hidden route entry

The installer now includes only the non-secret collector at `C:\VMS\tools\create-license-request.mjs`. It writes the installation binding to a caller-selected file without printing it and cannot issue or inspect a license. Issuer scripts, keys, and the private ledger remain absent. The License navigation link and duplicate Operators-page license card are removed, while `/license` remains available directly and retains Admin-only key installation.

Backend typecheck PASS; backend tests 79/79 PASS, including the Windows request-file/no-output regression; frontend lint and production build PASS with `/license` present; hardened release staging PASS with the collector present and issuer folder absent. Inno Setup 6.7.3 compile PASS. ProductVersion is `0.4.4`; size is 125,886,124 bytes (120.05 MiB); SHA-256 is `7D301DF77CE846B35F7399606B6A952865763BB21C6709C237BD9AA39F1BCD00`.

Use 0.4.4 instead of the superseded 0.4.3 candidate. It remains unsigned and needs the clean-Windows, reinstall/adoption, expiry/renewal, and physical-terminal acceptance matrix before external distribution.

---

## 0.4.3 — private offline-license issuance flow

The client-facing License page and `GET /api/license` no longer return or display the Windows-derived machine binding or installation ID. License-install audit rows use a neutral identifier and reports redact older license audit entity IDs. Only Admins see the key-installation form. An owner-only helper writes the binding directly to a secured file during an attended session, and `issue-license.mjs --machine-id-file` consumes it without placing the value in the product UI or issuer command line. New v3 keys omit the binding from their decodable payload and bind it through the Ed25519 signature; v1/v2 verification remains compatible. Runtime status re-verifies the stored key and derives expiry/plan from signed data rather than trusting editable database columns. Password change and current alert guidance now match the approved expired-license allowlist.

Backend typecheck PASS; backend tests 78/78 PASS, including identifier-exposure and v3-payload regressions; frontend lint and production build PASS; backend packaging and hardened release staging PASS. The staged client payload contains no issuer tools, source maps, first-party TypeScript, private key, or ledger. Inno Setup 6.7.3 compile PASS. ProductVersion is `0.4.3`; size is 183,282,130 bytes (174.79 MiB); SHA-256 is `30FB6750B15598142045753719AA9A22A8463E76606339DD6969B41DF3D43531`.

Use 0.4.3 instead of the superseded 0.4.2 candidate. It is still an unsigned release candidate and needs the clean-Windows, reinstall/adoption, expiry/renewal, and physical-terminal acceptance matrix before external distribution.

---

## 0.4.2 — Inside Now Company serialization fix

The People migration changed `Person.company` from text to a Company relation. The `/api/entries/board` endpoint accidentally returned that complete relation while its documented frontend contract remained `company: string | null`. Inside Now consequently passed an object with `{ id, name, isActive, createdAt, updatedAt }` to React and crashed with minified error 31 whenever a displayed person had a Company.

The board query now selects only the Company name and serializes both Inside and day-blocked rows back to the established string/null contract. Backend typecheck, all 77 backend tests, frontend lint, backend packaging, release staging, and the hardening audit pass. Inno Setup 6.7.3 compile PASS. ProductVersion is `0.4.2`; size is 183,295,853 bytes (174.80 MiB); SHA-256 is `F273E11CB736D25DC682C85E9F8EBF498C03E992F387364F26421691748B483D`.

Use 0.4.2 instead of the superseded 0.4.1 candidate. Clean-machine and physical-terminal release gates remain unchanged.

---

## 0.4.1 — installer correction and runtime hardening

This patch keeps the 0.4.0 application/schema behavior and corrects the two defects found during the Windows Server 2016 field installation. Service setup now grants `NetworkService` Modify permission on the embedded PostgreSQL `postgres.exe` and `initdb.exe`, validates native command exit codes, and creates the named `VMS-Backend-ADMS` inbound TCP firewall rule for the installer-selected backend port. The rule is restricted to `LocalSubnet` and is removed by uninstall; routed terminal VLANs still require their approved CIDRs to be added explicitly.

The client payload is also hardened. Next.js is staged with its standalone production server rather than the complete web project, production browser source maps are disabled, all remaining `.map` files are stripped, backend/web runtime scripts are allowlisted, backend dependencies are pruned with `--omit=dev`, and staging fails if it finds a source map, first-party TypeScript, issuer tooling, or a private-key marker. The backend remains a minified `server.cjs`; the Ed25519 private key and private issuer ledger remain issuer-only. These changes raise the cost of copying the product but are not a promise that offline on-premise software cannot be reverse-engineered by a determined local administrator.

Local verification on 30 August 2026: backend typecheck PASS; backend tests 77/77 PASS; frontend lint and production build PASS; backend package PASS; both Windows service scripts parsed successfully; staged Next standalone `/login` returned HTTP 200; staged bundled-Postgres URL resolution and Prisma 6.19.3 CLI execution PASS; release audit removed 1,512 source maps and reported zero remaining maps and zero first-party `.ts`/`.tsx` files. Inno Setup 6.7.3 compile PASS. ProductVersion is `0.4.1`; size is 183,287,685 bytes (174.80 MiB); SHA-256 is `EC35AF718B59253664A15B76573F06348B19EF063858F01A889D7CC08FDFC745`.

This candidate is not Authenticode-signed and still needs clean-install, reboot, upgrade/reinstall, uninstall/persistence, and physical-terminal verification on disposable Windows and Windows Server 2016 machines before external release.

---

## 0.4.0 — People, attendance, branding, and licensing upgrade

This clean-schema release replaces the active Vendor domain with People (`EMPLOYEE`/`VISITOR`), Company/Department directories, automatic classified registration, permanent Employee device access, paired attendance summaries/reports, organization branding, and persistent 30-day trial plus machine-bound v2 licenses. Release staging now requires the issuer public key and excludes issuer tools.

Local evidence on 29 August 2026: backend tests 75/75, E2E 252/252, fresh migration plus zero-drift comparison, backend/web production builds, backend package, and release staging all passed. The installer executable, disposable-Windows install/reinstall, and physical-terminal matrix remain release gates; see `PEOPLE_UPGRADE_VERIFICATION_GUIDE.md` and `KNOWN_ISSUES.md`.

Release-candidate installer SHA-256: `0CA9DB83BFC6677BA7BE1C092D8F7BFF9ABF35B75F0A2267FD54D20244941EA8`. ProductVersion is `0.4.0`. This candidate is not Authenticode-signed; sign it before external distribution if a code-signing certificate is available.

Windows Server 2016 field verification found one installer defect: on a machine with restrictive inherited ACLs, `VmsPostgres` runs as `NetworkService` but cannot perform the `embedded-postgres` wrapper's `chmod` call on its nested `postgres.exe` and `initdb.exe`. The service then crash-loops with `EPERM`, and the dependent backend remains stopped. Granting Modify permission on those two executables restored all three services. The exact 0.4.0 recovery commands are in `INSTALL_GUIDE.md`; the next installer build must apply and validate those ACLs automatically.

The same field installation confirmed a second packaging gap: 0.4.0 creates no Windows Firewall rule for the selected backend/ADMS port. Local health remained green while the terminal could not check in or appear on the Devices page. The current manual firewall command is in `INSTALL_GUIDE.md`; the next installer must create and remove a scoped rule using the actual installer-selected port.

---

## 0.3.0 — what it adds over 0.2.0

Three commits: `2acdeb1..7e07d2a`.

### The expiry sweeper was broken in 0.2.0 — read this first (`2acdeb1`)

`findExpired` issued `SELECT DISTINCT ... ORDER BY e."retention_expires_at"`
without that column in the select list. Postgres rejects the whole query
(`42P10`), so **`sweepExpiredEntries` threw on every run**.

The device has no native expiry, so that job is the only thing that removes a
lapsed vendor from a terminal. For as long as 0.2.0 has been running at a site,
**no authorization has ever ended**: every vendor provisioned is still loaded,
still able to open the barrier, with nothing anywhere saying so.

**At a site upgrading from 0.2.0, the first sweep after this upgrade will
remove the entire backlog at once.** Expect a burst of `DEPROVISION` commands.
Watch `GET /api/commands?openOnly=true` and the device's own face count
afterwards rather than assuming it drained; `GET /api/devices/drift` is the
fastest read on how far it had gone.

Introduced by `ef72206` (multi-device provisioning added the `DISTINCT`; the
`ORDER BY` predates it), so 0.1.0 is unaffected.

### Device user IDs are text, not numbers (`3564627`)

Terminals in the field hold IDs like `WCTPL070`, `wctpl101` and `ye01` beside
plain numbers. `essl_user_id` becomes `TEXT` on `vendor`, `punch_event` and
`punch_day_summary`; existing values convert unchanged (`10008` → `"10008"`).

**This was losing data before now.** The ATTLOG parser returned `null` for a
non-numeric ID, so every punch by such a user was silently discarded — no row,
no log line. A site whose terminal uses alphanumeric IDs recorded no movements
at all for those people.

IDs are validated as `[A-Za-z0-9]{1,20}` and matched **case-insensitively**
(`wctpl070` and `WCTPL070` are one vendor), while the wire always carries the
casing the device gave us. Photo files use the case-folded name, because NTFS
is case-insensitive where Postgres is not.

### Registration now requires the identifying details (`3564627`)

`name`, `company`, `mobile`, `aadharNumber` and `esslUserId` are **all
mandatory**. Aadhaar is unique and normalised (separators stripped, so one
number cannot become two rows). IDs are **never auto-allocated** any more — the
operator types the one the terminal uses.

Existing vendors keep a null aadhaar; the column is nullable for exactly that
reason, and they can be given one from the vendor page.

### Purpose of visit (`3564627`)

Captured at provision time beside the retention window and entry mode,
required, free text. Appears on the *Authorizations issued*, *Currently
authorized*, *On site now* and *Inside past their window* reports, on the
visitor pass, and on the inside board. Entries are never pruned, so it stays
answerable for any date.

### Adopting a terminal that uses alphanumeric IDs (`3564627`)

A scan can no longer be a blind numeric sweep — six characters of `[0-9A-Z]` is
two billion combinations. It now takes a **prefix and a zero-padded counter**
(`WCTPL001`..`WCTPL999`), or an **explicit list**: pasted, or read from a
**CSV/TXT/XLSX** export of whatever software ran the terminal before. The file
is parsed and shown before anything is queued.

### `VENDOR_PIN_START/END` → per-device vendor ID patterns (`3564627`)

A numeric range cannot describe such a roster. Which IDs on a terminal are
vendors is now `device.vendor_id_patterns` (`WCTPL*`, `YE*`), set on the
Devices page. **Empty means every ID is treated as a vendor**, which is what
every existing install gets and is right for a vendor-only gate.

**On a terminal shared with the client's own employees it must be set.**
Unrestricted, the backend pulls and stores a face photograph for every ID the
terminal mentions — several hundred staff biometrics in a vendor system. See
`docs/DPDP_SHARED_TERMINAL_RISK.md`, written to be handed to whoever owns that
decision.

### Unclaimed photos now expire (`3564627`)

`UNCLAIMED_PHOTO_RETENTION_DAYS`, default **30**. A pulled photo nobody
registers within that window is deleted from disk. Safe in a way nothing else
here is: the device still holds it, so it is re-pullable at any time — this
discards a cache, never the durable artifact. Set to `0` to keep them forever.

### Two-gate visibility (`7e07d2a`)

Both provisioning screens warn when terminals are checking in that were never
registered — an unregistered gate cannot be provisioned onto, which on a
two-gate site leaves a vendor able to enter and not to leave. The vendor page
now lists each terminal's own provisioning state (loaded / waiting / failed)
instead of one entry-level badge covering every roster.

---

## 0.2.0 — what it adds over 0.1.0

Eight commits: `b16ebd3..cb5d4ca`.

### Adopting a terminal that was already in use — the headline change

Two features that only matter together, and that between them close a hole
where a person could have permanent, invisible, unexpiring site access.

**Roster backfill scan** (`9ca473d`, `cb5d4ca`). Installing at a site whose
terminal already holds years of enrollments used to leave those people
undiscoverable — this firmware cannot list its users, so nothing routine ever
learns their PINs. A new per-device operator action scans a PIN range,
asking about each one, and everyone found with a face lands in unclaimed
enrollments ready to register. Paced at 50 queries in flight refilled on a
one-minute tick, because the device takes one command per poll and a bulk
scan would starve live provisioning. Progress survives a restart.

New: `POST /api/devices/:id/scan`, `GET /api/devices/scans`,
`DELETE /api/devices/:id/scan` (all `maintenance:run`), a devices-page
control, and the `DEVICE_SCAN_STARTED` audit action.

**Adoption safety** (`f4d3a37`). Adds `vendor.adopted_from_device`. Without
it, reconciliation would **delete faces the client enrolled themselves**: it
queues a `DEPROVISION` for any vendor on a device with no active entry, and
registering someone from an unclaimed enrollment produces exactly that state.
The trigger was innocuous — any USER record arriving between registration and
provisioning — and the backfill scan above makes such records routine, which
is how the interaction was found. Adopted vendors are now reported and left
alone; provisioning takes ownership and clears the flag.

The vendor page no longer claims these people are "not currently loaded on
any device", which was false in the dangerous direction.

### Ports moved out of the common range (`b16ebd3`)

| | 0.1.0 | 0.2.0 |
|---|---|---|
| Backend / ADMS | 8080 | **47102** (installer-configurable) |
| Web console | — | **47101** (fixed) |
| Bundled Postgres | 5433 | **47103** (fixed) |

8080 collides with almost everything. The backend port is now a question the
installer wizard asks; the other two are fixed, because the web console ships
as a pre-built bundle with no rebuild step available at install time.

**This is the one change that makes upgrading from 0.1.0 hazardous — see
Upgrade notes.**

### Vendor PIN range now defaults to everything (`2029a28`)

`VENDOR_PIN_START`/`VENDOR_PIN_END` default to `1`–`99999999` instead of a
narrow reserved band. Most sites already have vendors on low PINs, and the
old default silently ignored them.

**On a shared terminal this default is wrong** and must be raised above the
client's employee ID range *before* the terminal sees an employee — otherwise
every employee PIN is treated as a vendor PIN.

### Smaller changes

- **Unclaimed enrollments show the device's own name for a PIN** (`f623767`),
  read from `RECONCILE_DRIFT_FOUND` audit detail. The PIN field is locked
  when registering from an unclaimed enrollment — it is the join key to a
  photo already on disk, and editing it would orphan that photo.
- **Vendor avatars** across dashboard, inside board, commands and reports
  (`3982c4b`).
- **"Replace photo" removed** from the vendor page (`62db1c6`).

---

## 0.1.0 — baseline

Phase 6 productization: the Inno Setup installer, bundled Node and
PostgreSQL, three WinSW services (`VmsPostgres`, `VmsBackend`, `VmsWeb`),
the first-run setup wizard, and offline license enforcement. See
`SESSION_HANDOFF_PHASE6.md`.

---

## Upgrade notes

### 0.2.0 → 0.3.0

**Untested as an in-place upgrade — reasoned from the code. Do a trial upgrade
on a copy before running this at a client site.**

**Take a database backup and a copy of `backend\data\photos` first.** Two of
the four migrations are effectively one-way: once a site registers an
alphanumeric ID, `essl_user_id` cannot go back to an integer.

1. **The expiry backlog.** See the 0.3.0 notes above — the first sweep after
   the upgrade removes every vendor whose window lapsed while 0.2.0 was
   failing to sweep. This is correct behaviour finally happening, but it is a
   burst, and somebody should watch it.
2. **Unclaimed photos older than 30 days are deleted** on the first nightly
   retention run. Re-pullable from the device, but set
   `UNCLAIMED_PHOTO_RETENTION_DAYS=0` in `backend\.env` before starting the
   services if the site wants them kept.
3. **`VENDOR_PIN_START`/`VENDOR_PIN_END` in an existing `.env` are now
   ignored** (unknown keys are dropped, not rejected — the backend starts
   normally). If that terminal is shared with employees, set the device's
   vendor ID patterns on the Devices page **before** the first employee
   enrolls, or their photograph is pulled.
4. **Registration is stricter.** Any integration posting to `POST /api/vendors`
   without `company`, `mobile`, `aadharNumber` or `esslUserId` now gets a
   `400`, and provisioning without `purposeOfVisit` does too.
5. **Verify the ID column actually converted:**
   `SELECT pg_typeof(essl_user_id) FROM vendor LIMIT 1;` should say `text`.

### 0.1.0 → 0.2.0: check `DATABASE_URL` before declaring success

**Untested — reasoned from the code, not from a trial upgrade. Do a trial
upgrade before running this at a client site.**

`first-run-env.mjs` deliberately preserves an existing `.env`. It rewrites
`DATABASE_URL` **only** when that value is missing or still the example
placeholder (`first-run-env.mjs:120-127`). An existing 0.1.0 install has a
real value pointing at the old bundled Postgres port — so after upgrading:

- 0.2.0's bundled Postgres starts on **47103**
- `.env` still says **5433** (or `5432`, if it came from 0.1.0's
  `.env.example`, which disagreed with its own default)
- the backend points at a port where nothing is listening

**Worse on a machine that already runs its own PostgreSQL:** a stale
`DATABASE_URL` of `5432` will *connect* — to an unrelated database. Verify
the port, do not just check that the service started.

The fix is to edit `DATABASE_URL`'s port to `47103`. The cluster's data
directory is unchanged, so no data moves; only the listen port differs.

`PORT`/`ADMS_PORT` are safe — the installer passes `--backend-port`
explicitly, which does overwrite them. **If the backend port changes, the
terminal's Cloud Server setting must be updated to match**, or the device
goes quiet with no error anywhere.

### Migrations apply themselves

`bundled-postgres.mjs` runs `prisma migrate deploy` on service start
(`bundled-postgres.mjs:157`), so `20260811090000_vendor_adopted_from_device`
is applied automatically. No manual step at the client site.

### `adopted_from_device` is not retroactive

Existing vendors default to `false`, including any already registered from an
unclaimed enrollment. They keep the old behaviour: reconciliation may still
remove them from the device, and their vendor page will not warn. Provision
them — which they need regardless — or set the flag by hand for the ones that
apply.

---

## Cutting a release

Run the whole chain **on Windows**. `node_modules` holds native Windows
binaries (esbuild, Prisma engines); under WSL `npm test` and `tsx` fail
outright, and the staged payload would carry the wrong platform's binaries.

```
1. cd backend && npm test && npm run verify:e2e   # see the note below
2. bump AppVersion in installer/vms-installer.iss
3. cd backend && npx prisma generate      # SEPARATE from the bundle - see below
4. cd backend && npm run package          # dist-package/server.cjs
5. cd web     && npm run build            # .next
6. node installer/build-release.mjs       # stages installer/release/
7. "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer/vms-installer.iss
```

**Step 1 is not optional, and it is first for a reason.** 0.2.0 shipped with
its expiry sweeper throwing on every run — the only thing that removes a lapsed
vendor from a terminal, dead for the life of the release. `verify:e2e` catches
it in two minutes and was not run before that release was cut. It needs a
database whose name ends in `_test`:

```
psql -U postgres -c "CREATE DATABASE vms_test OWNER vms_app"
$env:DATABASE_URL="postgresql://vms_app:...@localhost:5432/vms_test"
$env:PHOTO_STORAGE_PATH="./data/photos-e2e"    # never the real photo directory
npx prisma migrate deploy
npm run verify:e2e
```

Step 7 takes about **12 minutes** (670 s for 0.2.0, 726 s for 0.3.0) — LZMA2
solid compression over both `node_modules` trees. Output:
`installer/Output/vms-setup.exe`.

**Delete any `vms-setup-test.exe` left in that folder** before handing anything
over. A test build is bigger than the real installer and sits right next to it.

Before compiling, confirm the payload actually picked up what you think it
did. Staging is a file copy and will happily ship a stale build:

```
ls  installer/release/backend/prisma/migrations/   # newest migration present?
grep -c <newField> installer/release/backend/node_modules/.prisma/client/index.d.ts
```

The second one matters more than it looks: `prisma generate` is a separate
step from `npm run package`, and a schema change without it produces a client
that compiles locally and fails at runtime on the client machine. That is why
it is its own numbered step above.

Finally, check the artifact itself rather than trusting the build log —
right-click → Properties → Details, or:

```powershell
(Get-Item installer\Outputms-setup.exe).VersionInfo.ProductVersion
```

Then record the row in the register above — version, date, **commit hash**,
size — and commit that change. A release whose commit is not written down is
a release nobody can reproduce.

### Test builds

```
iscc /DTestBuild /DSourceDir=release-test /DAppDirName=VMS-test ^
     /DOutputBaseFilename=vms-setup-test vms-installer.iss
```

Separate `AppId`, separate install path, faster (zip, non-solid) compression.
Never leave a stale `vms-setup-test.exe` next to a real build — it is bigger
than the real one and trivially grabbed by mistake.

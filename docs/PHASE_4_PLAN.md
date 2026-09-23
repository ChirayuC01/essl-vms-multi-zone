# Phase 4 — Authorization workflow, RBAC, reporting

> **Historical record — do not read as current behaviour.** This documents what was decided and verified during this phase, at the time. Where it disagrees with `CLAUDE.md`, `docs/API_REFERENCE.md` or `docs/VERSIONS.md`, those are current and this is not. (Most likely divergence: device user IDs are **text** since 0.3.0, and the `VENDOR_PIN_START`/`VENDOR_PIN_END` range described here no longer exists.)


**PHASE 4 IS COMPLETE (6 Aug 2026).** Milestones 17–22; M19 closed without
code by decision. 239 e2e checks, 50 unit tests.

Phases 1–3 built a system that works and keeps itself honest. Phase 4 decides
**who is allowed to operate it**, and makes what it has recorded readable by
someone who is not going to run a SQL query.

This is the last build phase before a client sees the product (Phase 5 is the
supervised pilot, Phase 6 is packaging).

---

## Two security gaps that exist right now

Found while planning, and both are real rather than theoretical:

**1. Roles are decorative.** `AppUser.role` exists (`ADMIN`,
`AUTHORIZED_PERSON`), it is carried on the JWT, and it is displayed in the UI
header — but **nothing checks it**. Every authenticated operator can do
everything: reconfigure a device's gate role, run retention (which deletes
rows), de-provision anyone. There is one guard, `requireAuth`, and it asks
only "is this a valid token".

**2. Deactivating an operator does not lock them out.** `requireAuth` verifies
the JWT signature and nothing else — it never touches the database. Setting
`is_active = false` has no effect until the token expires, up to **12 hours**
later. For a system whose entire job is controlling who gets through a door,
"we removed their access and they kept working" is not a defensible answer.

Both are Milestone 17, and neither needs a client decision to fix.

---

## Milestone 17 — Make roles real, and make revocation immediate ✅

**Done 5 Aug 2026.** `backend/src/api/permissions.ts`. 172 e2e checks, 46 unit tests.

All 35 operator routes now declare a permission — verified by grep, because a route that quietly has no guard is the one failure this milestone could not tolerate. Both security gaps are closed: a disabled account's existing token dies on the next request, and a role change applies in either direction without re-login.

- A `requireRole(...)` guard, applied per route rather than globally, so
  adding a route means deciding who may call it.
- **Revocation that actually revokes.** The cheapest correct fix is to check
  the operator's `is_active` (and current role) on each authenticated request
  — one indexed lookup, on the operator API only, never on the device path
  where the query budget matters. A token then stops working the moment the
  account is disabled, and a role change takes effect immediately rather than
  at next login.
- Every refusal audited. "Who tried to do what they were not allowed to" is
  exactly the question this log should answer.

### The permission model, and why it is worth building before it is needed

RBAC is not a current requirement — there are two roles and one operator. It
is built now because the expensive part of RBAC is never the roles; it is
retrofitting checks onto forty routes written assuming everyone is allowed
everything. Done later, it means touching every handler.

**Permissions, not roles, at the call site.** Routes declare what they require
(`vendor:provision`, `device:configure`), and one table maps roles to
permissions. Adding a role later is an entry in that table and nothing else.
Scattering `if (role === 'ADMIN')` through handlers is what makes RBAC
expensive to change — the same reasoning as CLAUDE.md #2 on client-specific
conditionals.

Proposed split, chosen so the daily job is unobstructed while the
configuration-changing and destructive actions are not:

| Permission | ADMIN | AUTHORIZED_PERSON |
|---|:--:|:--:|
| View everything — vendors, entries, punches, board, reports | ✓ | ✓ |
| Register / edit vendors, upload photos | ✓ | ✓ |
| Provision, block, unblock, de-provision | ✓ | ✓ |
| Query a vendor on the device | ✓ | ✓ |
| Deactivate a vendor | ✓ | ✓ |
| **Configure a device** (gate role, status-code maps, duplicate window) | ✓ | — |
| **Run maintenance** (retention, reconcile sweep, punch baseline) | ✓ | — |
| **Manage operators** | ✓ | — |
| **View the audit log** | ✓ | — |

The line is *"does this change how the system behaves, or only what it
holds"*. An authorized person does the whole barrier job including
de-provisioning, which is routine and reversible. They do not silently change
a gate's direction mapping or delete rows, because those are invisible from
the daily screens and hard to notice going wrong.

Audit-log access sits with ADMIN because it records other operators' actions,
and an operator who can read their colleagues' activity is a different product
from one who cannot. Easy to widen later if the client disagrees; hard to
un-share.

## Milestone 18 — Operator management ✅

**Done 5 Aug 2026.** `backend/src/api/operators.ts`, `web/.../operators`, `web/.../change-password`. 195 e2e checks, 46 unit tests.

The forced-change gate is enforced **in `requireAuth`, not the UI**: while it is set, only `/auth/me` and `/auth/change-password` are reachable. A client that skipped the change screen would otherwise hold a fully working session on a password somebody else chose.

Self-lockout is refused rather than warned about — an admin who disables or demotes themselves on an on-premise install recovers by editing the database. The last-admin guard behind it is unreachable through the API today (only ADMIN holds `operator:manage`, and self-targeting is caught first) and is kept as the backstop for the day that changes.

The seeded `admin@vms.local` now starts with `mustChangePassword` on new installs. A password published in `seed.ts` is not a credential, and "change it before deployment" in a README is a hope rather than a control.

The UI hides what a role cannot use — nav entries and per-row actions — while the API enforces the same rules independently. Hiding a button is courtesy; treating it as security is how client-side checks quietly become load-bearing.

Create, deactivate and re-activate operators; assign roles; change passwords.

**No email on-premise.** Many sites have no outbound internet at all
(PRD open question 7), so a reset link is not available. An admin sets a
temporary password that the operator must change at next login — which needs
a `must_change_password` flag and a forced-change screen.

Deactivation is never deletion: `app_user` is referenced by `audit_log.actor`
and `sync_command.initiated_by`, and removing an operator would orphan the
record of what they authorized.

## Milestone 19 — Authorization workflow — NOT BUILT (decided 5 Aug 2026)

**Decision: no approval step.** An authorized person provisions directly, as
today. The PRD's "full pre-notification UX" is not what this client does.

So this milestone is closed without code, which is the point of asking. A
request → approve queue would have been the largest single piece of work in
the phase, and it would have sat unused.

`entry.expected_in_at` stays as an informational field; `entry.authorized_by`
already records who made the call, which is the part that actually matters for
the audit trail. Nothing is lost if a future client does want approval — the
columns are there.

## Milestone 20 — Reporting ✅

**Done 6 Aug 2026.** `backend/src/reports/registry.ts`, `web/.../reports`,
`web/.../pass/[entryId]`. **208 e2e checks, 50 unit tests.**

Twenty reports behind two routes, driven by a registry: a report is a
definition, so the twenty-first costs the same as the first and appears in the
UI with no frontend change. Every one is paginated and exports to CSV.

**Movement reports read summaries as well as raw punches, and ADD them.**
Retention deletes raw rows after the window, so anything reading only
`punch_event` would work today and silently return nothing for last year — the
failure surfacing long after the change that caused it. A retention batch can
also summarise half a day and leave the rest raw, so preferring either source
would undercount. Both cases are asserted.

**CSV formula injection, and the fix for the fix.** A cell beginning `=` or `@`
executes when a spreadsheet opens it. The first version escaped `+` and `-`
too — and turned every phone number in the vendor register into
`'+919325474337`, visible in the cell. A dangerous payload needs a function
name after the sign, so those are now escaped only when a letter follows.
Found by running the export rather than by reading the code.

**The returning-visitor flow** (added 6 Aug 2026, on request). A permanent
**vendor card** at `/vendors/:id/card` carries the registration and the PIN in
large type; a **quick-provision** screen at `/provision` takes that PIN, shows
the stored photo large, and provisions on one confirm. Backed by
`GET /api/vendors/by-pin/:pin` — an exact lookup rather than the fuzzy search,
which also matches mobile numbers containing the digits and could therefore
return several people for a spoken PIN.

The security shape matters more than the convenience: **the PIN is a lookup
key, not a credential.** Anyone can say a number. What authorizes the visit is
the operator comparing the stored photo with the person in front of them,
which is why the photo is the largest thing on the screen and the confirm sits
beneath it. A flow where the PIN alone triggered provisioning would turn a
spoken number into site access. Both printed artifacts say on their face that
they do not grant entry.

**The visitor pass is an identity artifact, not a credential**, and says so on
its face: the barrier opens on a face match and nothing else. No QR — this
firmware reports no QR support, so a code would be decoration inviting someone
to scan it. Plain HTML with a print stylesheet, because a gate office has a
browser and a printer and nothing else.

Two reports from the catalogue were **not** built, and deliberately: *device
availability* and *capacity trend* need a history table nothing writes today,
so they would begin from the day that table exists rather than answering about
the past. Promising them now would mean shipping an empty chart.

`punch_day_summary` (M14) means reporting survives retention: raw punches are
pruned but who was on site on a given day is not. **Every report below is
answerable from data already being recorded** — none need new capture.

Every report: paginated table in the UI, CSV export, date-range filter.

### Movement and presence

| Report | Answers | Source |
|---|---|---|
| **Daily movement log** | who entered and left, with times, per day | `punch_event` + summaries |
| **On site now** | who is inside this minute | `entry.state = INSIDE` |
| **On site on a date** | who was present on any past day | `punch_day_summary` |
| **Time on site** | duration per visit; totals per vendor or company | in/out pairs |
| **Peak occupancy** | how many people inside, by hour or day | punch history |
| **First in / last out** | earliest arrival and latest departure per day | summaries |

### Vendors and authorizations

| Report | Answers | Source |
|---|---|---|
| **Vendor register** | every registered vendor, company, PIN, photo status | `vendor` |
| **Vendor history** | every visit by one vendor, ever | `entry` + punches |
| **Authorizations issued** | who authorized whom, when, how long, which mode | `entry.authorized_by` |
| **Active authorizations** | who is currently loaded on a device | `entry` |
| **Expiring soon** | windows closing in the next N hours | `retention_expires_at` |
| **Never visited** | vendors provisioned who never punched | `entry` + punches |
| **Frequent visitors** | visit counts per vendor or company | summaries |

### Exceptions — the ones worth reading weekly

| Report | Answers |
|---|---|
| **Overdue inside** | windows that closed while the vendor was still on site |
| **Never punched out** | visits with an IN and no OUT |
| **Single-entry blocks** | who was day-blocked, and when they were released |
| **Reconciliation events** | drift found and self-healed, per device |
| **Punch gaps** | records the device logged that never reached the server |
| **Direction conflicts** | punches whose status code contradicted their gate |

### Operations

| Report | Answers |
|---|---|
| **Command history** | every device write, with outcome and turnaround |
| **Failed commands** | changes that never reached a terminal |
| **Device availability** | offline periods |
| **Capacity trend** | faces used against capacity over time |
| **Audit trail** | every operator action (ADMIN only) |
| **Retention activity** | what has been summarised and pruned — a DPDP answer |

> **Two gaps worth stating.** *Device availability* and *capacity trend* need a
> history table nothing writes today — only current values are stored, so these
> begin from the day that table exists. And **denied entries can never be
> reported**: the terminal does not push them (`VMS_PROJECT_CONTEXT.md` §4). A
> blocked vendor's attempt leaves no trace anywhere, and no report can invent
> one.

### Visitor pass

A printable pass: photo, name, company, PIN, validity window, issuing operator,
issue time. Print-friendly HTML, so it works on any printer without extra
software.

**It is an identity artifact, not a credential.** The face is the credential —
the barrier opens on a face match and nothing else. A pass that looked like it
granted entry would be actively misleading, so it carries the validity window
and states that access is by face recognition. Worth being precise about,
because a laminated card with a photo *looks* like an access badge.

No QR or barcode: `INFO` reports no QR support on this firmware
(`IsSupportQRcode` came back empty), so a code would be decoration that invites
someone to try scanning it at the gate.

## Milestone 21 — Audit log UI ✅

**Done 6 Aug 2026.** 225 e2e checks, 50 unit tests.

The M20 *Audit trail* report already gave a paginated, exportable, date-filtered
view, so a second screen showing the same rows would have been duplicated work.
What was missing was narrowing it and asking it about one vendor.

**Actor and action filters**, populated from `GET /reports/meta/audit-facets` —
read out of the log rather than hardcoded, so an action that has never happened
is not offered and a new one appears the first time it occurs.

`actorId=system` matches a **NULL** actor. A scheduled job has nobody behind
it, so treating "system" as an id would have silently returned nothing for the
one thing most worth isolating: what ran unattended.

**`GET /api/vendors/:id/audit`**, rendered on the vendor page, answers "what
happened to this person and who did it" where the question is actually asked.
It spans the vendor row **and every entry belonging to them** — a provision,
block or de-provision is recorded against the entry, so filtering on
`entity_id` alone would have shown registration and nothing else, the least
interesting half of the story.

ADMIN only, per endpoint rather than only on the reports page, matching the
Milestone 17 decision that audit access is a product question settled once.

One test needed correcting rather than the code: it asserted `VENDOR_CREATED`
survived for the section-2 vendor, but an earlier section clears the audit log
— it was testing the harness's housekeeping. It now registers a vendor in place
and checks that one.

## Milestone 22 — Verification ✅

**Done 6 Aug 2026.** `verify:e2e` §24. **239 checks, 50 unit tests.**

Phase 4 added an auth layer across routes that already existed, so the seams
worth testing are where that layer meets everything built before it.

**A real gap found, and it is the one this milestone existed for.** Every
route re-reads the operator on each request, so disabling someone locks them
out on their next click — but **SSE is authorised once, at connect, and then
lives for hours.** A revoked operator kept receiving punches, entry
transitions and command outcomes until they happened to close the tab.
"Revocation is immediate" was true of short requests and false of the one
connection that stays open.

The stream's heartbeat already fired every 25 seconds, so it now re-checks the
account there and closes with a `revoked` event. Verified against a live
stream rather than by request: the account was disabled mid-connection and
`curl` exited, which proves the socket closed rather than merely being written
to.

The event stream also had no declared permission — only `requireAuth`. It
worked because both roles hold `read`, which is exactly the kind of accident
that stops working silently when a third role appears.

**Also covered:** `/iclock/*` stays unauthenticated after guards were added to
35 routes (breaking that takes the barrier down for everyone); a scheduled job
runs with no operator and no permission, and its commands are attributed to
nobody deliberately; an operator can read what a job did without being able to
run one; a permission denial recorded against an operator does not prevent
deactivating them later; and a forced password change leaves no usable session
on any route, including the stream.

One assertion was corrected rather than the code: it counted an operator's
refusals as a total, which broke as soon as the same block provoked a second
one. It now checks *which* permissions were refused.

---

## Phase 4 is complete

Milestones 17–22. `npm run verify:e2e` covers **239 checks**, `npm test`
**50 unit tests**; the web build and ESLint are clean.

M19 was closed without code by decision — there is no approval step, so a
request-approve queue would have been the largest piece of work in the phase
and would have sat unused.

---

## Decisions taken (5 Aug 2026)

1. **No approval step.** Authorized persons provision directly. M19 closed
   without code.
2. **RBAC is scaffolding, not a current requirement.** Build the framework so
   a future role costs a table entry rather than a rewrite — see the design
   above. The two security fixes in M17 are needed regardless of how many
   roles exist.
3. **Reports:** paginated tables and CSV are the priority; a visitor pass is
   wanted if feasible. Full catalogue below.

## Carried forward

- Device user **enumeration** — would give reconciliation a fast exact path.
- **Group 100** on a factory-fresh unit; **denied attempts** retrievable —
  both need the second device.
- `MainTime=1970-01-01` in `INFO`, unexplained.
- Remote-database check, deferred by decision (Phase 1).

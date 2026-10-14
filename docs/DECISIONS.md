# Decisions

One row per decision. Newest last. "Owner" is the product owner; "Client" is
the first two-zone site. Decisions from the 0.4.x product that still hold are
carried at the top; their full history is in `legacy/`.

## Carried forward from the 0.4.x product

| Decision | Why | Source |
|---|---|---|
| Path A: speak raw ADMS directly; no eSSL middleware | Proven end to end on hardware; no licence or Windows/IIS dependency | `legacy/VMS_PROJECT_CONTEXT.md` §8 |
| The photo is the durable artefact; templates are a same-device cache | Templates are algorithm-bound; a pushed photo regenerates a working template | Phase 0 |
| Block by `Grp` swap; group IDs per device | Observed eTimeTrackLite's behaviour; `TZ` is ignored | Phase 0 |
| Expiry and reconciliation are security controls | Terminal stores but ignores `EndDatetime` | Phase 0 |
| Device user IDs are text, case-insensitive, case-preserving | Real rosters hold `WCTPL070`, `ye01` | 0.3.0 |
| Separate non-overlapping Employee / Visitor ID patterns; unmatched IDs untouched | One owner per roster; bounded biometric collection on shared terminals | 0.4.4 |
| Employees have permanent desired access (`EmployeeDeviceAccess`), not Entries | Different lifecycle from visitors | 0.4.0 |
| Offline, installation-bound licensing; expiry blocks operator API only | A licence lapse must never strand anyone at a barrier | 0.4.x |
| Windows installer (Inno Setup) + WinSW services; no Tauri | Backend must run unattended 24/7 | Phase 6 |
| Photos normalised to 480×640 portrait JPEG before upload | `PUSH_PHOTO` `Return=-1001` for raw webcam frames | 0.4.19 |

## Two-zone rebuild

| Date | Decision | Why / detail | Source |
|---|---|---|---|
| 2026-09-15 | Visitor uploads a selfie during pre-registration; it becomes the enrolment photo | Removes gate capture for planned visitors | Owner |
| 2026-09-15 | Host reviews pre-registration: Clear / Query (mandatory text, new link) / Reject | Replaces gate verification | Owner |
| 2026-09-23 | Live selfie with a face guide; Security can retake at the gate | Selfie quality is the main recognition risk | Client (via owner) |
| 2026-09-23 | SMS via MSG91, email via SMTP/nodemailer — **not yet confirmed**; build against a local outbox now | Unblocks development | Owner |
| 2026-09-23 | Entry face loads **5 min** before the expected time | Client preference (draft said 30) | Owner |
| 2026-09-23 | Walk-ins need the host's Clear first; switchable later to immediate load | Client undecided; safer default | Owner |
| 2026-09-23 | Keep full audit history of every request, including queries (with text) and rejections | Accountability | Owner |
| 2026-09-23 | Visitors may upload documents (Govt ID, vehicle, etc.); all optional, formats/sizes pending client | Reverses draft's "no ID image kept" | Owner |
| 2026-09-23 | Hosts are operators (`AppUser`); roles Host, Security, Security In-charge, HR, HOD | — | Owner |
| 2026-09-23 | Required fields vary **per visitor/pass type**, not per department | Customs needs only name + designation | Owner |
| 2026-09-23 | 4 terminals: Outer IN/OUT (premise/office zone) and Yard IN/OUT; yard access implies office | Site topology | Client |
| 2026-09-23 | Employees also use these gates | — | Client |
| 2026-09-23 | Sub-contractor approval happens outside the system | — | Client |
| 2026-09-23 | Removal from an IN terminal 10 min after **that terminal's** punch, single entry only; multi entry keeps entry faces until the pass ends | Per-terminal, so a yard visitor isn't locked out of Yard IN | Owner |
| 2026-09-23 | A no-show's face stays until the pass ends | — | Owner |
| 2026-09-23 | Visitor portal published from the local server through a Cloudflare Tunnel; only portal routes exposed | Phone camera needs HTTPS on a public address; avoids opening inbound ports | Owner |
| 2026-09-23 | DPDP notice must be shown and accepted before collection; client supplies wording; consent time and notice version recorded; masked Aadhaar suggested | DPDP Act 2023 | Owner |
| 2026-09-23 | Returning visitors matched by OTP-verified mobile number | Verified at every request | Owner |
| 2026-09-23 | Long-term holders' exit code goes to the Security desk | No host to release them | Owner |
| 2026-09-23 | Legacy docs moved to `docs/legacy/`; new docs import still-true knowledge; CLAUDE.md and AGENTS.md rewritten | Clean tracking for the rebuild | Owner |
| 2026-09-23 | **Exit code applies to single entry only; multi entry has no exit code** | Supersedes "every exit needs a fresh OTP" | Client |
| 2026-09-23 | **Which exits need the code is chosen per pass**: office exit by default, yard exit optional | Supersedes "OTP loads both OUT terminals" | Client |
| 2026-09-23 | **Outage: site releases people with the terminal admin card and a manual register; when the system returns, outage-affected passes are released automatically and recorded** | Supersedes "no physical override". Amends hard rule #9 | Client |
| 2026-09-23 | **Saved ID numbers are only displayed redacted** (first 2 + last 2 characters, e.g. `CI******7b`) | Privacy; full value kept server-side for uniqueness/matching | Client |
| 2026-10-02 | Rebuild delivered phase by phase, stopping after each for owner verification | Owner's delivery rule | Owner |
| 2026-10-02 | Admin card holder's terminal ID must match neither ID pattern | Keeps the VMS from managing or deleting it | Plan |
| 2026-10-02 | Pass types, zones and their exit-code defaults are configuration/seed data; no site-specific strings in code | Hard rules #1–2 | Plan |
| 2026-10-02 | Zone management uses the existing `device:configure` permission | Topology is gate configuration; no new permission needed | Phase 1 |
| 2026-10-02 | Hosts get **no** site-wide read; only their own requests (Phase 6) | Least privilege: a host has no reason to browse every person, punch and report | Phase 2 |
| 2026-10-02 | HR and HOD are read-only until the client confirms their duties | Their approvals happen outside the system | Phase 2 |
| 2026-10-02 | Security in-charge = Security + blacklist + audit trail | Blacklist authority proposed to the client as Security In-charge only | Phase 2 |
| 2026-10-02 | Settings live in one `app_config` row, each field with its own default; a corrupt field falls back alone | New settings appear on upgrade without a migration | Phase 2 |
| 2026-10-02 | **Access becomes configurable (Phase 2b): Admin-defined custom roles; a feature × action (View/Create/Update/Delete) grid per role; per-user overrides that can allow or deny** | Owner wants role defaults and user-specific access changeable without code, like their existing product | Owner |
| 2026-10-02 | Admin system role is always full and cannot be edited or overridden; a save that leaves nobody able to manage access is refused | Prevents locking the site out | Plan |
| 2026-10-02 | "Delete" in the access grid means deactivate / remove from terminals, never data deletion; record-ownership rules (e.g. host sees only own requests) stay in code | Hard rule #3; a grid cannot express which records | Plan |
| 2026-10-02 | Operators reference roles by an immutable key; a custom role's key is generated from its first name and never changes | Renaming a role is then free and nothing referencing it breaks | Phase 2b |
| 2026-10-02 | Effective access is cached per user+role and cleared on every grid/override/operator change | Avoids extra round trips per request on a remote DB (rule #4) while revocation still lands on the next request | Phase 2b |
| 2026-10-05 | **Settings are Administrator-only by default** (no seeded role gets System settings: View); grantable per role from the Access page | Owner | Owner |
| 2026-10-05 | No pass types are pre-seeded; a site's types are created by its Admin (recommended set for the first site documented in PRODUCT.md §4) | Hard rules #1–2: site-specific categories are configuration | Phase 3 |
| 2026-10-05 | A person may carry a pass type ("visitor type"); employees and untyped visitors keep the long-standing rule (mobile, company, department, Aadhaar or PAN) | Nothing changes for existing people | Phase 3 |
| 2026-10-05 | "Details complete" is stored on the person and recomputed on every write that can change it (profile save, directory bulk assign, pass-type rule change), in batches | Keeps the needs-details list one indexed filter whatever the rules; no per-row loops (rule #4) | Phase 3 |
| 2026-10-05 | Masking happens in the single person DTO; a masked value sent back is treated as "unchanged" | One place to get right; edit forms never need the real number | Phase 3 |
| 2026-10-05 | People-transfer export reads full identity numbers directly from the database (`--database-url`); no API path returns them | Keeps rule #12 absolute while a backup stays re-importable | Phase 3 |
| 2026-10-05 | Document type is detected from the file's bytes; downloads are always attachments with nosniff and a sandbox CSP; removal hides but keeps; per-person count limit until visit requests exist (Phase 6); size cap ≤ 20 MB (the server's request limit) | An uploaded HTML page or program must never run in an operator's browser | Phase 3 |
| 2026-10-05 | Govt ID numbers are not unique (unlike Aadhaar/PAN) | Different ID types can share a number; uniqueness would cause false conflicts | Phase 3 |
| 2026-10-05 | One `pass_gate` row per (pass, terminal) is the only truth for "should this face be here now"; a one-minute engine tick loads/removes in batches; acks advance rows | Per-terminal rules (5 min before, 10 min after use, code-gated exits) need per-terminal state; batched for remote DBs (rule #4) | Phase 4 |
| 2026-10-05 | An entry IS the pass (extended in place): validity = expectedInAt … retentionExpiresAt; host = personToMeet | No parallel table; every earlier entry stays valid | Phase 4 |
| 2026-10-05 | **A single-entry pass lasts one day**; multi-day passes are multi entry | Removing a face after use would lock a multi-day single-entry holder out after day one | Phase 4 |
| 2026-10-05 | The SINGLE_ENTRY day-block and daily reset are retired; on a two-way terminal single entry removes the face 10 min after the OUT punch | One mechanism instead of two | Phase 4 |
| 2026-10-05 | The device-list (no zones) way of issuing a pass is kept and runs through the same engine | Single-entrance sites keep working; no second code path for loading | Phase 4 |
| 2026-10-05 | A pass shows as provisioned only when no due terminal is still loading | Never report "loaded" while an exit hasn't got the face (trap risk) | Phase 4 |
| 2026-10-05 | A pass ending while the holder is inside: entry terminals cleared, already-loaded exit kept, holder listed as overstayed; walking out closes the pass | Rule #9: never strand anyone | Phase 4 |
| 2026-10-05 | Blacklist (visitors only) ends every pass now and goes through the same pass-end path | Outside: removed everywhere at once; inside: keeps the exit they need | Phase 4 |
| 2026-10-05 | Reconciliation judges per terminal using gate state | A used single-entry gate must be cleared even while the pass is active | Phase 4 |
| 2026-10-05 | Zone widening and the exit override are not yet limited to the visitor's own host | Ownership arrives with visit requests (Phase 6) | Phase 4 |
| 2026-10-08 | The tunnel is set up from the Cloudflare dashboard (connector installed with `cloudflared service install <token>`) with a **path filter** `^/(v/\|_next/\|public-api/)` to the web port; everything else gets Cloudflare's 404 | Simplest for site staff; the console, backend and `/iclock` are never published | Phase 9 |
| 2026-10-11 | Each client has **its own Cloudflare account, in its name**, with us invited as a member; a fixed domain on Cloudflare is required in production (quick tunnels are test-only). Hosting on our own account and domain (one tunnel per client) only by exception, with a processor contract | Visitor data passes through the tunnel (DPDP: the client is the fiduciary); visitors trust the client's domain; the client stays independent of us; SMS DLT URL whitelisting needs a fixed domain | Owner |
| 2026-10-11 | Defence in depth: the web app itself answers **404** to any request that came through Cloudflare (`CF-Connecting-IP` present) unless it is a portal path (`/v/`, `/_next/`, `/public-api/`) — `web/src/proxy.ts` | The owner's check through a quick tunnel showed the console pages reachable (a quick tunnel has no path filter); the console must never depend on a dashboard setting being right | Owner test |
| 2026-10-08 | Portal hardening: the web proxy refuses any path segment that could leave `/public-api`; portal pages and API send `no-referrer`, no-store, anti-framing, `noindex` and a camera-only permissions policy | Link tokens live in URLs; the proxy is the only way in from the internet | Phase 9 |
| 2026-10-08 | `PUBLIC_PORTAL_URL` defaults to the installed console (`http://localhost:47101`); development sets 48101 in its own `.env` | An upgraded site works before its tunnel exists | Phase 9 |
| 2026-10-08 | The 0.5.0 installer is built by the owner (needs the production licence public key) and only after the upgrade acceptance passes on a disposable machine | Every past upgrade note said "untested"; this one must be tested | Phase 9 |
| 2026-10-08 | Each new report follows the access cell of what it shows (exit overrides and blacklist → `audit:view`; outages → `outages:view`; messages → `messages:view`; visits → `reports:view`; presence → `onsite:view`) | One grid governs screens and reports alike | Phase 8 |
| 2026-10-08 | The "Messages sent" report never includes message text | With the console transport the text holds live codes and links | Phase 8 |
| 2026-10-08 | Audit coverage is enforced two ways: a unit test that fails if any route lacks a permission (named exceptions with reasons), and an e2e check that every successful state-changing call in the run wrote an audit row (named no-change exceptions) | A rule nobody checks erodes; both found real gaps on first run (device settings, retention runs) | Phase 8 |
| 2026-10-08 | Exit code: issued on the holder's **first IN punch** (single entry with a code-gated exit only). The host gets it by SMS + email; the visitor gets an out-pass link (`/v/out/<link>`). Valid until the pass ends + 12 h; wrong tries limited by the OTP setting; a new code (console) replaces the old | Matches the client flow; the grace keeps an overstayer from being locked behind a dead code | Phase 7 |
| 2026-10-08 | A pass with no host (long-term, Security-issued) has its code **issued at the Security desk** on demand ("Issue exit code", shown once), not sent to a role by SMS | Plaintext codes are never stored, and "send to Security In-charge" would mean special-casing a role in code | Phase 7 |
| 2026-10-08 | The host may issue a new code for their own visitor from the request page; Security for any pass. The code is shown once on screen | Covers a lost SMS without storing codes | Phase 7 |
| 2026-10-08 | Out-pass links belong to the pass (`link_token.entry_id`); the public page shows only the visitor's first name | A long-term pass has no visit request; nothing personal on a forwarded link | Phase 7 |
| 2026-10-08 | Outage = a gap in the engine's minute heartbeat longer than `outageGapMinutes`. On recovery every **single-entry pass marked inside** that was live during the gap is released (off all terminals, closed) and linked to the outage; multi-entry passes are untouched. Listed on a new **Outages** page (`outages:view`, seeded to Security and Security In-charge) | Client, 23 Sep: admin-card release during the outage, automatic release on recovery, reconciled against the manual register | Client |
| 2026-10-08 | Confirmed: a **planned** request needs the host's Clear only if its visitor type's "Requires host Clear" is on; otherwise it is issued on submit. The request history names which rule applied (visitor type, or the walk-in site setting) | Owner: "depends on the pass type's setting" | Owner |
| 2026-10-08 | **Visitors no longer enter a company.** The host (or Security for a walk-in) picks it from the Directory on the request, or at Clear; nothing creates companies automatically. *Supersedes the 2026-10-06 "matched or added" rule.* | Free text created duplicates ("Test-Company" vs "Test Company") that split reports; a visitor can't know the directory's spelling | Owner |
| 2026-10-08 | Deciding another host's request is a grid cell, "Decide any host's visit requests" (`visit_requests_all:update`). The Administrator holds it (holds every cell); other roles get it only if an Admin grants it. *Amends the 2026-10-06 host-only rule.* | Admin must be able to clear any request; done as configuration, not a role check | Owner |
| 2026-10-08 | Development with numeric-only terminals uses a digit visitor prefix (`9` → `900001`, terminal pattern `9*`); client sites keep `V`. The prefix is 1–8 characters and never starts with 0 | The owner's test terminal accepts only numeric IDs; the client's accept alphanumeric. Configuration, not code; a leading 0 would be dropped by a numeric terminal | Owner |
| 2026-10-06 | Only the host named on a request can Clear, Query or Reject it | The decision is the host's; other operators may view but not decide | Phase 6 |
| 2026-10-06 | A host Clear is needed when the visitor type requires one; for a walk-in, additionally only while "walk-in requires host Clear" is on. Otherwise the pass is issued on submit; if that fails, the request waits for the host | Both toggles are configuration, no special cases | Phase 6 |
| 2026-10-06 | New visitors get `<visitorIdPrefix>` + a 5-digit number from a database sequence (IDs already held are skipped). Clear is refused, before a number is used, if any terminal of the pass would not classify the ID as a visitor | Rule #7: an ID outside the patterns would never be removed by reconciliation | Phase 6 |
| 2026-10-06 | ~~At Clear, the visitor's typed company is matched to the directory (ignoring case) or added to it~~ (superseded 2026-10-08); the department is optional and chosen by the host | Visitors don't know the internal directory | Phase 6 |
| 2026-10-06 | Clear writes the person, photo and documents first, then issues the pass; if the pass is refused, the person is kept and a retried Clear finds them | People are never deleted; a retry must not duplicate | Phase 6 |
| 2026-10-06 | A single-entry request with no exit ticked uses the zones' defaults (the office exit) | The office exit always needs the code (client, 23 Sep) | Phase 6 |
| 2026-10-06 | A rejection reason is internal; the visitor is told only that the request was not approved | Avoids sharing internal judgements by SMS | Phase 6 |
| 2026-10-06 | An undecided request (sent, submitted or queried) expires when its visit end passes; checked on the gate-engine tick | No stale links or pending reviews | Phase 6 |
| 2026-10-06 | The walk-in desk runs the portal's own steps with Security as the audited actor: the code goes to the visitor's phone and Security types it | One flow, one set of rules; the mobile is still proven | Phase 6 |
| 2026-10-06 | Security retake (passes:update): replaces the photo and re-pushes it to terminals already holding the face; loads still queued pick up the new file | A poor selfie fails at the gate; fix it without re-issuing | Phase 6 |
| 2026-10-06 | Zone widening: a host only on their own visitor's pass; an operator who manages passes on any | Closes the Phase 4 gap | Phase 6 |
| 2026-10-05 | The visit-request core (create → link → visitor submits; resend, cancel, host view) moves from Phase 6 into Phase 5; Clear / Query / Reject, walk-ins and request → pass stay in Phase 6 | The portal needs a request for its link to open | Phase 5 |
| 2026-10-05 | The portal reaches the backend through a same-origin Next route handler (`/public-api/*`) that reads `API_BASE_URL` at request time | The tunnel then publishes only the web app's `/v/`, `/_next/`, `/public-api/` paths; the backend is never exposed; no rebuild when the port changes | Phase 5 |
| 2026-10-05 | A visit request always names a visitor type (pass type) | The portal form is driven by that type's field rules | Phase 5 |
| 2026-10-05 | Link = 32 random bytes, only its SHA-256 stored, expiry from `linkExpiryHours`; a resend or cancel revokes the previous link | The link is the visitor's only credential | Phase 5 |
| 2026-10-05 | Mobile code: 6 digits, hashed, TTL and wrong-attempt limit from settings; the limit burns the code; at most 1 per minute and 5 per hour per request; whole portal 60 requests/min per client address (in memory) | Stops guessing and SMS flooding without a new dependency | Phase 5 |
| 2026-10-05 | Until the mobile is verified, a link shows only the site, host, visit time and the last 4 digits of the number | A forwarded or leaked link reveals nothing personal | Phase 5 |
| 2026-10-05 | Returning visitor = exactly one VISITOR on file whose mobile matches on the last 10 digits; their details prefill the form with ID numbers masked, and an echoed masked number keeps the stored one. Two or more matches → treated as new (host resolves in Phase 6) | Rule #12 holds on the portal too; ambiguity never merges two people | Phase 5 |
| 2026-10-05 | Consent is recorded against the exact notice version shown (with time, IP, browser); a notice changed since the page loaded must be read again; no notice text published = the portal refuses to continue | DPDP: consent must be to specific wording | Phase 5 |
| 2026-10-05 | The visitor's selfie must be the portal's 480×640 camera capture (server checks the size); no gallery upload | Rule #5, and a live face rather than a photo of a photo | Phase 5 |
| 2026-10-05 | The department is not asked of the visitor; Company is free text on the portal (matched to the directory at Clear, Phase 6) | Visitors don't know the site's internal directory | Phase 5 |
| 2026-10-05 | Message bodies are stored readable only by the `console` transport; a real transport stores them with codes and link tokens blanked. The outbox is a new `messages:view` cell, Administrator-only by default | The outbox must never become a way to read someone else's code | Phase 5 |
| 2026-10-05 | A host sees and acts on their own requests only; an operator holding `passes:view` sees everyone's | Hosts shouldn't browse other hosts' visitors | Phase 5 |
| 2026-10-02 | Privacy notice version is server-set (timestamp of the last text change), not typed | Consent must always be tied to the exact wording shown | Phase 2 |
| 2026-10-02 | **0.5.0 upgrades an existing single-zone 0.4.19 site in place**, keeping all data; a one-zone site is a normal configuration, not a legacy mode | Existing sites must take the new product without reinstalling or re-enrolling | Owner |
| 2026-10-02 | Upgrade migrations are additive, backfill in SQL, and change no behaviour until an Admin opts in; upgraded sites default to 0.4.19 behaviour (`exitCodeDefault` false, so single-entry IN and OUT load together) | No surprise at the gate after an upgrade | Owner |
| 2026-10-02 | Active passes at upgrade time are converted to `LOADED` gate rows, so no face is lost or re-pushed; fallback precondition is "no visitors inside" | Upgrades must not strand anyone at a barrier | Owner |
| 2026-10-02 | Phase 9 release gate: trial upgrade of a copy of a real 0.4.19 database + photos on disposable Windows; back up DB and photos before any site upgrade | Every past upgrade note says "untested"; this one must be tested | Owner |
| 2026-10-12 | **F1: the visitor type decides whether a single-entry exit needs the exit code** (`pass_type.exit_code_required`, default true, existing types migrated to true). Which exits still comes from the zones' `exitCodeDefault`. The type is **final — no per-pass choice, no Security override** on the issue-pass form; an `exitCodeZoneIds` field sent by an old client is ignored. A pass with no type follows the zones' defaults. Widening a zone follows the same rule | Hosts and Security choose only the visitor type; the rule is set once by an Admin | Owner |
| 2026-10-12 | `visit_request.exit_code_zone_ids` is left in place, no longer written | Upgrade migrations stay additive | F1 |
| 2026-10-14 | **Which exits need the exit code moves onto the pass type** (`pass_type.exit_code_zone_ids`, chosen when "The exit needs the exit code" is ticked). The zones' "Exit code by default" is removed from the console and no longer read; existing types inherit today's default zones. A pass with no type never needs an exit code. *Supersedes the zone half of F1.* | One setting instead of two that looked like rivals; removes the "General needs a code" surprise | Owner (F2) |
| 2026-10-14 | A live pass keeps the exit-code rule and terminals it was issued with; editing a pass type or zone affects new passes only. The console says how many live passes keep the old rule | Tightening a live pass could trap someone already inside (rule #9) | Owner (F2) |
| 2026-10-14 | Two-zone sites never register people from the terminal: only Requests and Register person. Register person issues system visitor IDs; employees keep typing their own employee code | Owner | Owner (F2) |
| 2026-10-14 | Person erasure on request (Administrator only by default): wipes identity, photo and documents, keeps the anonymised row, history and terminal ID. *Amends hard rule #3 for an explicit erasure request* | Client wants real deletion; DPDP erasure | Owner (F2) |
| 2026-10-14 | Hosts may add companies and departments from the request form | Client | Owner (F2) |
| 2026-10-14 | A zone can be deleted only if it never had a terminal, pass, employee grant or request; otherwise deactivate | Typos are fixable; used zones keep history | Owner (F2) |
| 2026-10-14 | **A pass always takes its holder's pass type**; the issue-pass form no longer offers a choice. Changing it means editing the person, which re-checks their required details | A separately chosen pass type skipped that type's required fields | Owner (F2) |
| 2026-10-14 | Port from 0.4.20–0.4.24: B1–B4, F-a, F-f (no shifts), F-g, F-h, F-j, F-m, D1–D3 (F3). Shift master and a time-in-zone attendance report are the second release (F4); unregistered search dropped. Every punch records its zone from now on (F-z) so that report stays correct after zones change | Owner | Owner (F3) |
| 2026-10-14 | The reconciliation sweep takes visitors from `pass_gate` (loaded, or cleared within `RECONCILE_REMOVED_DAYS`, default 30) rather than from entry states and PROVISION commands; Employees as in 0.4.20 | A gate is the two-zone truth for "should this face be on this terminal"; a recently cleared gate is the dangerous direction | F3 B2 |
| 2026-10-14 | The failed-commands alert counts a failure only if it is under 7 days old and no later command of the same type for the same person on that terminal succeeded. The command queue still lists every failure | A permanent critical alert gets ignored (0.4.x field case) | F3 B4 |
| 2026-10-14 | B3 (face counted after one of two commands) does not apply to two-zone: a gate counts a face only when both commands succeeded on that terminal, and only a LOADED gate gives one back. Pinned by e2e | Checked, no code change | F3 B3 |
| 2026-10-14 | A new pass type needs the exit code only if it names exits; a single-entry type that requires the code must name at least one zone (a site with no zones yet is exempt) | No half-configured rule that silently gates nothing | F2 #10 |
| 2026-10-14 | Widening a live pass uses its pass type's current exit-code zones | Widening is a new action; it follows today's rule like a new pass | F2 #10 |
| 2026-10-14 | New access cell `zones:delete` (Administrator only by default); delete is refused for a zone with sub-zones, terminals, passes, requests or pass-type exit settings, and audited `ZONE_DELETED` | The one place "delete" removes a row: a typo nothing references | F2 #9 |
| 2026-10-14 | Searchable dropdowns for every list that comes from data (companies, departments, pass types, hosts, zones, report filters); fixed two- to four-option lists (category, entry mode, kind, yes/no, status, field rule) and the admin-only role pickers stay native | Search only helps where the list grows | F2 #5 |
| 2026-10-14 | Removing someone still inside is a `force` on the normal de-provision, gated by a new cell `passes_force_end:update` (Administrator only by default), with a mandatory reason; it clears the location and every gate. Without `force`, inside is still refused and the engine never removes anyone inside | 0.4.21 field need (left without punching out); rule #9 holds by default | F3 F-a |
| 2026-10-14 | Discarding a hand enrolment is a new cell `unclaimed:delete` (Administrator only); terminal removals go only to terminals whose ID patterns cover the ID, best-effort | 0.4.24, plus rule #7 (never touch IDs outside the patterns) | F3 F-j |
| 2026-10-14 | Monthly Status counts punches whose stamped zone is top level or unset (no zones / unplaced terminal); days already summarised by retention use the summary, which has no zone | Matches "only the outer gate is the working day"; unplaced terminals are counted rather than silently dropped | F3 F-f |
| 2026-10-14 | Person details report: new cell `people_export:view`, Administrator only; Govt ID, Aadhaar and PAN masked in SQL (first 2 + last 2), so the CSV never holds a full number | Bulk personal data; rule #12 | F3 F-h |
| 2026-10-14 | Device roster in two-zone reads `pass_gate` (loading/loaded) for visitors, not PROVISION commands | Gates are the two-zone truth | F3 F-h |
| 2026-10-14 | The Monthly Status Excel always lays out at least 31 day columns, like the PDF and the eTimeTrackLite original | A range under 8 days crashed the 0.4.24 Excel export (negative column) | F3 F-f |
| 2026-10-14 | Erasure scope: wipe identity, photo and template, document files, the person's visit-request identity/form/selfie, and messages addressed to them; keep row, ID, category, company/department, passes, punches, consent records and the audit trail. Refused for a live pass or an unresigned employee. New cell `people_erasure:delete`; the PERSON_ERASED audit holds the reason and counts, never the erased values | DPDP erasure while keeping accountability and visit counts | F2 #1b |
| 2026-10-14 | Register person issues a visitor's ID from the same counter and checks as Clear when none is sent; the API still accepts an explicit ID (imports, older clients). Issuing skips numbers held by a person **or by a waiting hand enrolment's photo** | One counter, no clashes with a face already on a terminal | F2 #2 |
| 2026-10-14 | Visitors are deactivated / reactivated on their page (`people:delete`); employees keep Resign / Rehire. An erased person can never be reactivated | One way out and back per category | F2 #1a |
| 2026-10-14 | Pass type "Kind" (short/long-term) removed from the console; the column and API field stay (additive) but nothing reads them | It was a label only; one visit vs. a period is what entry modes and maximum validity decide | Owner |
| 2026-10-14 | Erasure stays alongside Deactivate: Deactivate is the everyday removal (data kept), Erase the Administrator-only answer to a formal DPDP erasure request | Deactivating keeps the personal data; only erasure satisfies a request | Owner |
| 2026-10-14 | Zones move to their own page out of Devices; to be done with the UI redesign | Zones are site layout, not terminal settings | Owner |
| 2026-10-14 | Console navigation is a left sidebar in five groups (Overview, Visitors, People, Site setup, Administration), collapsible to an icon rail (remembered per browser), a drawer on phones; entries and empty groups hidden by the access grid as before. Zones get their own page | Owner-approved design (Claude Design canvas "Sidebar Navigation") | Owner |
| 2026-10-14 | Console vocabulary: **"Device"** for the hardware everywhere (not "terminal"); **"Provision / De-provision"** for giving and removing access (the client's existing words); "pass" only for Pass types (client's name) and the printed Visitor pass; "ID" for a person's number | One name per thing before the client's go-live (pre-demo sweep) | Owner |
| 2026-10-14 | Block / Unblock stays; the "Unregistered people" panel stays on both Dashboard and People; the "Aadhaar verified" / "PAN verified" badges stay, by the client's request | Owner (client requests) | Owner |
| 2026-10-14 | Reports "On site now" (duplicate of "Inside now, by zone") and "Single-entry blocks" (retired mechanism) removed; report values show the console's wording, never database codes | Pre-demo sweep | Owner |
| 2026-10-14 | Uploading a photo on the person page re-sends it to devices already holding the face (visitor gates, employee access); the pass panel's separate Retake is removed | The upload used to save only the file, leaving the gate on the old face | Pre-demo sweep |

## Open (awaiting client)

- Privacy notice wording and retention periods for photos, documents and history.
- Documents required per pass type, formats and size limits.
- SMS provider and email account; site domain for the visitor portal.
- Names/phones per role; whether all employees may host.
- Employee list with zone per person; any existing software on the terminals.
- Daily sub-contractor pass sentence (cut off in the client's document).
- Maximum customs pass length.
- Blacklist authority (proposed: Security In-charge only).
- HR and HOD duties inside the system.
- Visitor ID format: `V00001` (today) or `V1`, `V2`… (F2 Q2).

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

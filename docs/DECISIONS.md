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

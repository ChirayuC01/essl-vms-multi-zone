# Product — Two-Zone Visitor Access

> **Status:** target specification. Each section notes the rebuild phase that
> delivers it (`PLAN.md`). Until that phase is accepted, the 0.4.19 behaviour
> described in `legacy/` is what actually runs.

## 1. What the product is

An on-premise system that controls who can pass the face-recognition
barriers of a site. Every person is registered **once** with a durable face
photograph. The system loads that face onto the right terminals at the right
time and removes it again. **Loading a face is the authorization** — the
terminal opens its own barrier on a face match; the system decides only who
is loaded.

Records are never deleted. Photographs and documents stay on the site's own
server.

## 2. Site topology (Phase 1 — implemented)

A site is a tree of **zones**. Each zone has its own IN and OUT terminals.
Access to a zone implies access to every zone above it.

The first two-zone deployment:

```
                  ┌──────────── PREMISE (office zone) ─────────────┐
 outside ──[Outer IN]──►                          ┌──── YARD ────┐  │
 outside ◄─[Outer OUT]──                ──[Yard IN]──►           │  │
                                        ◄─[Yard OUT]──           │  │
                  └────────────────────────────────┴─────────────┴──┘
```

- **Office pass** → Outer IN + Outer OUT.
- **Yard pass** → all four terminals.

Zone names, the tree and which terminal belongs to which zone are
configuration. Nothing in code names a zone. An Admin manages zones on the
**Devices** page: create a zone (optionally inside another), place each
terminal into a zone, and set whether the zone's exit is code-gated by
default. A zone lacking an entry or an exit terminal shows a warning.
Employee access can be granted by zone; it expands to the terminals of that
zone and every zone above it at the moment of granting, and is stored per
terminal as before.

## 3. People

| Kind | How access works |
|---|---|
| **Employee** | Permanent access to the terminals of their zones until an Admin removes it. Restored automatically if a terminal loses them. No exit code. Attendance from punches. *(Exists today; zone selection added in Phase 1.)* |
| **Visitor** | Time-bounded **pass**. Loaded and unloaded per the rules in §6. |
| **Operator** | A console login (`AppUser`), not a Person. Hosts are operators. |

The terminal's user ID is text (`[A-Za-z0-9]{1,20}`), unique case-insensitively.
Each terminal has non-overlapping Employee and Visitor ID patterns. An ID
matching neither is never touched — this is how the terminal's own admin card
holder stays outside the system.

A **returning visitor** is recognised by their OTP-verified mobile number and
reuses the same Person, photograph and terminal ID.

## 4. Pass types (Phase 3 — implemented)

Pass types are a site's own visitor categories, created by an Admin on the
**Pass types** page. Nothing is pre-seeded and no type is named in code. Each
defines:

- short- or long-term
- allowed entry modes (single / multi)
- whether a host must Clear it
- maximum validity in days
- for every profile field: **required**, **optional** or **hidden**
- optionally an external credential (a label, e.g. a port authority pass),
  with whether its expiry caps the pass

Profile fields: mobile, email, company, department, designation, Govt ID type
and number, Aadhaar, PAN, vehicle number, police clearance (yes/no), and
credential number and expiry. Name is always required.

**Visitors with no pass type** ("General") and **all employees** keep the
long-standing rule: mobile, company, department, and Aadhaar or PAN. Each
person's "details complete" state is stored and recomputed whenever their
profile, a directory bulk assignment, or their pass type's rules change. An
incomplete visitor appears in the needs-details list and can't be issued a
pass.

**Recommended setup for the first two-zone site.** An Admin creates these;
they're configuration, not built in:

| Pass type | Kind | Entry | Host Clear | Max days | Required fields | Hidden | Credential |
|---|---|---|---|---|---|---|---|
| Planned visitor | short | single, multi | yes | 1 | mobile, company, Govt ID number | — | — |
| Walk-in | short | single, multi | yes (setting) | 1 | mobile, company | — | — |
| Sub-contractor staff | long | multi (single if wanted) | no | 90 | mobile, email, company, Govt ID number, police clearance | — | — |
| CHA / customer rep | long | multi | no | 90 | as sub-contractor, plus credential number and expiry | — | "BCBA pass", caps validity |
| Customs official | long | multi | no | Security decides | designation | mobile, company, department | — |

Daily sub-contractor passes stay outside the system.

## 5. Flows

### 5.1 Planned visitor (Phases 5–7)

1. **Host** raises a request: visitor name, mobile, company, purpose, zone(s),
   pass type, entry mode, date and time, and for a single-entry yard pass,
   whether the yard exit also needs the exit code.
2. **System** sends the visitor a link (SMS + email). *(Phase 5 — implemented.)*
3. **Visitor** opens it *(Phase 5 — implemented, §11)*, verifies mobile by OTP, reads and accepts the privacy
   notice, enters Govt ID and vehicle number, takes a live selfie with a face
   guide, optionally uploads documents.
4. **Host** reviews and chooses:
   - **Clear** — Person registered (or matched as returning), unique visitor ID
     issued, pass created.
   - **Query** — host must write what is wrong; visitor gets a new link
     showing it and resubmits. Repeatable.
   - **Reject** — request closed, visitor informed.
5. **System** loads the face on the entry gates of the pass's zones at the
   scheduled time (§6).
6. **Visitor** looks at the entry gate and walks in.
7. On entry, for **single entry**, the host receives an arrival message with the
   **exit code**; the visitor receives an out-pass link.
8. When the visit ends, the host shares the code; the visitor enters it.
9. Only then is the face loaded on the code-gated exit gate(s).
10. Faces are removed per §6. Details, photo and history are kept.

Every request, every query (with its text), every rejection and every
decision is kept with full history.

### 5.2 Walk-in (Phase 6)

Security enters the same details at the gate, sends and types the mobile OTP,
captures the face, and names a host. With `walkInRequiresHostClear` on
(default) the host must Clear before anything is loaded; switched off, the
pass is issued immediately. Steps 7–10 above then apply.

### 5.3 Long-term passes (Phase 4 — implemented)

Security registers the person once and issues the pass. Faces stay loaded for
the validity period and are removed automatically when it ends. A **single
entry** long-term pass has no host, so its exit code goes to the **Security
desk**. A multi-entry one has no exit code.

## 6. Gate-loading rules (Phase 4 — implemented; exit code itself Phase 7)

Defaults shown; minutes are settings. A **gate engine** runs every minute and
is the only thing that loads or removes faces. Each pass has one row per
terminal saying when the face arrives and leaves; the operator console shows
it on the person page ("scheduled / loading / loaded / removing / removed").

| Event | Single entry | Multi entry |
|---|---|---|
| Pass issued | Entry-gate faces for its zones scheduled to load **5 min** before the expected time | Same, **and** all its exit gates load at the same time |
| No-show | Entry faces stay until the pass ends | Same |
| IN punch on a terminal | That terminal drops the face **10 min** later (Outer IN and Yard IN each on their own punch) | Nothing — faces stay until the pass ends |
| Exit | **Exit code required.** A verified code loads the code-gated exit gate(s) | **No exit code.** Exit gates are already loaded |
| OUT punch on a terminal | That terminal drops the face **10 min** later | Nothing |
| Pass ends | Entry faces removed; a visitor still inside is listed **overstayed** for Security | Faces removed; a visitor still inside keeps exit access until they leave |

**Which exits need the code** is chosen per pass: the office (outer) exit
always, by default; the yard exit only if ticked on a yard pass. An exit not
covered by the code is loaded with the entry gates. Each zone's default comes
from its "exit code by default" setting.

Further rules:

- **A single-entry pass lasts one day.** A multi-day single-entry pass is
  refused, because the holder would be locked out after the first day. Use
  multi entry for longer passes.
- **Location** follows the zone tree. In at the yard gate means "in the
  yard"; out of the yard means "back in the premise"; out of the outer gate
  means "outside".
- **A two-way (BOTH) terminal**, at sites without separate IN/OUT gates:
  - its face loads with the entry gates
  - single entry removes it 10 minutes after the OUT punch
  - the exit code never applies to it

  The old "blocked for the rest of the day, reset at midnight" mechanism is
  retired.
- **A pass also works without zones.** It can name terminals directly, which
  is how single-entrance sites and older integrations keep working.
- **Upgrade:** passes live at upgrade time keep exactly the terminals they
  were on (no face is re-sent).

## 7. Controls

- **Blacklist** (Security In-charge; visitors only) — ends every pass at once
  and blocks any new pass until lifted. Someone outside is removed from every
  terminal. Someone inside keeps any exit already loaded, so they can be walked
  out, and is listed as overstayed. Implemented, Phase 4.
- **Zone widening** (host) — add a zone (e.g. Yard) during a visit; its
  terminals load at once; recorded against the operator. Implemented, Phase 4.
  (Limiting it to the visitor's own host comes with visit requests, Phase 6.)
- **Exit override** (Security) — when the code route fails, Security releases
  a single-entry visitor at the exit: the code-gated exit terminals load at
  once. Reason mandatory; logged with operator, visitor, time and reason.
  Implemented, Phase 4. The report comes in Phase 8.
- **Security photo retake** — replace a poor selfie at the gate; re-pushed to
  the loaded terminals. Phase 6.
- **Outage procedure** — while the system is down, site staff release people
  physically with the terminal's admin card and note them in a manual
  register. When the system comes back, passes affected by the outage are
  released automatically and the release is recorded, for reconciling against
  the register. Phase 7.

## 8. Roles and access (Phases 2 and 2b — implemented)

Access is a grid of **feature × action** (View / Create / Update / Delete),
edited by an Admin in the console (**Access** page). Nothing about who may do
what is fixed in code, except that the **Administrator** role always has
everything.

- **Roles** are data. Seven are seeded (below), and an Admin can add custom
  roles: start empty, or copy an existing role's grid. Roles can be renamed or
  deactivated. A role with active operators can't be deactivated. The
  Administrator role can't be edited.
- **Per-operator overrides:** on any operator's Access page each cell is
  *Inherit* (follow the role), *Allow* or *Deny*. Administrators can't be
  overridden.
- **Changes apply on the operator's next action**, with no re-login. Every
  change is audited: grid cells added/removed, and each override's before and
  after.
- Only the actions that mean something for a feature appear in its row.
  **Delete never deletes data.** It means deactivate or remove from terminals,
  and the grid says which. Actions that aren't really CRUD (exit override,
  blacklist, refresh from terminal, maintenance jobs) are their own rows.
- The grid decides **whether** a role may do something. **Which records** it
  applies to stays a rule in code. For example, a host reviews only their own
  visitors' requests.

Seeded defaults. These are identical to an upgraded site's existing access.
**Settings (view and change) is Administrator-only by default**; an Admin can
grant it to a role on the Access page.


| Role | Default access |
|---|---|
| Administrator | Everything (system role, not editable) |
| Security in-charge | Security, plus blacklist and audit trail |
| Security | Gate work: view everything operational (not settings), people create/update/deactivate, passes, command retry, terminal refresh, companies/departments create and assign, walk-ins, long-term passes, exit override |
| Host | Visit requests (view, create, decide) and zone widening. No site-wide view |
| HR, HOD | View only (not settings), until the client confirms their duties |
| Authorized person | The 0.4.19 operator role, unchanged |

The feature catalogue is `backend/src/services/access.ts`. The seed is
migration `20261002140000_configurable_access`, and a unit test proves it
matches the Phase 2 matrix cell for cell.

## 9. Settings (Phase 2 — implemented)

Settings → **System settings** (Admin only). Every save is audited with the
old and new value of each changed setting.

| Setting | Default | Meaning |
|---|---|---|
| Load face before visit | 5 min | How early a visitor's face reaches the entry gates |
| Remove after punch | 10 min | Single entry: removal from a terminal after its punch |
| Walk-ins: host must Clear | on | Off = walk-ins load as soon as Security registers them |
| Outage after | 10 min | A server silence longer than this counts as an outage |
| Visitor ID prefix | `V` | Start of system-issued visitor terminal IDs; must fit the terminals' visitor ID patterns |
| Visitor link valid | 72 h | Pre-registration link lifetime |
| One-time code valid / attempts | 10 min / 5 | Mobile and exit codes |
| Documents | JPEG, PNG, WebP, PDF; 10 MB; 5 per visit | Upload limits; 0 per visit turns uploads off |
| Privacy notice | empty | The site's DPDP wording. The server stamps a new **version** (date-time) whenever the text changes, so each consent records exactly which wording was shown |

The single/multi exit-code rule is **not** a setting. It is the client's
confirmed rule. Which zone's exit is code-gated by default is set per zone on
the Devices page.

## 10. Privacy (Phases 3 and 5)

- India's DPDP Act 2023: the site (data fiduciary) supplies a notice stating
  what is collected, why, for how long, and how to seek correction/erasure or
  complain. Every visitor must accept it before submitting anything; the
  acceptance time and notice version are recorded.
- **ID numbers are redacted after saving** (implemented, Phase 3). Govt ID, Aadhaar, PAN and
  credential numbers are stored in full (uniqueness and returning-visitor
  checks need them) but every screen, report, export and print shows only the
  first two and last two characters, e.g. `CI******7b`. The vehicle number
  stays visible for Security.
- Aadhaar card copies: visitors are asked to upload masked Aadhaar.
- **Documents** (implemented, Phase 3): attached on a person's page (and, from
  Phase 5, by the visitor).
  - Optional until the site confirms requirements.
  - The type is decided by the file's **bytes**, not its name: JPEG, PNG,
    WebP or PDF, as enabled in System settings.
  - Size limit (≤ 20 MB) and a per-person count limit are also System
    settings.
  - Stored on local disk under a generated name.
  - Always downloaded as an attachment, with headers that stop a browser from
    running it.
  - Removing a document hides it, but the record and file are kept.
  - Upload, download and removal are audited in the person's history.
- **People transfer** (`backend/scripts/transfer-people.mjs`, `PEOPLE_TRANSFER.md`)
  is the one place full identity numbers leave the system. It reads them from
  the database with `--database-url` on the server, never through the API.
- Retention periods for photos, documents and history await the site's
  answer; until then nothing is deleted.
- Terminals shared with employees: only IDs matching a configured pattern are
  ever collected (carried over from the 0.4.x shared-terminal analysis in
  `legacy/DPDP_SHARED_TERMINAL_RISK.md`).

## 11. Messaging and the visitor portal (Phases 5 and 9)

Links and OTPs go by SMS and email. Until the site confirms a provider (MSG91
and an SMTP account are expected), messages go to an **outbox** readable by an
Admin in the console, which is how the flows are tested locally.

**Implemented in Phase 5:**
- **Requests** page: a host raises a request (visitor name, mobile, optional
  email and company, visitor type, entry mode, zones, exit-code exits, visit
  time, valid until, purpose). The visitor gets the link by SMS (and email if
  given). The host sees status, details (IDs masked), photo, documents and
  history; can send a new link (the old one stops working) or cancel with a
  reason. A host sees only their own requests; anyone who can see passes sees
  all.
- **Visitor portal** (`/v/<link>`), on the visitor's phone:
  1. confirm the mobile with an SMS code (the page shows nothing personal
     before this);
  2. read and accept the privacy notice;
  3. fill the fields the visitor type asks for (a returning visitor sees
     their saved details, ID numbers masked);
  4. take a live photo inside a face oval (camera only);
  5. optionally attach documents;
  6. submit — the host is notified.
- **Outbox** page (Administrator by default): every SMS and email recorded.
- Limits (settings): link validity, code validity, wrong-code attempts,
  document size, count and types. Codes: one a minute, five an hour.

The visitor portal (link, OTP, form, selfie, documents, out-pass) is the only
part reachable from the internet, published through a Cloudflare Tunnel on the
site's own domain. The operator console and the terminal endpoints stay on the
LAN.

## 12. Known limits

- A terminal does **not** report a person it recognised but refused (expired,
  blacklisted, wrong zone). Attempted entries cannot be reported.
- Govt ID and vehicle numbers are recorded as entered, not verified.
- The selfie becomes the face the gate matches; a poor selfie passes review
  and fails at the gate — hence live capture with a face guide and the
  Security retake.
- During an outage the system cannot release anyone; the admin card is the
  fallback (§7).

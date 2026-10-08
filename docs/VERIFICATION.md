# Verification Steps — per phase

How the owner verifies each rebuild phase by hand before accepting it. Each
phase adds its own section when it is implemented. Automated results (unit and
e2e) are in `EXECUTION_LOG.md`; this file is the **manual** walk-through.

Hardware assumed: **two physical terminals** plus virtual ones as needed. See
`TESTING_WITH_TWO_TERMINALS.md` for how virtual terminals work.

## Status

| Phase | Manual verification | Result |
|---|---|---|
| 0 | Read the new docs against what the client was told | Accepted 2026-10-02 (commit `33da17e`) |
| 1 | §Phase 1 below | **VERIFIED** by owner (confirmed 2026-10-02) |
| 2 | §Phase 2 below | Owner approved commit 2026-10-05; step results not recorded |
| 2b | §Phase 2b below | Owner approved commit 2026-10-05; step results not recorded |
| 3 | §Phase 3 below | Owner approved commit 2026-10-05; step results not recorded |
| 4 | §Phase 4 below | **VERIFIED** by owner (2026-10-05) |
| 5 | §Phase 5 below | **VERIFIED** by owner (2026-10-06), including the phone run over a quick tunnel |
| 6 | §Phase 6 below | **VERIFIED** by owner (2026-10-08) |

Record results here as `PASS` / `FAIL — note` per step when walking through.

---

## Common setup (every phase)

1. **Licence.** The dev console must not be returning `LICENSE_EXPIRED`
   (install a key on the License page, or use the dev-only workaround).
2. **Services**, one terminal window each:
   - `backend`: `npm run db:dev:start`
   - `backend`: `npm run dev`, which must say it is listening on **48102**
   - `web`: `npm run dev`
3. **Real terminals point at the dev backend:** Menu → COMM. → Cloud Server
   Settings, address = this PC's IP, port = **48102**. Reboot the terminal if
   it doesn't reconnect.
4. **Firewall** allows inbound TCP 48102.
5. Open **http://localhost:48101** (not 47101) and log in as an Admin.
6. When finished, point the terminals back to **47102** if the installed system
   should own them again.

---

## Phase 0 — Docs baseline

1. Read `docs/README.md`, then `PRODUCT.md`, and check them against what the
   client was told.
2. `CLAUDE.md` contains the amended hard rule #9 (exit code / override,
   admin-card release during outages, automatic release on recovery).
3. `docs/legacy/` holds every pre-rebuild document unchanged.

---

## Phase 1 — Zones and gates

**Layout used:** the real pair is the **Office** gates; a virtual pair is the
**Yard** gates. An office employee must land only on the real terminals. A
yard employee must land on all four, which proves that Yard access includes
the Office gates.

### Step 1 — Real terminals' roles

✅ Devices page shows both real terminals **online**. If they're listed under
"Unregistered devices", click **Register**.

On the Devices page:

| Terminal | Name | Role |
|---|---|---|
| Real terminal 1 | `Outer IN` | In only |
| Real terminal 2 | `Outer OUT` | Out only |

On each terminal: Menu → Personalize → Punch State Options → Punch State Mode
= *Fixed Mode*, Fixed Punch State = *Check-In* (Outer IN) or *Check-Out*
(Outer OUT).

✅ Each terminal card shows a **Zone** dropdown reading **Not placed**.

### Step 2 — Create the zones

In the **Zones** card at the top of the Devices page:

1. `Office`, parent *Top level* → **Add zone**.
2. `Yard`, parent *Inside Office* → **Add zone**.
3. Tick **Exit code by default** on Office only.

✅ Both zones are listed, Yard shows "Inside: Office", both show the warning
*"needs at least one entry and one exit terminal"*, and the Office tick
survives a page refresh.
❌ Adding a zone named `office` (lowercase) is **refused** as a duplicate.

### Step 3 — Create two virtual Yard terminals

```powershell
Invoke-WebRequest "http://localhost:48102/iclock/getrequest?SN=VIRTYARDIN"
Invoke-WebRequest "http://localhost:48102/iclock/getrequest?SN=VIRTYARDOUT"
```

Refresh Devices, register both from **Unregistered devices**, then set:

| Terminal | Name | Role |
|---|---|---|
| `VIRTYARDIN` | `Yard IN (virtual)` | In only |
| `VIRTYARDOUT` | `Yard OUT (virtual)` | Out only |

They show offline. That's expected.

### Step 4 — Place terminals into zones

| Terminal | Zone |
|---|---|
| Outer IN, Outer OUT | Office |
| Yard IN (virtual), Yard OUT (virtual) | Yard |

✅ Zones card: Office **1 in · 1 out**, Yard **1 in · 1 out**, no warnings.
❌ Set Yard OUT (virtual) to *Not placed*: Yard shows **1 in · 0 out** and the
warning returns. Put it back.

### Step 5 — Office employee: real terminals only

1. People → New person: **Employee**, complete profile (name, mobile, company,
   department, Aadhaar or PAN), a **photo**, and permanent device access
   **Outer IN** only. Save.
2. On their page, Zones → tick **Office** → **Assign selected**.

✅ Access table lists **Outer IN and Outer OUT** only.
✅ Commands page: Outer OUT's commands reach **SUCCESS** within seconds.
✅ At the terminals: recognised at both and the barrier opens. The live feed
shows IN at Outer IN and OUT at Outer OUT.

### Step 6 — Yard employee: all four terminals

1. Create a second employee the same way (Outer IN ticked at creation).
2. Zones → tick **Yard** → **Assign selected**.

✅ Access table lists **all four** terminals. This is the core Phase 1 proof.
✅ Real terminals' commands reach **SUCCESS**; recognised at both real
terminals.
✅ Virtual terminals' commands stay **PENDING** (nothing polls them).

Optional: play a virtual terminal (repeat until the poll returns `OK`):

```powershell
(Invoke-WebRequest "http://localhost:48102/iclock/getrequest?SN=VIRTYARDIN").Content
# reply: C:<number>:DATA UPDATE USERINFO ...
Invoke-WebRequest "http://localhost:48102/iclock/devicecmd?SN=VIRTYARDIN" -Method Post -Body "ID=<number>&Return=0&CMD=DATA"
```

✅ Those commands turn **SUCCESS**.

### Step 7 — Inactive zone cannot be granted

Deactivate **Yard** in the Zones card, then open any employee page.

✅ Yard is no longer offered in the Zones picker. Reactivate Yard afterwards.

### Step 8 — Rehire by zone (optional)

Resign the office employee, then in the rehire section tick zone **Office**
only → **Rehire**.

✅ Access returns on Outer IN and Outer OUT, and the face reloads on both.

### Step 9 — Audit trail

Reports → **Audit trail**, filtering by Action:

✅ `ZONE_CREATED` ×2 · `ZONE_UPDATED` (exit-code tick, deactivate/reactivate,
with old values) · `DEVICE_ZONE_CHANGED` per placement, including the Step 4
round trip (from/to) · `EMPLOYEE_ACCESS_ASSIGNED` with the expanded terminal
IDs. Actor = you.

### Step 10 — Permissions

Create an **Authorized Person** operator and log in as them (private window).

✅ Zones card is read-only. The terminal zone shows as text, not a dropdown.
Employee pages have no zone or device assignment controls.

### Step 11 — Nothing old broke

Give an existing visitor a normal pass on the Provision page (Outer IN + Outer
OUT).

✅ Loaded and recognised on both real terminals as before. Zones don't affect
visitor passes until Phase 4.

### Step 12 — Clean up

Remove the test employees' access (or keep them for later phases). Keep the
virtual terminals for Phase 4. Re-point the terminals to 47102 if needed.

**Pass:** Steps 5, 6, 2/4, 7, 9, 10 and 11 all hold.

---

## Phase 2 — Roles and settings

No terminal is needed for this phase. Two terminals stay connected only so
Step 6 can confirm nothing old broke.

### Step 1 — Every role can be created

Operators → Add operator. The **Role** list offers: Administrator, Security
in-charge, Security, Host, HR, HOD, Authorized person.

Create one operator per new role, e.g. `host@site.local`,
`security@site.local`, `incharge@site.local`, `hr@site.local`, each with a
temporary password.

✅ Each appears in the table with a role dropdown (your own row shows a
badge instead and can't be changed).
✅ Changing a role from the dropdown shows "… is now <role>" and survives a
refresh.

### Step 2 — What each role sees

Sign in as each (private window; set the new password when asked). These are
the **seeded defaults**. Phase 2b lets an Admin change them, so check them
before changing any grid.

| Role | Navigation shows | Should NOT see |
|---|---|---|
| Host | No site pages. Opening the console shows a "Welcome — your access does not include the site dashboard" card | Every site page |
| Security | Dashboard, Inside Now, Provision, People, Command Queue, Devices, Reports, Directory | Settings, Operators, Access |
| Security in-charge | Same as Security | Settings, Operators, Access |
| HR / HOD | Dashboard, Inside Now, People, Command Queue, Devices, Reports, Directory | Provision, Settings, Operators, Access |

✅ As Security, the Devices page Zones card is read-only.
❌ As Host, typing `http://localhost:48101/people` in the address bar shows
an error, not the list.

### Step 3 — System settings (Admin)

Settings → **System settings**.

✅ Defaults: load before visit **5**, remove after punch **10**, walk-ins
"Host must Clear" **ticked**, outage after **10**, visitor ID prefix **V**,
link **72** h, code **10** min / **5** attempts, documents **10** MB / **5**
per visit, all four types ticked, privacy notice empty ("not set yet").

1. Change *Load face before visit* to 7, type a short privacy notice, then
   **Save settings**.
   ✅ "Settings saved". After a refresh the values remain, and the notice hint
   shows "current version <date-time>".
2. Click **Save settings** again without changing anything.
   ✅ No new audit row (Step 5).
3. Set *Visitor ID prefix* to `V-1`, then save.
   ❌ Refused with an error mentioning visitorIdPrefix. Nothing changes.
4. Edit the notice text and save.
   ✅ The version date-time changes.
5. Put *Load face before visit* back to **5** and save.

### Step 4 — Only Admin can change settings

Settings is **Administrator-only by default**. As Security (or any non-Admin
role):

✅ **Settings** is not in the menu.
✅ Opening `http://localhost:48101/settings` directly shows no settings and
no branding.

(If an Admin later grants a role **System settings: View** on the Access
page, that role sees the settings read-only; **Update** is needed to save.)

### Step 5 — Audit trail

As Admin: Reports → Audit trail.

✅ `SETTINGS_CHANGED` rows exist for each real save, each listing only the
changed settings with their old and new value. The no-change save in
Step 3.2 produced no row.
✅ `PERMISSION_DENIED` rows exist for the Host's attempt in Step 2.
✅ `OPERATOR_CREATED` / `OPERATOR_UPDATED` rows exist for Step 1.

### Step 6 — Nothing old broke

As Admin (or Security), provision an existing visitor on the two real
terminals as before.

✅ They load and are recognised.

**Pass:** Steps 1–5 hold as described and Step 6 still works.

---

## Phase 2b — Configurable access

Sign in as Admin. A new **Access** menu item appears, and each operator row
gets an **Access** link.

### Step 1 — Nothing changed on upgrade

Access → **Role defaults**:

1. Select *Authorized person*. ✅ Ticks match what that role could do before:
   view across the site, people create/update/deactivate, passes, command
   retry, refresh from terminal, companies/departments create and assign.
2. Select *Administrator*. ✅ Everything is ticked and greyed out, with the
   note "always has full access and cannot be edited".

✅ Your existing operators still have their old roles (Operators page) and
can do exactly what they could before.

### Step 2 — Grid layout

✅ Features are grouped: General, Gate, People, Terminals, Reports,
Administration.
✅ Only meaningful actions have a box. For example, *Audit trail* has only
View, and *Exit override* has only Update ("release without the exit code").
✅ Small notes under boxes explain them, e.g. People → Delete = "deactivate".
✅ Typing in **Search features** filters rows.

### Step 3 — Custom role

Access → **Roles** → New role name `Gate supervisor`, Start from *No access*
→ **Add role**.

✅ It's listed with key `GATE_SUPERVISOR`, 0 active operators, active.
❌ Adding `gate supervisor` again is refused (duplicate name).

Role defaults → select *Gate supervisor* → tick **People: View** and
**Terminals: View** → **Save Gate supervisor**.

Operators → add an operator with role **Gate supervisor**. Sign in as them
(private window).

✅ They see **People** and **Devices** in the menu, and nothing else (no
Dashboard, Reports, Provision, …).

### Step 4 — A grid change applies without re-login

As Admin: Role defaults → *Gate supervisor* → tick **Zones: View** → save.
As the supervisor, **refresh** the Devices page (don't sign out).

✅ The Zones card now loads its zones.

### Step 5 — Per-operator overrides

As Admin: Operators → the supervisor's row → **Access**.

1. **Command queue: View** → *Allow*. **People: View** → *Deny*. The two
   cells turn green and red. **Save access**.
2. As the supervisor, refresh.
   ✅ **Command Queue** appears in the menu, and **People** is gone.
3. Back on their Access page, set both cells to *Inherit* and save.
   ✅ Back to role defaults.

❌ Open an **Administrator's** Access page. Cells are disabled with the note
"Administrators always have full access".

### Step 6 — Role rules

1. **Rename:** in Roles, click into *Gate supervisor*'s name, change it to
   `Gate lead` and click away. ✅ The name changes everywhere; the key stays
   `GATE_SUPERVISOR`.
2. **Deactivate while in use:** click Deactivate on Gate lead.
   ❌ Refused while it has active operators.
3. **Deactivate when unused:** move the supervisor to another role (Operators
   page), then deactivate Gate lead. ✅ It works, and Gate lead no longer
   appears in the Operators role picker.
4. ✅ The Administrator row has no Deactivate button and its name can't be
   edited.

### Step 7 — Audit trail

Reports → Audit trail:

✅ `ROLE_CREATED` · `ROLE_UPDATED` (rename, deactivate, with old values) ·
`ROLE_PERMISSIONS_CHANGED` (cells added/removed per save) ·
`USER_PERMISSIONS_CHANGED` (each cell's before → after, e.g. INHERIT → DENY).
✅ `PERMISSION_DENIED` rows for anything the supervisor tried while refused.

### Step 8 — Nothing old broke

As a Security operator, provision a visitor on the real terminals as before.

✅ It works, because Security's defaults include passes.

**Pass:** Steps 1–8 hold and Phase 2's steps still hold.

---

## Phase 3 — Pass types, visitor profile, documents, ID redaction

No terminal is needed except in Step 8. Sign in as Admin.

### Step 1 — Nothing changed for existing people

Open **People**.

✅ Existing people look as before. Anyone who was complete is still complete
(no "Needs details").
✅ Their Aadhaar/PAN now shows **masked** (e.g. `23********23`) wherever it
appears: the list badges, the person header, and the person page details.

### Step 2 — Create pass types

Open the new **Pass types** menu → **Add pass type**.

1. **Customs official:**
   - Kind *Long-term*, Multi entry only, Host must Clear **off**
   - Profile fields: Designation **Required**; Mobile, Company and
     Department **Hidden**
   - Save.
2. **CHA / customer rep:**
   - Long-term, max 90 days, Host Clear off
   - External credential `BCBA pass`, tick "A pass ends no later than the
     credential"
   - Profile fields: Mobile, Company, Police clearance, BCBA pass number and
     BCBA pass valid until all **Required**
   - Save.

✅ Both appear in the table.
❌ Adding another called `customs official` is refused (duplicate).
✅ Credential rows say "hidden — set an external credential first" until a
credential label is typed.

### Step 3 — Register by visitor type

People → **Register person** → Category *Visitor*.

1. Visitor type **Customs official**.
   ✅ Only Name, Email, Designation, Govt ID, Aadhaar, PAN, Vehicle and Police
   clearance remain; Mobile, Company and Department disappear. Designation
   is marked `*`.
2. Fill only ID, Name and Designation, then save. ✅ Registered and complete.
3. Register a **CHA / customer rep** and leave the BCBA number empty.
   ❌ Refused with "required: BCBA…" style wording naming the missing
   fields. Fill them and save. ✅ Registered.
4. Register with type **General**, leaving Aadhaar and PAN empty.
   ❌ Refused: "required: Aadhaar or PAN" (the old rule still applies).

### Step 4 — Masking and editing

On the CHA person, enter a Govt ID number (e.g. `CI12345A7B`) and save.

✅ It shows as `CI******7B`, never in full, including after a refresh.
✅ **Edit** → the Govt ID / BCBA number fields are **empty**, with a hint
"On file: CI******7B — type a new one to replace it".
✅ Saving without touching them keeps the old numbers. Typing a new one
replaces it (it shows masked again).
✅ The vehicle number stays fully visible.

### Step 5 — Stricter rules re-flag people

Pass types → Edit **Customs official** → set **Email** to *Required* → Save.

✅ The customs person from Step 3 now shows **Needs details** in People and
in the needs-details filter. Add an email to clear it.

### Step 6 — Documents

On any person, use the new **Documents** card.

1. Upload a PDF (kind *Govt ID*). ✅ Listed with size and time.
2. **Download**. ✅ The browser downloads it as a file; it does not open
   inside the console.
3. Rename any `.html` or `.exe` file to `.pdf` and upload it.
   ❌ Refused ("only JPEG, PNG, WEBP, PDF").
4. Settings → System settings → *Documents per visit* = 1 → save. Try a
   second upload. ❌ Refused (limit). Put it back to 5.
5. **Remove** the document. ✅ It disappears from the list. (The record and
   file are kept; this is visible in the audit trail.)

### Step 7 — Audit trail

Reports → Audit trail.

✅ `PASS_TYPE_CREATED` / `PASS_TYPE_UPDATED` (with before and changes).
✅ `DOCUMENT_UPLOADED` / `DOCUMENT_DOWNLOADED` / `DOCUMENT_REMOVED`, which
also appear in that person's own history.
✅ No audit row or report shows a full Aadhaar, PAN, Govt ID or credential
number.

### Step 8 — Nothing old broke

Provision an existing complete visitor on the two terminals as before.
✅ Works.
❌ Try to provision a visitor flagged **Needs details**. Refused: "complete
the visitor profile".

### Step 9 — People transfer (optional)

Run an export as in `PEOPLE_TRANSFER.md`, including `--database-url`.
✅ `people.json` holds the full numbers and the pass type names; the console
never does.

**Pass:** Steps 1–8 hold.

---

## Phase 4 — Gate engine

**Layout:**
- **Office zone:** your two real terminals, as Outer IN and Outer OUT.
- **Yard zone:** two virtual terminals, as in Phase 1.

Drive the virtual ones with the simulator (`TESTING_WITH_TWO_TERMINALS.md`).
Restart the dev backend first (schema changed).

Setup:
1. Devices page: Office has **exit code by default** ticked; Yard doesn't.
   Outer IN/OUT are in Office; `VIRTYARDIN`/`VIRTYARDOUT` in Yard.
2. Have a complete **visitor** with a photo (call them V).

### Step 1 — Multi-entry yard pass, loaded later

V's page → **Issue pass**: zone **Yard**, Multi entry, Visit time = now + 30
min, Valid until = today.

✅ The pass shows four terminals, all **scheduled**, "from <visit time − 5
min>".
✅ Nothing appears on the Command queue yet.

To skip the wait, set Visit time to now instead.
✅ Within a minute all four show **loading**. The real terminals turn
**loaded** by themselves. Drain the virtual ones:

```powershell
node scripts\sim-terminal.mjs drain VIRTYARDIN
node scripts\sim-terminal.mjs drain VIRTYARDOUT
```

✅ All four **loaded**; the pass is PROVISIONED.

### Step 2 — Location as V moves

1. Walk through **Outer IN** (real). ✅ Inside Now: V, Location = Office.
2. `sim-terminal.mjs in VIRTYARDIN <V's ID>`. ✅ Location = Yard.
3. `sim-terminal.mjs out VIRTYARDOUT <V's ID>`. ✅ Location = Office.
4. Walk out through **Outer OUT** (real). ✅ V leaves Inside Now.
5. ✅ Multi entry: no terminal shows "leaves" earlier than the pass end.

Close the pass (De-provision) before the next step.

### Step 3 — Single-entry office pass: exit waits

Issue: zone **Office**, **Single entry**.

✅ Only **Outer IN** is listed; the form shows "Exit code needed at: Office
exit" ticked.
✅ The note reads "Exit terminals load after the exit code is verified, or a
Security override".

1. Walk through **Outer IN**. ✅ Outer IN shows "leaves <now + 10 min>".
2. ❌ Try the Outer OUT terminal: **not recognised** (no face yet).
3. Type a reason ("Host unreachable") → **Release at exit (override)**.
   ✅ Outer OUT appears with *override*, loading, then loaded.
4. ❌ Release again: refused (already loaded).
5. Walk out through Outer OUT. ✅ Outer OUT shows "leaves <now + 10 min>".
6. After 10 minutes: ✅ both terminals show **removed**, and ❌ V is no
   longer recognised at either.

### Step 4 — Single-entry yard pass: yard exit optional

Issue for zone **Yard**, Single entry:
- With only "Office exit" ticked: ✅ Outer IN, Yard IN and **Yard OUT** load;
  Outer OUT waits.
- With "Office exit" and "Yard exit" both ticked: ✅ only Outer IN and Yard IN
  load.

❌ A single-entry pass with "Valid until" on a later day is refused ("single
entry passes end the same day").

### Step 5 — Widening

Issue a **multi-entry Office** pass, then on V's page **Add a zone… → Yard →
Widen pass**.

✅ Yard IN / Yard OUT appear marked *widen* and load.

### Step 6 — Blacklist

1. V's page → **Blacklist** with a reason, while V is **outside**.
   ✅ Every terminal goes to removing, then removed. ✅ The pass closes.
   ❌ Issuing a new pass is refused (blacklisted).
2. **Lift blacklist.** Issue a multi-entry Office pass, walk V **in**, then
   blacklist again.
   ✅ Outer IN is removed but **Outer OUT stays loaded**. V is shown
   **overstayed** on Inside Now and can still walk out. After they do, the pass
   closes.
3. Lift the blacklist.

### Step 7 — Pass ends while inside

Issue a single-entry Office pass with Valid until a few minutes ahead. Walk
in; don't release.

✅ After the end time V shows **overstayed** on Inside Now, and the warning
explains it.
✅ Use the override to let them out; after they exit, the pass closes.

### Step 8 — Audit

Reports → Audit trail.

✅ `ENTRY_PROVISION_REQUESTED` (with zones and terminals) ·
`GATE_LOAD_QUEUED` / `GATE_LOADED` · `GATE_UNLOAD_SCHEDULED` (after each
single-entry use) · `GATE_UNLOAD_QUEUED` / `ENTRY_DEPROVISIONED` ·
`EXIT_OVERRIDE` (with reason) · `ZONE_WIDENED` · `BLACKLISTED` /
`BLACKLIST_LIFTED`.

### Step 9 — Nothing old broke

On a person with no zones involved (or if you remove all zones), issuing a
pass still loads every registered terminal, as before.
✅ The Provision page (returning visitor by ID) issues passes with the same
form.

**Pass:** Steps 1–8 hold.

---

## Phase 5 — Visit requests and the visitor portal

No terminals are needed for this phase: nothing is loaded onto a gate until
Phase 6 turns a cleared request into a pass. Restart the dev backend and the
web dev server first (new routes; the migration is already applied to `vms`).

Nothing is really sent: every SMS and email lands on the **Outbox** page
(Administrator). That is where you read links and codes.

### Step 1 — Setup

1. **Settings → Privacy notice:** enter some text and save. (Without a notice
   the portal stops at the notice step — that is deliberate.)
2. **Pass types:** have a visitor type for the test, e.g. "Visitor" with
   Govt ID type + Govt ID number **required**, Vehicle number optional.
3. **Operators:** your Host test user should have a **mobile** and an
   **email** set, so you can see the "visitor submitted" notification.

### Step 2 — Raise a request

Sign in as the Host (or as Admin) → **Requests** → **New visit request**:
your own mobile, an email, the visitor type, single entry, zone Office, a time
later today, a purpose → **Send request**.

✅ The request appears with status **sent**.
✅ **Outbox** (as Admin): one SMS and one email to the visitor, containing a
link `http://localhost:48101/v/…`.

### Step 3 — The link shows nothing before the code

Open the link in a private browser window.

✅ Only the site name, host, visit time and "number ending ####". No name.
✅ A made-up link (change a character) says "not valid".

### Step 4 — Mobile code

**Send code** → read it in the Outbox.

✅ Asking for another code within a minute is refused.
✅ A wrong code says "not right". After the attempt limit (Settings, default
5) it says "too many" and even the right code stops working; send a new one.
✅ The right code moves on to the privacy notice.

### Step 5 — Notice, details, photo, documents, submit

1. Tick and **Continue** on the notice.
2. Fill the details. Leave Govt ID number empty and **Submit**: ✅ refused,
   naming "Govt ID number". Fill it. (**Save details** keeps a half-filled
   form; **Submit** saves the form itself first.)
3. **Open camera** (the browser allows the camera on `localhost`): ✅ face oval
   shown, preview mirrored. **Take photo** → "Photo saved".
4. Attach a PDF. ✅ A `.txt` renamed to `.pdf` is refused.
5. **Submit my details**. ✅ "Thank you … your details are with …".
6. ✅ Reloading the link shows the same thank-you page; nothing can be edited.

### Step 6 — What the host sees

**Requests** → the request:

✅ Status **submitted**, "Mobile … · verified", privacy notice accepted (time).
✅ Details with the Govt ID **masked** (first 2 and last 2 characters).
✅ The photo, and the document (downloads as a file).
✅ History: sent → submitted by the visitor.
✅ Outbox: "has submitted their details" to the host's mobile and email.

### Step 7 — New link and cancel

Raise a second request. Open its link once, then on the request page click
**Send a new link**.

✅ The first link now says "replaced or withdrawn"; the new one works.
✅ **Cancel request** needs a reason; afterwards the link says withdrawn and
the status is **cancelled**.

### Step 8 — Returning visitor

Raise a request for the mobile of a **visitor already registered** (with a
Govt ID saved). Open the link and confirm the code.

✅ "Welcome back", with their name and details filled in and the ID number
masked. Leaving the masked number as it is keeps their saved number (the
request page shows the same masked value).

### Step 9 — On a phone (real camera, from outside the LAN)

The camera only works on HTTPS, so use a temporary Cloudflare quick tunnel:

1. Install `cloudflared` and run `cloudflared tunnel --url http://localhost:48101`.
   It prints an `https://….trycloudflare.com` address. (The web dev server already
   allows `*.trycloudflare.com` via `allowedDevOrigins` in
   `web/next.config.ts`; without it the phone page loads but the dev server
   refuses its `/_next/` requests with "Unauthorized".)
2. In `backend/.env` set `PUBLIC_PORTAL_URL=` that address; restart the
   backend.
3. Raise a new request with your mobile; open the link from the Outbox on
   your phone (mobile data, not Wi-Fi, proves it works from outside).
4. ✅ Code, notice, form, front camera with the oval, submit — all work on
   the phone.
5. Stop `cloudflared` afterwards and set `PUBLIC_PORTAL_URL` back. A quick
   tunnel publishes the **whole** web app for as long as it runs; the
   production tunnel (Phase 9) publishes only the portal paths.

### Step 10 — Access and audit

✅ Signed in as a Host: **Requests** shows only that host's requests; there is
no **Outbox**; opening another host's request URL says not found.
✅ **Reports → Audit trail**: the request's rows — created, link sent, code
sent, code failed, mobile verified, consented, details saved, photo saved,
document uploaded, submitted (visitor rows have no operator; they carry the
visitor's address). No row contains a code or a link.

**Pass:** Steps 1–10 hold.

---

## Phase 6 — Host review, walk-ins, photo retake

Use the Phase 4 layout: your two real terminals as the **Office** IN/OUT, the
virtual pair as **Yard**. Restart the dev backend and web (new migration is
already applied to `vms`; the backend needs the restart for the new routes).

### Step 1 — Setup

1. **Visitor IDs on your numeric-only test terminal:** Settings → **visitor ID
   prefix** = `9` (new visitors get `900001`, `900002`, …). On **every**
   terminal set the **visitor ID pattern** to `9*`, and make sure the
   employee pattern does not overlap it (e.g. `1*`). The client's terminals
   take letters, so their sites keep `V` / `V*`.
2. **Operators:** a Host test user with a **mobile** and an **email**, and a
   Security user. (Admin can do Security's part; only the host named on a
   request can decide it.)
3. **Settings:** privacy notice set; **Walk-in requires host Clear** ticked.

### Step 2 — Query loop

As the Host, raise a request for your own mobile (Office, single entry, visit
in ~10 minutes), picking the **Company** from the list. Complete it on the
portal (Phase 5 steps) and submit. ✅ The portal never asks the visitor for a
company.

1. Open it under **Requests** → **Decision** → write a query → **Send query**.
   ✅ Status **queried**; the Outbox has a new link whose message quotes your
   question; the old link says "replaced or withdrawn".
2. Open the new link: ✅ your question is shown at the top; your earlier
   details are still filled in. Change something and **Submit**.
3. Query once more and resubmit. ✅ **History** lists every step with your
   query texts.
4. As **another Host**: ✅ the request isn't visible to them at all.
   As **Admin**: ✅ the Decision panel *is* shown — Admin may decide any
   request ("Decide any host's visit requests" on the Access page; grant it
   to other roles there if wanted).

### Step 3 — Clear → pass → gate

1. **Clear — issue the pass.** ✅ "Cleared"; a **Pass** card shows a terminal
   ID like `V00001`.
   - If it refuses with "does not match the visitor ID patterns", Step 1.1
     was missed — fix the pattern and Clear again.
2. ✅ **People**: the visitor exists with your mobile, the company you picked,
   the ID number masked, and the selfie as their photo; their documents are on
   their page.
3. ✅ Outbox: "Your visit … is confirmed" to the visitor.
4. About 5 minutes before the visit time the face loads onto the Office IN
   terminal (Phase 4 rules). ✅ You walk in by face.

### Step 4 — Host widens the pass

While the pass is loaded, as the Host, on the request's **Pass** card pick
**Yard** → **Widen pass**. ✅ The Yard terminals load.

### Step 5 — Security retake

As Security, open the visitor on **People** → the pass panel → **Use webcam**
→ capture. ✅ "Photo replaced"; the Command Queue shows a photo push to each
terminal that already held the face; you still pass by face (with the new
photo).

### Step 6 — Returning visitor

Close the pass (de-provision). Raise another request for the **same mobile**,
complete and submit it, Clear it. ✅ The request shows "returning visitor";
Clear gives the **same terminal ID** and the same person — no duplicate in
People.

### Step 7 — Reject

Raise a request, complete it, then **Reject** with a reason. ✅ Status
**rejected**; the link is withdrawn; the visitor's SMS says it was not
approved and does **not** include your reason.

### Step 8 — Walk-in, host Clear required

As Security → **Walk-in** → fill the visit, pick the Host → **Register
walk-in**. Then on the same page: **Send code** (read it from the Outbox, as
the visitor would from their phone), show them the notice and tick, fill the
details, **Open camera** on this PC, **Submit**.

(Leave **Company** empty this time.)

✅ "Waiting for … to clear"; the host gets "… is at the gate to see you".
✅ If the visitor type requires a company, Clear refuses until you pick one in
the **Company** box on the Decision card.
✅ No link was sent to the visitor.
✅ As the Host, the request is in **Requests**; Clear it → pass issued.

### Step 9 — Walk-in, host Clear switched off

Settings → untick **Walk-in requires host Clear**. Register another walk-in
and submit. ✅ "Cleared — the pass is issued"; the host gets "has been issued
a pass"; the request's history says it was issued without a host Clear.
Tick the setting again afterwards.

### Step 10 — Expiry and audit

1. A request left unanswered past its **valid until** becomes **expired**
   within a minute, and its link stops working.
2. ✅ **Reports → Audit trail**: `VISIT_REQUEST_QUERIED`, `…_CLEARED`
   (with the person, terminal ID and pass), `…_REJECTED`, `…_EXPIRED`;
   walk-in steps carry the Security operator as the actor.

**Pass:** Steps 1–10 hold.

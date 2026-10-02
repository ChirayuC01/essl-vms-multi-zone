# Phase 0 — Verification Checklist

> **Historical record — do not read as current behaviour.** This documents what was decided and verified during this phase, at the time. Where it disagrees with `CLAUDE.md`, `docs/API_REFERENCE.md` or `docs/VERSIONS.md`, those are current and this is not. (Most likely divergence: device user IDs are **text** since 0.3.0, and the `VENDOR_PIN_START`/`VENDOR_PIN_END` range described here no longer exists.)


**Device (all values read from the device's own firmware, Menu → System Info → Device Info):**

| | |
|---|---|
| Serial number | `NCD8252500406` |
| Device name | `x2008` |
| Platform | `ZAM180_TFT` |
| Face algorithm | `Face VX3.9` |
| MAC address | `00:17:61:13:19:b0` |
| MCU version | `203` |
| Face capacity | **3,000** (spec sheet claimed 6,000) |

**Network:** device `192.168.0.25` (static, DHCP off, gateway/DNS `192.168.0.1`); laptop `192.168.0.106`.

**Servers on the laptop:**

| | |
|---|---|
| eTimeTrackLite (Path B) | `192.168.0.106:83` — dashboard at `/iclock/Main.aspx` |
| Node test server (Path A) | `192.168.0.106:8080` — not yet started |

**Goal of Phase 0:** answer one project-defining question before writing any application code —

> After deleting a vendor from the device, can we re-push their stored enrollment photo and have the device generate a working face template, without the vendor physically re-enrolling?

If the answer is no, the product premise changes completely. Everything else waits until this is settled.

---

## Step 0 — Baseline (done)

- [x] Device online in eTimeTrackLite — status `online`, Validate Status `Valid`, Last Ping populating. **ADMS communication confirmed working on this hardware.**
- [x] Static IP `192.168.0.25`, gateway and DNS set to `192.168.0.1`
- [x] Cloud Server Settings recorded: Mode `ADMS`, Address `192.168.0.106`, Port `83` — switching to Path A means changing the port to `8080`, nothing else
- [x] Windows Firewall inbound rule open for port 83
- [ ] Add the equivalent firewall rule for port `8080` before Stage B (run Command Prompt as Administrator):
      `netsh advfirewall firewall add rule name="VMS ADMS 8080" dir=in action=allow protocol=TCP localport=8080`
- [ ] Router DHCP reservation binding MAC `00:17:61:13:19:b0` to `192.168.0.25`, or confirm `.25` sits outside the DHCP pool
- [ ] Delete the leftover demo device records (`Mobile`, `TD`) to stop them muddying the dashboard counts

### Hardware discrepancies confirmed — for the PRD update

Three independent mismatches against the published AiFace-Arion spec. Treat the spec sheet as unreliable for this unit and read capabilities off the hardware instead.

| Item | Spec sheet / plan | Actual |
|---|---|---|
| Face capacity | 6,000 | **3,000** |
| Wi-Fi | Listed as supported | No Wireless Network option in COMM. menu |
| Serial (paperwork) | `SYZ8251400179` | `NCD8252500406` |
| Serial (box label) | `AJE1260300753` | `NCD8252500406` |

`device.serial_no` must come from the device's ADMS check-in payload, never from a label or invoice.

Record `Face VX3.9` against `vendor_biometric.algorithm_version` — templates are bound to the algorithm version, which is exactly why the photo is the durable artifact and any cached template is a same-device optimisation only.

---

## Stage A — Prove the premise using eTimeTrackLite

Do this stage **first**. eTimeTrackLite is the vendor's own software, so if the photo-repush cycle fails here, it is a hardware/firmware limitation rather than a bug in your protocol code. That distinction is worth a lot: it tells you whether to escalate to eSSL or to keep debugging your own implementation.

### The device's actual command vocabulary

Read off the Select Command dropdown in Device Management → Device List. This is what the firmware supports, and therefore what Path A has to reimplement:

| Command | Maps to |
|---|---|
| `Upload Users To Device` | `PROVISION` — and possibly `PUSH_PHOTO`, see A7 |
| `Delete Users From Device` | `DEPROVISION` |
| `Block Users From Device` | `BLOCK` — the SINGLE_ENTRY day-block |
| `UnBlock Users From Device` | `UNBLOCK` — the daily reset |
| `Enroll User Face` / `Enroll User Face Ex` | `ENROLL` — server-initiated enrollment |
| `Get ATTLOG By Datetime` | punch backfill |
| `Clear Logs From Device` | log rotation (§7) |
| `Restart Device`, `Unlock Door`, `Change IP/Gateway/SubnetMask/WebServerIP/WebServerPort` | device admin |
| `Reset Transaction Stamp` / `Reset OpStamp` / `Reset AttPhoto Stamp` | force the device to re-send data it thinks it already sent — useful in recovery |

**Block and UnBlock exist as first-class commands.** §6 hedged that user-disable might be unreliable and you would fall back to temporary deletion. That hedge can be dropped for this firmware.

**There is no download-photo command.** That is the open question A3 has to resolve.

### A1 — Enroll a test user directly on the device
- [ ] Menu → User Mgmt. → New User
- [ ] User ID: `9001`, Name: `TEST ONE`
- [ ] Enroll face (follow the on-screen positioning prompts)
- [ ] Save
- [ ] Menu → System Info → Device Capacity — Face count should read `2/3000`

### A2 — Confirm eTimeTrackLite received the user
No command needed: in ADMS the device **pushes** user records to the server on enrollment, the same way it pushes punches.

- [ ] Device Management → Device List → **View Users** on the `chirayu` row
- [ ] Confirm `9001 / TEST ONE` is listed

> If it is missing, the likely cause is that A1 was done before the device came online — the push had nowhere to go. Delete `9001` on the device and re-enroll it now that the link is live.

### A3 — Find the enrollment photo (critical) — **ANSWERED: yes, and it works both ways**

**Result:** the enrollment photo is retrievable, and there is also a route to push a photo back.

- [x] **Not** in the IIS `Photos` folder (`C:\eTimeTrackLiteWeb\eTimeTrackLiteWeb\iclock\Photos`) — that holds only app assets (`noPhoto.jpg` etc.), not enrollment captures
- [x] **Found at:** Masters → Employee → the **`BioPhoto`** link in the Register column → *Upload Employee Bio Photo* page, which displays the face captured on the device
- [x] The device pushed the photo to the server automatically on enrollment — no command needed, same mechanism as punches
- [x] Since it is not a file on disk, the photo is stored as a BLOB in the eTimeTrackLite SQL database

**Why this matters:** the premise holds. The photo survives independently of the device, exactly as the architecture assumes. It also confirms photo-in-database is a workable pattern for `vendor_biometric.photo`.

**The same page uploads a photo back** — `Choose File` + `Update`. That is the manual equivalent of the `UpdateEmployeePhoto` SOAP method listed in §4 Path B, and it is the mechanism the whole product depends on.

### A4 — Get the photo out as a file

The page has no download button, but the image is being served over HTTP, so it is retrievable:

- [ ] **Right-click the displayed photo → "Save image as…"** → save to `C:\vms-test\photos\9001.jpg`

If that is unavailable or saves something unusable, inspect how it is served:

- [ ] Press **F12** → Elements tab → find the `<img>` tag for the photo → look at its `src`
  - A **URL** (e.g. `GetPhoto.aspx?empcode=9001`) means photos can be fetched programmatically over plain HTTP — worth recording, it is a simpler pull mechanism than SOAP
  - A **`data:image/jpeg;base64,…`** string means the photo is inlined; decode it, or fall back to reading the BLOB from SQL

> Photo `src` observed: ______________________________________________
> Format / dimensions: ______________________________________________

Note the format and size — the device may be fussy about what it accepts on the way back in.

### A5 — Confirm normal operation before you break anything
- [ ] Walk up to the device — confirm it recognizes you in under ~1 second
- [ ] Confirm the punch appears in eTimeTrackLite (Reports, or the Dashboard's Present count)

### A6 — Delete the user from the device
- [ ] Tick the device row → Select Command → **`Delete Users From Device`** → Execute
- [ ] Wait up to a minute — commands are collected on the device's next poll
- [ ] On the device: Menu → User Mgmt. → confirm `9001` is gone
- [ ] Menu → System Info → Device Capacity → Face count back to `1/3000`
- [ ] Walk up to the device — confirm it does **not** recognize you

### A7 — THE TEST: push the user back — **PASSED (pending A8 confirmation)**

**Result: the device regenerated a face biometric from server-side data. Face count went `0 → 1`.**

The working sequence:

1. Tick the device row → Select Command → **`Upload Users To Device`** → Execute
2. Choose **`For Selected Devices`** → Ok
3. A user-picker appears listing employees with bio details. Tick `9001`.
4. In the row of checkboxes at the bottom, tick **`Face`** (alongside the always-on `User Info`)
5. Click **Upload**
6. Wait for the device's next poll

Confirmed on-device: `9001` reappeared in User Mgmt., and Device Capacity's face count incremented. **No physical re-enrollment took place.**

Note the device's face count only ever reached `1`, not `2` — the other employee (`Test Employee1`, code `1`) is a software-side seed record that was never enrolled on the device, so it has no biometric.

#### Important protocol detail: `Face` vs `AIFace`

The upload picker shows two separate columns, and for `9001` they read:

| Column | Value |
|---|---|
| `Face` | `0` |
| `AIFace` | **`1`** |

These are different biometric types. `Face` is the legacy infrared face template; **`AIFace` is the visible-light AI face used by this device** (algorithm `Face VX3.9`), and it is derived from the BioPhoto rather than from a proprietary template blob.

This is the technical heart of the product: **`AIFace` data is a photo, so it is portable and re-pushable.** A legacy `Face` template would have been algorithm-bound and far more fragile. Path A must target the BioPhoto/AIFace path, not the legacy face-template path.

#### The upload options are the ADMS field map

The checkbox row — `User Info`, `Cards`, `Password`, `User Pic`, `FingerPrints`, `Palms`, `Face` — is effectively the list of data types the protocol can push per user. `User Info` is always on (identity is mandatory); everything else is optional payload. Useful reference when building the `PROVISION` and `PUSH_PHOTO` commands in §8.

Also note `Device Verification Mode` on that screen — it sets how the device authenticates this user (face only, face+card, etc.). Worth revisiting when vendor access policy is defined.

### A8 — Recognition from a pushed photo — **PASSED. Premise confirmed.**

The device recognized a face it had never physically enrolled, from a photo held only on the server.

Proof came from the block test screen, which reported:

```
Failed to verify.
Error! Invalid time period
User ID : 9001
Verify : Face
```

**The device identified user `9001` by face.** Identification succeeded; only authorization was refused. And after unblocking, recognition was immediate and clean.

**This closes Risk #1 in §16 and answers the project-defining question: yes.** Register-once / push-many works on this hardware. A vendor never has to re-enroll.

The full cycle proven end to end:

1. Enroll once on the device → photo pushed to server automatically
2. Delete user from the device → face count drops, recognition stops
3. `Upload Users To Device` with `Face` ticked → face count returns
4. **Walk up → recognized, no re-enrollment**

### A9 — Block / unblock — **PASSED, and it behaves better than assumed**

- [x] `Block Users From Device` → device refuses entry
- [x] `UnBlock Users From Device` → recognition resumes immediately

**§6's hedge can be dropped.** The plan allowed for user-disable being unreliable, with temporary deletion as a fallback. Not needed — block and unblock both work cleanly and reversibly on this firmware.

#### The important detail: blocking does not make the vendor unrecognizable

The rejection message was `Invalid time period`, and it named the user: `User ID : 9001, Verify : Face`. So the sequence on a blocked user is:

1. Device **identifies** the face successfully
2. Device **denies** access on an authorization rule
3. Barrier stays shut

Blocking is implemented as a **time-period / access-window restriction**, not as a biometric removal. §6 described the goal as making the vendor "unrecognizable for the remainder of the day" — that is not what happens, and the actual behaviour is **better**:

- The vendor is still identified, so the attempt is attributable
- Denials are distinguishable from strangers being ignored
- Re-entry attempts by a day-blocked vendor become auditable events rather than silence

- [x] **Do denied attempts reach the server? Apparently not.** The blocked attempt at ~21:43 does not appear in Log Records, which shows punches at 21:37:56 and 21:44:58 either side of it. The `Invalid time period` rejection was shown on the device screen and went no further.

  This reverses the optimistic reading above: a day-blocked vendor's re-entry attempt is **invisible to the server**. §6's SINGLE_ENTRY rule is enforced but not observable, and the turnaround-race edge case leaves no trace either way.

  Worth double-checking before treating as settled — denials may surface in one of the other report types (`Random Check Report`, `Continuous Abnormality`, `Extra Reports`), or the device may hold them in its own on-device log without pushing. Check Menu → System Info or the device's record browser for a locally-stored denial at 21:43. If the device stores denials locally but does not push them, Path A may be able to retrieve them explicitly via `Get ATTLOG By Datetime`.

#### Implication for Path A

The device exposes an access-time-window concept per user. Two consequences:

- The `BLOCK` / `UNBLOCK` commands in §8 map to manipulating that time window on the user record, not to a delete/recreate cycle
- **The device may be able to enforce retention windows natively.** §5 assumed device-native expiry was only available on Path B via `UpdateEmployeewithExpiryDates`, with the Path A sweeper as the only enforcement. If a per-user validity period can be set directly, that becomes a hardware backstop on Path A too — a meaningful reduction in the sync-drift risk (§16 Risk #4), since a missed de-provision would no longer leave a vendor able to open the barrier indefinitely.

> Worth investigating in Stage B: what fields the device accepts for per-user time windows.

### A10 — Punch records — **DONE**

Reports → **Log Records** → set the date range → Generate Report. Fields returned:

| Field | Example |
|---|---|
| Log Date | `28-Jul-2026 21:44:58` |
| Direction | `in` |
| Employee Code | `9001` |
| Employee Name | `TEST ONE` |
| Company / Department | `Default` |

#### Direction is a device-level setting, not a per-punch value

Every record reads `in` because the device record is configured `Device Direction = In Device` (Device Management → Edit). The device does not stamp direction itself; the server applies it based on which device reported the punch.

**This confirms §8's model** — direction derives from source device identity (`.102 = IN`, `.101 = OUT`). No change needed.

A third option exists and is useful right now: the seed device records show direction `altinout`, meaning alternating in/out on a single device. **With only one unit, switching to `altinout` lets you exercise full IN → OUT cycles** — which is what §5's state machine and §6's SINGLE_ENTRY day-block both need in order to be tested at all. Worth doing before Stage B, then switching back to `In Device` when the second unit arrives.

- [ ] Set Device Direction to `altinout` and confirm alternating punches produce `in` / `out` records

#### This report is a processed view, not raw data

Note what is *absent*: no verify mode (face vs card vs password), no raw record ID, no device serial per row. Those exist in the underlying ADMS payload but are not surfaced here.

On Path A the raw `ATTLOG` arriving at `/iclock/cdata` will carry more than this — expect user ID, timestamp, status/direction code, verify mode, and work code. **Capture the exact raw payload in Stage B (B5) and design `punch_event` against that**, not against this report's column set.

`Export Logs` in the Reports menu may expose a rawer format — worth a look if you want to see the underlying shape before switching to Path A.

---

## Stage A result — the premise holds

Every primitive the product depends on is proven on this hardware:

| Primitive | Result |
|---|---|
| Receive punches | ✅ pushed automatically, real time |
| Photo retrievable off device | ✅ auto-pushed to server on enrollment, stored as BLOB |
| Create user on device | ✅ `Upload Users To Device` |
| **Push photo → working face match** | ✅ **the project-defining test, passed** |
| Block / unblock | ✅ clean and reversible |
| Delete user | ✅ `Delete Users From Device` |

**Risk #1 in §16 is closed.** Vendors register once and are re-authorized by pushing a stored photo. No re-enrollment, ever.

Open items carried into Stage B:
- Denied attempts appear not to reach the server — confirm, and check whether the device holds them locally
- Per-user time windows exist (`Invalid time period`) — investigate whether retention windows can be enforced device-side on Path A
- Raw `ATTLOG` payload shape, for designing `punch_event`
- `altinout` direction mode, to test IN/OUT cycles on a single device

---

## Stage B — Path A: direct PUSH / ADMS protocol

Only start this once Stage A has given you a clear answer. Note that repointing the device **disconnects eTimeTrackLite** — the device has only one Cloud server setting, so the two cannot both own it.

Before switching, note that everything proven in Stage A was proven *through eTimeTrackLite*. Stage B is not re-testing the hardware — it is testing whether **your own code** can speak the same protocol. If something fails here, the hardware is not the suspect.

### B1 — Get Node running — **DONE**
- [x] `node -v` returns a version

### B2 — Install and start the test server — **DONE**
- [x] `npm install` in the `vms-adms-test-server` folder
- [x] `npm start` → `ADMS test server listening on port 8080.`

Leave that Command Prompt window open — it is your live log of everything the device sends. Everything from B5 onward is read from that window.

### B3 — Open port 8080 in Windows Firewall

This is the same step that kept the device showing `offline` on port 83 earlier. Windows silently drops inbound connections from other machines, so without this the device's POSTs never arrive and nothing appears in the log — a failure that looks identical to the device being broken.

**If you saw a popup** when the server first started ("Windows Defender Firewall has blocked some features of this app" for Node.js) and clicked **Allow access**, this is already done. If you dismissed it or never saw it, do the following.

**Open Command Prompt as Administrator** (this will not work in a normal window):
- Press the Windows key, type `cmd`
- Right-click **Command Prompt** → **Run as administrator** → Yes

Then run, as a single line:

```
netsh advfirewall firewall add rule name="VMS ADMS 8080" dir=in action=allow protocol=TCP localport=8080
```

- [x] Rule added / Node allowed through the firewall
- [x] Verified reachable from a phone on the same Wi-Fi

**Verify it actually worked.** Testing from the laptop itself proves nothing, because Windows does not firewall traffic to itself. Use your **phone on the same Wi-Fi** and browse to:

```
http://192.168.0.106:8080/queue
```

- [ ] Phone shows `Add ?cmd=... to the URL to queue a command for the device.`

If the phone loads that text, the port is genuinely open to other devices on the network — including the terminal. If it times out, the rule did not take: confirm the Command Prompt was elevated, and check no other firewall/antivirus is intercepting.

> To remove the rule later: `netsh advfirewall firewall delete rule name="VMS ADMS 8080"`

### B4 — Repoint the device from eTimeTrackLite to your server — **DONE**
- [x] Server Port changed `83` → `8080`; device now checking in to the Node server
- [x] Device power-cycled

> eTimeTrackLite is now offline. That is expected and reversible: set the port back to `83` to return to it.

### B5 — Primitive 1: receive data — **device is reaching the server**

**Finding: this firmware calls the ADMS endpoints with an `.aspx` suffix.**

First contact observed:

```
GET /iclock/getrequest.aspx?SN=NCD8252500406   from 192.168.0.25
```

Much ADMS documentation shows the plain `/iclock/getrequest` form. This unit does not use it. The endpoints to implement are:

| Endpoint | Purpose |
|---|---|
| `/iclock/cdata.aspx` | device check-in and data push (punches arrive here as `table=ATTLOG`) |
| `/iclock/getrequest.aspx` | device polls for queued commands |
| `/iclock/devicecmd.aspx` | device reports command results |
| `/iclock/fdata.aspx` | photo / biometric payload uploads |

This is consistent with eTimeTrackLite being an ASP.NET application — the firmware was built against that server. **The real VMS backend must serve these paths**, and should register both forms defensively since other units or firmware revisions may differ.

The test server now handles both forms, plus a catch-all that logs any unrecognised path rather than silently 404ing. Keep that catch-all — it is what surfaced this in the first place.

- [x] Device reaches the server; requests logged with `SN=NCD8252500406`
- [x] Punch captured. Raw request:

```
POST /iclock/cdata.aspx?SN=NCD8252500406&table=ATTLOG&Stamp=9999
body:
9001<TAB>2026-07-28 22:40:21<TAB>1<TAB>15<TAB>0<TAB>0<TAB>0<TAB>0<TAB>0<TAB>0
```

#### Decoded ATTLOG format (tab-separated)

| # | Value | Meaning |
|---|---|---|
| 1 | `9001` | User ID (PIN) |
| 2 | `2026-07-28 22:40:21` | Timestamp — **device local time, not UTC** |
| 3 | `1` | Status / attendance-state code |
| 4 | `15` | **Verify mode — `15` = face** |
| 5–10 | `0` | Work code and reserved fields |

This is materially richer than the Log Records report, which exposed only date / direction / employee code / name.

#### Findings from this single punch

**Verify mode is available per punch.** `15` indicates face recognition. Card, password and fingerprint entries would carry different codes. `punch_event` should store this — it lets the system distinguish a face entry from a card or password fallback, which matters for an access-control audit trail. eTimeTrackLite discarded it.

**There is a per-punch status field (position 3).** A10 concluded from eTimeTrackLite that direction is purely device-level configuration. The raw protocol says otherwise — the device stamps a state code on every record. Worth establishing what drives it before finalising the direction model.

- [ ] Punch several times and see whether field 3 ever changes
- [ ] Switch the device's Device Direction / state setting and re-punch — does field 3 follow?
- [ ] Try `altinout` mode — does field 3 alternate between values?

If field 3 tracks IN/OUT, Path A gets per-punch direction rather than inferring it from device identity — simpler, and it would let a single device serve both directions.

**Timestamps are device-local.** The device reported `22:40:21` while the server logged `17:10:21` UTC — a clean +5:30 offset, so the device clock is correct and it sends local time. The backend must know each device's timezone (eTimeTrackLite stored `330` for this one). Store it on the `device` record and normalise on ingest.

**`Stamp=9999`** is the incremental-sync marker — the same value eTimeTrackLite displayed as `T Stamp`. The device uses it to track what the server has already acknowledged. Relevant to backfill and crash recovery (§10): mishandling it risks either replayed or silently dropped punches.

#### Polling interval — adaptive backoff, not a fixed rate

Initial reading was "roughly every 30 seconds" (17:08:44, 17:09:15, 17:09:45, 17:10:15). **That is only the idle rate.** After any activity the device polls far more aggressively, then backs off again. Intervals observed immediately after a command: 1s, 1s, 3s, 5s, 8s, 8s… climbing back toward 30s.

**This substantially improves the §6 picture.** A day-block queued in response to an OUT punch arrives while the device is in its fast phase — realistically **1–3 seconds**, not thirty. The turnaround race stays a narrow edge case, close to the PRD's original "a few seconds" wording. No rewrite needed on that point.

- [ ] Confirm by measuring actual OUT-punch → block-effective delay once block is working on Path A

### B6 — Primitive 2: send a command

**Finding: commands must carry a command-ID prefix.** The wire format is:

```
C:<CmdID>:<COMMAND>
```

A bare command line (e.g. `DATA QUERY USERINFO PIN=9001`) is **silently discarded** — the device collects it, does nothing, and never reports back. No error, no `devicecmd` call. First attempt failed exactly this way.

The device replies on `/iclock/devicecmd.aspx` with something like:

```
ID=1&Return=0&CMD=DATA
```

`Return=0` means success; any other value is an error code. The `ID` correlates back to the command that was issued, which is the natural key for the `sync_command` status tracking in §8/§10 — the protocol supports per-command acknowledgement natively.

The test server now assigns IDs automatically, so `/queue?cmd=...` takes the bare command and the prefix is added on the wire. It also parses the reply and prints SUCCESS/FAILED alongside the original command text.

Commands worth trying, in rough order of risk:

| Command | Purpose |
|---|---|
| `INFO` | device info — safest first test |
| `CHECK` | make the device re-send its data |
| `DATA QUERY USERINFO PIN=9001` | read one user back |
| `DATA UPDATE USERINFO PIN=9002<TAB>Name=TEST TWO<TAB>Pri=0` | create/update a user |
| `DATA DELETE USERINFO PIN=9002` | delete a user |
| `REBOOT` | restart the device |

In URLs, `%09` is the TAB that separates fields.

- [x] `INFO` returns device details — **works**
- [x] `DATA QUERY USERINFO PIN=9001` — **works, and returns the photo**
- [x] `DATA UPDATE USERINFO PIN=9002<TAB>Name=TEST TWO<TAB>Pri=0` — **works**, `Return=0`
- [x] `devicecmd` reports `ID=<n>&Return=0&CMD=DATA` for each

#### The user record format — including two fields that change the architecture

`DATA QUERY USERINFO PIN=9001` caused the device to push three separate records back:

**1. The user record** (`table=OPERLOG`):

```
USER PIN=9001  Name=TEST ONE  Pri=0  Passwd=  Card=  Grp=1
     TZ=0000000100000000  Verify=-1  ViceCard=  StartDatetime=0  EndDatetime=0
```

| Field | Meaning |
|---|---|
| `PIN` | user ID |
| `Name` | display name |
| `Pri` | privilege (0 = normal user, higher = admin) |
| `Passwd` / `Card` / `ViceCard` | credential fallbacks |
| `Grp` | access group |
| **`TZ`** | 16-char time-zone / access-window mask — **this is what block/unblock manipulates** (`Invalid time period` from A9) |
| `Verify` | verification mode (`-1` = device default) |
| **`StartDatetime` / `EndDatetime`** | **per-user validity window** |

**`StartDatetime` / `EndDatetime` are the significant find.** §5 assumed device-native expiry was Path-B-only, available via `UpdateEmployeewithExpiryDates`, and that Path A would depend entirely on the sweeper. **These fields say otherwise: a retention window can be written directly onto the device user record on Path A.**

That gives retention a hardware backstop. If the VMS crashes, loses the network, or a de-provision command is missed, the device refuses the vendor once the window lapses instead of leaving them able to open the barrier indefinitely. **This materially reduces §16 Risk #4 (sync drift), which was primarily a security risk.**

### B8b — Device-native retention windows: **NOT AVAILABLE on this firmware**

`StartDatetime` / `EndDatetime` exist in the user record and can be written, but **the device does not enforce them.** Investigation closed; do not revisit without new information.

#### What was tried

| Sent | Stored | Result |
|---|---|---|
| `EndDatetime=1785300000` | `17850100` | accepted, no effect |
| `EndDatetime=20260729` | `20260100` | accepted, no effect |

The stored value `20260100` reads as **January 2026 — already in the past** at the time of testing (device date 2026-07-29). The device recognized and admitted the user anyway. The field is stored but inert.

The encoding was never determined. The year survives intact; everything after it collapses to `0100`, even though `07`/`29` are valid month/day values. No clean scheme fits both data points. **This does not matter, because the field has no effect regardless of format.**

#### Also learned: `Return=0` does not mean "valid"

A command containing the literal placeholder text `EndDatetime=<value>` was accepted with `Return=0`. **The return code confirms the command was processed, not that the payload was sensible.** The sync engine must validate values before sending; it cannot rely on the device to reject nonsense. Worth noting in §10 alongside the retry/idempotency design.

#### Consequence for the design

§5 assumed device-native expiry was a Path B feature (`UpdateEmployeewithExpiryDates`) and hoped Path A might have an equivalent. **It does not.** So:

- **The expiry sweeper is load-bearing**, not a backstop. It is the only thing removing lapsed vendors from the device.
- **§10's reconciliation job matters more.** A missed de-provision leaves a vendor able to open the barrier until reconciliation catches it, which is a security exposure (§16 Risk #4) rather than an inconvenience. Reconciliation frequency and reliability should be treated as security requirements.
- No change to the state machine or data model — the sweeper was always specified. This removes an optimisation that was never depended upon.

> If a future firmware revision or a different unit does enforce these fields, revisit — it would be a genuine improvement. Nothing else in the design blocks on it.

**2. The biometric template** (`table=BIODATA`):

```
BIODATA Pin=9001  No=0  Index=0  Valid=1  Duress=0  Type=9
        MajorVer=39  MinorVer=3  Format=0  Tmp=<base64 blob>
```

`Type=9` is the face biometric; `MajorVer=39 MinorVer=3` matches the device's `Face VX3.9`. This is the algorithm-bound artifact — cache it only as a same-device optimisation, per §8.

**3. The enrollment photo** (`table=OPERLOG`) — **the one that matters most**:

```
BIOPHOTO PIN=9001  FileName=9001.jpg  Type=9  Size=59128  Content=<base64 JPEG>
```

**The device hands over the enrollment photo as a base64 JPEG on request.** This is the Master DB ingestion path for `vendor_biometric.photo`, working at raw protocol level with no middleware involved. 59 KB, real photographic resolution — not the 131×142 thumbnail the eTimeTrackLite page displayed.

Together these confirm the full round trip is available on Path A: **pull the photo out with `DATA QUERY USERINFO`, store it in Postgres, push it back later with the matching update command.**

#### Working command syntax (verbatim, confirmed on this firmware)

```
INFO
DATA QUERY USERINFO PIN=9001
DATA UPDATE USERINFO PIN=9002<TAB>Name=TEST TWO<TAB>Pri=0
```

Sent on the wire as `C:<id>:<command>`. Fields are TAB-separated (`%09` when queuing via URL).

#### Device state reporting

After executing a command the device appends its status to the next poll:

```
GET /iclock/getrequest.aspx?SN=NCD8252500406&INFO=ZAM180-NF50VA-Ver3.4.10,1,0,16,192.168.0.25,10,39,12,1,01110,0,0,0
```

Firmware version, counts, IP and capability flags — a free health check on every command round trip. Useful for `device.last_seen_at` and drift detection in §10.

#### Notable values from `INFO`

| Key | Value | Note |
|---|---|---|
| `FWVersion` | `ZAM180-NF50VA-Ver3.4.10` | firmware — record it; behaviour is firmware-specific |
| `PushVersion` | `Ver 2.0.33S-20220623` | ADMS protocol version |
| `~MaxFaceCount` | `3000` | confirms the capacity finding at protocol level |
| `FaceCount` | `1` | live count — **source for `device.faces_used`** |
| `BioPhotoFun` | `1` | BioPhoto supported |
| `VisilightFun` | `1` | visible-light face (AIFace) |
| `~MaxBioPhotoCount` | `3000` | |
| `MultiBioVersion` | `0:0:0:0:0:0:0:0:0:39.3` | type 9 = face, version 39.3 |
| `FaceVersion` | `39` | |
| `MainTime` | `1970-01-01 00:00:00` | **suspicious — investigate** |

- [ ] `MainTime=1970-01-01` looks like an unset internal clock even though punch timestamps are correct. Worth understanding before relying on device-side time for `StartDatetime`/`EndDatetime` enforcement.

### B7 — Primitive 3: push a BioPhoto (the hard one)
- [ ] Push the saved photo to a device user and confirm the face count increments
- [ ] Confirm a working live face match

Stage A proved the hardware does this, so any failure here is a protocol-format problem in your own code, not a hardware limitation. Target the **BioPhoto / AIFace** path — not legacy face templates.

**If you get stuck, imitate the reference implementation.** eTimeTrackLite already performs this exact operation successfully. Point the device back at port `83`, trigger `Upload Users To Device` with `Face` ticked, and capture what actually goes over the wire — via IIS logs, or Wireshark filtered on port 83. That gives you the precise payload format to reproduce.

### B8 — Primitive 4: block / unblock

Stage A showed this is implemented as an **access time window**, not a disable flag — the device identifies the user, then denies with `Invalid time period`. The task is finding what to write to reproduce it.

#### Values ruled out (do not retry)

Baseline for an allowed user: **`TZ=0000000100000000`**

| Attempted | Stored? | Blocked? |
|---|---|---|
| `TZ=0000000000000000` | yes | **no** — still recognized and admitted |
| `TZ=0001000000000000` | yes | **no** — still recognized and admitted |

Both were accepted by the device (`Return=0`, confirmed by re-query) but neither denied access. The 4-char-group reading — flag + TZ1 + TZ2 + TZ3, with all-zeros falling back to the group timezone — did not hold up, or `Grp=1` overrides regardless.

**Useful side finding:** `DATA UPDATE USERINFO` does **not** disturb the biometric. BIODATA and BIOPHOTO survived every update, and recognition continued working. Provisioning can therefore update user attributes without re-pushing the photo.

#### The definitive method — observe eTimeTrackLite

Stop guessing at a 16-character field with unknown semantics; a working implementation exists on port 83. Keep the Node server **running throughout** (the diff cache is in-memory and is lost on restart).

- [ ] Restore the default and set a clean baseline:
      `/set-user?pin=9001&name=TEST ONE&pri=0&grp=1&tz=0000000100000000` then `/user?pin=9001`
- [ ] Device → COMM. → Cloud Server Settings → port `83`; reboot; confirm `online` in eTimeTrackLite
- [ ] eTimeTrackLite → Device List → tick device → **`Block Users From Device`** → Execute → select `9001` → confirm
- [ ] Walk up — confirm `Invalid time period` (proves the block actually landed)
- [ ] Device → port `8080`; reboot
- [ ] `/user?pin=9001` — **read the diff**

#### ANSWER: blocking is group membership, not `TZ`

Observed by letting eTimeTrackLite perform `Block Users From Device` and diffing the user record:

```
Grp:  1  ->  100
```

`TZ` was untouched (`0000000100000000` throughout). **Access control on this device resolves through the access group; the per-user `TZ` field is ignored or overridden by it.** That is why both `TZ` hypotheses were accepted by the device yet had no effect.

| Operation | Command |
|---|---|
| **Block** | `DATA UPDATE USERINFO PIN=<pin><TAB>Grp=100` |
| **Unblock** | `DATA UPDATE USERINFO PIN=<pin><TAB>Grp=1` |

Group `1` is the normal, always-allowed group. Group `100` has no valid access window.

- [x] Confirmed on Path A: set `Grp=100`, walk up → `Invalid time period`
- [x] Confirmed on Path A: set `Grp=1`, walk up → recognized
- [ ] **Does group 100 exist by default, or did eTimeTrackLite create it?** This matters for deployment: if the VMS must guarantee a blocked group exists on a fresh device, it needs a way to create or verify one. **This unit can no longer answer the question — eTimeTrackLite has already touched it. Test on the second device when it arrives, while it is still factory-fresh.** If group 100 is not a factory default, the alternative is defining a known-blocked group during device onboarding in the setup wizard (§13.1).

**B8 COMPLETE.** Block and unblock both work on Path A, are fully reversible, and leave the biometric untouched.

**Implication for §6:** the SINGLE_ENTRY day-block becomes a group swap — clean, reversible, and it leaves the biometric untouched. `entry.day_blocked` maps to "user is in the blocked group". The daily reset job moves everyone back to group 1.

**Implication for §8:** the `device` model may need a notion of blocked-group ID and normal-group ID as configuration, since group numbering could differ across devices or firmware.

### B9 — Primitive 5: delete
- [ ] Delete a user by command; confirm removal on-device and that the face count decremented

### B10 — Loose ends worth resolving while on Path A
- [ ] Does the device store *denied* attempts locally? Try `Get ATTLOG By Datetime` covering a period containing a blocked attempt. Stage A showed denials never reach the server via eTimeTrackLite; if the raw protocol can retrieve them, §6's SINGLE_ENTRY rule becomes auditable after all.
- [ ] What does the device report for its own capacity and identity on check-in? This is where `device.max_faces` and `device.serial_no` should come from, rather than being typed in.

---

## Stage C — Decide and write it down

- [ ] **Path decision:** A (direct PUSH) / B (eTimeTrackLite middleware) / hybrid — and the reasoning

Stage A already establishes the fallback position: **Path B works today**. Every primitive the product needs has been demonstrated through eTimeTrackLite. So Path A only needs to win on merit (no middleware licence, pure Node stack, true real-time, full control) rather than being the only option — which makes it safe to timebox the protocol work rather than open-endedly debugging it.

### PRD v4 changes to make

Hardware and capacity:
- [ ] Face capacity **3,000**, not 6,000 → `MAX_FACES` guard ≈ **2,800**; alert thresholds ≈ **2,100 / 2,550**
- [ ] Device transaction log **150,000**, not 200,000 → log-rotation schedule recalculated (~50 days at 3,000 punches/day)
- [ ] `device.max_faces` and `device.serial_no` sourced from device check-in data, never hardcoded or typed from a label
- [ ] Serial is **`NCD8252500406`** (paperwork said `SYZ8251400179`; box said `AJE1260300753`)
- [ ] No Wi-Fi on this unit → Ethernet-only deployment assumption
- [ ] Record platform `ZAM180_TFT`, algorithm `Face VX3.9`, MCU `203`

Biometrics and the core premise:
- [ ] §16 Risk #1 **closed** — photo re-push regenerates a working face template, proven on real hardware
- [ ] Name the **`AIFace` vs `Face`** distinction explicitly: this device uses visible-light AIFace derived from the BioPhoto; legacy infrared face templates are a different, non-portable thing. `vendor_biometric.algorithm_version` = `Face VX3.9`
- [ ] Photo-as-durable-artifact confirmed; server-side photo storage as a BLOB is a proven pattern

Entry modes and blocking (§6 rewrite):
- [ ] Drop the "disable may be unreliable, fall back to temporary delete" hedge — block/unblock is clean and reversible
- [ ] Correct the mental model: blocking does **not** make a vendor unrecognizable. The device **identifies then denies** on a time-period rule
- [ ] **Denials are not pushed to the server** → SINGLE_ENTRY is enforceable but its violations are invisible. Note as a limitation, or resolve via B10
- [ ] Possible device-native per-user time windows on Path A → potential hardware backstop for retention (§5, §16 Risk #4)

Punches and direction:
- [ ] Direction is a **device-level** attribute, confirming §8's IN-device / OUT-device model
- [ ] Note `altinout` mode as the single-device testing workaround until unit #2 arrives
- [ ] `punch_event` fields to be finalised from the raw `ATTLOG` captured in B5

Process:
- [ ] Close §15 open questions #1 (firmware behaviour — answered yes), #2 (what eSSL software is present — eTimeTrackLite, and it works), #3 (on-device capacity — 3,000)
- [ ] Add a standing note: **verify every hardware assumption against the physical unit**; three spec-sheet claims have already proven wrong

---

## Outstanding non-blocking items

- [ ] Router DHCP reservation binding MAC `00:17:61:13:19:b0` → `192.168.0.25`, or confirm `.25` sits outside the DHCP pool
- [ ] Delete eTimeTrackLite's leftover demo device records (`Mobile`, `TD`, and the `ME(...)` entries)
- [ ] Set Device Direction to `altinout` and confirm alternating in/out records (do before leaving eTimeTrackLite)
- [ ] Raise the three hardware discrepancies with the supplier — half the quoted face capacity is the substantive one
- [ ] Second device (OUT gate) still to arrive

---

## Two things to stay careful about

**Never let eTimeTrackLite and the VMS both manage users on this device.** If eTimeTrackLite still has employees synced and later reconciles, it can delete or overwrite users your system created. In testing that means confusing results; in production it means a vendor stuck at a barrier. This is §16 Risk #3. Once Path A is committed to, unregister the device from eTimeTrackLite properly rather than just repointing the port.

**Never write to eTimeTrackLite's SQL database to provision users.** Read-only at most, and only if Path B punch-polling is ever needed.

---

## What comes after this

Phase 1 begins once Stage C is filled in: Master DB schema, vendor registration, photo storage, and manual push / block / de-provision working end to end against this device.

Config-driven from the first commit — no client names anywhere in code or naming, no client-specific conditionals. That discipline is nearly free now and expensive to retrofit later.

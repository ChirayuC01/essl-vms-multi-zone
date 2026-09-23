# VMS Project — Complete Context & Progress Record

> **Historical hardware/protocol authority, not current product-state authority.** Sections describing the verified eSSL protocol remain valid for the named firmware. Packaged 0.4.14 is defective; 0.4.18 is the current packaged artifact. For current behavior read `AGENTS.md`, `PEOPLE_ATTENDANCE_BRANDING_LICENSING_UPGRADE_PLAN.md`, `PEOPLE_UPGRADE_EXECUTION_LOG.md`, `LICENSING.md`, `API_REFERENCE.md`, `KNOWN_ISSUES.md`, and `VERSIONS.md`.

**Purpose of this document:** full context handoff. Given to a fresh session (human or AI) with no prior knowledge, it should convey what this project is, why it exists, everything done so far, every finding, and exactly where things stand. Pair it with the PRD (`VMS_PRD_Technical_Plan.md`) for the architecture.

**Last updated (original narrative below): 6 August 2026.** This document's Phase 0/1 narrative (§1–§10) is unchanged and remains the authority on hardware/protocol findings. Status has moved on substantially since 6 Aug — updating the summary here rather than the history:

- **Phase 0** — every ADMS/PUSH primitive proven on the real unit. §4 below is the protocol reference and remains the authority on device behaviour.
- **Phase 1** — Master DB, registration, manual provision/block/de-provision. Hardware-verified from a clean install, including re-provision with no re-enrollment.
- **Phase 2** — punches drive the lifecycle: direction resolution, expiry sweeper, entry modes with day-block and daily reset, inside-now board. See `PHASE_2_PLAN.md`.
- **Phase 3** — reconciliation and self-heal, punch-loss detection, retention with summarise-before-delete, alerting. See `PHASE_3_PLAN.md`.
- **Phase 4 — COMPLETE (6 Aug 2026).** Real RBAC with immediate revocation, operator management, 20 reports with CSV, visitor pass and vendor card, audit views, and M22 end-to-end verification. 239 e2e checks, 50 unit tests. See `PHASE_4_PLAN.md`.
- **Multi-device support (8 Aug 2026).** Provisioning, block/unblock, de-provisioning, expiry and reconciliation all now support an entry spanning any number of devices, not just one — see `INSTALL_GUIDE.md` §7. The second physical unit (OUT gate) still has not arrived, so this is verified at the code level only, not yet against two real terminals.
- **Phase 6 — Productization, COMPLETE**, built *before* Phase 5 by deliberate decision. Installer (Inno Setup), bundled PostgreSQL, three Windows services under WinSW (`VmsPostgres`/`VmsBackend`/`VmsWeb`), a first-run setup wizard, and offline warn-only license enforcement — all verified on real Windows, including a reboot-survival test. **No Tauri shell was built**; the web console runs as its own persistent service (`VmsWeb`) instead. Full detail in `SESSION_HANDOFF_PHASE6.md`.
- **Phase 5 — the supervised pilot at a real client site — has not started yet.** It is next. See `DEPLOYMENT_READINESS.md`.
- **Release 0.3.0 (13 Aug 2026)** — built for the first client site. Four things in it change facts recorded elsewhere in this document, so they are stated here rather than left to a changelog:
  1. **Device user IDs are TEXT.** A screenshot of the first site's own eTimeTrackLite roster shows `wctpl070`, `WCTPL071`, `wctpl101`, `WCTPL502`, `ye01` — a prefix and a zero-padded counter, in inconsistent case, alongside plain numbers. `essl_user_id` is therefore `TEXT` everywhere (vendor, punch_event, punch_day_summary), validated `[A-Za-z0-9]{1,20}`, unique case-insensitively, stored in the casing it was given. **Before this, the ATTLOG parser returned `null` for a non-numeric PIN and the punch was discarded with no row and no log line** — pointing this build at that terminal would have recorded no movements at all for those people.
  2. **`VENDOR_PIN_START/END` is gone**, replaced by `device.vendor_id_patterns` (case-insensitive globs, per device, empty = everything). A numeric range cannot describe such a roster. The gating it did for `autoPullPhotoIfMissing` matters more at this site than any before it, because that terminal is shared with the client's own employees — see `DPDP_SHARED_TERMINAL_RISK.md`.
  3. **Aadhaar and purpose of visit** are captured and mandatory: aadhaar unique per vendor at registration, purpose free-text at provision time.
  4. **The expiry sweeper had been throwing on every run since `ef72206`** (the multi-device commit added a `SELECT DISTINCT` that the existing `ORDER BY` made invalid). 0.2.0 therefore never removed a lapsed vendor from any terminal. Fixed; recorded in `KNOWN_ISSUES.md`.

  **Unverified, and it gates all of the above:** no firmware has been shown to answer `DATA QUERY USERINFO PIN=WCTPL070`, or to say whether it treats `abc1` and `ABC1` as one user. Every alphanumeric behaviour in 0.3.0 is reasoned from the numeric case. The site's terminal is a **different model and firmware** from `NCD8252500406`, so §4 below is the authority on *this* unit and a starting hypothesis for that one — nothing more. Test on the real terminal before the migration runs there.

`npm run verify:e2e` covered **225 checks** as of 6 Aug; **239 checks** as of Phase 4's completion the same day, growing further afterward.

**Decisions taken since this document was first written:** photo storage stays on local disk; the remote-Postgres check is deferred (Phase 1 ships on local PostgreSQL); development is on ONE terminal in `role = BOTH` (multi-device is now supported in software — see above); there is **no approval workflow** — authorized persons provision directly; **no Tauri desktop shell** — the operator console runs as its own Windows service instead; **licensing is fully offline and warn-only**, bound to a per-install id rather than a hardware fingerprint, with no heartbeat and no lockout.

**Protocol findings added after Phase 0** (all in §4): ATTLOG field 3 is per-punch direction (0 = Check-In, 1 = Check-Out, 255 = Undefined); `Duplicate Punch Period(m)` suppresses repeat punches per USER regardless of state; `Stamp`/`OpStamp` are inert constants on this firmware; the full 74-key `INFO` reply is stored on `device.last_info`.

---

## 1. The project

**Chirayu** (solo full-stack developer; TypeScript / React / Node / Next.js / PostgreSQL / Prisma) is building a **Vendor Management System (VMS)** — an on-premise product managing vendor entry/exit through **eSSL face-recognition terminals** driving flip barriers.

**The problem:** vendors must be enrolled on the biometric device to enter. Devices get purged, so returning vendors re-register from scratch — details re-entered, face re-captured — every visit. At 1,200–1,500 vendor movements/day this is slow and error-prone.

**The core idea:** register each vendor **once** in a permanent PostgreSQL Master DB (identity + face photo). Treat the device as a managed, time-bounded working set. When a returning vendor is authorized, the VMS pushes their stored photo back; the device regenerates a face template from it and they walk in. **No re-enrollment, ever.** When the authorization window lapses the VMS removes them from the device; the Master DB record lives forever.

**Product intent:** built for a first client but designed from day one as a packaged, licensed, **multi-client product** — one codebase, per-client differences only in config, machine-bound license keys, installer with setup wizard. No client names anywhere in code or naming.

Plan vocabulary used throughout:
- **States:** `REGISTERED → PENDING_PROVISION → PROVISIONED → INSIDE → PENDING_DEPROVISION → REGISTERED`
- **Retention window** — how long a vendor stays loaded on the device (default 1 day, up to custom ranges)
- **Entry mode** — `SINGLE_ENTRY` (one IN+OUT per day, enforced by a day-block after OUT plus a daily reset) or `MULTI_ENTRY` (unlimited)
- **Path A** — VMS speaks the device's PUSH/ADMS HTTP protocol directly (preferred; pure Node)
- **Path B** — VMS drives eSSL's middleware (eTimeTrackLite) via its SOAP API
- **Phase 0** — prove the hardware can do what the plan assumes, before writing app code

---

## 2. The hardware — ordered vs delivered

One unit in hand; the second (OUT gate) has not arrived. Sold as **eSSL AiFace-Arion**. The actual unit contradicts the published Arion spec sheet in three ways:

| Item | Spec sheet / paperwork | Actual (device firmware) |
|---|---|---|
| Face capacity | 6,000 | **3,000** |
| Wi-Fi | Listed as supported | **Absent** — no Wireless Network option in COMM. |
| Serial (paperwork) | `SYZ8251400179` | — |
| Serial (box label) | `AJE1260300753` | — |
| **Serial (firmware — authoritative)** | — | **`NCD8252500406`** |

Device identity (Menu → System Info → Device Info, and confirmed via the `INFO` command):

| | |
|---|---|
| Device Name | `x2008` |
| Platform | `ZAM180_TFT` |
| Firmware | `ZAM180-NF50VA-Ver3.4.10` |
| ADMS/Push version | `Ver 2.0.33S-20220623` |
| Face algorithm | `Face VX3.9` (`FaceVersion=39`, `MultiBioVersion` type 9 → `39.3`) |
| MAC | `00:17:61:13:19:b0` |
| MCU | `203` |

Capacities: users 3,000 · faces 3,000 · BioPhotos 3,000 · cards 3,000 · **T&A records 150,000** (PRD assumed 200,000) · T&A photos 1,000 · blocklist photos 500.

Capability flags from `INFO`: `FaceFunOn=1`, `BioPhotoFun=1`, `VisilightFun=1`, `UserPicURLFunOn=1`, `PhotoFunOn=1`, `FingerFunOn=0`, `IsSupportNFC=0`, `MachineTZFunOn=1`, `AutoServerFunOn=1`.

**Standing rule:** never trust the spec sheet, box, or invoice for this hardware. Read capabilities off the device. `device.serial_no`, `device.max_faces` and `device.faces_used` all come from the device's own `INFO` response.

**Plan impact:** worst-case ~1,500 simultaneous vendors is ~50% of 3,000, not 25% of 6,000. Still viable. `MAX_FACES` guard ≈ 2,800; alerts ≈ 2,100 / 2,550. Deployment is Ethernet-only.

---

## 3. Network & environment

| Thing | Value |
|---|---|
| Device | `192.168.0.25` — static (DHCP off), mask `255.255.255.0`, gateway & DNS `192.168.0.1`, TCP port 4370, LAN cable to router |
| Laptop (Windows) | `192.168.0.106` on the same router's Wi-Fi |
| eTimeTrackLite | `http://192.168.0.106:83/iclock/Main.aspx` — login `essl`; IIS site `essl`, app `/iclock`, path `C:\eTimeTrackLiteWeb\eTimeTrackLiteWeb\`, SQL Server backend |
| Node ADMS test server | `192.168.0.106:8080`, project at `C:\Work\Essl` |

**The device has ONE Cloud Server setting** (Menu → COMM. → Cloud Server Settings: Mode `ADMS`, Address, Port). eTimeTrackLite and the Node server cannot both own it — switching between them means changing the port (`83` ↔ `8080`). This is PRD §16 Risk #3 in miniature: one owner per device roster, always.

Setup traps already debugged — do not re-solve these:
- Device shipped on static `192.168.1.201`, wrong subnet; fixed via DHCP then pinned static at `.25`
- Gateway was `0.0.0.0`, which blocks NTP and anything off-subnet; set to `192.168.0.1`
- **Windows Firewall silently drops inbound traffic.** Each port needs an explicit rule or the device's POSTs vanish with no error:
  `netsh advfirewall firewall add rule name="VMS ADMS 8080" dir=in action=allow protocol=TCP localport=8080` (elevated prompt)
- **Verify firewall rules from a phone on the same Wi-Fi**, never from the laptop — Windows does not firewall traffic to itself, so local tests always pass
- The device's **Network Diagnosis** reports failure against the laptop even when everything works, because Windows does not answer ICMP. Red herring.
- eSSL devices often need a **reboot** before changed Cloud Server settings take effect
- Browsing eTimeTrackLite's **site root** (`:83/`) throws `Request is not available in this context` — a known ASP.NET pipeline bug, harmless; always use `/iclock/Main.aspx`
- eTimeTrackLite ships demo device records (`Mobile`, `TD`, `ME(...)`) that appear as offline devices — noise, safe to delete

Outstanding: router DHCP reservation binding MAC `00:17:61:13:19:b0` → `192.168.0.25` (or confirm `.25` is outside the DHCP pool).

---

## 4. ADMS / PUSH protocol reference — as actually observed on this firmware

**This section is the highest-value output of Phase 0.** It was derived by observation, and firmware behaviour varies by batch, so treat it as authoritative for `ZAM180_TFT` / FW `3.4.10` / Push `2.0.33S`.

### 4.1 Shape of the conversation

The device initiates everything. The server never connects to the device. The device POSTs data and polls for commands.

**Polling is adaptive:** ~30 seconds when idle, but **1–3 seconds immediately after any activity**, backing off gradually (observed 1s, 1s, 3s, 5s, 8s… → 30s). This matters: a command queued in response to a punch lands within a couple of seconds, so §6's "a few seconds" turnaround-race assumption holds.

### 4.2 Endpoints — note the `.aspx` suffix

This firmware calls the endpoints **with `.aspx`**. Much ADMS documentation shows the bare form; this unit does not use it. Serve both defensively.

| Endpoint | Purpose |
|---|---|
| `POST /iclock/cdata.aspx?SN=&table=&Stamp=` | device pushes data (punches, user records, photos) |
| `GET /iclock/getrequest.aspx?SN=` | device polls for queued commands |
| `POST /iclock/devicecmd.aspx?SN=` | device reports command results |
| `POST /iclock/fdata.aspx?SN=` | biometric/photo payload uploads |

After executing a command the device appends its state to the next poll:
`?SN=...&INFO=ZAM180-NF50VA-Ver3.4.10,1,0,16,192.168.0.25,10,39,12,1,01110,0,0,0` — firmware, counts, IP, capability flags. A free health check every round trip; useful for `device.last_seen_at` and drift detection.

### 4.3 Command format — the `C:<id>:` prefix is mandatory

Commands are returned in the body of the `getrequest` response as:

```
C:<CmdID>:<COMMAND>
```

**A bare command with no prefix is silently discarded** — no error, no acknowledgement, no `devicecmd` call. This cost real debugging time.

The device replies on `/iclock/devicecmd.aspx`:

```
ID=<n>&Return=0&CMD=DATA
```

`Return=0` = success. **The protocol therefore provides native per-command acknowledgement with a correlation ID** — this maps directly onto `sync_command.status` / `attempts` in PRD §8. No tracking mechanism needs inventing.

Fields within a command are **TAB-separated**.

### 4.4 Commands confirmed working

| Command | Effect |
|---|---|
| `INFO` | full device info dump (see §2) |
| `DATA QUERY USERINFO PIN=<pin>` | device pushes back USER + BIODATA + BIOPHOTO records |
| `DATA UPDATE USERINFO PIN=<pin><TAB>Name=<name><TAB>Pri=0` | create/update user |
| `DATA UPDATE BIOPHOTO PIN=<pin><TAB>FileName=<pin>.jpg<TAB>Type=9<TAB>Size=<bytes><TAB>Content=<base64 JPEG>` | **push a photo; device generates a face template from it** |
| `DATA DELETE USERINFO PIN=<pin>` | remove user from device |
| `DATA UPDATE USERINFO PIN=<pin><TAB>Grp=100` | **block** — deny access, biometric untouched |
| `DATA UPDATE USERINFO PIN=<pin><TAB>Grp=1` | **unblock** — restore access |
| `REBOOT` | restart |

Also present in eTimeTrackLite's command vocabulary (equivalents to be confirmed on Path A): block/unblock users, enroll face, clear logs, unlock door, change IP/gateway/subnet/server, reset transaction/op/att-photo stamps, `Get ATTLOG By Datetime`.

### 4.5 Record formats

**Punch** (`table=ATTLOG`), tab-separated:

```
9001 <TAB> 2026-07-28 22:40:21 <TAB> 1 <TAB> 15 <TAB> 0 <TAB> 0 <TAB> 0 <TAB> 0 <TAB> 0 <TAB> 0
```

| # | Meaning |
|---|---|
| 1 | user ID (PIN) |
| 2 | timestamp — **device local time, not UTC** (device TZ was `330` = +05:30) |
| 3 | status / attendance-state code |
| 4 | **verify mode — `15` = face** |
| 5–10 | work code and reserved |

Field 3 is a per-punch status the eTimeTrackLite report never exposed. **It is the device's attendance-state code, and it is controllable — see §4.9.**

### 4.9 Punch state: field 3 IS per-punch direction (4 Aug 2026)

The device stamps its current *attendance state* on every ATTLOG record. Field 3 had always read `1` not because the device cannot vary it, but because this unit is pinned to a fixed state — and `1` is the code for that state.

**Menu paths, recorded verbatim from the terminal:**

```
Menu > Personalize > Punch State Options
    Punch State Mode      Off | Manual Mode | Auto Mode |
                          Manual and Auto Mode | Manual Fixed Mode | Fixed Mode
    Punch State Required  (toggle)
    Fixed Punch State     Undefined | Check-In | Check-Out | Break-Out |
                          Break-In | Overtime-In | Overtime-Out

Menu > Personalize > Shortcut Key Mappings
    F1 Check-In   F2 Check-Out   F3 Break-Out
    F4 Break-In   F5 Overtime-In F6 Overtime-Out

Menu > System > Attendance
    Duplicate Punch Period(m)  1
    Recognition Interval(s)    1
    Authentication Timeout(s)  3
    Camera Mode                No photo
```

**As shipped to us:** `Punch State Mode = Fixed Mode`, `Fixed Punch State = Check-Out`, and every punch carries field 3 = `1`. The state list order matches the F1–F6 mapping, giving the standard code assignment:

| Code | State | |
|---|---|---|
| `255` | **Undefined** | observed |
| `0` | Check-In | observed |
| `1` | Check-Out | observed |
| `2` | Break-Out | inferred |
| `3` | Break-In | inferred |
| `4` | Overtime-In | inferred |
| `5` | Overtime-Out | inferred |

**`255` is not an index into the menu list — it is `0xFF`, "no state".** Its existence is what makes the rest of the table coherent: the list *displays* `Undefined` first, so a naive reading would put Check-In at `1`. Check-In is `0`, which means the displayed order is not the numbering, and `Undefined` sits at `255` outside the sequence. With both ends observed, codes `2`–`5` following in menu order is a much safer inference than it was.

**`0` and `1` are OBSERVED (5 Aug 2026).** With `Punch State Mode = Manual Mode`, pressing F1 then F2 nine seconds apart on the same user produced:

```
1001 | 2026-08-05 16:28:26 | 0 | 15 | 0 | ...   F1, Check-In
1001 | 2026-08-05 16:28:35 | 1 | 15 | 0 | ...   F2, Check-Out
```

Both `verify=15` (face), so the key selects the state and the face scan commits the record — the keypress alone logs nothing. Device-local 16:28:26 normalised to 10:58:26 UTC confirms the +05:30 offset end to end.

**`255` (Undefined) also occurs in normal use** (observed 5 Aug 2026). In Manual Mode the F-key selection is not sticky: if nothing was pressed, or the selection lapsed before the face matched, the device stamps `255` — it is reporting *no answer*, not a direction.

This is frequent enough that handling it is load-bearing rather than defensive. It must never be mapped to IN or OUT: guessing IN would walk a departing vendor back inside. The VMS alternates from the entry's current state instead, which is right far more often than any fixed guess and cannot invent a movement that did not happen.

`Menu > Personalize > Punch State Options > Punch State Required` would force a state to be chosen and eliminate `255` — **but leave it off.** It makes a missed keypress into a refused entry, and a vendor denied at the barrier because they did not press F1 is a worse failure than a direction inferred from context. The VMS is not in the barrier path (CLAUDE.md #9) and must not create a way to be.

Codes `2`–`5` remain inferred from list order; nothing depends on them.

**What this means for the product.** Direction is available per punch, not only per device:

- **Production (two devices):** put the IN terminal in `Fixed Mode / Check-In` and the OUT terminal in `Fixed Mode / Check-Out`. Direction then arrives *stamped on the record* and independently corroborates device identity — if the two ever disagree, something is misconfigured and the system can say so instead of silently trusting a wire.
- **Single-device testing (now):** `Manual Mode` lets the user press F1 or F2 before presenting their face, producing both IN and OUT records from one terminal. This is the real replacement for the "altinout" idea, and unlike altinout it is a device-side fact rather than middleware labelling.

`punch_event.status_code` already stores this, so no schema change is needed.

### 4.10 The device suppresses repeat punches at source

`Menu > System > Attendance > Duplicate Punch Period(m)` is **1** on this unit. A second punch by the same user inside that window is refused **on the device** — it displays a duplicate-punch notice and **no record is sent to the server at all**.

This is not our deduplication (which works on `raw_record_hash` and would have stored the record). It happens earlier, and the punch is simply invisible to the VMS.

**Consequences for Phase 2:**
- A vendor who enters and leaves within the window produces **one** punch, not two. The state machine must not assume every physical movement generates a record.
- SINGLE_ENTRY enforcement keys off the OUT punch; if that OUT falls inside the window after the IN, it never arrives, and the day-block never fires.
- The window is device configuration, so it is a **per-device setting the VMS should record and surface**, not a constant to be assumed.
- It also explains why rapid manual testing appears to "lose" punches — set it to `0` while testing, and decide a sensible production value deliberately.

**Answered 5 Aug 2026: the window is per USER, not per punch state.** Changing the punch state between attempts does not evade it — a Check-Out within the window of a Check-In by the same user is still refused as a duplicate. (The two Manual Mode punches nine seconds apart in §4.9 were delivered only because `Duplicate Punch Period(m)` had been set to `0` for that test.)

So a vendor who enters and leaves inside the window produces **one** record — the IN — and the OUT is never sent. This is the pessimistic case, and it makes the setting a **correctness precondition rather than a preference**:

- **`Duplicate Punch Period(m) = 0` is mandatory for a single-terminal (`role = BOTH`) deployment.** SINGLE_ENTRY's day-block triggers on the OUT punch; if the OUT can be suppressed, single-entry silently degrades to multi-entry. That is a security failure, not a logging gap. Device onboarding must verify this setting, not assume it.
- **A two-gate deployment is largely immune,** because the window is enforced against the *local* device's own log: the IN is recorded on the IN terminal and the OUT on the OUT terminal, so neither sees a recent punch by that user. This is worth confirming when the second unit arrives, but it follows from the setting being device-local.
- **The state machine must tolerate a missing OUT regardless.** Devices get reconfigured, people tailgate through an open barrier, and records can be lost for reasons that have nothing to do with this setting. An entry that is still `INSIDE` past its retention window must be **surfaced**, not silently deferred forever by the sweeper.

**Unresolved and worth a minute at the terminal: does the barrier still open on a suppressed punch?** The device displays a duplicate-punch notice, but it is not established whether the lock relay fires anyway. The two outcomes have opposite consequences and both argue for `0`:

- Relay fires, no record → the barrier opens and the VMS never knows. A blind spot in the movement log.
- Relay does not fire → a vendor who enters and immediately turns around is physically unable to leave until the window lapses.

**Whether the VMS can read this setting from the device is unknown.** `INFO` does not report it. The ZK push protocol has option get/set verbs that may expose it under some option name; worth probing in Phase 3 so onboarding can verify rather than instruct.

**User record** (`table=OPERLOG`):

```
USER PIN=9001  Name=TEST ONE  Pri=0  Passwd=  Card=  Grp=1
     TZ=0000000100000000  Verify=-1  ViceCard=  StartDatetime=0  EndDatetime=0
```

| Field | Meaning |
|---|---|
| `Pri` | privilege — 0 = normal user |
| `Grp` | access group |
| **`TZ`** | 16-char time-zone / access-window mask — **what block/unblock manipulates** |
| `Verify` | verification mode, `-1` = device default |
| `StartDatetime` / `EndDatetime` | per-user validity window — **present but NOT ENFORCED, see below** |

**Access control is resolved through `Grp`, not `TZ`.** Confirmed by letting eTimeTrackLite run `Block Users From Device` and diffing the user record: the only field that changed was `Grp: 1 -> 100`. `TZ` was untouched. Two independent `TZ` hypotheses (`0000000000000000` and `0001000000000000`) were accepted by the device with `Return=0` yet had no effect on access — the personal `TZ` field appears to be ignored or overridden by group membership.

- Group `1` = normal, always allowed
- Group `100` = no valid access window → `Invalid time period`

Both directions confirmed working on Path A, fully reversible, **biometric untouched** (BIODATA and BIOPHOTO survive every `DATA UPDATE USERINFO`). The SINGLE_ENTRY day-block is therefore a group swap, and `entry.day_blocked` maps to "user is in the blocked group".

**Open question for deployment:** does group 100 exist on a factory-fresh device, or did eTimeTrackLite create it? This unit can no longer answer that — it has already been touched. **Test on the second device while it is still factory-fresh.** If the group is not a factory default, the VMS must create or verify one during device onboarding (§13.1 setup wizard). Group IDs should be per-device configuration rather than constants, since numbering may vary by firmware.

#### `StartDatetime` / `EndDatetime` are stored but NOT enforced

Both fields accept writes and persist, but **the device ignores them.** A user whose `EndDatetime` resolved to January 2026 — months in the past — was still recognized and admitted. Investigation closed.

| Sent | Stored | Effect |
|---|---|---|
| `1785300000` | `17850100` | none |
| `20260729` | `20260100` | none |

The encoding was never determined: the year survives intact while everything after it collapses to `0100`, even though `07`/`29` are valid month/day values. No clean scheme fits both observations. Moot, since the field has no effect regardless.

**Consequence:** §5 assumed device-native expiry was Path-B-only via `UpdateEmployeewithExpiryDates` and hoped Path A had an equivalent. It does not. **The expiry sweeper is load-bearing, not a backstop** — it is the only thing removing lapsed vendors from the device. §10's reconciliation job therefore carries real security weight: a missed de-provision leaves a vendor able to open the barrier until reconciliation notices. Treat reconciliation frequency and reliability as security requirements (§16 Risk #4), not housekeeping.

No change to the state machine or data model — the sweeper was always specified. This removes an optimisation that was never depended upon.

#### `Return=0` means "processed", not "valid"

A command containing the literal placeholder text `EndDatetime=<value>` was accepted with `Return=0`. **The device does not validate payloads.** The sync engine must validate before sending; a success return code is no guarantee the value was sensible. Relevant to §10's retry and idempotency design.

**Biometric template** (`table=BIODATA`):

```
BIODATA Pin=9001  No=0  Index=0  Valid=1  Duress=0  Type=9
        MajorVer=39  MinorVer=3  Format=0  Tmp=<base64>
```

`Type=9` = face. Version matches `Face VX3.9`. Algorithm-bound — cache only as a same-device optimisation, never as the durable artifact.

**Enrollment photo** (`table=OPERLOG`) — **the artifact everything depends on**:

```
BIOPHOTO PIN=9001  FileName=9001.jpg  Type=9  Size=59128  Content=<base64 JPEG>
```

~59 KB, full photographic resolution. This is what goes into `vendor_biometric.photo`.

### 4.6 Other protocol notes

- **`Stamp` / `OpStamp` are inert on this firmware — ANSWERED 5 Aug 2026.** They were assumed to be incremental-sync markers the device advances to track what the server has acknowledged, with "mishandling risks replayed or dropped punches" listed as a hazard. **Both have read `9999` on every request ever observed** — 58 punches across two days, several disconnects and reboots, plus the `9999` eTimeTrackLite showed in Phase 0. They are constants, not counters.

  **Consequences:** there is no incremental sync to get wrong, and no replay-or-drop risk from these fields. There is also **no Stamp-based backfill** — a gap in punch history (say, a database restored from backup) cannot be recovered by asking the device to resume from an earlier marker. What protects punch integrity is the `raw_record_hash` dedup, which is independent of these fields.

  The handshake is a `GET /iclock/cdata`; data pushes are `POST`s. We answer the handshake with a bare `OK`, **and so did the Phase 0 reference server that proved every capability on this hardware** — nothing this firmware requires is missing.
- Bodies arrive with unusual or absent content-types; parse as raw buffers or requests get rejected.
- `INFO` reported `MainTime=1970-01-01 00:00:00` despite punch timestamps being correct — unexplained, worth understanding before relying on device-side time to enforce `StartDatetime`/`EndDatetime`. Still 1970 as of 5 Aug 2026.

- **The full `INFO` reply is 74 key/value pairs, and is now stored verbatim** on `device.last_info` (5 Aug 2026). Only firmware, face count and capacity are acted on; the rest is kept because the device is the only authority on what it can report, and three printed specifications have already proven wrong. Notable keys observed:

  | Key | Value | Note |
  |---|---|---|
  | `TransactionCount` | `97` | attendance records held **on the device** — the basis of punch-loss detection |
  | `UserCount` / `FaceCount` | `1` / `1` | matches one provisioned vendor |
  | `~MaxFaceCount` | `3000` | exact, and confirms the Phase 0 finding over the spec sheet's 6,000 |
  | `~MaxAttLogCount` | `15` | **not literal** — the log holds ~150,000 |
  | `~MaxUserCount` | `30` | **not literal** — the device holds 3,000 faces |
  | `MultiBioVersion` | `0:0:...:39.3` | face algorithm 39.3, matching `Face VX3.9` |

  The tilde-prefixed maxima are **not** in consistent units: `~MaxFaceCount` is exact while `~MaxAttLogCount` and `~MaxUserCount` clearly are not. **Do not derive capacity from them** — `~MaxFaceCount` is the only one corroborated by testing.
- **A fresh on-device enrollment auto-pushes the USER record and the BIODATA template, but NOT the BIOPHOTO.** Confirmed 3 Aug 2026 over raw ADMS by enrolling a new user and watching every request: the device sent the USER record (`cdata?table=OPERLOG`), the face template (`cdata?table=BIODATA`), and several `OPLOG` operation-audit lines — **no photo, and no `fdata` call at all**; the on-device face count still incremented. The enrollment photo must be pulled explicitly with `DATA QUERY USERINFO`, which returns USER + BIODATA + BIOPHOTO via `cdata?table=OPERLOG`. (Phase 0 Stage A's "device auto-pushes user + photo on enrollment" was observed *through eTimeTrackLite*, which evidently issues that query itself.) **Implementation consequence:** on learning of a PIN with no stored photo, the backend auto-enqueues `DATA QUERY USERINFO` to pull it — this is what makes device-first registration hands-free. (An earlier guess that the photo arrived via `fdata` and was being dropped was **wrong** — the photo simply isn't auto-sent.)
- **There is no way to enumerate the device roster, and that shapes two features.** No "list every user" command has been established on this firmware. Every USER record is an *observation* — the device volunteered it, or we asked about one specific PIN with `DATA QUERY USERINFO`. You cannot ask a terminal who it is holding.

  **Consequence 1 — reconciliation works from observations,** manufacturing more of them at a controlled rate rather than diffing against an authoritative dump (`services/reconcile.ts`).

  **Consequence 2 — adopting an already-populated terminal needs a brute-force scan.** A site whose device already holds years of enrollments generates no traffic for those people: no enrollment record, no menu edit, and reconciliation never asks because it only checks vendors already in the database. They are invisible indefinitely. The only remedy is to ask about each PIN in a range and see what comes back (`services/backfill.ts`, operator-triggered per device).

  The entire cost is queue pressure: `getrequest` hands out **one command per poll**, ordered by `seq`, so a scan that queued its whole range at once would starve every operator provision behind it. It keeps 50 queries in flight, refilled on a one-minute tick, and skips PINs whose photo is already on disk. Progress lives in `app_config`, so it survives a restart.

  **A vendor with no face enrolled cannot be found this way** — `QUERY_USER` returns their USER record but no `BIOPHOTO`, nothing reaches `photos/`, and the unclaimed-enrollments panel is driven by what is on disk.

- **A face on the device that we did not put there must not be auto-removed.** Registering someone from an unclaimed enrollment sets `vendor.adopted_from_device`. Without it, `reconcileUserRecord` — which queues a `DEPROVISION` for any vendor on a device with no active entry — would delete an enrollment the client made themselves, triggered by nothing more than a USER record arriving between registration and provisioning. A backfill scan makes that trigger routine rather than rare, which is how the interaction was found. The flag is cleared when we provision them, at which point they are an ordinary managed vendor and the self-heal applies in full.

  Deliberately a column, not "has a `PROVISION` ever existed": retention prunes completed commands for closed entries, so the derived form silently stops protecting real vendors months later.

- **`OPLOG` operation-audit records** also arrive on `cdata?table=OPERLOG`, shape `OPLOG <opcode>\t0\t<YYYY-MM-DD HH:MM:SS>\t<pin>\t0\t0\t0` (opcodes seen: 4, 30, 70, 101, 103 around enroll events; also 108 for menu toggles like `VoiceOn`/`KeyPadBeep`, subject not a PIN). Confirmed live (Phase 6 field testing) that **a face enrolled directly on the terminal pushes only this line — no USER or BIOPHOTO record follows on its own.** Parsed since: any OPLOG whose subject is PIN-shaped triggers the same auto-pull `DATA QUERY USERINFO` used elsewhere (`ingest.ts`), which is what actually populates the unclaimed-enrollments panel for a device-first enrollment. Not filtered by opcode — the mapping above is observational, not documented by eSSL, and firmware varies by batch.

---

## 5. Phase 0 Stage A — proving the hardware (via eTimeTrackLite)

Stage A used the vendor's own software to prove the *hardware* can do what the product needs, so that hardware failures and code failures stay separable. Test user **`9001` / `TEST ONE`** (Chirayu's own face).

| Test | Result |
|---|---|
| A1–A2 Enroll on device; sync to server | ✅ device **auto-pushes** user + photo on enrollment; no download command exists or is needed |
| A3–A4 Photo retrievable server-side | ✅ Masters → Employee → `BioPhoto`; stored as SQL BLOB (not in the IIS `Photos` folder, which holds only app assets); served inline as base64; same page also **uploads** a photo back |
| A5 Normal recognition | ✅ sub-second; punches arrive near-real-time |
| A6 Delete from device | ✅ `Delete Users From Device`; **employee record + photo survive on the server** — the separation the product depends on |
| **A7 Push photo → biometric regenerated** | ✅ `Upload Users To Device` with `Face` ticked; **face count 0 → 1** |
| **A8 Live recognition without re-enrollment** | ✅ **premise confirmed** |
| A9 Block / unblock | ✅ clean and reversible |
| A10 Punch record fields | ✅ direction is device-level config; `altinout` mode exists |

**A8's proof came from the block test screen**, which read `Failed to verify. Error! Invalid time period — User ID: 9001, Verify: Face`. The device *identified* a face it had never physically enrolled, then denied on authorization grounds.

Two findings that changed the design:

**`AIFace` vs `Face` are different biometric types.** eTimeTrackLite's upload picker showed `Face = 0`, `AIFace = 1` for user 9001. `Face` is the legacy infrared template — algorithm-bound and non-portable. **`AIFace` is the visible-light AI face this device uses, derived from the BioPhoto.** The hardware agrees with the PRD's core decision: the photo is the portable artifact.

**Blocking does not make a vendor unrecognizable.** The device identifies, then denies on a time-period rule. Better than planned: denials are attributable rather than silent. §6's hedge about disable being unreliable can be dropped. **However, denied attempts do not reach the server** — the blocked attempt at ~21:43 never appeared in Log Records (punches at 21:37:56 and 21:44:58 bracket it). SINGLE_ENTRY is enforceable but its violations are currently invisible.

---

## 6. Phase 0 Stage B — proving our own code (Path A, raw protocol)

Stage B repointed the device from eTimeTrackLite (port 83) to the Node test server (port 8080) and replicated every primitive in raw ADMS.

| Primitive | Result |
|---|---|
| Receive check-ins and punches | ✅ raw `ATTLOG` captured and decoded |
| `INFO` — device interrogation | ✅ full capability dump |
| `DATA QUERY USERINFO` | ✅ returns USER + BIODATA + **BIOPHOTO (full JPEG)** |
| `DATA UPDATE USERINFO` — create user | ✅ `Return=0` |
| `DATA DELETE USERINFO` — delete user | ✅ face count drops, recognition stops |
| **`DATA UPDATE BIOPHOTO` — push photo** | ✅ **face count returns, live recognition works** |
| Block / unblock (`Grp=100` / `Grp=1`) | ✅ both directions, reversible, biometric preserved |

**The complete product lifecycle was executed over raw HTTP with no middleware:**

1. Query user → device pushes photo → server saves it to disk (stands in for the Master DB)
2. Delete user from device → face count `1 → 0`, no longer recognized
3. Recreate user identity → present on device, face count still `0`
4. Push saved photo back → **face count `0 → 1`**
5. Walk up → **recognized, no re-enrollment**

**Path A is proven. The VMS can own the device end to end in pure Node/TypeScript** — no middleware licence, no Windows dependency, no .NET bridge.

Two architectural wins from the user record format:

**Blocking is a group swap.** `Grp=100` denies access with `Invalid time period`; `Grp=1` restores it. Reversible, and the biometric is untouched throughout. The SINGLE_ENTRY day-block in §6 is therefore trivial to implement, and the PRD's hedge about falling back to temporary deletion can be dropped. Found by observing eTimeTrackLite rather than guessing — see §4.5.

**Device-native retention windows are not available.** `StartDatetime` / `EndDatetime` exist and accept writes but are ignored by the firmware. The expiry sweeper is load-bearing rather than a backstop, which raises the importance of §10 reconciliation as a security control. See §4.5.

---

## 7. Assets built

**`vms-adms-test-server/`** (at `C:\Work\Essl`) — Node/Fastify Phase 0 rig, now a genuinely useful reference implementation:
- Serves both `/iclock/<name>` and `/iclock/<name>.aspx` for all four endpoints
- Catch-all request logger — this is what revealed the `.aspx` suffix; unknown paths are logged rather than silently 404'd
- Assigns `C:<id>:` command IDs automatically and correlates `devicecmd` replies back to the original command with SUCCESS/FAILED
- Parses USER / BIODATA / BIOPHOTO records and prints the fields that matter
- **Auto-saves received BioPhotos to `./photos/<PIN>.jpg`**
- Browser helpers: `/queue?cmd=...`, `/push-photo?pin=9001[&as=9002]`, `/photo?pin=9001`
- Accepts any content-type as a raw buffer; 20 MB body limit for photo payloads

**`PHASE_0_CHECKLIST.md`** — granular test-by-test record with every result annotated.

**This document.**

---

## 8. Where things stand, and what is next

**Phase 0 is effectively complete.** The project-defining question is answered: register-once / push-many works on this hardware, and works over the raw protocol our own stack speaks. **PRD §16 Risk #1 is closed. §15 open questions #1, #2 and #3 are answered.**

**Path decision: Path A.** Not by elimination — Path B also works and remains a proven fallback, which is a comfortable position. Path A wins on merit: no middleware licence, no Windows/IIS/SQL Server dependency, pure Node, real-time push, full control, and native command acknowledgement.

### Before writing application code — finish Stage B and do Stage C

Roughly a day's work, and each item directly shapes the data model or the entry-mode design. Discovering any of them mid-Phase-1 means rework.

1. ~~Block / unblock on Path A~~ — **DONE.** It is a `Grp` swap (100 = blocked, 1 = normal), not a `TZ` change. See §4.5.
2. ~~`StartDatetime` / `EndDatetime`~~ — **DONE (negative result).** Stored but not enforced; the sweeper is load-bearing. See §4.5.
3. **`altinout` direction mode.** With one device this is the only way to exercise IN → OUT cycles, which the state machine (§5) and day-block logic (§6) both need. Also check whether ATTLOG field 3 changes with it — if it carries direction, Path A gets per-punch direction instead of inferring from device identity.
4. **Denied attempts.** Try `Get ATTLOG By Datetime` (or its raw equivalent) over a window containing a blocked attempt. If denials are retrievable, SINGLE_ENTRY violations become auditable.
5. **`MainTime=1970-01-01`** — understand it before relying on device-side time for expiry enforcement.
6. ~~Stage C: update the PRD to v4~~ — **DONE (2 Aug 2026).** PRD v4 shipped, superseding v3 entirely; see the status note in §9.

### Then Phase 1 — now under way

Master DB schema, vendor registration, photo storage, and manual push / block / de-provision working end to end against this device. Config-driven from the first commit — no client names, no client-specific conditionals.

**Progress:** Milestones 0–4 are complete and **all verified against real hardware** — environment (PostgreSQL 17, backend/web scaffolds, zod config), data model (Prisma schema, migrations, seed), ADMS device layer (endpoints, command queue, ingestion), vendor registration (CRUD, photo upload, device-first auto-attach), and manual device operations (provision / block / unblock / de-provision / query, plus queue visibility and retry).

**The Phase 1 definition of done has been met on the terminal (3 Aug 2026):** register → provision → the barrier opens → block → denied → unblock → admitted → de-provision → gone from the device but fully retained in the database → re-provision → recognised again **with no re-enrollment**. That last step is the premise the whole product rests on, and it is now demonstrated rather than argued.

**Photo storage is decided: local disk remains the primary store** (Chirayu + team, 3 Aug 2026), so durability is a backup problem rather than an architecture one. Milestone 5 (basic UI) is complete and walked through in the browser — login, a live punch feed updating instantly, vendor registration, and the whole barrier cycle driven from the UI. **Phase 1 is complete.** Milestone 6 closed 4 Aug 2026: the automated half — `npm run verify:e2e` drives the real app against a simulated terminal on a separate `_test` database and asserts 41 behaviours including the hot-path query budget, all passing. and the hardware run from a clean install covered enrollment through de-provisioning, re-provision with no re-enrollment, and a physical device unplug/reconnect. **The remote-Postgres check is deferred by decision (4 Aug 2026) — Phase 1 ships on local PostgreSQL only;** see `PHASE_1_PLAN.md` for the residual risk that leaves. The authoritative progress log with per-milestone decisions is `PHASE_1_PLAN.md` § Progress.

The test server is effectively a working prototype of the device-integration layer; Phase 1's sync engine can be built directly from it.

**Waiting on:** second device (OUT gate); supplier conversation about the three hardware discrepancies — half the quoted face capacity is the substantive one.

---

## 9. PRD v4 changes queued

**Status: PRD v4 has been drafted and applies this list.** Two bullets below (blocking mechanism, retention backstop) originally reflected an earlier, less complete understanding and were corrected during the v4 rewrite by following §4.5's actual findings rather than this list as first written. Both are shown here already corrected, so this section and the shipped PRD v4 agree. Keep this section as the historical change-log; if a future v5 is drafted, diff against the PRD directly rather than this list, since a list summarizing findings can drift from the findings themselves — as happened here.

**Hardware & capacity**
- Face capacity **3,000** not 6,000 → `MAX_FACES` ≈ 2,800; alerts ≈ 2,100 / 2,550
- Transaction log **150,000** not 200,000 → log rotation ~50 days at 3,000 punches/day
- `device.max_faces`, `faces_used`, `serial_no` all sourced from the device's `INFO` response
- Serial is `NCD8252500406`; record firmware `ZAM180-NF50VA-Ver3.4.10`, platform `ZAM180_TFT`, push version `2.0.33S`
- No Wi-Fi → Ethernet-only deployment
- Add a standing note: verify every hardware assumption against the physical unit

**Integration**
- **Path A confirmed and chosen**; Path B proven as fallback
- Add §4 protocol reference: `.aspx` endpoints, `C:<id>:` command prefix, `ID=&Return=` acknowledgement, TAB-separated fields, adaptive polling
- `sync_command` maps onto the protocol's native command ID + return code — no invented tracking needed
- Record all confirmed command syntax verbatim

**Biometrics**
- §16 Risk #1 **closed**
- Name the **`AIFace` vs `Face`** distinction explicitly; `vendor_biometric.algorithm_version` = `Face VX3.9` (`Type=9`, `MajorVer=39 MinorVer=3`)
- BioPhoto is a full JPEG (~59 KB) retrievable via `DATA QUERY USERINFO` and pushable via `DATA UPDATE BIOPHOTO`

**Entry modes & blocking (§6)**
- Drop the "disable may be unreliable, fall back to temporary delete" hedge
- Correct the model: the device **identifies then denies** on a time-period rule; blocking is a **`Grp` swap** (confirmed: `Grp=100` blocks, `Grp=1` unblocks — the earlier `TZ`-mask hypothesis was tested twice and disproven; see §4.5). Group IDs are per-device config.
- **Denials are not pushed to the server** — note as a limitation pending item 4 above
- Turnaround race stays "a few seconds" — adaptive polling means commands land in 1–3s after activity

**Retention (§5, §16 Risk #4)**
- **CORRECTED (was speculative when this list was first drafted, now settled by §4.5 / B8b): there is NO device-native expiry backstop.** `StartDatetime` / `EndDatetime` are stored but not enforced — a user with a months-lapsed `EndDatetime` was still admitted. The expiry sweeper is load-bearing, not a backstop, and §10 reconciliation is a security control accordingly. Risk #4 is elevated, not reduced.

**Punches (§8)**
- `punch_event` gains verify mode (`15` = face) — distinguishes face entry from card/password fallback, real audit value
- Timestamps are device-local; store device timezone and normalise on ingest
- Direction is device-level, confirming the IN-device / OUT-device model; note `altinout` as the single-device testing mode
- Handle `Stamp` / `OpStamp` correctly for backfill and crash recovery

---

## 10. Working practices that have paid off

- **Verify against the physical hardware; trust nothing printed.** Every spec-sheet assumption checked so far has been wrong in some way.
- **Prove capability through the vendor's own tooling first, then your own code.** Stage A established the hardware works; Stage B then tested only our implementation. When something failed in Stage B, the hardware was never the suspect.
- **Log everything, including unrecognised requests.** The `.aspx` discovery came from a catch-all logger. A silent 404 is indistinguishable from a dead network.
- **Record exact working syntax verbatim.** Firmware variability is the biggest ongoing risk; what works on this firmware is what matters, not what documentation says.
- **Observe the reference implementation rather than guessing at field semantics.** Two hypotheses about the `TZ` bit layout were both accepted by the device and both did nothing. Letting eTimeTrackLite perform the operation and diffing the resulting user record answered it in five minutes — and the answer (`Grp`) was not even the field being guessed at. When eTimeTrackLite can already do the thing, watch it do the thing.
- **Keep the test server running across experiments.** Its user-record diff cache is in-memory; restarting loses the baseline that makes changes visible.
- **One owner per device roster.** eTimeTrackLite and the VMS must never both manage users on one device.
- **Never write to eSSL's SQL database** to provision users; read-only at most.
- **Keep these documents current as results land**, so any session can resume from the files alone.

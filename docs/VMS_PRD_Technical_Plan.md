# Vendor Management System (VMS) — Product & Technical Implementation Plan

> **Historical architecture record through 0.3.0.** Packaged 0.4.14 is defective; 0.4.18 is the current packaged artifact. Do not use this document's Vendor schema, pattern defaults, setup, or warn-only licensing sections as current behavior. Current authority: `PEOPLE_ATTENDANCE_BRANDING_LICENSING_UPGRADE_PLAN.md`, `API_REFERENCE.md`, `LICENSING.md`, `INSTALL_GUIDE.md`, `KNOWN_ISSUES.md`, and `VERSIONS.md`.

**Type:** On-premise, packaged vendor entry/exit management product with eSSL face-recognition integration
**Hardware:** sold as eSSL **AiFace-Arion**; actual unit verified as platform `ZAM180_TFT`, firmware `ZAM180-NF50VA-Ver3.4.10` (2 units planned: IN + OUT; **the second unit has still not physically arrived** — the software gained full multi-device support in Phase 4, see §4.1 and §15 #5, but it has only ever run against one real terminal)
**Author:** Chirayu
**Status:** frozen historical v4. It supersedes v3 only; the later People releases supersede its active product/domain/licensing descriptions.

---

## 0. Confirmed hardware and what it changes

**Standing rule: verify every hardware assumption against the physical unit.** Every spec-sheet claim checked in Phase 0 was wrong in some way. Read capabilities off the device (`INFO` response), never off paperwork.

What the published AiFace-Arion spec claimed vs what the delivered unit actually is:

| Item | Spec sheet / paperwork | Actual (device firmware — authoritative) |
|------|-------|--------|
| Face template capacity | 6,000 (1:N) | **3,000** |
| Transaction (log) capacity | 200,000 | **150,000** |
| Wi-Fi | Supported | **Absent** — no Wireless Network option in COMM. |
| Serial (paperwork) | `SYZ8251400179` | **`NCD8252500406`** |
| Serial (box label) | `AJE1260300753` | **`NCD8252500406`** |

Verified device identity (Menu → System Info → Device Info, confirmed via the `INFO` command):

| | |
|---|---|
| Device name | `x2008` |
| Platform | `ZAM180_TFT` |
| Firmware | `ZAM180-NF50VA-Ver3.4.10` |
| ADMS/Push version | `Ver 2.0.33S-20220623` |
| Face algorithm | `Face VX3.9` (`FaceVersion=39`, type 9 → `39.3`) |
| MAC | `00:17:61:13:19:b0` |
| MCU | `203` |

Capacities: users 3,000 · faces 3,000 · BioPhotos 3,000 · cards 3,000 · T&A records **150,000** · T&A photos 1,000. Camera, recognition speed (< 1 s), 5-inch touchscreen, QR reading and the access-control interface (lock relay, door sensor, exit button) are as advertised.

Three consequences reshape the plan:

1. **Capacity: 3,000 faces, not 6,000.** Worst plausible case — every distinct vendor of a 1,500-movement day provisioned simultaneously — is **~50% of capacity**, not 25%. Still viable, but capacity monitoring is real rather than ceremonial: `MAX_FACES` guard ≈ **2,800**, alert thresholds ≈ **2,100 / 2,550** (§7). `device.max_faces`, `device.faces_used` and `device.serial_no` are all sourced from the device's own `INFO` response — never hardcoded, never typed from a label.

2. **Integration: Path A (direct PUSH/ADMS) is proven and chosen.** Phase 0 replicated every primitive the product needs — punch ingestion, user create/delete, photo push with live recognition, block/unblock — over the raw protocol in pure Node, with no middleware. §4 records the protocol as actually observed on this firmware. Path B (eSSL middleware) is also proven and remains a fallback.

3. **No Wi-Fi → Ethernet-only deployment.** Site network planning must assume a LAN cable to each device.

**The project's single largest assumption is now verified, not pending.** After deleting a vendor from the device, re-pushing their stored enrollment photo regenerates a working face template — **no physical re-enrollment**. Proven twice: through eSSL's own software (Stage A) and over the raw protocol with our own code (Stage B). §16 Risk #1 is closed.

One critical distinction learned in the process: **`AIFace` vs `Face` are different biometric types.** `Face` is the legacy infrared template — algorithm-bound and non-portable. `AIFace` is the visible-light AI face this device uses, derived from the **BioPhoto**. The photo is the durable, portable artifact (`vendor_biometric`, §8, records `algorithm_version = Face VX3.9`, `Type=9`, `MajorVer=39 MinorVer=3`); any cached raw template is a same-device optimization only.

---

## 1. The problem and the product

Vendors currently must be enrolled on the device to enter, and are removed after leaving. Without a system of record above the device, a returning vendor has to **re-register from scratch on every visit** — re-entering details and re-capturing their face. At 1,200–1,500 vendor movements/day this is slow, repetitive, and error-prone.

With the verified capacity of 3,000 faces, fitting a full day's vendors onto the device is workable but not lavish — the worst case uses about half the device. The problems are:

- **Repetition:** no permanent vendor identity survives device cleanup, so registration repeats.
- **Authorization:** entry should require explicit approval by an authorized person, per visit or per validity period — with control over both **how long** access lasts and **how often per day** it may be used.
- **Hygiene & security:** vendors left on the device indefinitely can open the barrier indefinitely. Stale entries are an access-control hole — and this firmware provides **no device-native expiry** (§5), so cleanup is entirely the VMS's job.
- **Visibility:** who is inside right now, who entered when, full audit trail, reports.

The VMS solves all four with one idea: **register once in a permanent Master DB; treat the device as a managed, time-bounded working set.** Vendors are pushed to the device when authorized, live there for a configurable retention window under a configurable entry mode, and are automatically removed when the window lapses — while their identity and photo remain in the Master DB forever, ready for one-click re-authorization.

**Product vision:** built for a first client but designed from day one as a **packaged, licensed, multi-client product** (§13). One codebase; per-client differences (branding, DB connection, defaults) live entirely in configuration. Functionality is identical across clients. No client names appear anywhere in code, config, or documentation.

---

## 2. System of record vs working set

- **VMS Master DB (PostgreSQL)** = permanent **system of record**. Owns every vendor, photo, authorization, punch, and audit event forever. Never deletes vendors.
- **The face-recognition devices (+ eSSL server software, if present)** = downstream **managed working set** — the vendors currently authorized to pass. Rows here are created, blocked/unblocked, and destroyed by the VMS on schedule.

Data flows **Master → device** for provisioning/blocking/de-provisioning, and **device → Master** for punch events (pushed by the device in real time — confirmed working). Avoid the word "replica" — the Master DB leads, the device follows.

---

## 3. System overview

```
                        ┌──────────────────────────────────────────────┐
                        │        VMS Application (packaged install)     │
                        │                                               │
 Authorized Person ───▶ │  Web UI (browser on LAN; served by the       │   │
 / Admin                │  VmsWeb Windows service — no Tauri, §12)  │   │
                        │             Node/TS API (Fastify)          │   │
                        │             [runs as the VmsBackend        │   │
                        │              Windows service]              │   │
                        │                   │            │           │   │
                        │           ┌───────┘            └───────┐   │   │
                        │           ▼                            ▼   │   │
                        │  VMS Master DB (Postgres,        PUSH endpoint │
                        │  bundled service)               + command queue│
                        │  - vendors (permanent)          + sync worker  │
                        │  - photos (durable artifact,         ▲  │      │
                        │    stored on local disk)             │  │      │
                        │  - authorizations/retention/mode     │  │      │
                        │  - punches, audit, license, config   │  │      │
                        └──────────────────────────────────────┼──┼──────┘
                                   device POSTs punches (HTTP) │  │ queued commands
                                   & polls for commands        │  ▼ (add/photo/block/delete)
                        ┌──────────────────────────────────────────────┐
                        │  Device layer (LAN, Ethernet only)            │
                        │                                               │
                        │  Face terminal IN       Face terminal OUT     │
                        │  (IP from config)       (IP from config)      │
                        │        │                      │               │
                        │        ▼                      ▼               │
                        │  Flip Barrier IN        Flip Barrier OUT      │
                        │  (opened by device's own lock relay)          │
                        └──────────────────────────────────────────────┘
```

Three principles:

- **The VMS never sits in the real-time barrier path.** The device's built-in access-control interface opens the flip barrier the instant it matches a face, in under a second. The VMS controls *who is loaded (and unblocked) on the device* — that provisioning decision **is** the authorization. A VMS outage never strands authorized vendors; it only pauses new authorizations, blocking, and cleanup until recovery.
- **Punches arrive by push, not polling.** Confirmed: the device POSTs each punch within moments of the event — the live dashboard is genuinely real-time.
- **The backend is an always-on service, not a desktop app.** Devices push 24/7 and scheduled jobs (expiry sweeper, daily entry-mode reset, reconciliation) must run unattended, so the backend + DB install as services on one always-on LAN machine (§13). The UI is a thin layer on top.

---

## 4. Integration approach — how the VMS talks to the device

**Decision (Phase 0, closed): Path A — direct PUSH/ADMS protocol.** Not by elimination — Path B also works and remains a proven fallback — but on merit: no middleware licence, no Windows/IIS/SQL Server dependency, pure Node, true real-time push, full control, and native per-command acknowledgement.

| Path | Mechanism | Status after Phase 0 |
|------|-----------|----------------------|
| **A — Direct PUSH protocol** *(chosen)* | Device is pointed at the VMS server (Cloud Server settings: IP + port). Device **POSTs punches in real time** and **polls for queued commands**. | **Proven end to end on real hardware.** Every primitive works: punch ingestion, user create/update/delete, BioPhoto push with live recognition, block/unblock, device interrogation. The full register→delete→re-push→recognize cycle executed over raw HTTP in pure Node. |
| **B — eSSL middleware (eTimeTrackLite / eBioServer-New)** *(fallback)* | eSSL's server software manages the devices; VMS talks to its SOAP/HTTP web service (`webservice.asmx`): `UpdateEmployee`, `UpdateEmployeePhoto`, `DeviceCommand_BlockUnBlockUser`, `GetEmployeePunchLogs`, etc. | **Also proven** (Stage A demonstrated every primitive through it). Kept as a documented fallback; not used in the product. |

Rules that hold on either path:
- **Never write directly to any eSSL SQL database** to provision users — read-only access only, for punch polling at most.
- Every device write goes through the VMS **command queue** (§10) — idempotent, retried, status-tracked.
- **One owner per device roster.** The VMS is the sole manager of vendor user IDs on a device; eSSL software must not simultaneously manage the same device (§16 Risk #3).

### 4.1 Protocol reference — as observed on this firmware

This subsection records the protocol **as actually verified** on `ZAM180_TFT` / firmware `3.4.10` / Push `2.0.33S`. Firmware behaviour varies by batch; what works on this firmware is authoritative for this product, not what documentation says. Full detail in `VMS_PROJECT_CONTEXT.md` §4.

**Conversation shape.** The device initiates everything: it POSTs data and polls for commands. The server never connects to the device. Polling is **adaptive**: ~30 s idle, but **1–3 s immediately after any activity**, backing off gradually. A command queued in response to a punch therefore lands within a couple of seconds.

**Endpoints — this firmware uses an `.aspx` suffix.** Serve both forms defensively:

```
POST /iclock/cdata.aspx?SN=&table=&Stamp=     device pushes data (punches, users, photos)
GET  /iclock/getrequest.aspx?SN=              device polls for queued commands
POST /iclock/devicecmd.aspx?SN=               device reports command results
POST /iclock/fdata.aspx?SN=                   biometric/photo payload uploads
```

**Command format — the `C:<id>:` prefix is mandatory.** Commands are returned in the `getrequest` response body as `C:<CmdID>:<COMMAND>`. A bare command is **silently discarded** — no error, no acknowledgement. The device replies on `devicecmd` with `ID=<n>&Return=0&CMD=DATA`; `Return=0` = processed. The protocol thus provides **native per-command acknowledgement with a correlation ID**, which maps directly onto `sync_command` tracking (§8) — no mechanism needs inventing. Fields within commands are **TAB-separated**.

**Confirmed working commands (verbatim):**

```
INFO                                                    device capabilities + counts
DATA QUERY USERINFO PIN=<pin>                           returns USER + BIODATA + BIOPHOTO
DATA UPDATE USERINFO PIN=<pin><TAB>Name=<n><TAB>Pri=0   create/update user
DATA UPDATE BIOPHOTO PIN=<pin><TAB>FileName=<pin>.jpg<TAB>Type=9<TAB>Size=<b64len><TAB>Content=<base64>
DATA DELETE USERINFO PIN=<pin>                          remove user
DATA UPDATE USERINFO PIN=<pin><TAB>Grp=<blocked>        BLOCK (observed: Grp=100)
DATA UPDATE USERINFO PIN=<pin><TAB>Grp=<normal>         UNBLOCK (observed: Grp=1)
REBOOT
```

**Record formats.** Punch (`table=ATTLOG`, tab-separated): `PIN, timestamp (device-local), status code, verify mode (15 = face), work code, reserved`. User (`table=OPERLOG`): `USER PIN= Name= Pri= Passwd= Card= Grp= TZ= Verify= ViceCard= StartDatetime= EndDatetime=`. Photo (`table=OPERLOG`): `BIOPHOTO PIN= FileName= Type=9 Size= Content=<base64 JPEG>` — full photographic JPEG (~44–59 KB), **the durable artifact**; `Size` is the **base64 character count**, not the decoded byte count. Template (`table=BIODATA`): `Type=9 MajorVer=39 MinorVer=3 Tmp=<base64>` — algorithm-bound, cache only.

**Behaviours that shape the design (all verified):**

- **Access control resolves through `Grp`, not `TZ`.** Blocking is a group swap (observed: group 1 = allowed, group 100 = `Invalid time period`). Personal `TZ` writes are accepted and ignored. Group IDs are **per-device configuration**, not constants — numbering may vary by firmware, and whether the blocked group exists on a factory-fresh device is an open question (§15).
- **`StartDatetime` / `EndDatetime` are stored but NOT enforced.** A user whose `EndDatetime` was months in the past was still recognized and admitted. **There is no device-native expiry on this firmware** — the expiry sweeper is load-bearing (§5, §10).
- **Blocking does not remove the biometric.** The device **identifies the face, then denies** on an authorization rule. `DATA UPDATE USERINFO` never disturbs BIODATA or BIOPHOTO.
- **Denied attempts are NOT pushed to the server.** A blocked vendor's attempt shows on the device screen and goes no further (§6).
- **`Return=0` means "processed", not "valid".** The device accepted the literal string `EndDatetime=<value>` without complaint. **The VMS must validate every payload before sending** (§10).
- **Timestamps are device-local.** Store each device's timezone and normalise on ingest.
- **`Stamp` / `OpStamp`** query params are incremental-sync markers; mishandling risks replayed or dropped punches (§10).
- **Bodies arrive with unusual or absent content-types** — parse as raw buffers or requests get rejected.
- After executing a command the device appends its state to the next poll (`&INFO=<firmware,counts,IP,flags>`) — a free health check every round trip, feeding `device.last_seen_at` and drift detection.

---

## 5. Vendor lifecycle — the state machine

| State | On device? | Meaning | Trigger to next state |
|-------|:---:|---------|------------------------|
| `REGISTERED` | No | Registered once; details + photo permanent in Master DB. Idle. | Authorized person authorizes entry (sets retention window + entry mode) |
| `PENDING_PROVISION` | No | Push-to-device command queued | Command succeeds → `PROVISIONED` |
| `PROVISIONED` | **Yes** | Loaded on device, authorized for the retention window; recognizable unless day-blocked (§6) | IN punch → `INSIDE`; window expires (not inside) → `PENDING_DEPROVISION` |
| `INSIDE` | **Yes** | Punched IN, physically on premises | OUT punch → back to `PROVISIONED` (window open; day-block applied if SINGLE_ENTRY) or `PENDING_DEPROVISION` (window lapsed) |
| `PENDING_DEPROVISION` | **Yes** | Window expired or access revoked; removal command queued | Removal succeeds → `REGISTERED` |

**Two independent controls are set at authorization:**

1. **Retention window** — how long the vendor stays loaded on the device: **default one day**, or **one week / one month / quarterly / custom from–to dates**. De-provisioning is triggered by **window expiry, not by an OUT punch**. **There is no hardware backstop on this firmware:** the device's `StartDatetime`/`EndDatetime` fields are stored but not enforced (verified — a lapsed user was still admitted). **The expiry sweeper is the only mechanism removing lapsed vendors from the device**, which makes the sweeper and the reconciliation job (§10) security controls, not housekeeping (§16 Risk #4).
2. **Entry mode** — how often the vendor may enter **per day** within that window (§6): `SINGLE_ENTRY` (one IN + one OUT per day) or `MULTI_ENTRY` (unlimited IN/OUT cycles per day).

Re-entry after expiry is the **one-click push**: a `REGISTERED` vendor is re-authorized → fresh window + mode → cycle repeats, **no re-registration ever**. Proven on hardware: the stored photo pushed back via `DATA UPDATE BIOPHOTO` regenerates a working face template.

Hard rules:
- Never de-provision a vendor who is `INSIDE`; if the window lapses mid-visit, removal defers until their OUT punch.
- No double-entry: an `INSIDE` vendor cannot punch IN again.
- Re-entry after OUT within the window follows the entry mode; after the window, fresh authorization is required.
- De-provision removes from the **device only**, never from the Master DB.

---

## 6. Entry modes — SINGLE_ENTRY vs MULTI_ENTRY

The entry mode is a **daily frequency rule that applies on every day of the retention window**, independent of the window's length:

- **`MULTI_ENTRY`** — unlimited IN/OUT cycles per day for the whole window. No special handling: each OUT simply returns the vendor to `PROVISIONED`.
- **`SINGLE_ENTRY`** — exactly one IN + one OUT per day, for every day of the window. Example: a 1-week window with SINGLE_ENTRY means the vendor can enter once each day, all seven days; after Monday's OUT they are done for Monday but can enter again Tuesday morning — no re-authorization needed.

**Implementation (verified on hardware):** the barrier is opened by the device, not the app — as long as a vendor is loaded and unblocked, the device will admit them. SINGLE_ENTRY therefore actively blocks the vendor for the remainder of the day:

1. **OUT punch arrives** for a SINGLE_ENTRY vendor → VMS queues a **day-block**: `DATA UPDATE USERINFO PIN=<pin> Grp=<blocked_group_id>` — a clean, reversible group swap that leaves the biometric untouched. `entry.day_blocked` maps to "user is in the blocked group". (v3 hedged that user-disable might be unreliable, with temporary deletion as a fallback. **Dropped** — block/unblock is proven clean and reversible in both directions.)
2. **Daily reset job** at a configurable day-start time (default midnight; settable to e.g. 4 AM) moves every day-blocked vendor whose retention window is still open back to the normal group — recognizable again each morning.
3. **Window expiry** → normal de-provisioning removes them for good, blocked or not.

**The corrected mental model: the device identifies, then denies.** Blocking does **not** make the vendor unrecognizable — a blocked vendor is identified by face and refused with `Invalid time period`. On the device screen the denial is attributable to a specific user, which is better than silence.

**Known limitation: denied attempts are not pushed to the server.** A day-blocked vendor's re-entry attempt appears on the device screen and leaves no server-side trace — punches on either side of a verified blocked attempt arrived normally; the denial never did. SINGLE_ENTRY is therefore **enforceable but its violations are currently invisible** to reporting. Open item: the device may store denials locally and `Get ATTLOG By Datetime` may retrieve them (§15); until then, document this limitation to clients.

Acknowledged edge cases (decide defaults with the client, both configurable):
- **Turnaround race:** the block command reaches the device on its next poll. Adaptive polling means this is realistically **1–3 seconds** after the OUT punch (verified), so a vendor who punches OUT and immediately turns around has only a seconds-wide gap. Rare, low-stakes; any successful punch is still logged and reported.
- **Day boundary:** "one per day" = one per configured day-window. A vendor exiting at 23:55 could re-enter at 00:05 under a midnight reset; set the reset to early morning if that matters to the client.

---

## 7. Capacity — assessed for 3,000 faces

**The math (revised):** worst plausible working set = every distinct vendor across a full day simultaneously provisioned ≈ 1,500 ≈ **50% of the verified 3,000-face capacity**. Viable, but headroom is half what v3 assumed — capacity machinery is genuinely load-bearing monitoring, not ceremony:

| Component | Verdict | Why |
|---|---|---|
| Slot ledger (on-device user count, tracked transactionally) | **Keep** | Nearly free; feeds monitoring, reconciliation, and the dashboard. `device.faces_used` is corrected against the device's own `FaceCount` from `INFO`. |
| Hard admission gate on every provision | **Soft guard** | One check (`faces_used < MAX_FACES`, with `MAX_FACES ≈ 2,800` headroom). At 50% worst-case utilisation this can genuinely trip under runaway retention policies. |
| FIFO admission queue | **Dormant safety valve** | Kept, expected empty. Anything sitting in it is a signal (runaway retention policies, drift, real growth) — alert loudly. |
| Expiry sweeper | **Keep — load-bearing for both security and capacity** | The only mechanism removing lapsed vendors (no device-native expiry, §5), and at 3,000 slots generous long-window passes eat real headroom. Cleanup is access revocation *and* capacity management. |
| Threshold alerting | **Keep, retuned** | Alert at ≈ **2,100 (70%)** and **2,550 (85%)** of the 3,000 capacity. |

Also monitor the **150,000-record device transaction log** (verified; v3 assumed 200,000): at ~3,000 punches/day it fills in **~50 days**. Since punches stream to the Master DB in real time, schedule a **verified-ingest-then-clear** (e.g., monthly, after confirming the Master DB holds everything).

---

## 8. Data model (VMS Master DB — PostgreSQL / Prisma)

- **`vendor`** — permanent identity. `id`, `name`, `company`, `mobile`, `aadhar_number`, `essl_user_id`, `adopted_from_device`, `is_active`, `created_at`. **Never deleted** (soft `is_active` only).
  - **CORRECTED in 0.3.0 — `essl_user_id` is `TEXT`, not a number, and is not allocated from a range.** Terminals in the field carry `WCTPL070`, `wctpl101` and `ye01` beside plain numbers. It is validated `[A-Za-z0-9]{1,20}`, unique **case-insensitively**, stored in whatever casing it was given, and always supplied by the operator — the ID typed on the terminal for a device-first vendor, or one they pick. The old "configurable reserved range" (`VENDOR_PIN_START/END`) is gone: a numeric range cannot describe such a roster, and *which IDs on a terminal are ours* is now per-device configuration (`device.vendor_id_patterns`).
  - `aadhar_number` is unique, normalised (separators stripped), and mandatory at registration alongside `company` and `mobile`. Nullable in the database only because vendors are never deleted and rows predating the column have none.
- **`vendor_biometric`** — `vendor_id`, `photo_path` (**JPEG on local disk** — the durable artifact; photos never live in the database, only metadata does), `photo_size_bytes`, `face_template` (nullable — same-device cache only, algorithm-bound), `algorithm_version` (e.g. `Face VX3.9`), `biometric_type` (9 = face), `captured_at`.
- **`entry`** — one row per authorization cycle. `vendor_id`, `state` (§5 enum), `expected_in_at`, `in_at`, `out_at`, `retention_policy` (`ONE_DAY` default / `ONE_WEEK` / `ONE_MONTH` / `QUARTERLY` / `CUSTOM`), `retention_expires_at`, **`entry_mode` (`SINGLE_ENTRY` / `MULTI_ENTRY`)**, **`purpose_of_visit`** (0.3.0 — required at provision time, free text: "why was this person let in" is what an incident review asks, and a fixed list answers it with whichever option was nearest the mouse), **`day_blocked` (bool — maps to "user is in the blocked group")**, `authorized_by`, `created_at`. Multiple punches within one window link here via `punch_event`.
- **`device`** — `id`, `name`, `ip`, `role` (`IN` / `OUT` / `BOTH`), `serial_no` (e.g. `NCD8252500406`), `firmware_version`, `algorithm_version`, `timezone_offset_minutes`, `max_faces`, `faces_used`, **`normal_group_id` / `blocked_group_id`** (per-device config — group numbering may vary by firmware; observed 1/100 on the test unit), `last_seen_at`, `online`, `last_stamp`, `last_op_stamp`. **`serial_no`, `max_faces`, `faces_used`, `firmware_version` are all populated from the device's `INFO` response — never hardcoded, never typed from a label.** Three spec-sheet claims have already proven wrong.
- **`sync_command`** — device command queue. `id`, `entry_id`, `type` (`PROVISION` / `PUSH_PHOTO` / `DEPROVISION` / `BLOCK` / `UNBLOCK` / `QUERY_USER` / `DEVICE_INFO` / `CLEAR_LOGS`), `target_device_id`, `status` (`PENDING`/`SENT`/`SUCCESS`/`FAILED`/`RETRY`), **`device_cmd_id`** (the numeric ID sent as `C:<id>:` — the protocol's native correlation key), **`initiated_by`** (nullable — the operator who triggered this command; `null` = system-initiated by a scheduled job, e.g. the expiry sweeper or daily reset), `attempts`, `last_error`, `payload`, idempotency key, timestamps. The protocol supplies the correlation ID and return code natively; no tracking mechanism needs inventing. `initiated_by` makes "whose action caused this device write, and when" a direct query on the command itself, not something reconstructed from `audit_log` JSON.
- **`punch_event`** — raw punches. `essl_user_id` (**`TEXT` since 0.3.0**, like the vendor column; matched against vendors case-insensitively), `device_id`, **`punched_at_device`** (as reported — device-local time) and **`punched_at_utc`** (normalised via the device's timezone), `status_code` (ATTLOG field 3), **`verify_mode` (`15` = face)** — distinguishes face entry from card/password fallback, real audit value, `work_code`, `direction` (derived from source device identity; devices report direction as device-level config, not per-punch), `raw_record_hash` (dedup), `raw_line` (original, for debugging), `processed`, `entry_id`.
- **`admission_queue`** — dormant safety valve (§7); alert if non-empty.
- **`audit_log`** — every authorization, revocation, block/unblock, push, delete, login, role/config change. **Photo updates are a first-class audited event:** every time `vendor_biometric.photo_path` changes — whether from the device's auto-push on enrollment or a manual UI upload (§9.1) — an `audit_log` row is written with `action = PHOTO_UPDATED`, `entity_type = vendor_biometric`, the source (`DEVICE_PUSH` / `UI_UPLOAD`) in `detail`, and `actor_id` set to the operator for a UI upload or `null` for a device-initiated push. Deliberately **timestamps only, not a photo history table**: the current photo is the only one kept on disk; the audit trail records *when* it changed and *by what path*, not prior versions.
- **`app_user`** — operators, roles `ADMIN` / `AUTHORIZED_PERSON`.
- **`app_config`** — instance configuration (§13): branding, defaults (retention, entry mode, day-reset time), device list, license state. Written by the setup wizard; editable by Admin where safe.
- **`license`** — license key, plan/expiry. The table also carries `machine_fingerprint`, `last_heartbeat_at` and `grace_period_state` columns from the original schema design, but the shipped implementation (§13.2) doesn't populate or read them: binding is to a per-install `installationId` in `app_config`, not a machine fingerprint, there is no heartbeat, and expiry state is computed live rather than stored as a grace-period phase.

---

## 9. Functional requirements

1. **First-time registration** — capture name, company, mobile, **aadhaar number and device user ID (all mandatory since 0.3.0)** + face enrollment; the device **auto-pushes** the enrolled user and photo to the server (verified — no download command needed), and ingestion stores the photo in the Master DB immediately. Happens exactly once per vendor, ever.
2. **One-click re-authorization ("push button")** — authorize an existing vendor in one action; VMS pushes the stored photo back to both devices via `DATA UPDATE BIOPHOTO`; the device regenerates the face template. **Core differentiator — proven on hardware.**
3. **Configurable retention** — per authorization: **default one day**, or one week / one month / quarterly / custom from–to. Auto-removed from the device at expiry (deferred if inside); admin can revoke early. **No device-native expiry exists on this firmware** — enforcement is entirely the sweeper's (§5), so sweeper health is monitored and alertable.
4. **Entry modes** — per authorization: `SINGLE_ENTRY` (one IN+OUT per day, every day of the window; enforced via group-swap day-block after OUT + daily reset at a configurable day-start time) or `MULTI_ENTRY` (unlimited per day). §6.
5. **Authorization gating** — no authorization → not on device → barrier never opens. Only `AUTHORIZED_PERSON`/`ADMIN` can authorize.
6. **IN / OUT processing** — ingest real-time punch POSTs; dedupe on raw record hash; normalise device-local timestamps to UTC on ingest; record verify mode; drive the state machine.
7. **Re-entry control** — no double-entry while `INSIDE`; re-entry after OUT governed by entry mode within the window; fresh authorization after expiry.
8. **Sync/command engine** — queued, idempotent, retried device commands (incl. block/unblock) with visible status, **with every payload validated before sending** — the device does not validate (`Return=0` ≠ valid) (§10).
9. **Reconciliation** — periodic diff of actual device roster (incl. group/block state) vs expected set; auto-heal drift; correct `faces_used` against the device's own count. **A security control, not housekeeping** — a missed de-provision leaves a vendor able to open the barrier until reconciliation notices (§16 Risk #4).
10. **Device log rotation** — verified-ingest-then-clear on schedule; 150,000-record capacity ≈ 50 days at full volume (§7).
11. **Live dashboard** — currently inside (list + count), device online status + last-seen, faces used/capacity, command queue health, day-blocked count, admission-queue alert. Real-time via SSE.
12. **Reporting** — vendor-wise & date-wise IN/OUT, daily vendor count, currently-inside, authorization/audit reports, custom from–to ranges. Punch records include verify mode (face vs card/password fallback). **Limitation:** denied attempts by blocked vendors are not pushed by the device and do not appear in reports (§6, §15).
13. **RBAC + audit** — Admin vs Authorized Person; every sensitive action logged, including **photo updates** (device-push or UI upload, with source and actor, §8) and **command attribution** (every device write traceable to the operator or scheduled job that triggered it, via `sync_command.initiated_by`, §8).
14. **Licensing enforcement** — built (§13.2): an installation-bound (not machine-fingerprinted), fully offline, warn-only license key with expiry and a 14-day pre-expiry warning. No heartbeat, no lockout.
15. **Instance configuration** — device list, per-device group IDs, DB connection: all config today, zero code changes per client. **Branding/theming and instance-level defaults are not yet config-driven** (§13.3) — the setup wizard only creates the admin account, and retention/entry-mode choices are made per vendor at provision time, not set once per install.
16. **Phase-2 candidates (confirm scope)** — Aadhaar verification; visitor-vs-vendor distinction; **QR-code passes** (the device reads QR natively — printable/SMS QR for one-off visitors without consuming a face slot).

---

## 10. Sync engine, failure modes, reconciliation

- **Command queue semantics:** commands wait as `PENDING`; the device picks them up on check-in — **1–3 seconds when active, ~30 s at idle** (adaptive polling, verified); each command goes on the wire as `C:<id>:<command>` and the device's `devicecmd` reply (`ID=&Return=`) confirms `SUCCESS`/`FAILED` against the correlation ID. Timeouts → `RETRY` with backoff; N failures → `FAILED` + admin alert. Every command idempotent (safe re-delivery).
- **Validate before sending.** `Return=0` means the device processed the command, **not** that the payload was valid — the device accepted the literal string `EndDatetime=<value>` without complaint. The sync engine validates every field before building a command; a success return code is no guarantee the value was sensible.
- **Block-command latency:** SINGLE_ENTRY day-blocks ride the same queue; the OUT→block delay is 1–3 s (the device polls fast immediately after activity), accepted as the turnaround-race edge case (§6).
- **Device offline:** detected via missed check-ins (`last_seen_at`); commands hold and flush on reconnect. Already-provisioned (and unblocked) vendors are unaffected by VMS or network outages — the device matches faces locally.
- **Crash recovery:** on startup, re-process unprocessed `punch_event`s, re-deliver in-flight commands, run reconciliation — including re-applying any day-blocks or resets missed during downtime — before resuming. **Handle `Stamp` / `OpStamp` correctly**: they are the device's incremental-sync markers, and mishandling them risks replayed or silently dropped punches during backfill and recovery.
- **Reconciliation job:** every few minutes, query each device's user list + group state (`DATA QUERY USERINFO`), diff against expected, repair drift (push missing, delete orphans, fix block states and counters). **This is a security control**: with no device-native expiry, a missed de-provision leaves a vendor able to open the barrier until reconciliation catches it. Treat reconciliation frequency and reliability as security requirements, not housekeeping (§16 Risk #4).
- **Punch integrity:** dedup on raw record hash; direction from source device identity; store both device-local and normalised UTC timestamps; configurable end-of-day auto-OUT for missed OUT punches.

---

## 11. Non-functional requirements

- **Deployment:** client LAN only; no cloud; no internet dependency for operation. **Ethernet-only** — the delivered hardware has no Wi-Fi. Backend + Postgres run as always-on services on one LAN machine (§13); operator UI via browser on the LAN or an optional thin desktop shell.
- **Performance:** punch-to-dashboard under ~2 s (device push makes this easy — verified real-time). Barrier latency is hardware-only (< 1 s face match), untouched by the VMS.
- **Throughput:** ~3,000 punches/day is trivial for Node + Postgres; engineering care goes into command-queue correctness, not load. The `getrequest` handler is the hot path — it fires every 1–3 s per device and must claim a command in one round trip.
- **Reliability:** graceful degradation (device autonomy during VMS outage), catch-up on restart, transactional state transitions, services auto-restart on boot/crash. The expiry sweeper and reconciliation are reliability-critical: they are the only enforcement of retention (§5).
- **Security:** RBAC, hashed credentials, audit log, biometric photos encrypted at rest, least-privilege DB accounts, no external exposure. The retention sweeper, day-block mechanism, and reconciliation are themselves security controls (automatic access revocation with no hardware backstop).
- **Compliance (DPDP Act):** face photos are biometric personal data — document consent at registration, encrypt at rest, restrict by role, log access, and make indefinite Master-DB retention an explicit, consented policy decision. Photos stay on local disk on-premise (simpler compliance position). As a multi-client product, bake the consent flow into the standard registration UX.
- **Scalability:** the device abstraction (per-device command queue + roster + capacity + per-device group IDs and timezone) generalizes to more entry points, more terminals, or other PUSH-protocol eSSL models without redesign — with the caveat that **firmware variability is real**: behaviour verified on this firmware must be re-verified on any new model or revision.

---

## 12. Tech stack

- **Frontend:** Next.js + React + TypeScript, **Tailwind only** — hand-rolled components (`web/src/components/ui.tsx`), not shadcn; live board via **SSE**. CSS-variable tokens for color/branding exist in `globals.css`, but nothing yet loads them from `app_config` at runtime — see §13.3's correction.
- **Backend:** Node.js + TypeScript (**Fastify**) — one service exposing the operator API and the **device PUSH endpoints** (both `/iclock/<name>` and `/iclock/<name>.aspx` forms, raw-buffer body parsing, catch-all logging of unrecognised paths — never silently 404 a device request).
- **Jobs/queue:** **pg-boss** (Postgres-backed) for the command queue, expiry sweeper, **daily entry-mode reset**, reconciliation, log rotation — no Redis, minimal on-prem footprint.
- **Master DB:** PostgreSQL + Prisma. Swappable by connection string alone; photos always on local disk regardless of where the database lives.
- **Path B extras (only if ever needed):** SOAP client for `webservice.asmx`; `mssql` driver for read-only punch polling. Not in the product build.
- **Packaging (built, Phase 6 — corrects every "planned" statement below):** no `pkg`/`bun compile` single-binary step — the installer bundles `backend/dist-package` (esbuild output) plus `backend/node_modules` and `web/node_modules` **whole**, alongside a copied `node.exe`, so nothing on the target machine needs to be pre-installed. Windows services are **WinSW only** (`VmsPostgres`, `VmsBackend`, `VmsWeb`) — nssm was never used. The installer itself is **Inno Setup** (`installer/vms-installer.iss`), not MSI/WiX. Linux/systemd was never built — Windows is the only shipped target. **Tauri was scoped for a desktop-shell feel, then explicitly dropped**: the web console instead runs as its own persistent Windows service (`VmsWeb`, wrapping `next start` under WinSW) — see `docs/SESSION_HANDOFF_PHASE6.md` task 6. Tauri remains genuinely unbuilt, not merely undecided; nothing forecloses adding it later on top of `VmsWeb` if a client wants the kiosk feel.
- **Auth:** JWT + RBAC (reuse the OrgNest two-layer pattern).

---

## 13. Productization — packaging, protection, multi-client

The system is delivered as a **packaged, installed product**, not a hosted website, and is designed for resale to multiple clients from one codebase.

### 13.1 Packaging & deployment shape — **as actually built in Phase 6**, correcting every bullet below

The backend cannot be a desktop app that gets closed at 6 PM: devices push punches 24/7 and scheduled jobs (expiry sweeper, daily reset, reconciliation) must run unattended. This section originally described a plan; Phase 6 (see `docs/SESSION_HANDOFF_PHASE6.md`) built and shipped it, and reality diverged from the plan in several places:

- **One installer** (`installer/vms-installer.iss`, **Inno Setup, not MSI/WiX**) places everything on an always-on LAN machine: the backend, the built web app, a **bundled Node.js runtime** (a copied `node.exe` — the machine needs nothing pre-installed), and **bundled PostgreSQL** (the `embedded-postgres` npm package, not a silent sub-installer). It registers **three** auto-starting Windows services via **WinSW** — `VmsPostgres`, `VmsBackend`, `VmsWeb` — in dependency order. **nssm was never used; there is no Linux/systemd build,** Windows is the only shipped target. The installer's own wizard asks for one thing beyond the install path: the **backend port** (default `47102`) — a client machine sometimes already has something on the default, and the backend is the one port a device also has to be pointed at. The web console's port and the bundled database's port are fixed, not asked.
- **Setup wizard is much narrower than planned.** `web/src/app/setup/page.tsx`, reached automatically on a fresh install, collects **only an administrator email and password** — two fields, one submit button (this is a separate, later step from the Inno installer's port prompt above). It does **not** collect device IPs/serials (devices self-register by checking in over ADMS; adopted afterward from the **Devices** page's "Unregistered devices" list — see `docs/INSTALL_GUIDE.md` §4–5), does **not** collect branding, does **not** collect retention/entry-mode/day-reset defaults (those are chosen per-vendor at provision time, not as an instance default), and does **not** collect a license key (installed later, by an admin, from the **Operators** page — see §13.2 below and `docs/LICENSING.md`). **Device onboarding verifying/creating the blocked access group is still not automated** — §15 #10 remains genuinely open.
- **Operator access:** browser on the LAN (zero install per operator), served by the `VmsWeb` service on a fixed port (`47101`). **No Tauri shell was built** — see §12's packaging note. There is no per-client decision to make here; every install works this way.
- **Updates:** **not built.** There is no release-feed checker and no signed offline update package mechanism. Today, updating a live install means rebuilding the installer from the dev checkout and re-running it (safe to re-run in place — see task 6/8's `Remove-ServiceIfRegistered` fix), or a manual file copy + service restart. Schema migrations do run through Prisma Migrate, which the installer's first-run step already applies automatically.

Packaging, wizard and services were real work, done as **Phase 6 — completed before Phase 5** (the supervised pilot), a deliberate reordering from the original plan of packaging only after a stable pilot. See §14.

### 13.2 Protection & licensing — honest threat model

Technical obfuscation **cannot** stop a competent team from rebuilding this product: the behavior is fully visible to anyone who uses the app, and behavior is what a rival would copy. Protection is therefore layered, with the contract and licensing doing the heavy lifting:

- **License enforcement — built in Phase 6, and simpler than planned here:** the shipped design is **fully offline (no heartbeat, ever) and warn-only (nothing is ever technically blocked)** — no locked-out logins, no blocked device sync, no stopped barrier. A license key is an Ed25519-signed payload bound to a per-install `installationId` (a random id generated once into that install's database), **not** a hardware/machine fingerprint — true OS-level fingerprinting was deliberately rejected as fragile across Windows editions/VMs, and not worth it when nothing is actually locked by it. There is no post-expiry "grace period" with escalating lockout; the only mechanism is a 14-day **pre-expiry** warning that continues, unchanged, as an ordinary alert after expiry. This was a deliberate choice, not a scope cut: CLAUDE.md rule #9 (a VMS outage must never strand an authorized vendor) makes a licensing-driven lockout a bad trade for what it would protect. License state is visible on the **Operators** page and in the dashboard **Alerts** panel. See `docs/LICENSING.md` for the full mechanism and the issuing/renewal runbook. This still prevents copying the installer to a second site without a matching key and makes a lapsed license visible — it just never becomes a lockout.
- **Contract (decisive):** software is **licensed, not sold**; source code remains yours; reverse engineering and redistribution prohibited; per-site licensing defined. In any dispute this matters far more than obfuscation.
- **Obfuscation (speed bump, not wall):** compiled binary (V8 bytecode snapshot via `pkg`), minified frontend, no source maps shipped, secrets out of the client bundle. Cheap; do it; don't rely on it.
- **The actual moat:** you understand this hardware's firmware quirks — verified protocol behaviour that contradicts the documentation in several places — you ship fixes fast, and replacing you means re-doing the painful device-integration work. Service quality retains clients; obfuscation doesn't.

### 13.3 Multi-client configurability

One codebase, many installs. The discipline that makes this nearly free if enforced from day one:

- **Everything client-specific is configuration**: DB connection string, device list (incl. per-device group IDs, timezone, gate role, punch-state maps, duplicate-punch window and **vendor ID patterns**), retention/day-reset defaults, license key. Branding and instance-level retention/entry-mode defaults remain **not** config-driven (§13.3 correction below), and the setup wizard writes only the first administrator.
  - **`device.vendor_id_patterns` (0.3.0) replaced the global PIN reservation range.** Case-insensitive globs (`WCTPL*`, `YE*`); **empty means every ID on that terminal is treated as a vendor**, which is right for a vendor-only gate and is what every install gets by default. It is what stops a terminal shared with the client's employees pulling several hundred staff face photographs into the system — a DPDP exposure documented in `docs/DPDP_SHARED_TERMINAL_RISK.md`.
- **UI theming via design tokens — half-built.** `web/src/app/globals.css` already defines every color as a CSS variable, by design, so no component ever hardcodes a color. **What's not built yet: nothing loads those variables from `app_config` (or anything) at runtime** — there is no theme-loading code path, no per-client stylesheet, no config-driven product name or logo. The scaffolding is deliberate prep, not a shipped feature; wiring it up is a remaining Phase 6/7-scope task, not a redesign, once a client actually needs it.
- **Hard rule: zero client-specific conditionals in code.** Any client difference must be expressible in config. `if (client === '...')` is banned; the moment it appears, the product forks and dies slowly. No client names anywhere — code, config keys, comments, table names, UI strings, or commit messages.
- **Per-client operational overhead to plan for (not v1-blocking):** update distribution across sites, supporting mixed versions in the field, and a minimal license registry (who has which key, plan, expiry) — a spreadsheet at first, a tiny internal tool later.

---

## 14. Phased roadmap

**Phase 0 — Protocol & premise verification. ✅ COMPLETE.**
Every primitive proven on the real unit, twice — first through eSSL's own software (isolating hardware behaviour from our code), then over the raw ADMS protocol in pure Node: punch ingestion, user create/delete, **BioPhoto push → live face match with no re-enrollment**, block/unblock (group swap), device interrogation. **Path A chosen**; Path B proven as fallback. Face capacity verified at 3,000; transaction log at 150,000; no device-native expiry; denials not pushed. Full record in `VMS_PROJECT_CONTEXT.md` and `PHASE_0_CHECKLIST.md`.

**Phase 1 — Master DB + registration + manual push/remove.** ✅ COMPLETE
Vendor CRUD, photo storage, schema, basic UI; manual provision/block/de-provision working end-to-end against real hardware. Config-driven from the first commit (§13.3). Detailed breakdown in `PHASE_1_PLAN.md`.

**Phase 2 — Punch ingestion + lifecycle automation.** ✅ COMPLETE
State machine, retention windows, **entry modes with day-block + daily reset**, expiry sweeper, live inside-now board.

**Phase 3 — Hardening the sync layer.** ✅ COMPLETE
Command queue with retries + idempotency, reconciliation/self-heal (incl. block states), crash recovery, device-offline handling, `Stamp`/`OpStamp` handling, log rotation, capacity + queue alerting.

**Phase 4 — Authorization workflow + RBAC + reporting. ✅ COMPLETE (6 Aug 2026).**
Roles that are actually enforced (M17), operator management (M18), 20 reports + CSV + visitor pass + vendor card (M20), audit log UI (M21), end-to-end verification (M22) — 239 e2e checks, 50 unit tests. **The pre-notification UX was dropped by decision (5 Aug 2026, M19 closed without code):** authorized persons provision directly, so a request-approve queue would have been the largest piece of work in the phase and would have sat unused. `entry.expected_in_at` and `entry.authorized_by` remain, so a future client wanting approval costs a feature rather than a migration. See `docs/PHASE_4_PLAN.md`.

**Phase 6 — Productization. ✅ COMPLETE**, and built *before* Phase 5 (deliberate reordering — the team chose to package now rather than wait for a pilot). Eight tasks, all verified on real Windows hardware including a reboot-survival test: production backend bundle, bundled/portable PostgreSQL, WinSW service registration, first-run setup wizard, offline warn-only license enforcement, the `VmsWeb` persistent web-console service (replacing the originally-scoped Tauri shell), a single Inno Setup installer, and end-to-end verification. Full detail and exact verification steps in `docs/SESSION_HANDOFF_PHASE6.md`. **Not done, and not blocking:** an updater/release-feed mechanism, build obfuscation, and config-driven theming polish — all still open, see §12 and §13.3.

**Phase 5 — Stabilize as a product candidate. Not yet started; this is next.**
Run the now-packaged installer in real conditions at the first client site (see `docs/DEPLOYMENT_READINESS.md` for the pre-install checklist); fix what reality finds; validate the second physical device once it arrives (§15 #5); freeze v1 functionality.

---

## 15. Open questions

Closed by Phase 0:

1. ~~**Firmware behavior on the exact units**~~ — **ANSWERED: yes.** Every ADMS/PUSH primitive works, including BioPhoto upload with live recognition and block/unblock. Verbatim syntax recorded in §4.1 and `VMS_PROJECT_CONTEXT.md` §4.
2. ~~**What eSSL software is installed**~~ — **ANSWERED:** eTimeTrackLite, and it works (Path B proven as fallback). Once Path A is committed, the device must be properly unregistered from it — one owner per roster.
3. ~~**On-device face capacity**~~ — **ANSWERED: 3,000**, not the spec sheet's 6,000.

Still open:

4. **Barrier wiring** — confirm each terminal's lock relay drives its flip barrier directly.
5. **IN/OUT roster model** — **software side ANSWERED (8 Aug 2026):** provisioning, block/unblock, de-provisioning, expiry and reconciliation all now support an entry spanning any number of devices via an explicit device checklist, not just a single push-to-both assumption (see `docs/INSTALL_GUIDE.md` §7). **Still open:** none of it has run against two physical terminals — the second unit has still not arrived, so this remains reasoned-through and code-level-tested only.
6. ~~**Entry-mode defaults & day-reset time**~~ — **ANSWERED (5 Aug 2026):** daily reset at midnight in each *device's* local time, configurable via `DAILY_RESET_HOUR`. `SINGLE_ENTRY` is refused on a bidirectional terminal whose duplicate-punch window is non-zero or unrecorded, because such a device can swallow the OUT punch the mode depends on. **DPDP consent language is still open** — and note that photo retention is now the one retention setting with no default: `AUDIT_RETENTION_DAYS` is unset deliberately, since "no longer than necessary" is a client policy decision.
7. ~~**Packaging choices**~~ — **ANSWERED (Phase 6):** Windows only (no Linux build). Browser UI only — Tauri was scoped, then explicitly dropped in favor of the `VmsWeb` persistent service (§12, §13.1). Licensing is fully offline by decision, so internet availability no longer gates the licensing design; it still gates remote support and an updater, neither of which exists yet.
8. **Commercial terms for the product model:** per-site license pricing, support/maintenance terms, contract template with license/no-reverse-engineering clauses. **Still not decided** — the license *mechanism* is built and asks nothing of this decision (see §13.2), but no real key has been issued for commercial use.
9. **Aadhaar / visitor / QR scope** — partially answered. A printable **visitor pass** and a permanent **vendor card** shipped in Phase 4 M20; both state on their face that they do not grant entry, because the face is the credential. **QR is not available on this firmware** — `INFO` reports no QR support (`IsSupportQRcode` empty), so a code on either artifact would be decoration. Aadhaar verification remains optional Phase 6 scope.

New, raised by Phase 0:

10. **Does the blocked group (observed as 100) exist on a factory-fresh device**, or did eTimeTrackLite create it? The test unit can no longer answer — test on the second device while it is still factory-fresh. If not factory-default, device onboarding must create or verify one (§13.1).
11. **Can denied attempts be retrieved?** They are not pushed (§6). `Get ATTLOG By Datetime` (or its raw equivalent) may retrieve locally-stored denials; if so, SINGLE_ENTRY violations become auditable.
12. **ATTLOG field 3 (per-punch status code)** — does it ever change, e.g. under `altinout` direction mode? If it carries IN/OUT, direction could come per-punch rather than per-device. (`altinout` is also the single-device testing mode until unit #2 arrives.)
13. **`MainTime=1970-01-01`** in the `INFO` response despite correct punch timestamps — unexplained; understand before ever relying on device-side clock state.

---

## 16. Risks (ranked)

1. ~~**BioPhoto re-push fails on this firmware**~~ — **CLOSED.** Proven on the real unit, through both eSSL's software and our own code: the pushed photo regenerates a working face template and the vendor is recognized live with no re-enrollment. The product premise holds.
2. **PUSH-protocol firmware quirks on *other* units** (region/batch variability) → behaviour verified on this firmware may differ on the second unit or future models. *Mitigate: the protocol reference records exact working syntax verbatim per firmware; re-verify on every new unit (starting with the factory-fresh checks in §15 #10); idempotent commands; reconciliation as constant safety net; Path B fallback remains proven.*
3. **Roster contention** — eSSL software and the VMS both managing device users → drift and mystery deletions. *Mitigate: single owner (the VMS) for vendor user IDs; unregister the device from eTimeTrackLite properly once Path A is committed; reserved PIN range if employees share the devices; reconciliation detects intrusions.*
4. **Sync drift** (missed deletes/blocks → vendors who can still open the barrier). **Elevated from v3: there is no device-native expiry backstop on this firmware** — `StartDatetime`/`EndDatetime` are stored but not enforced. The sweeper and reconciliation are the *only* enforcement. *Mitigate: treat reconciliation frequency and reliability as security requirements; monitor sweeper health; alert on any FAILED de-provision.*
5. ~~**Productization underestimated**~~ — **CLOSED (Phase 6 complete).** Installer, wizard, services, and licensing shipped and verified on real Windows including a reboot-survival test; only the updater/release-feed piece was never built (not blocking — see §13.1). *Deliberately done before Phase 5 stabilization,* the opposite order originally planned here — a considered reordering, not scope creep, per `docs/SESSION_HANDOFF_PHASE6.md`.
6. **SINGLE_ENTRY turnaround race** — 1–3 second gap between OUT punch and block landing (verified: adaptive polling keeps this narrow). *Accepted: rare, low-stakes, any successful punch logged either way; document for the client. Note the adjacent limitation: denied attempts after the block lands are invisible to the server (§6).*
7. **Device transaction-log overflow** — 150,000 records ≈ **~50 days** at full volume (verified capacity, down from the assumed 200,000). *Mitigate: scheduled verified-ingest-then-clear, monthly or better.*
8. **Multi-client drift** — client-specific hacks creeping into code. *Mitigate: config-only rule enforced from first commit; any exception requires making it a configurable feature.*

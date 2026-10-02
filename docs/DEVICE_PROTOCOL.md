# Terminals and the ADMS protocol

Carried forward from `legacy/VMS_PROJECT_CONTEXT.md` §2–4 and
`legacy/VMS_PRD_Technical_Plan.md` §0/§4.1, which remain the full narrative
record. Everything here was **observed on real hardware**, not taken from
documentation.

**Standing rule:** trust nothing printed. Every spec-sheet claim checked so far
was wrong in some way. Firmware varies by batch, so this document is
authoritative for the unit below and a starting hypothesis for any other —
including all four terminals at the two-zone site (checklist in §9).

## 1. The verified unit

| | Spec sheet / paperwork | Actual (read from the device) |
|---|---|---|
| Model | eSSL AiFace-Arion | platform `ZAM180_TFT` |
| Firmware | — | `ZAM180-NF50VA-Ver3.4.10` |
| ADMS / Push | — | `Ver 2.0.33S-20220623` |
| Face algorithm | — | `Face VX3.9` (`FaceVersion=39`, type 9 → `39.3`) |
| Face capacity | 6,000 | **3,000** |
| Transaction log | 200,000 | **150,000** |
| Wi-Fi | supported | **absent** — Ethernet only |
| Serial | `SYZ8251400179` / `AJE1260300753` | **`NCD8252500406`** |
| QR | advertised | `INFO` reports no QR support |

`device.serial_no`, `max_faces`, `faces_used` and firmware always come from the
device's own `INFO` reply, never from a label. The full 74-key `INFO` reply is
kept verbatim on `device.last_info`. Do not derive capacity from the
tilde-prefixed maxima except `~MaxFaceCount`.

## 2. Conversation shape

The device initiates everything; the server never connects to it. It POSTs data
and polls for commands. Polling is **adaptive**: ~30 s idle, 1–3 s right after
any activity, backing off 1, 1, 3, 5, 8 … 30 s. A command queued in response to
a punch lands within a couple of seconds.

After executing a command the device appends its state to the next poll
(`&INFO=<firmware,counts,IP,flags>`) — a free health check.

## 3. Endpoints — this firmware uses `.aspx`

```
POST /iclock/cdata.aspx?SN=&table=&Stamp=     device pushes data
GET  /iclock/getrequest.aspx?SN=              device polls for commands
POST /iclock/devicecmd.aspx?SN=               device reports results
POST /iclock/fdata.aspx?SN=                   biometric/photo uploads
```

Serve both the bare and `.aspx` forms. The handshake is a `GET /iclock/cdata`,
answered with a bare `OK`. Bodies arrive with unusual or absent content-types —
parse as raw buffers. **Log unrecognised paths; never 404 a device silently**
(that is how the `.aspx` suffix was found).

## 4. Commands

Returned in the `getrequest` body as `C:<CmdID>:<COMMAND>`. **A bare command is
silently discarded.** Fields are TAB-separated. The device replies on
`devicecmd` with `ID=<n>&Return=<code>&CMD=DATA`; the ID is the correlation key
for `sync_command.device_cmd_id`.

Confirmed working, verbatim:

```
INFO                                                    capabilities + counts
DATA QUERY USERINFO PIN=<pin>                           returns USER + BIODATA + BIOPHOTO
DATA UPDATE USERINFO PIN=<pin><TAB>Name=<n><TAB>Pri=0   create/update user
DATA UPDATE BIOPHOTO PIN=<pin><TAB>FileName=<pin>.jpg<TAB>Type=9<TAB>Size=<b64len><TAB>Content=<base64>
DATA DELETE USERINFO PIN=<pin>                          remove user
DATA UPDATE USERINFO PIN=<pin><TAB>Grp=100              BLOCK
DATA UPDATE USERINFO PIN=<pin><TAB>Grp=1                UNBLOCK
REBOOT
```

- **`Return=0` means "processed", not "valid".** The device accepted the
  literal string `EndDatetime=<value>`. Validate every field before a command
  exists (`backend/src/adms/commands.ts`).
- `Size` on `BIOPHOTO` is the **base64 character count**, not the byte count.
- A pushed photo makes the device generate its own face template: **no physical
  re-enrolment is ever needed** (proven through eSSL software and raw ADMS).
- Log-clearing syntax has **not** been verified on raw ADMS; the queue refuses
  `CLEAR_LOGS` rather than guess.

### `PUSH_PHOTO` `Return=-1001`

Observed on site 12 Sep 2026: webcam/phone photos (full-resolution landscape
JPEGs, hundreds of KB) were rejected. The terminal's own enrolment photos are
~45–60 KB portraits. Since 0.4.19 the console centre-crops every photo to a
**480×640 portrait JPEG** (`web/src/lib/photo.ts`) before upload, and the
problem has not recurred. The exact meaning of `-1001` is undocumented — record
the reply verbatim if it recurs with a normalised photo. **Visitor selfies must
go through the same normalisation.**

## 5. Records

**Punch** (`table=ATTLOG`), TAB-separated:
`PIN, timestamp (device-local), status, verify (15 = face), workcode, reserved…`

**User** (`table=OPERLOG`):
`USER PIN= Name= Pri= Passwd= Card= Grp= TZ= Verify= ViceCard= StartDatetime= EndDatetime=`

**Photo** (`table=OPERLOG`) — the durable artefact:
`BIOPHOTO PIN= FileName= Type=9 Size=<b64 len> Content=<base64 JPEG>`

**Template** (`table=BIODATA`) — algorithm-bound, a same-device cache only:
`BIODATA Pin= No=0 Index=0 Valid=1 Duress=0 Type=9 MajorVer=39 MinorVer=3 Tmp=<base64>`

**`OPLOG`** lines (`OPLOG <opcode>\t0\t<time>\t<pin>\t…`) also arrive on
`table=OPERLOG`. A face enrolled at the terminal pushes **only** an OPLOG — no
USER or BIOPHOTO follows on its own. The backend pulls the photo with
`DATA QUERY USERINFO` when it sees a PIN-shaped OPLOG subject (gated by the ID
patterns).

`AIFace` (visible-light, derived from the BioPhoto) is what this terminal uses;
legacy `Face` templates are not portable. **The photo is the durable artefact.**

## 6. Behaviours that shape the design

- **Access is by `Grp`, not `TZ`.** Group 1 = allowed, group 100 = denied
  (`Invalid time period`). `TZ` writes are accepted and ignored. Group IDs are
  per-device config. Whether group 100 exists on a **factory-fresh** unit is
  unknown — check on new terminals.
- **`StartDatetime` / `EndDatetime` are stored but not enforced.** A user with
  a months-old `EndDatetime` was admitted. There is no device-native expiry:
  the system's own unload/expiry jobs and reconciliation are security controls.
- **Blocking does not remove the biometric.** The device identifies, then
  denies.
- **Denied attempts are never pushed to the server.** Refused entries cannot be
  reported.
- **Timestamps are device-local.** Each device stores its offset
  (`timezone_offset_minutes`, default `+330`) and punches are normalised on
  ingest.
- **`Stamp` / `OpStamp` are inert constants (`9999`)** on this firmware. There
  is no incremental sync to get wrong, and no Stamp-based backfill.
  `raw_record_hash` dedup protects punch integrity.
- **There is no "list every user" command.** Reconciliation works from
  observations (`QUERY_USER` at a controlled rate); adopting an already
  populated terminal needs a brute-force ID scan.
- **`getrequest` hands out one command per poll**, ordered by `seq`. Anything
  that queues many commands must meter itself.
- `INFO` reports `MainTime=1970-01-01` despite correct punch times —
  unexplained; never rely on device-side clock state.

## 7. Punch direction

ATTLOG field 3 is the attendance state per punch: `255` Undefined, `0`
Check-In, `1` Check-Out (observed); `2`–`5` inferred. Menu:
`Personalize > Punch State Options`.

- **Dedicated gate terminals** (every terminal at the two-zone site): set
  `Fixed Mode` with `Check-In` on IN terminals and `Check-Out` on OUT terminals.
  The device's configured role decides direction; a disagreeing status code is
  logged as a misconfiguration.
- `255` means "no answer" and is never mapped to IN or OUT.
- Leave `Punch State Required` **off**.

## 8. Duplicate punch period

`System > Attendance > Duplicate Punch Period(m)` suppresses a repeat punch by
the **same user** within the window **on the device** — no record is sent. It
is per user, not per punch state, and per device. With separate IN and OUT
terminals the IN and OUT land on different devices, so the effect is limited,
but a visitor recognised twice at the same gate within the window produces one
record. Whether the barrier still opens on a suppressed punch is unverified.
The system never assumes every movement produces a record.

## 9. Checklist for every new terminal (two-zone site: all four)

Record results verbatim in this file and `KNOWN_ISSUES.md`.

- [ ] Serial, platform, firmware, ADMS version, face algorithm and face capacity from `INFO`
- [ ] Endpoint form used (`.aspx` or bare)
- [ ] `DATA QUERY USERINFO` with an alphanumeric ID; whether `abc1` and `ABC1` are one user
- [ ] Blocked group (100) exists on the factory-fresh unit, or must be created
- [ ] `PUSH_PHOTO` of a normalised phone selfie → recognised live
- [ ] Punch State Mode set to Fixed, Check-In / Check-Out per role; status codes observed
- [ ] Duplicate Punch Period value recorded on the device row
- [ ] Device timezone offset correct (punch time matches wall clock)
- [ ] Admin card opens the barrier with the VMS stopped; whether a card release produces a punch record
- [ ] The admin card holder's ID matches neither Employee nor Visitor pattern
- [ ] Only the VMS manages the roster (no eTimeTrackLite or other software pointed at it)

## 10. Network setup traps (already debugged once)

- Each terminal has **one** Cloud Server setting (Mode `ADMS`, address, port).
  Two servers cannot share it — one owner per roster.
- Terminals often need a **reboot** before changed Cloud Server settings apply.
- Gateway `0.0.0.0` blocks NTP and anything off-subnet; set a real gateway.
- **Windows Firewall silently drops inbound terminal traffic.** Each backend
  port needs an explicit inbound rule (the installer adds it). Verify from
  another device on the LAN, never from the server itself.
- The terminal's Network Diagnosis reports failure against Windows hosts that
  do not answer ICMP — a red herring.

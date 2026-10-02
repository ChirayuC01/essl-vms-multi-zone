# Testing the two-zone system with only two terminals

A real two-zone site has **four** terminals: Outer IN, Outer OUT, Yard IN and
Yard OUT. For development you only need **two**. This page explains how.

## The short answer

Yes, two terminals are enough for almost all development testing.

1. **Test one zone at a time** with the two real terminals.
2. For tests that need both zones at once, **add two pretend ("virtual")
   terminals** in software.
3. The automatic tests (`verify:e2e`) already simulate all four terminals.

What two terminals **cannot** prove is listed at the end. Those checks happen
on the client's real four terminals before go-live.

---

## Before you start (every time)

1. **Point both terminals at the development backend**, not the installed one.
   - The installed VMS uses port **47102**; development uses **48102**.
   - On each terminal: Menu → COMM. → Cloud Server Settings → Port = `48102`,
     with the address set to your PC's IP. Reboot the terminal if it doesn't
     reconnect.
   - Never let both systems manage the same terminal. Two managers delete each
     other's people ("mystery deletions").
2. Start the three development services: database (`npm run db:dev:start`),
   backend (`npm run dev` in `backend`) and web console (`npm run dev` in
   `web`). See `DEVELOPMENT_SETUP.md`.
3. Open the **development** console at `http://localhost:48101`. The installed
   one is on 47101 and doesn't have the new features.
4. Allow inbound TCP `48102` through Windows Firewall. If you skip this, the
   terminals' requests are silently dropped.

---

## Method 1: one zone at a time (real hardware)

Use your two real terminals as **one gate pair**.

| Terminal | Role (Devices page) | Punch state on the terminal |
|---|---|---|
| Terminal A | IN | Fixed Mode → Check-In |
| Terminal B | OUT | Fixed Mode → Check-Out |

On the terminal: Menu → Personalize → Punch State Options → Punch State Mode
= *Fixed Mode*, Fixed Punch State = *Check-In* (A) or *Check-Out* (B).

**To test the Office zone:** on the Devices page, put both terminals in the
Office zone.

**To test the Yard zone:** move both terminals into the Yard zone. Changing
the zone takes a few seconds on the Devices page; nothing on the terminal
changes.

This covers, on real hardware:

- the face loading onto the entry terminal 5 minutes before the visit
- removal 10 minutes after a single-entry punch
- the exit code (single entry) and the Security exit override
- multi-entry (entry and exit both loaded, no code)
- blacklist (removed from both terminals immediately)
- photo push and recognition of phone selfies
- automatic release after an outage
- employee access by zone

---

## Method 2: real pair + virtual pair (both zones at once)

Some flows cross both zones. For example, a yard visitor goes
Outer IN → Yard IN → Yard OUT → Outer OUT. For these, two of the four
terminals are virtual.

Example: real terminals as the **Yard** pair, virtual ones as the **Outer**
pair (or the other way round, depending on what you want to watch on real
hardware).

| Gate | Physical? | Zone | Role |
|---|---|---|---|
| Outer IN | virtual, serial `VIRTOUTERIN` | Office | IN |
| Outer OUT | virtual, serial `VIRTOUTEROUT` | Office | OUT |
| Yard IN | real terminal A | Yard | IN |
| Yard OUT | real terminal B | Yard | OUT |

### What a virtual terminal is

It's just a terminal record with a made-up serial number. The system treats it
exactly like a real one: it schedules faces for it and queues commands. Those
commands then **wait in the queue**, because nothing is polling for them,
until you "play" the terminal by hand with the HTTP calls below.

You can see everything a virtual terminal would have received on the
**Commands** page.

### Step 1: make the virtual terminal appear

Send one poll with the made-up serial (PowerShell):

```powershell
Invoke-WebRequest "http://localhost:48102/iclock/getrequest?SN=VIRTOUTERIN"
```

It now shows on the Devices page under **Unregistered devices**. Click
**Register**, then set its zone and role like any real terminal. Repeat for
`VIRTOUTEROUT`.

### Step 2: let it collect a command

Each poll hands out **one** queued command, if there is one:

```powershell
(Invoke-WebRequest "http://localhost:48102/iclock/getrequest?SN=VIRTOUTERIN").Content
```

The reply looks like `C:1234:DATA UPDATE USERINFO PIN=V0001...`. The number
after `C:` (here `1234`) is the command ID. A reply of plain `OK` means
nothing is queued.

### Step 3: confirm the command, as a real terminal would

```powershell
Invoke-WebRequest "http://localhost:48102/iclock/devicecmd?SN=VIRTOUTERIN" -Method Post -Body "ID=1234&Return=0&CMD=DATA"
```

`Return=0` means success. Use a non-zero value, e.g. `Return=-1001`, to test
how the system handles a terminal rejecting something.

Repeat steps 2–3 until the poll answers `OK`. Loading one person is usually two
commands: create the user, then push the photo.

### Step 4: make a virtual punch (someone passing the gate)

```powershell
$time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Invoke-WebRequest "http://localhost:48102/iclock/cdata?SN=VIRTOUTERIN&table=ATTLOG&Stamp=9999" -Method Post -Body "V0001`t$time`t0`t15`t0`t0"
```

- `V0001` is the person's terminal ID (shown on their page).
- `` `t `` is a TAB, which PowerShell writes as backtick-t.
- `0` is the punch state: use `0` (Check-In) on an IN terminal and `1`
  (Check-Out) on an OUT terminal.
- `15` means "face".

The punch appears in the live feed, exactly as if the person had walked
through.

### Putting it together: one yard visitor

1. Give the visitor a single-entry Yard pass.
2. **Outer IN (virtual):** poll and confirm until `OK`, so the face is
   "loaded". Then post an IN punch.
3. **Yard IN (real):** wait for the face to load, then walk up to terminal A.
4. **Exit code:** verify it in the out-pass page, or use the Security
   override.
5. **Yard OUT (real):** walk out through terminal B.
6. **Outer OUT (virtual):** poll and confirm the exit load, then post an OUT
   punch (punch state `1`).
7. Watch the Commands page: each terminal's face is removed 10 minutes after
   its own punch.

> A small command-line simulator that does steps 2–4 in one line is planned
> for Phase 4 (see `PLAN.md`). Until then, use the commands above.

---

## Method 3: automatic tests (all four terminals)

`npm run verify:e2e` drives the real application against **four simulated
terminals**. It checks the zone rules automatically: office vs yard access,
and, from Phase 4, loading and removal timings, exit codes, overrides and
outages. Run it after every change. How to run it safely (separate database,
photo folder and licence state) is in `DEVELOPMENT_SETUP.md` § Verify the
source tree.

---

## What two terminals cannot prove

These are checked on the **client's own four terminals** during installation
(the checklist is in `DEVICE_PROTOCOL.md` §9):

- A real person walking through four real barriers in sequence, with real
  timing between gates.
- The client's terminals' model and firmware. They may differ from yours: a
  different firmware can behave differently, and every printed spec checked so
  far was wrong somewhere.
- Whether the client's terminals already have the "blocked" access group.
- That each terminal's admin card opens its barrier during an outage.

---

## Common problems

| Symptom | Cause | Fix |
|---|---|---|
| Real terminal never shows online | Still pointed at port 47102, or firewall blocking 48102 | Check Cloud Server port; add firewall rule; reboot terminal |
| Everything says `LICENSE_EXPIRED` | The PC's trial (shared by dev and installed copies) has expired | Install a key on the License page, or ask for the dev-only workaround |
| Backend won't start: `EADDRINUSE 47102` | `backend/.env` has the installed port | Set `PORT=48102` and `ADMS_PORT=48102` in `backend/.env` |
| Virtual terminal's commands never move | Nobody is polling it, which is expected | Poll and confirm by hand (Method 2, steps 2–3) |
| Person loaded but terminal won't recognise them | Photo rejected (`Return=-1001`) | Retake or upload the photo; it's resized to 480×640 automatically; retry the command |
| `FATAL: lock file "postmaster.pid" already exists` | A previous database process is still running | Use the running one, or stop it before starting again |

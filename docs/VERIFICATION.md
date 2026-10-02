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
| 1 | §Phase 1 below | Owner approved commit 2026-10-02; individual step results not recorded |
| 2 | §Phase 2 below | Pending |

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

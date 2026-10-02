# Phase 2 — Punch ingestion + lifecycle automation

> **Historical record — do not read as current behaviour.** This documents what was decided and verified during this phase, at the time. Where it disagrees with `CLAUDE.md`, `docs/API_REFERENCE.md` or `docs/VERSIONS.md`, those are current and this is not. (Most likely divergence: device user IDs are **text** since 0.3.0, and the `VENDOR_PIN_START`/`VENDOR_PIN_END` range described here no longer exists.)


Phase 1 made every device operation manual and reliable. Phase 2 makes the
lifecycle run itself: punches move entries, windows close on their own, and
entry modes are enforced without an operator watching.

**Prerequisite met.** Phase 1 Milestone 6 passed on hardware, and the one
open protocol question Phase 2's design waited on — whether direction is
per-punch or per-device — was answered on 5 Aug 2026. See
`VMS_PROJECT_CONTEXT.md` §4.9.

**PHASE 2 IS COMPLETE (5 Aug 2026).** Milestones 7–11 done. M7, M8 and M9 are
hardware-verified on the terminal; M10 was verified in the browser against it.
`npm run verify:e2e` covers **107 checks**, `npm test` **40 unit tests**.

---

## Development topology: one terminal

The product is built and tested against a **single device in `role = BOTH`**,
using `Punch State Mode = Manual Mode` so F1/F2 select Check-In or Check-Out
before the face scan. This yields a complete IN/OUT cycle from one unit.

This is **not** a testing shim. A client with one bidirectional turnstile is a
supported install, so `BOTH` is a real topology that has to work properly —
which conveniently means the development setup exercises production code
paths rather than a parallel one.

**A single terminal has one hard prerequisite:**
`Menu > System > Attendance > Duplicate Punch Period(m)` **must be 0.** The
device drops repeat punches by the same user inside that window before
sending them — per user, regardless of punch state (§4.10). A suppressed OUT
punch turns SINGLE_ENTRY into MULTI_ENTRY with nothing logged anywhere. Two-gate
deployments are largely immune, because the window is enforced against each
device's own log.

### Still blocked on a second device

Carried forward, none blocking Phase 2:

- Does group 100 exist on a factory-fresh unit? This one has been touched by
  eTimeTrackLite and can no longer answer it.
- Can denied attempts be retrieved after the fact?
- IN/OUT corroboration — a gate whose punch state contradicts its role. The
  code path exists and is unit-tested; it has never run against two terminals.

---

## Milestone 7 — Direction resolution + punch state machine ✅

**Done 5 Aug 2026.** `backend/src/services/punches.ts`.

Direction is resolved per punch, from configuration rather than a constant:

| `Device.role` | Direction from | Notes |
|---|---|---|
| `IN` / `OUT` | the role | Authoritative — the barrier's physical position outranks a field in a record. A contradicting status code is audited as `PUNCH_DIRECTION_CONFLICT`, not obeyed. |
| `BOTH` | `in_status_codes` / `out_status_codes` | Observed: 0 = Check-In, 1 = Check-Out. |
| `BOTH`, code absent or unmapped | alternation from entry state | Includes **`255` = Undefined**, which the device sends whenever no F-key was pressed or the selection lapsed — observed in normal use, not an edge case. It means "no answer" and must never be mapped to a direction. |

Transitions are guarded on the state they expect: `PROVISIONED --IN--> INSIDE`
and `INSIDE --OUT--> PROVISIONED`. Anything else links the punch to the entry,
logs it, and changes nothing — a second Check-In is exactly what a suppressed
OUT looks like from here, and it must not corrupt the entry.

Query shape is fixed regardless of batch size: two reads, then one
transaction. No lookup inside the per-punch loop (CLAUDE.md #4).

Punches from PINs with no entry — employees on a shared terminal — are stored
and marked processed with no entry link. Never dropped.

`PATCH /api/devices/:id` configures role, code maps and the duplicate-punch
window. `GET /api/devices` warns when a `BOTH` terminal has a non-zero window.

**Verified:** 7 unit tests on direction resolution; 9 checks in
`verify:e2e` §4b driving the state machine over the wire; §6 now reaches
`INSIDE` through a real punch rather than a direct write. 52 checks passing.

---

## Milestone 8 — pg-boss + expiry sweeper ✅

**Done 5 Aug 2026.** `backend/src/jobs/expiry.ts`, `backend/src/jobs/index.ts`.

The sweeper is the **only** thing that removes a lapsed vendor from a device —
Phase 0 proved `EndDatetime` is stored and ignored, so there is no
device-native expiry. It is a security control, not housekeeping.

- pg-boss on the same PostgreSQL, own schema (`JOBS_SCHEMA`), own small pool
  (`JOBS_POOL_SIZE`, default 2). No Redis. Schedule is `EXPIRY_SWEEP_CRON`,
  default every 5 minutes — that interval **is** the worst-case window in
  which a vendor whose authorization ended can still open a barrier.
- **Startup fails loudly if jobs cannot start.** A service running without the
  sweeper is silently insecure, and silence is the worst available outcome.
  Vendors are not stranded by this: the device opens its own barrier.
- Sweep cost is fixed, not per-entry — one read, three writes, however many
  windows lapse together (CLAUDE.md #4).
- **Never de-provision `INSIDE`.** The OUT punch is what removes them, and
  `deprovisionLapsedOnExit` fires it the moment they walk out, rather than
  waiting up to a full sweep interval.
- `GET /api/entries/overdue` lists vendors inside past their window —
  "correctly deferred" and "quietly forgotten" look identical without it.
- `POST /api/entries/sweep-expiry` runs it on demand.

**One real bug found by the harness on first run**, worth remembering because
it is the second instance of the same trap: interpolating a JS `Date` into raw
SQL against a `TIMESTAMP` (no time zone) column casts it through the *session*
time zone. On +05:30 that put `now` five and a half hours ahead, sweeping
every window closing inside that span — de-provisioning vendors before their
authorization ended. Fixed with an explicit
`::timestamptz AT TIME ZONE 'UTC'`. Same root cause as the `sent_at` skew in
`adms/queue.ts`. Prisma's query builder gets this right; only hand-written SQL
has to be careful.

**Verified:** 14 checks in `verify:e2e` §6b, including the rule that must
never break (a lapsed vendor who is INSIDE is left alone), de-provision on
exit, idempotency under repeat sweeps, and system attribution on the queued
command. 66 checks passing.

**Hardware-verified 5 Aug 2026** on the single terminal: a lapsed window
removes the vendor from the device while the record and photo stay in the
database; a vendor who is INSIDE past their window keeps working access and
is listed on `/entries/overdue`; punching out de-provisions immediately; and
the scheduled job does all of it unattended.

## Milestone 9 — Entry modes: day-block + daily reset ✅

**Done 5 Aug 2026.** `backend/src/services/entry-modes.ts`.

`SINGLE_ENTRY` is enforced on the **OUT punch**: leaving moves the vendor into
the device's blocked group, and a daily reset moves them back.

**The decision this milestone turned on** (Chirayu, 5 Aug 2026). The OUT punch
can be suppressed by the device (§4.10), which would make single-entry
silently degrade to multi-entry. Blocking on the **IN** punch instead would be
immune to that, and was rejected: on a single bidirectional terminal a blocked
vendor is denied at the very barrier they need to leave through, so the fix
would trap people inside. Instead the **unsafe configuration is refused up
front** — `provisionVendor` rejects `SINGLE_ENTRY` when the target terminal is
`role = BOTH` and its duplicate-punch window is non-zero *or unrecorded*, with
an error naming the exact menu path. A silent security degradation becomes a
loud error at authorization time. `MULTI_ENTRY` is never restricted, and
dedicated IN/OUT gates are unaffected.

"Not yet recorded" is treated as unsafe deliberately: nobody having checked is
not evidence of safety for a control that decides who may re-enter a site.

**Daily reset** runs at `DAILY_RESET_HOUR` (default 0) in **each device's own
local time**, checked every `DAILY_RESET_CRON` (default 15 min). It acts once
per device-local day, decided from `device.last_day_reset_on` rather than from
the schedule firing — so a service that was down at midnight catches up on its
next run, and running it twice does nothing. A vendor whose retention window
has already closed is **not** released; the sweeper is about to remove them.

`GET /api/entries/day-blocked` and `POST /api/entries/daily-reset` expose it.

**Verified:** 7 unit tests on the guard and the device-local clock; 19 checks
in `verify:e2e` §6c covering refusal, the block on exit, device-confirmed
`dayBlocked`, no double-block, reset idempotency within a day, release on a
new day, and the refusal to release a lapsed vendor. 85 checks passing.

**Hardware-verified 5 Aug 2026** on the single terminal: `SINGLE_ENTRY` was
refused on an unsafe configuration and accepted once the duplicate window was
recorded as zero; the OUT punch blocked the vendor and **the terminal then
denied them at the barrier**; the daily reset released them and they were
**admitted again with no re-enrollment**. The two hardware-only facts — that a
blocked vendor is really denied, and a released one really admitted — now hold
on the physical unit rather than against a simulator.

## Milestone 10 — Inside-now board ✅

**Done 5 Aug 2026.** `web/src/app/(app)/inside/page.tsx`, `GET /api/entries/board`.

Who is on site, since when, whose window has closed, and who has used up
today's single entry. Live off the existing SSE bus; polls harder when the
stream is down, because a screen whose whole value is being current must never
be stale and silent about it.

**One request, one round trip.** The board is a single endpoint rather than
three list calls: it sits open on a gate desk refreshing all day, and on a
client-supplied remote database three round trips every few seconds is three
times the cost for a view that is always read together.

**`serverTime` travels with the payload** and is what "overdue" and "here for
3h" are judged against. A gate PC with a drifted clock must not be able to
invent or hide an expiry. There is no separate `overdue` list — it is derived
from `retentionExpiresAt` on rows already returned, so the two cannot disagree.

The page states its own limits rather than implying certainty: someone who
left shortly after arriving can still be listed, because the terminal
suppressed that exit punch before it ever reached the server (§4.10).

React 19's purity rule caught a real bug here — `Date.now()` during render.
The fallback was unreachable (no board means no rows to judge), but the rule
was right to reject reading a clock in render at all.

**Verified:** 4 checks in `verify:e2e` (board reports inside, carries a sane
server clock, agrees with the day-blocked list, and exposes the expiry the UI
derives overdue from). 89 checks passing. `npm run build` clean, ESLint clean
at `--max-warnings=0`.

## Milestone 11 — Verification ✅

**Done 5 Aug 2026.** `verify:e2e` §13. **107 checks passing; 40 unit tests.**

Most of the phase was verified as it was built (§4b, §6b, §6c). M11 covers
what none of that reached: the behaviours the hardware in the room cannot
demonstrate, and the cost properties that regress silently.

- **Batched punches.** Every earlier test sent one record per request; the
  terminal does not work that way. A single body now carries an IN and an OUT
  for one vendor, a punch for a second vendor, and an unknown PIN — and is
  applied in punch order, not body order.
- **Dedicated IN and OUT gates**, the production topology, with a punch state
  that contradicts the gate. The role wins and the disagreement is audited.
- **Two devices in different timezones**, so the per-device local day is
  actually exercised rather than inferred from one device at +05:30.
- **`DAILY_RESET_HOUR` gating**, extracted into `isResetDue` and unit-tested.
  With the default hour of 0 the gate is always satisfied, so it was invisible
  to every test — exactly the shape that hides an off-by-one until a client
  sets a non-zero hour in production.
- **Expiry and the day-block contesting the same vendor.** A lapsed
  `SINGLE_ENTRY` vendor punching out must be removed, not blocked; queueing a
  group change for a user being deleted would be nonsense. The ordering was
  reasoned about in code and never tested.
- **Query budgets as assertions.** Ingesting 12 punches costs no more queries
  than ingesting 2, and sweeping several lapsed entries costs no more than
  sweeping one.

### Two bugs found, one of them real

**`PATCH /api/devices/:id` did not invalidate the ADMS device cache.** The
punch path resolves devices from a 60-second cache to protect the `getrequest`
query budget, so changing a gate's role or its punch-state maps silently did
not apply for up to a minute — punches kept being resolved by the old rules
with nothing indicating it. Introduced in M7, found here by setting a gate to
`IN` and watching the next punch still be treated as bidirectional. Fixed.

**The first query-budget assertion was wrong, not the code.** It compared a
1-punch batch against a 12-punch batch and read the difference as per-punch
scaling. It was two fixed queries from the exit path, which only runs when a
batch *ends* on an OUT. Cost does grow with the number of distinct entries a
batch touches — unavoidable, since each entry has its own `inAt`/`outAt` — but
that is bounded by how many people walked through, not by how many records
arrived. The corrected test compares batches ending in the same direction.

---

## Open items carried from Phase 1

- **Does the barrier still open on a suppressed punch?** Both answers argue
  for `Duplicate Punch Period(m) = 0`, for opposite reasons: if the relay
  fires there is a hole in the movement log; if it does not, a vendor who
  turns straight around cannot leave.
- **Is the duplicate-punch window readable over the protocol?** `INFO` does
  not report it. If an option verb exposes it, onboarding can verify the
  setting instead of instructing an installer to check a menu.
- Punch-state codes `2`–`5` (Break/Overtime) are inferred from menu order,
  never observed. Nothing depends on them.
- `MainTime=1970-01-01` in `INFO`, unexplained.
- Remote-database check, deferred by decision on 4 Aug 2026.

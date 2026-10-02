# Phase 3 — Hardening the sync layer

> **Historical record — do not read as current behaviour.** This documents what was decided and verified during this phase, at the time. Where it disagrees with `CLAUDE.md`, `docs/API_REFERENCE.md` or `docs/VERSIONS.md`, those are current and this is not. (Most likely divergence: device user IDs are **text** since 0.3.0, and the `VENDOR_PIN_START`/`VENDOR_PIN_END` range described here no longer exists.)


**PHASE 3 IS COMPLETE (5 Aug 2026).** Milestones 12–16. M12–M15 are
hardware-verified on the terminal; M16 is the interaction pass.
`npm run verify:e2e` covers **155 checks**, `npm test` **40 unit tests**.

Phase 2 made the lifecycle run itself. Phase 3 makes it survive being wrong:
the device and the database drifting apart, a crash mid-command, a log table
growing without bound, and a capacity ceiling nobody was watching.

**Why this phase is security work, not housekeeping.** There is no
device-native expiry (Phase 0: `EndDatetime` is stored and ignored), so the
database's belief about who is loaded on a terminal is the *only* record of
who can open a barrier. If the two drift, a vendor whose authorization ended
keeps working access and nothing anywhere says so. Reconciliation is the
control that closes that gap — PRD §16 Risk #4.

---

## What Phase 3 is NOT

Several items the PRD lists under Phase 3 already shipped, and re-doing them
would be busywork:

| Item | Where it landed |
|---|---|
| Command queue with retries + idempotency | Phase 1 M4 — `adms/queue.ts`, `MAX_ATTEMPTS`, `idempotencyKey` |
| Crash recovery for in-flight commands | `sweepTimeouts()`; verified in `verify:e2e` §7 (app torn down and rebuilt mid-cycle) |
| Device-offline handling | Phase 1 M6 — `DEVICE_OFFLINE_AFTER_SECONDS`, queue-and-flush verified §9 |

What remains is genuinely new.

---

## The protocol question this phase depends on

**Can the device enumerate its own user list?** Phase 0 proved
`DATA QUERY USERINFO PIN=<pin>` for a *known* PIN. Nothing has established a
"list every user" form.

This matters because the dangerous drift is asymmetric:

- A vendor **missing** from the device is a nuisance — they get turned away,
  someone notices, and it is fixable.
- A vendor **still on** the device who should not be is a **security hole**,
  and it is silent: they walk in, the barrier opens, and everything looks
  normal.

Detecting the second case properly needs enumeration. Without it, Phase 3
uses two weaker signals that are both built on proven behaviour:

1. **`INFO` reports `FaceCount`.** If the device holds more faces than we
   expect, something is on it that we did not put there. That detects the
   condition without identifying who.
2. **Every `USER` record the device sends is a free observation.** It arrives
   on enrollment, and on demand via `DATA QUERY USERINFO`. Comparing each one
   against what we expect turns ordinary traffic into a roster audit.

A hardware probe for enumeration is listed under open items. If it works, the
reconciler gets a fast exact path; the design below does not depend on it.

---

## Milestone 12 — Reconciliation and self-heal ✅

**Done 5 Aug 2026.** `backend/src/services/reconcile.ts`.

Compare the device's reality against the database's belief, and correct what
is safely correctable.

**Auto-heal only what we own and understand:**

| Observed | Expected | Action |
|---|---|---|
| User on device, entry is `REGISTERED` | not on device | **De-provision** — our missed removal, unambiguous |
| User on device, wrong `Grp` | blocked/unblocked state | **Re-issue** the group change |
| Active entry, user absent from device | on device | **Re-provision** from stored photo |
| No vendor claims the PIN, but it is in the reserved range | nothing | **Report only** |
| No vendor claims the PIN, outside the reserved range | not ours | **Ignore** — one owner per roster (CLAUDE.md #7) |

**Ownership is decided by the vendor record, never by the PIN range.**
`POST /api/vendors` deliberately accepts an explicit `esslUserId` outside the
reserved range, because device-first registration has to take whatever PIN the
terminal already used — a vendor at PIN 1001 with the range starting at 10000
is ordinary, not an edge case. The first version of this reconciler used the
range as the ownership test and therefore skipped every such vendor in
silence: the security control excluding exactly the records it exists to
cover, with nothing anywhere reporting it. Found on hardware, not by a test.
The range now only decides what to do with a PIN **no vendor claims**.

The last two rows are the important restraint. Deleting a user we cannot
identify is worse than leaving it: on a shared terminal that could be an
employee, and the VMS is not the owner of their record.

**Face-count drift** is exposed at `GET /api/devices/drift`. `POST /api/devices/reconcile` runs a sweep on demand; the scheduled one is `RECONCILE_CRON` (hourly) over `RECONCILE_BATCH` vendors, rate-limited so reconciliation never starves a provision an operator is waiting on.

**A privacy bug surfaced while writing the tests.** `autoPullPhotoIfMissing`
ran for every `USER` record the device sent, including PINs outside the
reserved vendor range — so on a terminal shared with the client's employees,
the VMS would pull and store *their* enrollment photos. Biometric data for
people the product has no relationship with, on our disk, under DPDP. One
owner per roster cuts both ways: we do not manage those records, so we do not
collect them either. Now gated on the vendor PIN range and asserted.

**Verified:** 10 checks in `verify:e2e` §14 — the dangerous removal, system
attribution, the refusal to delete an unidentifiable PIN, foreign PINs left
entirely alone, group correction, silence when in sync, and face-count excess.
117 checks passing.

## Milestone 13 — `Stamp` / `OpStamp`, and punch-loss detection ✅

**Done 5 Aug 2026.** Answered by observation, not by guessing at a reply format.

### The markers are inert

`Stamp` and `OpStamp` were assumed to be incremental-sync counters the device
advances, with "mishandling risks replayed or dropped punches" carried as a
hazard since Phase 0. **Every value ever observed is `9999`** — 58 punches
across two days, several disconnects and reboots, matching what eTimeTrackLite
showed. They are constants.

So there is no incremental sync to get wrong, no replay-or-drop risk from
these fields, and **no Stamp-based backfill**: a gap in punch history cannot
be closed by asking the device to resume from an earlier marker. Punch
integrity rests on the `raw_record_hash` dedup, which never depended on them.

The handshake is a `GET /iclock/cdata`, answered with a bare `OK` — as the
Phase 0 reference server did while proving every capability on this hardware.
Nothing this firmware requires is missing.

### What replaced it

The real question was never the markers; it was **"can we tell if we lost
punches?"** `INFO` answers it: the device reports `TransactionCount`, the
number of attendance records it holds.

The full 74-key `INFO` reply is now stored verbatim on `device.last_info`.
Only three keys are acted on; the rest is kept because the device is the only
authority on what it can report, and three printed specifications have already
proven wrong. That is how `TransactionCount` was found — by looking, rather
than by shipping a command to see what came back.

**Measured as growth, never as a raw difference.** The device's log outlives a
wiped database: it reported 97 records against 58 stored, entirely explained by
pre-install testing. Comparing absolutes would cry loss on a healthy system,
and an alarm that is wrong on day one gets ignored by day two. From a fixed
baseline, the two counts must rise together; if the device gains records we did
not, the difference is punches that never reached us.

Limits stated rather than papered over: the device log wraps at capacity
(months away at 1,500 movements/day, but not never); clearing the log or
restoring the database invalidates the baseline and it must be re-taken
deliberately; and it counts records, not identities — it says punches were
lost, never whose.

`GET /api/devices/punch-gaps` and `POST /api/devices/:id/punch-baseline`.

**Verified:** 4 checks in `verify:e2e` §15 — a device holding old history is
not reported as loss, undelivered records are, a cleared or wrapped log is
not, and re-baselining refuses without a recorded count. 125 checks passing.

## Milestone 14 — Retention and log rotation ✅

**Done 5 Aug 2026.** `backend/src/jobs/retention.ts`.

At 1,200–1,500 movements/day `punch_event` gains ~500k rows a year, and
`sync_command` several per vendor per cycle. On a bundled on-premise
PostgreSQL nobody is watching, unbounded growth is how an installation dies
quietly two years after handover.

**The rule: summarise before deleting.** Pruning raw punches outright would
make "was this vendor on site last March" unanswerable — the question a site
asks after an incident. `punch_day_summary` keeps who, where, first seen, last
seen, and counts in each direction; the prune loses granularity, not history.
Summary and deletion share one transaction, because a crash between them would
either lose movements or double-count them, and a summary that silently drifts
is worse than none — it still looks authoritative.

Direction is resolved against each device's own status-code maps at prune
time, so the summary carries IN/OUT even though the raw codes are going away.
The day boundary comes from `punched_at_device`, which is already device-local
wall time, so no timezone arithmetic is involved and the date cannot disagree
with what the terminal thought it was.

**Never pruned:** live commands; **`FAILED` commands at any age** — evidence
that something never reached a barrier is not clutter; punches belonging to a
still-active entry; and the audit log unless `AUDIT_RETENTION_DAYS` is set.

That last default is deliberate. The audit log records who authorized whom to
enter a site — the one thing an investigation needs and the last thing that
should vanish on a timer. DPDP's "no longer than necessary" pulls the other
way, and resolving that tension is a client policy decision rather than a
default anyone else should pick for them.

Work is bounded per run (`RETENTION_BATCH` × `RETENTION_PASSES_PER_RUN`): a
year of backlog clears over successive nights rather than one statement
holding locks for minutes on a database that may not be ours.

**Verified:** 9 checks in `verify:e2e` §16 — what is due is reported before
anything is deleted, expired punches are summarised then removed, the summary
carries direction, a punch inside the window is untouched, a repeat pass does
not double-count, and an 900-day-old FAILED command survives.

## Milestone 15 — Alerting ✅

**Done 5 Aug 2026.** `backend/src/services/alerts.ts`, `web/src/components/alerts.tsx`.

`GET /api/alerts`, an alerts panel on the dashboard, and a badge in the nav so
a problem is visible from any screen.

**Computed, never stored.** No acknowledge flag, no alert table. A stored
alert has to be cleared by something, and the failure mode of every such
system is a stale warning nobody trusts or a resolved one nobody cleared.
These derive from current data, so an alert lasts exactly as long as its
cause. Nothing is dismissible — a dismiss button only lets someone hide a
device that is still offline.

**Every alert carries what to do about it**, rendered rather than hidden
behind a click. An alert an operator cannot act on teaches them to ignore the
panel, and a panel that gets ignored is worse than none: it looks like
supervision while providing none.

A health view, not a notification system. Nothing is emailed or pushed — who
should be told and how needs client input (PRD open question 7; some sites
have no internet at all).

**Critical:** device offline (nothing can be provisioned *or removed* while it
is away), face capacity ≥ 85%, failed commands, faces on the device we never
authorized. **Warning:** capacity ≥ 70%, commands stuck while the device is
online, undelivered punches, vendors overdue inside, a bidirectional terminal
that can swallow OUT punches, unrecognised PINs.

A queue backed up behind an offline device does **not** also raise the stuck
alert — two alerts for one cause is how people learn to ignore them.

**Info:** a device that has never reported its capacity. Until it does there
is no ceiling to compare against, so capacity alerting is silently inactive —
and on a fresh install that silence is indistinguishable from health. Found
while testing: setting `maxFaces` by hand to a value the device never reported
is exactly the state a new install is in.

**A second live-system bug, in the one alert that broke its own rule.** The
unrecognised-PIN warning counted audit *rows* rather than distinct PINs — so
one PIN observed twice read as "2 unrecognised PINs" — and it was derived from
a log of past sightings rather than current state, so registering the vendor
left the warning standing. Every other alert here lasts exactly as long as its
cause; this one could not clear itself, which is how a panel stops being read.
It now counts distinct PINs that *still* have no vendor, and names them so the
alert is actionable without digging through the audit log.

Residual, stated rather than hidden: a PIN deleted from the terminal by hand
keeps its alert until the 7-day window ages out. Not seeing something again is
the only evidence available that it is gone — this firmware cannot enumerate
its roster.

**A real bug surfaced on the live system the first time this ran.** It
reported "6 punches never reached the server" when nothing was lost: retention
had summarised and deleted raw rows, so the punch-gap baseline read a falling
row count as loss. Two jobs fighting, and the alarm was the one losing. Punch
accounting is now raw rows **plus** summarised counts, durable across pruning,
and the false alert cleared on the live system.

**Verified:** 10 checks in `verify:e2e` §17 — a healthy system is silent,
capacity escalates at each threshold without double-reporting, offline is
critical, an offline device's queue is not reported twice, the same backlog on
an online device *is*, roster excess is critical, and criticals sort first.
Plus the retention interaction in §15. 144 checks passing.

## Milestone 16 — Verification ✅

**Done 5 Aug 2026.** `verify:e2e` §18. **155 checks; 40 unit tests.**

Each Phase 3 job was verified alone as it was built. M16 targeted the seam
between them, on the evidence that the one bug that actually shipped was an
interaction — retention deleting rows the punch-gap baseline was counting, so
a healthy system reported six punches lost.

That instinct paid immediately. **A second bug of the same shape:** retention
prunes SUCCESS commands after 120 days, and `faceCountDrift` derives "how many
faces did we authorize" by counting `PROVISION` rows. Prune one under a live
entry and the device appears to hold faces nobody asked for — a **critical**
alert on a perfectly consistent system.

Worse than the false alarm: `deviceForEntry` reads that same row to know which
device a vendor sits on. A vendor whose `PROVISION` had been pruned would have
become **impossible to de-provision** — stuck on a terminal with no way to
issue the removal. Reachable in production with any retention window longer
than `COMMAND_RETENTION_DAYS`, or an entry left `INSIDE`.

Retention now never prunes commands belonging to a still-active entry, and the
status view mirrors the same guard so "due for deletion" cannot overstate what
the job will do.

**Interactions now covered:**

- A vendor reported by the device **mid-provision** is not removed as drift —
  during `PENDING_PROVISION`, "not fully on the device yet" is correct.
- The expiry sweeper and the reconciler never both remove the same vendor, so
  the face-capacity slot is returned exactly once.
- Retention leaves punches belonging to an open visit alone, however old.
- Retention leaves the `PROVISION` record of a live entry alone.
- The alerts endpoint — polled by every open dashboard — costs the same with
  60 extra commands as with none.
- After every Phase 3 job has run, a consistent system raises **no alerts**.

Also fixed the structural cause of four `const` collisions in the harness: new
sections are now wrapped in a block rather than relying on distinctive names,
which is what the file header had been advising since M11.

### Still open, and needing the second device

Not blocking; carried into Phase 4.

- Device user **enumeration** — would give reconciliation a fast exact path.
- Does **group 100** exist on a factory-fresh unit?
- Can **denied attempts** be retrieved after the fact?
- `MainTime=1970-01-01` in `INFO`, still unexplained.

---

## Open items

- **Device user enumeration** — probe for a "list all users" command form. A
  fast exact reconciliation depends on it; nothing else does.
- **Does group 100 exist on a factory-fresh device?** Needs the second unit.
- **Can denied attempts be retrieved?** Needs the second unit. If they can,
  SINGLE_ENTRY violations become auditable.
- **`MainTime=1970-01-01`** in `INFO`, still unexplained.

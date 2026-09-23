import { CommandStatus, EntryState } from "@prisma/client";
import { config } from "../config/index.js";
import { prisma } from "../db/index.js";
import { getLicenseStatus } from "./license.js";
import { faceCountDrift, punchGaps } from "./reconcile.js";

// Operational alerting (Phase 3 Milestone 15).
//
// Everything here is COMPUTED, never stored. There is no acknowledge flag, no
// sent/unsent state, no alert table — deliberately. A stored alert has to be
// cleared by something, and the failure mode of every such system is a stale
// warning nobody trusts or a resolved one nobody cleared. These are derived
// from current data, so an alert exists exactly as long as the condition does
// and disappears the moment it is fixed.
//
// This is a health view, not a notification system. Nothing is emailed or
// pushed: who should be told, and how, is a client decision that needs their
// input (PRD open question 7 — some sites have no internet at all).
//
// Ordered by what can hurt: something that lets the wrong person through a
// barrier outranks something that merely fills a disk.

export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  /** Stable across polls, so a UI can key on it without flicker. */
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** What to actually do about it. An alert without one is just noise. */
  action: string;
  entityType?: string;
  entityId?: string;
}

const displayIst = (value: Date) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(value);

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * PINs the device reported that no person claims — and that STILL do not.
 *
 * Two things this must not do, both of which the first version did:
 *
 *   - Count audit rows rather than PINs. The same PIN observed twice became
 *     "2 unrecognised PINs", which is simply wrong.
 *   - Alert on history. Every other alert here is derived from current state,
 *     so it lasts exactly as long as its cause; this one read a log of past
 *     sightings and kept warning about a PIN that had since been registered
 *     as a person. An alert that cannot clear itself is how a panel stops
 *     being read.
 *
 * Residual, and worth stating rather than hiding: a PIN deleted from the
 * terminal by hand keeps its alert until the lookback window ages out. Not
 * seeing something again is the only evidence available that it is gone —
 * there is no way to enumerate the device's roster on this firmware.
 */
async function unresolvedOrphanPins(now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  // Joined and grouped on UPPER(), because `wctpl070` and `WCTPL070` are one
  // person: matching case-sensitively would report a person as unrecognised
  // purely because the terminal reported a different casing than we stored.
  const rows = await prisma.$queryRaw<{ pin: string }[]>`
    SELECT DISTINCT UPPER(a."detail"->>'pin') AS pin
      FROM "audit_log" a
      LEFT JOIN "person" v ON UPPER(v."essl_user_id") = UPPER(a."detail"->>'pin')
     WHERE a."action" = 'RECONCILE_DRIFT_FOUND'
       AND a."created_at" >= ${since.toISOString()}::timestamptz AT TIME ZONE 'UTC'
       AND a."detail"->>'pin' IS NOT NULL
       AND v."id" IS NULL
     ORDER BY pin ASC
  `;
  return rows.map((r) => r.pin);
}

/**
 * Everything currently wrong, worst first.
 *
 * Query cost is fixed: a handful of aggregates plus the device list, not a
 * query per device. This is polled by the dashboard, and a health check that
 * loads the database is its own outage.
 */
export async function collectAlerts(now: Date = new Date()): Promise<Alert[]> {
  const offlineCutoff = new Date(now.getTime() - config.deviceOfflineAfterSeconds * 1000);
  const stuckCutoff = new Date(now.getTime() - config.commandStuckMinutes * 60_000);

  const [devices, failedCommands, stuckCommands, overdueInsideCount, unknownPins, drift, gaps, license] =
    await Promise.all([
      prisma.device.findMany({
        select: {
          id: true,
          name: true,
          serialNo: true,
          role: true,
          facesUsed: true,
          maxFaces: true,
          lastSeenAt: true,
          duplicatePunchPeriodMinutes: true,
        },
      }),
      prisma.syncCommand.groupBy({
        by: ["targetDeviceId"],
        where: { status: CommandStatus.FAILED },
        _count: { _all: true },
      }),
      prisma.syncCommand.groupBy({
        by: ["targetDeviceId"],
        where: {
          status: { in: [CommandStatus.PENDING, CommandStatus.RETRY] },
          createdAt: { lt: stuckCutoff },
        },
        _count: { _all: true },
      }),
      prisma.entry.count({
        where: { state: EntryState.INSIDE, retentionExpiresAt: { not: null, lte: now } },
      }),
      unresolvedOrphanPins(now),
      faceCountDrift(),
      punchGaps(),
      getLicenseStatus(now),
    ]);

  const failedBy = new Map(failedCommands.map((r) => [r.targetDeviceId, r._count._all]));
  const stuckBy = new Map(stuckCommands.map((r) => [r.targetDeviceId, r._count._all]));
  const alerts: Alert[] = [];

  for (const d of devices) {
    const label = d.name ?? d.serialNo;

    // A terminal that is not talking to us is not being managed. Nothing can
    // be provisioned, nothing removed — including a person whose window just
    // closed, who keeps working access at the barrier the whole time.
    if (d.lastSeenAt === null || d.lastSeenAt < offlineCutoff) {
      alerts.push({
        id: `device-offline:${d.id}`,
        severity: "critical",
        title: `${label} is offline`,
        detail:
          d.lastSeenAt === null
            ? "This device has never checked in."
            : `Last contact ${displayIst(d.lastSeenAt)} IST. Queued work is not reaching it, including removals for expired people.`,
        action: "Check the terminal's power, network cable, and Cloud Server settings.",
        entityType: "device",
        entityId: d.id,
      });
    }

    // Capacity alerting cannot work at all until the device has told us its
    // ceiling — and silently not working is the worst shape for a warning.
    // A fresh install has no maxFaces until someone refreshes, so the absence
    // is reported rather than left to look like "nothing is wrong".
    if (d.maxFaces === null) {
      alerts.push({
        id: `capacity-unknown:${d.id}`,
        severity: "info",
        title: `${label} has never reported its capacity`,
        detail:
          "Face-capacity alerting is inactive for this device: we do not know its maximum, so there is no threshold to cross. Provisioning will simply start failing at whatever the real ceiling is.",
        action: "Open Devices and click 'Refresh from device' to read capacity from the device itself.",
        entityType: "device",
        entityId: d.id,
      });
    }

    // Capacity. The ceiling is real and hard: at 3,000 faces a provision
    // simply fails, and it fails at the moment somebody is waiting at a gate.
    if (d.maxFaces !== null && d.maxFaces > 0) {
      const pct = Math.round((d.facesUsed / d.maxFaces) * 100);
      if (pct >= config.faceCapacityCriticalPercent) {
        alerts.push({
          id: `capacity-critical:${d.id}`,
          severity: "critical",
          title: `${label} is at ${pct}% face capacity`,
          detail: `${d.facesUsed} of ${d.maxFaces} faces used. New provisions start failing at the ceiling.`,
          action:
            "De-provision people whose windows have lapsed (see the Inside Now board), or shorten retention windows for new provisions.",
          entityType: "device",
          entityId: d.id,
        });
      } else if (pct >= config.faceCapacityWarnPercent) {
        alerts.push({
          id: `capacity-warning:${d.id}`,
          severity: "warning",
          title: `${label} is at ${pct}% face capacity`,
          detail: `${d.facesUsed} of ${d.maxFaces} faces used.`,
          action: "Review retention windows before this becomes urgent.",
          entityType: "device",
          entityId: d.id,
        });
      }
    }

    const failed = failedBy.get(d.id) ?? 0;
    if (failed > 0) {
      alerts.push({
        id: `commands-failed:${d.id}`,
        severity: "critical",
        title: `${failed} command${failed === 1 ? "" : "s"} failed on ${label}`,
        detail:
          "A failed command means an intended change never reached the terminal — a person not loaded, not removed, or not blocked. The device and the database disagree until this is dealt with.",
        action: "Open the command queue, read the error, and retry or resolve each one.",
        entityType: "device",
        entityId: d.id,
      });
    }

    // Queued but not collected, while the device is talking to us. That
    // combination means dispatch is broken rather than the device being away,
    // which the offline alert already covers.
    const stuck = stuckBy.get(d.id) ?? 0;
    if (stuck > 0 && d.lastSeenAt !== null && d.lastSeenAt >= offlineCutoff) {
      alerts.push({
        id: `commands-stuck:${d.id}`,
        severity: "warning",
        title: `${stuck} command${stuck === 1 ? "" : "s"} waiting on ${label}`,
        detail: `Queued more than ${config.commandStuckMinutes} minutes ago, but the device is online and polling. Work is not being handed over.`,
        action: "Check the backend log for dispatch errors; a command that cannot be rendered is marked FAILED instead.",
        entityType: "device",
        entityId: d.id,
      });
    }

    // A bidirectional terminal that can swallow the OUT punch. Provisioning
    // refuses SINGLE_ENTRY on such a device, but the setting can be changed
    // afterwards — leaving existing single-entry people unenforced.
    if (d.role === "BOTH" && (d.duplicatePunchPeriodMinutes ?? 1) !== 0) {
      alerts.push({
        id: `duplicate-window:${d.id}`,
        severity: "warning",
        title: `${label} may be dropping OUT punches`,
        detail:
          d.duplicatePunchPeriodMinutes === null
            ? "This terminal reports both directions and its duplicate-punch window has never been recorded."
            : `This terminal reports both directions and drops repeat punches by the same user within ${d.duplicatePunchPeriodMinutes} minute(s). A person who leaves shortly after arriving produces no OUT record, so SINGLE_ENTRY is not enforced and the inside-now board overstates who is present.`,
        action:
          "Set Menu > System > Attendance > Duplicate Punch Period(m) to 0 on the terminal, then record that on the Devices page so this alert clears.",
        entityType: "device",
        entityId: d.id,
      });
    }
  }

  // The device holds faces we did not authorize. Whoever they are, they can
  // open the barrier, and nothing else in the system reports it.
  for (const d of drift.filter((x) => x.excess > 0)) {
    const label = d.name ?? d.serialNo;
    alerts.push({
      id: `roster-excess:${d.deviceId}`,
      severity: "critical",
      title: `${label} holds ${d.excess} face${d.excess === 1 ? "" : "s"} we did not authorize`,
      detail: `The device reports ${d.onDevice} faces; we authorized ${d.expected}. Someone is loaded who should not be, or a removal was missed — either way they can open the barrier.`,
      action:
        "Open Devices and click 'Reconcile now'. If the extra face was enrolled directly on the terminal, it also appears in the Unclaimed enrollments panel on the Dashboard, ready to register.",
      entityType: "device",
      entityId: d.deviceId,
    });
  }

  for (const g of gaps) {
    const label = g.name ?? g.serialNo;
    alerts.push({
      id: `punch-gap:${g.deviceId}`,
      severity: "warning",
      title: `${g.missing} punch${g.missing === 1 ? "" : "es"} never reached the server`,
      detail: `Since ${displayIst(g.baselineAt)} IST, ${label} logged ${g.deviceGained} records and we stored ${g.weStored}. The movement history has holes.`,
      action:
        "Check for network interruptions. If the device log was cleared or the database restored, open Devices and click 'Reset baseline' for this device.",
      entityType: "device",
      entityId: g.deviceId,
    });
  }

  if (overdueInsideCount > 0) {
    alerts.push({
      id: "overdue-inside",
      severity: "warning",
      title: `${overdueInsideCount} person${overdueInsideCount === 1 ? " is" : "s are"} inside past their window`,
      detail:
        "They are deliberately not removed — taking a credential away mid-visit would strand someone at the exit barrier — so removal waits for their OUT punch. If it never comes, they stay loaded indefinitely.",
      action: "Open the inside-now board. If someone left without punching out, de-provision them by hand.",
    });
  }

  if (unknownPins.length > 0) {
    alerts.push({
      id: "unknown-pins",
      severity: "warning",
      title: `${unknownPins.length} unrecognised ID${unknownPins.length === 1 ? "" : "s"} seen on a terminal`,
      detail:
        `${unknownPins.join(", ")} — observed on a terminal, but no person record claims ${unknownPins.length === 1 ? "it" : "them"}. ` +
        "Never changed or removed automatically: an ID we cannot identify might belong to another roster.",
      action:
        "Register the ID as a person if it belongs to one, or delete the user from the terminal if it does not. The alert clears on its own once a person claims it.",
    });
  }

  // Licensing (Phase 6 task 5) is deliberately warn-only — this is the ONLY
  // enforcement that exists. Nothing is ever blocked; the worst outcome of
  // ignoring this alert forever is that it never goes away.
  //
  // No "no license installed" alert here, deliberately: commercial licensing
  // terms are not decided yet (docs/DEPLOYMENT_READINESS.md §5), so most
  // installs will never have one, and a permanent info alert nobody can act
  // on is exactly the noise that makes a client stop reading this panel. An
  // installed license that later expires still needs surfacing below.
  if (license.installed && license.expired) {
    alerts.push({
      id: "license-expired",
      severity: "warning",
      title: "The installed license has expired",
      detail: `Expired ${license.expiresAt}. Device communication and safety jobs continue, but operator APIs are locked.`,
      action: "An Admin must install a renewed key from the License page.",
    });
  } else if (license.expiringSoon) {
    alerts.push({
      id: "license-expiring",
      severity: "info",
      title: `License expires in ${license.daysRemaining} day${license.daysRemaining === 1 ? "" : "s"}`,
      detail: `Expires ${license.expiresAt}.`,
      action: "Install a renewed license key from the License page ahead of time.",
    });
  }

  return alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

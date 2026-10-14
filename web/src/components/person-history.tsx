"use client";

import { type AuditList } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/swr";
import { formatDateTime, titleCase } from "@/lib/format";
import { Badge, Card, Empty, Table } from "@/components/ui";

// This person's audit history, shown where the question gets asked.
//
// Admin only, matching every other audit view: these rows name the operators
// who acted, and who may read a colleague's activity was settled in Milestone
// 17. Rendering nothing rather than an empty card for other roles — a panel
// that is always empty invites someone to report it as broken.

/** Requested vs done: the gap between them is where a device problem lives. */
function tone(action: string): "ok" | "warn" | "danger" | "info" | "neutral" {
  if (action.startsWith("RECONCILE")) return "warn";
  if (action === "PERMISSION_DENIED" || action.includes("CONFLICT")) return "danger";
  if (action.endsWith("_REQUESTED")) return "info";
  return "neutral";
}

/** The interesting part of a detail blob, not the whole JSON. */
function summarise(detail: unknown): string {
  if (detail === null || typeof detail !== "object") return "";
  const d = detail as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["reason", "fromState", "drift", "grp", "action", "esslUserId"]) {
    if (d[key] !== undefined) parts.push(`${key}: ${String(d[key])}`);
  }
  return parts.join(" · ");
}

// The wording the rest of the console uses (pre-demo sweep); a rare action
// falls back to its code, title-cased.
const ACTION: Record<string, string> = {
  ENTRY_PROVISION_REQUESTED: "Provision requested",
  ENTRY_PROVISIONED: "Provisioned",
  ENTRY_DEPROVISION_REQUESTED: "De-provision requested",
  ENTRY_DEPROVISIONED: "De-provisioned",
  ENTRY_BLOCK_REQUESTED: "Block requested",
  ENTRY_BLOCKED: "Blocked",
  ENTRY_UNBLOCK_REQUESTED: "Unblock requested",
  ENTRY_UNBLOCKED: "Unblocked",
  GATE_LOAD_QUEUED: "Loading on device",
  GATE_LOADED: "Loaded on device",
  GATE_UNLOAD_QUEUED: "Removing from device",
  GATE_UNLOAD_SCHEDULED: "Removal scheduled",
  RECONCILE_HEALED: "Device corrected automatically",
  RECONCILE_DRIFT_FOUND: "Device mismatch found",
  ZONE_WIDENED: "Zone added",
  EXIT_OVERRIDE: "Exit override",
  EXIT_OTP_ISSUED: "Exit code issued",
  EXIT_OTP_VERIFIED: "Exit code used",
  EXIT_OTP_FAILED: "Wrong exit code",
  PHOTO_UPDATED: "Photo updated",
  PERSON_CREATED: "Registered",
  PERSON_UPDATED: "Details changed",
  PERSON_DEACTIVATED: "Deactivated",
  PERSON_REACTIVATED: "Reactivated",
  PERSON_ERASED: "Data erased",
  BLACKLISTED: "Blacklisted",
  BLACKLIST_LIFTED: "Blacklist lifted",
};

export function PersonHistory({ personId }: { personId: string }) {
  const { can } = useAuth();
  const allowed = can("audit:view");
  const { data } = useApi<AuditList>(allowed ? `/api/people/${personId}/audit` : null);

  if (!allowed) return null;

  return (
    <Card title="History">
      {!data ? (
        <Empty>Loading…</Empty>
      ) : data.items.length === 0 ? (
        <Empty>Nothing recorded for this person yet.</Empty>
      ) : (
        <>
          <Table head={["When", "What", "Who", "Detail"]}>
            {data.items.map((row, i) => (
              <tr key={i} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2 whitespace-nowrap text-xs text-[var(--text-muted)]">
                  {formatDateTime(row.createdAt)}
                </td>
                <td className="px-2 py-2">
                  <Badge tone={tone(row.action)}>{ACTION[row.action] ?? titleCase(row.action)}</Badge>
                </td>
                <td className="px-2 py-2 text-xs">{row.actor}</td>
                <td className="px-2 py-2 text-xs text-[var(--text-muted)]">
                  {summarise(row.detail)}
                </td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Covers this person and every provisioning of them. An actor of{" "}
            <strong>system</strong> means the system acted on its own — loading or removing a face on
            schedule, or correcting a device that drifted — not a person.
          </p>
        </>
      )}
    </Card>
  );
}

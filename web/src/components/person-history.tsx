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

export function PersonHistory({ personId }: { personId: string }) {
  const { can } = useAuth();
  const allowed = can("audit:read");
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
                  <Badge tone={tone(row.action)}>{titleCase(row.action)}</Badge>
                </td>
                <td className="px-2 py-2 text-xs">{row.actor}</td>
                <td className="px-2 py-2 text-xs text-[var(--text-muted)]">
                  {summarise(row.detail)}
                </td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Covers this person and every authorization issued to them. An actor of{" "}
            <strong>system</strong> means a scheduled job — an expiry sweep, a daily reset, or
            reconciliation correcting drift — not a person.
          </p>
        </>
      )}
    </Card>
  );
}

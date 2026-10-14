"use client";

import { useState } from "react";
import { getApiBase, getToken, type ReportRun } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { formatDateInputIst, formatDateTime } from "@/lib/format";
import { Badge, Card, Empty, Field, Input, Table } from "@/components/ui";

// One person's INs and OUTs over a date range: per-day counts from the
// Attendance report and each punch from the Punch log, both run through the
// report registry so this panel, the Reports page and the CSV agree. Ported
// from 0.4.24 (F3 F-g); two-zone adds the zone of each punch.

const PAGE_SIZE = 200;

export function PersonMovement({ personId }: { personId: string }) {
  const today = formatDateInputIst(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const params = new URLSearchParams({ personId, pageSize: String(PAGE_SIZE) });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const { data: days } = useApi<ReportRun>(`/api/reports/attendance?${params.toString()}`);
  const { data: punches } = useApi<ReportRun>(`/api/reports/punch-log?${params.toString()}`);
  const csvHref = `${getApiBase()}/api/reports/punch-log?${params.toString()}&format=csv&token=${encodeURIComponent(getToken() ?? "")}`;

  const text = (value: unknown) => (value === null || value === undefined ? "—" : String(value));
  const when = (value: unknown) => (typeof value === "string" ? formatDateTime(value) : "—");

  return (
    <Card
      title="Ins and outs"
      action={<a href={csvHref} className="text-xs text-[var(--brand)] hover:underline" download>Download CSV</a>}
    >
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {!days || !punches ? (
        <Empty>Loading…</Empty>
      ) : days.rows.length === 0 && punches.rows.length === 0 ? (
        <Empty>No punches in this range.</Empty>
      ) : (
        <div className="space-y-4">
          <Table head={["Date", "IN", "OUT", "First IN", "Last OUT"]}>
            {days.rows.map((row, i) => (
              <tr key={i} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2">{text(row.day)}</td>
                <td className="px-2 py-2">{text(row.ins)}</td>
                <td className="px-2 py-2">{text(row.outs)}</td>
                <td className="px-2 py-2 text-xs">{when(row.first_in_utc)}</td>
                <td className="px-2 py-2 text-xs">{when(row.last_out_utc)}</td>
              </tr>
            ))}
          </Table>
          <Table head={["Time", "Direction", "Device", "Zone"]}>
            {punches.rows.map((row, i) => (
              <tr key={i} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2 text-xs">{when(row.punched_at)}</td>
                <td className="px-2 py-2">
                  <Badge tone={row.direction === "IN" ? "ok" : row.direction === "OUT" ? "info" : "neutral"}>{text(row.direction)}</Badge>
                </td>
                <td className="px-2 py-2">{text(row.device)}</td>
                <td className="px-2 py-2">{text(row.zone)}</td>
              </tr>
            ))}
          </Table>
          {punches.total > punches.rows.length && (
            <p className="text-xs text-[var(--text-muted)]">
              Showing the latest {punches.rows.length} of {punches.total} punches — download the CSV for all of them.
            </p>
          )}
          <p className="text-xs text-[var(--text-muted)]">
            Individual punch times are kept for the retention window only; older days show counts but no times.
          </p>
        </div>
      )}
    </Card>
  );
}

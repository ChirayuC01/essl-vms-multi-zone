"use client";

import { type AlertList, type AlertSeverity } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { Accordion, Badge, Empty } from "@/components/ui";

// Operational alerts.
//
// Every alert carries what to DO about it, and that field is rendered rather
// than hidden behind a click. An alert an operator cannot act on teaches them
// to ignore the panel, and a panel that gets ignored is worse than none —
// it looks like supervision while providing none.
//
// Nothing is dismissible. These are computed from current state, so an alert
// disappears when its cause is fixed and not before. A dismiss button would
// only let someone hide a device that is still offline.

const TONE: Record<AlertSeverity, "danger" | "warn" | "info"> = {
  critical: "danger",
  warning: "warn",
  info: "info",
};

export function AlertsPanel() {
  const { data } = useApi<AlertList>("/api/alerts", { refreshInterval: 30_000 });

  return (
    <Accordion
      title="Alerts"
      summary={
        <span className="flex items-center gap-1">
          {!data && <Badge>…</Badge>}
          {data && data.total === 0 && <Badge tone="ok">0 active</Badge>}
          {data && data.critical > 0 && <Badge tone="danger">{data.critical} critical</Badge>}
          {data && data.warning > 0 && <Badge tone="warn">{data.warning} warning</Badge>}
          {data && data.total > data.critical + data.warning && <Badge tone="info">{data.total - data.critical - data.warning} info</Badge>}
        </span>
      }
    >
      {!data ? <Empty>Loading alerts…</Empty> : data.total === 0 ? <Empty>Nothing needs attention.</Empty> : <ul className="space-y-2">
        {data.items.map((alert) => (
          <li
            key={alert.id}
            className="rounded-[var(--radius)] border border-[var(--border)] p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium">{alert.title}</span>
              <Badge tone={TONE[alert.severity]}>{alert.severity}</Badge>
            </div>
            <p className="mt-1 text-sm text-[var(--text-muted)]">{alert.detail}</p>
            <p className="mt-2 text-sm">
              <span className="font-medium">What to do: </span>
              {alert.action}
            </p>
          </li>
        ))}
      </ul>}
    </Accordion>
  );
}

/** Critical count for the nav, so a problem is visible from any screen. */
export function AlertBadge() {
  const { data } = useApi<AlertList>("/api/alerts", { refreshInterval: 30_000 });
  if (!data || data.total === 0) return null;
  return (
    <Badge tone={data.critical > 0 ? "danger" : "warn"}>
      {data.critical > 0 ? `${data.critical} critical` : `${data.warning} warning`}
    </Badge>
  );
}

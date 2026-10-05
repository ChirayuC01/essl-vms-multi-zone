"use client";

import { useState } from "react";
import type { AccessAction, AccessResource } from "@/lib/api";
import { Input } from "@/components/ui";

const ACTIONS: AccessAction[] = ["view", "create", "update", "delete"];

/** A cell's state. Role grids use allow/off; operator grids add inherit/deny. */
export type CellState = "allow" | "off" | "inherit" | "deny";

/**
 * The feature x action grid, grouped and searchable. Only the actions that
 * mean something for a feature are shown; the rest of the row is blank.
 *
 * `render` draws one cell; the two screens (role defaults and one operator's
 * overrides) differ only in what a cell can be, so they share everything else.
 */
export function AccessGrid({
  resources,
  render,
}: {
  resources: AccessResource[];
  render: (permission: string, resource: AccessResource, action: AccessAction) => React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = resources.filter((r) => !q || r.label.toLowerCase().includes(q) || r.group.toLowerCase().includes(q));
  const groups = [...new Set(shown.map((r) => r.group))];

  return (
    <div>
      <Input className="mb-3 max-w-sm" placeholder="Search features…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <th className="px-3 py-2 font-medium">Feature</th>
              {ACTIONS.map((a) => <th key={a} className="w-28 px-2 py-2 text-center font-medium">{a}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <GroupRows key={group} group={group} resources={shown.filter((r) => r.group === group)} render={render} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({
  group,
  resources,
  render,
}: {
  group: string;
  resources: AccessResource[];
  render: (permission: string, resource: AccessResource, action: AccessAction) => React.ReactNode;
}) {
  return (
    <>
      <tr className="bg-[var(--surface-muted)]">
        <td colSpan={5} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{group}</td>
      </tr>
      {resources.map((r) => (
        <tr key={r.key} className="border-b border-[var(--border)] last:border-0">
          <td className="px-3 py-2">{r.label}</td>
          {ACTIONS.map((a) => (
            <td key={a} className="px-2 py-2 text-center align-top">
              {r.actions.includes(a) && (
                <>
                  {render(`${r.key}:${a}`, r, a)}
                  {r.notes?.[a] && <div className="mt-1 text-[10px] leading-tight text-[var(--text-muted)]">{r.notes[a]}</div>}
                </>
              )}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** A ✓ / ✗ toggle for a role grid. */
export function ToggleCell({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onChange}
      aria-pressed={on}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-sm ${
        on ? "border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok)]" : "border-[var(--border)] text-[var(--text-muted)]"
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {on ? "✓" : "✕"}
    </button>
  );
}

"use client";

import { endOfIstDay, formatDateTime } from "@/lib/format";
import { Field, Input } from "@/components/ui";

const pad = (n: number) => String(n).padStart(2, "0");
/** A datetime-local value for a Date, in the browser's local time. */
export function localInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Calendar days including the visit day, as the server counts them.
const PRESETS: [string, number][] = [["today", 1], ["1 week", 7], ["1 month", 30], ["3 months", 90], ["6 months", 180], ["1 year", 365]];

/**
 * "Valid until" with shortcuts and the latest end the pass type and entry
 * mode allow. The server enforces the same limit; this only says it up front.
 */
export function ValidUntilField({ from, until, onChange, singleEntry, maxDays }: {
  from: string;
  until: string;
  onChange: (value: string) => void;
  singleEntry: boolean;
  maxDays: number | null | undefined;
}) {
  const start = new Date(from);
  const limitDays = singleEntry ? 1 : maxDays ?? null;
  const latest = limitDays !== null && !Number.isNaN(start.getTime()) ? endOfIstDay(start, limitDays) : null;
  const over = latest !== null && new Date(until) > latest;
  return (
    <Field label="Valid until" hint={latest ? `Latest allowed: ${formatDateTime(latest.toISOString())}` : undefined}>
      <Input type="datetime-local" value={until} max={latest ? localInput(latest) : undefined} onChange={(e) => onChange(e.target.value)} />
      {over && <p className="mt-1 text-xs text-[var(--danger)]">Later than this pass type allows.</p>}
      <div className="mt-1 flex flex-wrap gap-2 text-xs">
        {PRESETS.map(([label, days]) => {
          const allowed = limitDays === null || days <= limitDays;
          return (
            <button key={label} type="button" className="underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40" disabled={!allowed || Number.isNaN(start.getTime())} title={allowed ? undefined : "Longer than this pass allows"} onClick={() => onChange(localInput(endOfIstDay(start, days)))}>
              {label}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

"use client";

import { useState } from "react";
import { api, ApiError, type EntryDetail, type GateState, type ZoneList } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Badge, Button, Input, Select } from "@/components/ui";

// Where one pass stands on each terminal, plus the Security actions on it.
// "PROVISIONED" is one word for any number of terminals; this is the answer
// to "can they get out?".

const LABEL: Record<GateState, { text: string; tone: "ok" | "warn" | "danger" | "neutral" | "info" }> = {
  PENDING: { text: "scheduled", tone: "neutral" },
  LOADING: { text: "loading", tone: "info" },
  LOADED: { text: "loaded", tone: "ok" },
  UNLOADING: { text: "removing", tone: "warn" },
  DONE: { text: "removed", tone: "neutral" },
};

export function PassGates({ entryId }: { entryId: string }) {
  const { can } = useAuth();
  const url = `/api/entries/${entryId}`;
  const { data: entry } = useApi<EntryDetail>(url, { refreshInterval: 10_000 });
  const { data: zoneList } = useApi<ZoneList>("/api/zones");
  const [reason, setReason] = useState("");
  const [widenTo, setWidenTo] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (!entry) return null;

  const zoneName = (id: string | null | undefined) => (id ? zoneList?.items.find((z) => z.id === id)?.name ?? "zone" : null);
  const live = entry.state === "PROVISIONED" || entry.state === "INSIDE";
  const codeExitsMissing = entry.entryMode === "SINGLE_ENTRY" && (entry.exitCodeZoneIds?.length ?? 0) > 0 && !entry.gates.some((g) => g.device.role === "OUT" && g.device.zoneId && entry.exitCodeZoneIds!.includes(g.device.zoneId));
  const widenable = (zoneList?.items ?? []).filter((z) => z.isActive && !(entry.zoneIds ?? []).includes(z.id));

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setProblem(null);
    setNotice(null);
    try {
      await fn();
      await refresh(url);
      setNotice(label);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "action failed");
    }
  };

  return (
    <div className="space-y-3 rounded-[var(--radius)] bg-[var(--surface-muted)] p-3">
      {problem && <Alert>{problem}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}
      <p className="text-xs font-medium">
        Location: {entry.state === "INSIDE" ? `inside${zoneName(entry.locationZoneId) ? ` — ${zoneName(entry.locationZoneId)}` : ""}` : "outside"}
        {entry.state === "INSIDE" && entry.retentionExpiresAt && new Date(entry.retentionExpiresAt) < new Date() && <Badge tone="danger">overstayed</Badge>}
      </p>
      {entry.gates.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">No terminals scheduled for this pass.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {entry.gates.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2">
              <span>{g.device.name ?? g.device.serialNo}{g.device.role !== "BOTH" ? ` (${g.device.role})` : ""}</span>
              <Badge tone={LABEL[g.state].tone}>{LABEL[g.state].text}</Badge>
              {g.reason !== "SCHEDULE" && <span className="text-[var(--text-muted)]">{g.reason.toLowerCase().replace("_", " ")}</span>}
              {g.state === "PENDING" && <span className="text-[var(--text-muted)]">from {formatDateTime(g.loadAt)}</span>}
              {g.unloadAt && g.state !== "DONE" && <span className="text-[var(--text-muted)]">leaves {formatDateTime(g.unloadAt)}</span>}
            </li>
          ))}
        </ul>
      )}
      {codeExitsMissing && <p className="text-xs text-[var(--text-muted)]">Exit terminals load after the exit code is verified, or a Security override.</p>}
      {live && codeExitsMissing && can("exit_override:update") && (
        <div className="flex flex-wrap items-end gap-2">
          <Input className="max-w-xs" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required), e.g. host unreachable" />
          <Button variant="danger" disabled={reason.trim().length < 3} onClick={() => void run("Exit released: the exit terminals are loading.", () => api(`${url}/exit-override`, { method: "POST", body: { reason: reason.trim() } }))}>
            Release at exit (override)
          </Button>
        </div>
      )}
      {live && can("zone_widen:update") && widenable.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <Select className="max-w-xs" value={widenTo} onChange={(e) => setWidenTo(e.target.value)}>
            <option value="">Add a zone…</option>
            {widenable.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </Select>
          <Button disabled={!widenTo} onClick={() => void run("Zone added: its terminals are loading.", () => api(`${url}/widen`, { method: "POST", body: { zoneId: widenTo } }))}>
            Widen pass
          </Button>
        </div>
      )}
    </div>
  );
}

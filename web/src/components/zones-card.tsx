"use client";

import { useState } from "react";
import { api, type Zone, type ZoneList } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Badge, Button, Card, Input, Select, Table } from "@/components/ui";

// Site zones. A zone inside another (a yard inside the premise) also grants
// its parent's gates, because the parent's barrier is in the way. Terminals
// are placed into zones from their own cards below.
export function ZonesCard() {
  const { can } = useAuth();
  const { data } = useApi<ZoneList>("/api/zones");
  const [name, setName] = useState("");
  const [parentZoneId, setParentZoneId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const editable = can("device:configure");
  const zones = data?.items ?? [];
  const nameOf = (id: string | null) => zones.find((z) => z.id === id)?.name ?? "—";

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh("/api/zones");
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    }
  }
  const patch = (zone: Zone, body: object) => run(() => api(`/api/zones/${zone.id}`, { method: "PATCH", body }));

  return (
    <Card title="Zones">
      {error && <Alert>{error}</Alert>}
      {editable && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New zone name" />
          <Select value={parentZoneId} onChange={(e) => setParentZoneId(e.target.value)}>
            <option value="">Top level (no parent)</option>
            {zones.filter((z) => z.isActive).map((z) => <option key={z.id} value={z.id}>Inside {z.name}</option>)}
          </Select>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={() => run(async () => {
              await api("/api/zones", { method: "POST", body: { name: name.trim(), parentZoneId: parentZoneId || null } });
              setName("");
              setParentZoneId("");
            })}
          >
            Add zone
          </Button>
        </div>
      )}
      {zones.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No zones yet. Add the outermost zone first, then any zone inside it.</p>
      ) : (
        <Table head={["Zone", "Inside", "Terminals", "Exit code by default", "Status", ...(editable ? ["Action"] : [])]}>
          {zones.map((zone) => (
            <tr key={zone.id} className="border-b border-[var(--border)] align-top">
              <td className="px-2 py-2">
                {zone.name}
                {zone.warning && <p className="mt-1 text-xs text-[var(--warn)]">{zone.warning}</p>}
              </td>
              <td className="px-2 py-2">{nameOf(zone.parentZoneId)}</td>
              <td className="px-2 py-2">{zone.gates.IN} in · {zone.gates.OUT} out{zone.gates.BOTH ? ` · ${zone.gates.BOTH} both` : ""}</td>
              <td className="px-2 py-2">
                {editable ? (
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={zone.exitCodeDefault} onChange={() => patch(zone, { exitCodeDefault: !zone.exitCodeDefault })} />
                    {zone.exitCodeDefault ? "Yes" : "No"}
                  </label>
                ) : zone.exitCodeDefault ? "Yes" : "No"}
              </td>
              <td className="px-2 py-2"><Badge tone={zone.isActive ? "ok" : "warn"}>{zone.isActive ? "active" : "inactive"}</Badge></td>
              {editable && (
                <td className="px-2 py-2">
                  <Button onClick={() => patch(zone, { isActive: !zone.isActive })}>{zone.isActive ? "Deactivate" : "Reactivate"}</Button>
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

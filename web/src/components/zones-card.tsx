"use client";

import { useState } from "react";
import { api, type Zone, type ZoneList } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Badge, Button, Card, Input, SearchSelect, Table } from "@/components/ui";

// Site zones. A zone inside another (a yard inside the premise) also grants
// its parent's gates, because the parent's barrier is in the way. Terminals
// are placed into zones from their own cards below. Which exits need the exit
// code is set on each pass type, not here (F2 #10).
//
// A zone can be renamed or moved under another at any time; live passes and
// employee access keep the terminals they were given. Delete is only for a
// zone nothing ever used (a typo); anything used can only be deactivated.
export function ZonesCard() {
  const { can } = useAuth();
  const { data } = useApi<ZoneList>("/api/zones");
  const [name, setName] = useState("");
  const [parentZoneId, setParentZoneId] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; parentZoneId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editable = can("zones:update");
  const creatable = can("zones:create");
  const deletable = can("zones:delete");
  const zones = data?.items ?? [];
  const nameOf = (id: string | null) => zones.find((z) => z.id === id)?.name ?? "—";
  // A zone cannot move inside itself or anything inside it.
  const insideOf = (id: string): Set<string> => {
    const out = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const z of zones) if (z.parentZoneId && out.has(z.parentZoneId) && !out.has(z.id)) { out.add(z.id); grew = true; }
    }
    return out;
  };

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh("/api/zones");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
      return false;
    }
  }
  const patch = (zone: Zone, body: object) => run(() => api(`/api/zones/${zone.id}`, { method: "PATCH", body }));

  return (
    <Card title="Zones">
      {error && <Alert>{error}</Alert>}
      {creatable && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New zone name" />
          <div className="min-w-56">
            <SearchSelect value={parentZoneId} onChange={setParentZoneId} options={zones.filter((z) => z.isActive).map((z) => ({ value: z.id, label: `Inside ${z.name}` }))} emptyLabel="Top level (no parent)" />
          </div>
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
        <Table head={["Zone", "Inside", "Devices", "Status", ...(editable || deletable ? ["Action"] : [])]}>
          {zones.map((zone) =>
            editing?.id === zone.id ? (
              <tr key={zone.id} className="border-b border-[var(--border)] align-top">
                <td className="px-2 py-2"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></td>
                <td className="px-2 py-2">
                  <SearchSelect
                    value={editing.parentZoneId}
                    onChange={(v) => setEditing({ ...editing, parentZoneId: v })}
                    options={zones.filter((z) => z.isActive && !insideOf(zone.id).has(z.id)).map((z) => ({ value: z.id, label: `Inside ${z.name}` }))}
                    emptyLabel="Top level (no parent)"
                  />
                  <p className="mt-1 text-xs text-[var(--text-muted)]">Applies to new passes and grants; live ones keep their devices.</p>
                </td>
                <td className="px-2 py-2" colSpan={2} />
                <td className="px-2 py-2">
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      disabled={!editing.name.trim()}
                      onClick={async () => { if (await patch(zone, { name: editing.name.trim(), parentZoneId: editing.parentZoneId || null })) setEditing(null); }}
                    >
                      Save
                    </Button>
                    <Button onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={zone.id} className="border-b border-[var(--border)] align-top">
                <td className="px-2 py-2">
                  {zone.name}
                  {zone.warning && <p className="mt-1 text-xs text-[var(--warn)]">{zone.warning}</p>}
                </td>
                <td className="px-2 py-2">{nameOf(zone.parentZoneId)}</td>
                <td className="px-2 py-2">{zone.gates.IN} in · {zone.gates.OUT} out{zone.gates.BOTH ? ` · ${zone.gates.BOTH} both` : ""}</td>
                <td className="px-2 py-2"><Badge tone={zone.isActive ? "ok" : "warn"}>{zone.isActive ? "active" : "inactive"}</Badge></td>
                {(editable || deletable) && (
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap gap-2">
                      {editable && <Button onClick={() => setEditing({ id: zone.id, name: zone.name, parentZoneId: zone.parentZoneId ?? "" })}>Edit</Button>}
                      {editable && <Button onClick={() => patch(zone, { isActive: !zone.isActive })}>{zone.isActive ? "Deactivate" : "Reactivate"}</Button>}
                      {deletable && (
                        <Button
                          variant="danger"
                          onClick={() => { if (window.confirm(`Delete zone "${zone.name}"? Only a zone that was never used can be deleted.`)) void run(() => api(`/api/zones/${zone.id}`, { method: "DELETE" })); }}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ),
          )}
        </Table>
      )}
    </Card>
  );
}

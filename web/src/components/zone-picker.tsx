"use client";

// Zone tick boxes. A zone inside another opens its parent's gates too (the
// parent's barrier is in the way), and the server always adds them. So
// ticking the yard shows the premise ticked and locked, "with Yard" — the
// operator sees what the pass or grant will really cover. Only the zones
// actually ticked are sent; the server derives the rest.

interface PickerZone { id: string; name: string; parentZoneId: string | null }

export function ZonePicker({ zones, value, onChange }: { zones: PickerZone[]; value: string[]; onChange: (ids: string[]) => void }) {
  const byId = new Map(zones.map((z) => [z.id, z]));
  // Ancestor id → the ticked zone that pulls it in (first found wins).
  const includedBy = new Map<string, string>();
  for (const id of value) {
    for (let p = byId.get(id)?.parentZoneId; p && !includedBy.has(p); p = byId.get(p)?.parentZoneId ?? null) {
      includedBy.set(p, byId.get(id)!.name);
    }
  }
  return (
    <div className="flex flex-wrap gap-4">
      {zones.map((z) => {
        const via = value.includes(z.id) ? undefined : includedBy.get(z.id);
        return (
          <label key={z.id} className={`flex items-center gap-2 text-sm ${via ? "text-[var(--text-muted)]" : ""}`}>
            <input
              type="checkbox"
              checked={value.includes(z.id) || via !== undefined}
              disabled={via !== undefined}
              onChange={() => onChange(value.includes(z.id) ? value.filter((x) => x !== z.id) : [...value, z.id])}
            />
            {z.name}
            {via && <span className="text-xs">(with {via})</span>}
          </label>
        );
      })}
    </div>
  );
}

"use client";

import { useState } from "react";
import { api, ApiError, type Person } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { Alert, Button, Card, Input } from "@/components/ui";

// Blacklist a visitor: removed from every terminal at once and refused any
// pass until lifted. Both directions need a reason and are audited.
export function BlacklistControl({ person, onChanged }: { person: Person; onChanged: () => void }) {
  const { can } = useAuth();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (person.category !== "VISITOR" || (!can("blacklist:update") && !person.blacklistedAt)) return null;

  const run = async (url: string, body: object) => {
    setProblem(null);
    try {
      await api(url, { method: "POST", body });
      setReason("");
      onChanged();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "action failed");
    }
  };

  return (
    <Card title="Blacklist">
      {problem && <Alert>{problem}</Alert>}
      {person.blacklistedAt ? (
        <Alert tone="warn">Blacklisted since {formatDateTime(person.blacklistedAt)}{person.blacklistReason ? ` — ${person.blacklistReason}` : ""}. Removed from every terminal; no pass can be issued.</Alert>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">Not blacklisted.</p>
      )}
      {can("blacklist:update") && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Input className="max-w-sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={person.blacklistedAt ? "Reason for lifting (optional)" : "Reason (required)"} />
          {person.blacklistedAt ? (
            <Button onClick={() => void run(`/api/people/${person.id}/blacklist/lift`, { reason: reason.trim() || undefined })}>Lift blacklist</Button>
          ) : (
            <Button variant="danger" disabled={reason.trim().length < 3} onClick={() => void run(`/api/people/${person.id}/blacklist`, { reason: reason.trim() })}>Blacklist</Button>
          )}
        </div>
      )}
    </Card>
  );
}

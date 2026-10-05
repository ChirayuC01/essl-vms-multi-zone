"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api, ApiError, type AccessCatalogue, type OperatorAccess, type OperatorList, type PermissionOverride, type RoleList } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { refresh, useApi } from "@/lib/swr";
import { AccessGrid } from "@/components/access-grid";
import { Alert, Button, Card, Empty } from "@/components/ui";

type Choice = "INHERIT" | "ALLOW" | "DENY";

// One operator's access: their role's grid plus their own exceptions. Each
// cell either follows the role (Inherit) or is forced on (Allow) or off
// (Deny). Overridden cells are highlighted so exceptions are easy to spot.
export default function OperatorAccessPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const url = `/api/operators/${id}/permissions`;
  const { data } = useApi<OperatorAccess>(can("access:view") ? url : null);
  const { data: catalogue } = useApi<AccessCatalogue>(can("access:view") ? "/api/access/catalogue" : null);
  const { data: operators } = useApi<OperatorList>(can("operators:view") ? "/api/operators" : null);
  const { data: roles } = useApi<RoleList>(can("access:view") ? "/api/roles" : null);
  const [draft, setDraft] = useState<Map<string, Choice> | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!can("access:view")) return <Card title="Operator access"><Empty>Your access does not include roles and permissions.</Empty></Card>;
  if (!data || !catalogue) return <Empty>Loading…</Empty>;

  const operator = operators?.items.find((o) => o.id === id);
  const roleName = roles?.items.find((r) => r.key === data.role)?.name ?? data.role;
  const saved = new Map<string, Choice>(data.overrides.map((o) => [o.permission, o.effect]));
  const current = draft ?? saved;
  const grants = new Set(data.roleGrants);
  const editable = can("access:update") && data.editable;

  const choose = (permission: string, choice: Choice) => {
    const next = new Map(current);
    if (choice === "INHERIT") next.delete(permission);
    else next.set(permission, choice);
    setDraft(next);
  };
  const save = async () => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const overrides: PermissionOverride[] = [...current].map(([permission, effect]) => ({ permission, effect: effect as "ALLOW" | "DENY" }));
      await api(url, { method: "PUT", body: { overrides } });
      await refresh(url);
      setDraft(null);
      setNotice("Access saved. It applies on this operator's next action.");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Link href="/operators" className="text-sm text-[var(--text-muted)] hover:underline">← Operators</Link>
      {problem && <Alert>{problem}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}
      <Card title={`Access — ${operator?.name ?? operator?.email ?? "operator"}`}>
        <p className="mb-3 text-sm text-[var(--text-muted)]">
          Role: <strong>{roleName}</strong>. <em>Inherit</em> follows the role (shown as ✓ or ✕); <em>Allow</em> and <em>Deny</em> override it for this operator only.
        </p>
        {!data.editable && <Alert tone="info">Administrators always have full access; their access cannot be overridden.</Alert>}
        <AccessGrid
          resources={catalogue.items}
          render={(permission) => {
            const choice = current.get(permission) ?? "INHERIT";
            const overridden = choice !== "INHERIT";
            return (
              <select
                aria-label={permission}
                disabled={!editable}
                value={choice}
                onChange={(e) => choose(permission, e.target.value as Choice)}
                className={`w-24 rounded-md border px-1 py-1 text-xs ${
                  overridden
                    ? choice === "ALLOW"
                      ? "border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok)]"
                      : "border-[var(--danger)] bg-[var(--danger-bg)] text-[var(--danger)]"
                    : "border-[var(--border)] bg-[var(--surface)]"
                }`}
              >
                <option value="INHERIT">Inherit {grants.has(permission) ? "✓" : "✕"}</option>
                <option value="ALLOW">Allow</option>
                <option value="DENY">Deny</option>
              </select>
            );
          }}
        />
        {editable && (
          <div className="mt-3 flex gap-2">
            <Button variant="primary" disabled={draft === null} loading={busy} onClick={save}>Save access</Button>
            <Button disabled={draft === null} onClick={() => setDraft(null)}>Discard changes</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

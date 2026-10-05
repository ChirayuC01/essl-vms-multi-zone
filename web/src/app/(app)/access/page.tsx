"use client";

import { useState } from "react";
import { api, ApiError, type AccessCatalogue, type Role, type RoleAccess, type RoleList } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { refresh, useApi } from "@/lib/swr";
import { AccessGrid, ToggleCell } from "@/components/access-grid";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Table } from "@/components/ui";

// Roles and their default access. What a role may do is data an Admin edits
// here; per-operator exceptions live on each operator's Access page. Every
// change is audited and applies on the affected operators' next request.
export default function AccessPage() {
  const { can } = useAuth();
  const { data: roleList } = useApi<RoleList>(can("access:view") ? "/api/roles" : null);
  const { data: catalogue } = useApi<AccessCatalogue>(can("access:view") ? "/api/access/catalogue" : null);
  const [roleKey, setRoleKey] = useState<string>("");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!can("access:view")) return <Card title="Access"><Empty>Your access does not include roles and permissions.</Empty></Card>;
  const roles = roleList?.items ?? [];
  const selected = roles.find((r) => r.key === roleKey) ?? roles.find((r) => !r.isSystem) ?? roles[0];

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setProblem(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      await refresh("/api/roles");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "something went wrong");
    }
  };

  return (
    <div className="space-y-4">
      {problem && <Alert>{problem}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}
      <Card title="Role defaults">
        <p className="mb-3 text-sm text-[var(--text-muted)]">
          What each role may do. Operators inherit this unless their own Access page overrides a cell.
        </p>
        <Field label="Role">
          <Select className="max-w-xs" value={selected?.key ?? ""} onChange={(e) => setRoleKey(e.target.value)}>
            {roles.map((r) => <option key={r.key} value={r.key}>{r.name}{r.isActive ? "" : " (inactive)"}</option>)}
          </Select>
        </Field>
        <div className="mt-3">
          {selected && catalogue && (
            <RoleGrid key={selected.key} role={selected} catalogue={catalogue} canEdit={can("access:update")} onSaved={(n) => setNotice(n)} onError={setProblem} />
          )}
        </div>
      </Card>
      <RolesCard roles={roles} run={run} canCreate={can("access:create")} canEdit={can("access:update")} />
    </div>
  );
}

function RoleGrid({
  role,
  catalogue,
  canEdit,
  onSaved,
  onError,
}: {
  role: Role;
  catalogue: AccessCatalogue;
  canEdit: boolean;
  onSaved: (notice: string) => void;
  onError: (problem: string) => void;
}) {
  const url = `/api/roles/${role.key}/permissions`;
  const { data } = useApi<RoleAccess>(url);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return <Empty>Loading…</Empty>;
  const current = draft ?? new Set(data.permissions);
  const editable = canEdit && data.editable;
  const dirty = draft !== null;

  const toggle = (permission: string) => {
    const next = new Set(current);
    if (next.has(permission)) next.delete(permission);
    else next.add(permission);
    setDraft(next);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api(url, { method: "PUT", body: { permissions: [...current] } });
      await refresh(url);
      setDraft(null);
      onSaved(`${role.name} access saved. It applies to their operators on their next action.`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {!data.editable && <Alert tone="info">The Administrator role always has full access and cannot be edited.</Alert>}
      <AccessGrid
        resources={catalogue.items}
        render={(permission) => <ToggleCell on={current.has(permission)} disabled={!editable} onChange={() => toggle(permission)} />}
      />
      {editable && (
        <div className="mt-3 flex gap-2">
          <Button variant="primary" disabled={!dirty} loading={busy} onClick={save}>Save {role.name}</Button>
          <Button disabled={!dirty} onClick={() => setDraft(null)}>Discard changes</Button>
        </div>
      )}
    </div>
  );
}

function RolesCard({
  roles,
  run,
  canCreate,
  canEdit,
}: {
  roles: Role[];
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  canCreate: boolean;
  canEdit: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  return (
    <Card title="Roles">
      {canCreate && (
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <Field label="New role name"><Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gate supervisor" /></Field>
          <Field label="Description" hint="optional"><Input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} /></Field>
          <Field label="Start from">
            <Select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              <option value="">No access (empty grid)</option>
              {roles.filter((r) => r.isActive).map((r) => <option key={r.key} value={r.key}>Copy of {r.name}</option>)}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={() =>
                void run(`Role "${name.trim()}" added. Set its access in Role defaults above.`, async () => {
                  await api("/api/roles", { method: "POST", body: { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), ...(copyFrom ? { copyFrom } : {}) } });
                  setName("");
                  setDescription("");
                  setCopyFrom("");
                })
              }
            >
              Add role
            </Button>
          </div>
        </div>
      )}
      <Table head={["Role", "Key", "Active operators", "Status", ...(canEdit ? ["Action"] : [])]}>
        {roles.map((r) => (
          <tr key={r.key} className="border-b border-[var(--border)] last:border-0">
            <td className="px-2 py-2">
              {canEdit && !r.isSystem ? (
                <Input
                  className="py-1 text-sm"
                  defaultValue={r.name}
                  maxLength={60}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== r.name) void run(`Renamed to "${next}".`, () => api(`/api/roles/${r.key}`, { method: "PATCH", body: { name: next } }));
                  }}
                />
              ) : (
                r.name
              )}
              {r.description && <div className="mt-1 text-xs text-[var(--text-muted)]">{r.description}</div>}
            </td>
            <td className="px-2 py-2 font-mono text-xs">{r.key}</td>
            <td className="px-2 py-2">{r.activeUsers}</td>
            <td className="px-2 py-2">
              {r.isSystem ? <Badge tone="info">system</Badge> : <Badge tone={r.isActive ? "ok" : "warn"}>{r.isActive ? "active" : "inactive"}</Badge>}
            </td>
            {canEdit && (
              <td className="px-2 py-2">
                {!r.isSystem && (
                  <Button onClick={() => void run(`${r.name} ${r.isActive ? "deactivated" : "reactivated"}.`, () => api(`/api/roles/${r.key}`, { method: "PATCH", body: { isActive: !r.isActive } }))}>
                    {r.isActive ? "Deactivate" : "Reactivate"}
                  </Button>
                )}
              </td>
            )}
          </tr>
        ))}
      </Table>
    </Card>
  );
}

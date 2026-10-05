"use client";

import { useState } from "react";
import { api, ApiError, type FieldRule, type PassType, type PassTypeList } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Table } from "@/components/ui";

// Pass types: a site's own visitor categories. Each decides which profile
// fields are required, optional or hidden, whether a host must Clear it, how
// long it may last, and whether it carries an external credential whose
// expiry caps the pass. Configuration, never code.

type Draft = Omit<PassType, "id" | "isActive">;
const BLANK: Draft = {
  name: "",
  description: null,
  kind: "SHORT_TERM",
  entryModes: ["SINGLE_ENTRY", "MULTI_ENTRY"],
  requiresHostClear: true,
  maxValidityDays: 1,
  fieldRules: {},
  credentialLabel: null,
  credentialCapsValidity: false,
};
const CREDENTIAL_FIELDS = new Set(["credentialNumber", "credentialExpiresAt"]);

export default function PassTypesPage() {
  const { can } = useAuth();
  const { data } = useApi<PassTypeList>(can("pass_types:view") ? "/api/pass-types" : null);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!can("pass_types:view")) return <Card title="Pass types"><Empty>Your access does not include pass types.</Empty></Card>;
  if (!data) return <Empty>Loading…</Empty>;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setProblem(null);
    setNotice(null);
    try {
      await fn();
      await refresh("/api/pass-types");
      setNotice(label);
      return true;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "save failed");
      return false;
    }
  };

  const save = async () => {
    if (!editing) return;
    const { id, draft } = editing;
    const ok = await run(`${draft.name} saved.`, () =>
      id ? api(`/api/pass-types/${id}`, { method: "PATCH", body: draft }) : api("/api/pass-types", { method: "POST", body: draft }),
    );
    if (ok) setEditing(null);
  };

  return (
    <div className="space-y-4">
      {problem && <Alert>{problem}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}
      <Card
        title="Pass types"
        action={can("pass_types:create") && !editing ? <Button variant="primary" onClick={() => setEditing({ id: null, draft: BLANK })}>Add pass type</Button> : undefined}
      >
        {data.items.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No pass types yet. Visitors use the General rule (company, department, mobile, Aadhaar or PAN) until you add one.</p>
        ) : (
          <Table head={["Name", "Kind", "Entry", "Host Clear", "Max days", "Credential", "Status", ""]}>
            {data.items.map((t) => (
              <tr key={t.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-2">{t.name}{t.description && <div className="text-xs text-[var(--text-muted)]">{t.description}</div>}</td>
                <td className="px-2 py-2">{t.kind === "LONG_TERM" ? "Long-term" : "Short-term"}</td>
                <td className="px-2 py-2">{t.entryModes.map((m) => (m === "SINGLE_ENTRY" ? "single" : "multi")).join(" / ")}</td>
                <td className="px-2 py-2">{t.requiresHostClear ? "Yes" : "No"}</td>
                <td className="px-2 py-2">{t.maxValidityDays ?? "—"}</td>
                <td className="px-2 py-2">{t.credentialLabel ? `${t.credentialLabel}${t.credentialCapsValidity ? " (caps validity)" : ""}` : "—"}</td>
                <td className="px-2 py-2"><Badge tone={t.isActive ? "ok" : "warn"}>{t.isActive ? "active" : "inactive"}</Badge></td>
                <td className="px-2 py-2">
                  {can("pass_types:update") && (
                    <div className="flex justify-end gap-2">
                      <Button onClick={() => setEditing({ id: t.id, draft: { ...t } })}>Edit</Button>
                      <Button onClick={() => void run(`${t.name} ${t.isActive ? "deactivated" : "reactivated"}.`, () => api(`/api/pass-types/${t.id}`, { method: "PATCH", body: { isActive: !t.isActive } }))}>
                        {t.isActive ? "Deactivate" : "Reactivate"}
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing && (
        <Card title={editing.id ? `Edit ${editing.draft.name}` : "New pass type"}>
          <Editor
            draft={editing.draft}
            fields={data.fields}
            onChange={(draft) => setEditing({ ...editing, draft })}
          />
          <div className="mt-4 flex gap-2">
            <Button variant="primary" disabled={!editing.draft.name.trim()} onClick={() => void save()}>Save</Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Editor({ draft, fields, onChange }: { draft: Draft; fields: Record<string, string>; onChange: (d: Draft) => void }) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value });
  const toggleMode = (mode: "SINGLE_ENTRY" | "MULTI_ENTRY") => {
    const next = draft.entryModes.includes(mode) ? draft.entryModes.filter((m) => m !== mode) : [...draft.entryModes, mode];
    if (next.length) set("entryModes", next);
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Name"><Input maxLength={60} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Contractor staff" /></Field>
        <Field label="Description" hint="optional"><Input maxLength={200} value={draft.description ?? ""} onChange={(e) => set("description", e.target.value || null)} /></Field>
        <Field label="Kind">
          <Select value={draft.kind} onChange={(e) => set("kind", e.target.value as Draft["kind"])}>
            <option value="SHORT_TERM">Short-term (a visit)</option>
            <option value="LONG_TERM">Long-term (a period)</option>
          </Select>
        </Field>
        <Field label="Entry modes allowed">
          <div className="mt-2 flex gap-4 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={draft.entryModes.includes("SINGLE_ENTRY")} onChange={() => toggleMode("SINGLE_ENTRY")} />Single entry</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={draft.entryModes.includes("MULTI_ENTRY")} onChange={() => toggleMode("MULTI_ENTRY")} />Multi entry</label>
          </div>
        </Field>
        <Field label="Host must Clear">
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.requiresHostClear} onChange={(e) => set("requiresHostClear", e.target.checked)} />Requires the host&apos;s approval</label>
        </Field>
        <Field label="Maximum validity (days)" hint="empty = no limit">
          <Input type="number" min={1} max={366} value={draft.maxValidityDays ?? ""} onChange={(e) => set("maxValidityDays", e.target.value ? Number(e.target.value) : null)} />
        </Field>
        <Field label="External credential" hint="e.g. a port authority pass; empty = none">
          <Input maxLength={60} value={draft.credentialLabel ?? ""} onChange={(e) => set("credentialLabel", e.target.value || null)} />
        </Field>
        {draft.credentialLabel && (
          <Field label="Credential expiry">
            <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.credentialCapsValidity} onChange={(e) => set("credentialCapsValidity", e.target.checked)} />A pass ends no later than the credential</label>
          </Field>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Profile fields</h3>
        <p className="mb-2 text-xs text-[var(--text-muted)]">Name is always required. Unlisted fields are optional.</p>
        <Table head={["Field", "Rule"]}>
          {Object.entries(fields).map(([key, label]) => {
            const credential = CREDENTIAL_FIELDS.has(key);
            return (
              <tr key={key} className="border-b border-[var(--border)] last:border-0">
                <td className="px-2 py-1.5">{credential && draft.credentialLabel ? `${draft.credentialLabel}: ${label.replace("Credential ", "")}` : label}</td>
                <td className="px-2 py-1.5">
                  {credential && !draft.credentialLabel ? (
                    <span className="text-xs text-[var(--text-muted)]">hidden — set an external credential first</span>
                  ) : (
                    <Select
                      className="py-1 text-sm"
                      value={draft.fieldRules[key] ?? "optional"}
                      onChange={(e) => set("fieldRules", { ...draft.fieldRules, [key]: e.target.value as FieldRule })}
                    >
                      <option value="required">Required</option>
                      <option value="optional">Optional</option>
                      <option value="hidden">Hidden</option>
                    </Select>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      </div>
    </div>
  );
}

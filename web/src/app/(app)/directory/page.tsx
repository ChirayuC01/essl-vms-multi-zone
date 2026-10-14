"use client";

import { useDeferredValue, useState } from "react";
import { categoryLabel } from "@/lib/format";
import { api, type DirectoryItem, type DirectoryList, type Paged, type Person } from "@/lib/api";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Badge, Button, Card, Field, Input, SearchSelect, Table } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function DirectoryPage() {
  const { can } = useAuth();
  const { data: companies } = useApi<DirectoryList>("/api/companies");
  const { data: departments } = useApi<DirectoryList>("/api/departments");
  // Searchable, so everyone is reachable rather than only the first 100.
  // Picks survive a new search (pre-demo sweep).
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const { data: people } = useApi<Paged<Person>>(`/api/people?pageSize=100&active=true${deferredSearch ? `&q=${encodeURIComponent(deferredSearch)}` : ""}`);
  const [companyName, setCompanyName] = useState("");
  const [departmentName, setDepartmentName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create(kind: "companies" | "departments", name: string) {
    try {
      await api(`/api/${kind}`, { method: "POST", body: { name } });
      if (kind === "companies") setCompanyName(""); else setDepartmentName("");
      await refresh(`/api/${kind}`);
    } catch (err) { setError(err instanceof Error ? err.message : "save failed"); }
  }
  async function toggle(kind: "companies" | "departments", item: DirectoryItem) {
    await api(`/api/${kind}/${item.id}`, { method: "PATCH", body: { isActive: !item.isActive } });
    await refresh(`/api/${kind}`);
  }
  async function assign() {
    try {
      if (companyId) await api(`/api/companies/${companyId}/people`, { method: "POST", body: { personIds: selected } });
      if (departmentId) await api(`/api/departments/${departmentId}/people`, { method: "POST", body: { personIds: selected } });
      setSelected([]);
      await refresh("/api/people");
    } catch (err) { setError(err instanceof Error ? err.message : "assignment failed"); }
  }

  const section = (title: string, kind: "companies" | "departments", items: DirectoryItem[] | undefined, name: string, setName: (value: string) => void) => (
    <Card title={title}>
      <div className="mb-3 flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`New ${title.slice(0, -1).toLowerCase()}`} />
        <Button variant="primary" disabled={!name.trim()} onClick={() => create(kind, name.trim())}>Add</Button>
      </div>
      <Table head={["Name", "Status", ...(can("directory:delete") ? ["Action"] : [])]}>
        {(items ?? []).map((item) => <tr key={item.id} className="border-b border-[var(--border)]">
          <td className="px-2 py-2">{item.name}</td><td className="px-2 py-2"><Badge tone={item.isActive ? "ok" : "warn"}>{item.isActive ? "active" : "inactive"}</Badge></td>
          {can("directory:delete") && <td className="px-2 py-2"><Button onClick={() => toggle(kind, item)}>{item.isActive ? "Deactivate" : "Reactivate"}</Button></td>}
        </tr>)}
      </Table>
    </Card>
  );

  return <div className="space-y-4">
    {error && <Alert>{error}</Alert>}
    <div className="grid gap-4 lg:grid-cols-2">
      {section("Companies", "companies", companies?.items, companyName, setCompanyName)}
      {section("Departments", "departments", departments?.items, departmentName, setDepartmentName)}
    </div>
    <Card title="Bulk assignment">
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Field label="Company"><SearchSelect value={companyId} onChange={setCompanyId} options={(companies?.items ?? []).filter((x) => x.isActive).map((x) => ({ value: x.id, label: x.name }))} emptyLabel="No change" /></Field>
        <Field label="Department"><SearchSelect value={departmentId} onChange={setDepartmentId} options={(departments?.items ?? []).filter((x) => x.isActive).map((x) => ({ value: x.id, label: x.name }))} emptyLabel="No change" /></Field>
        <div className="flex items-end"><Button variant="primary" disabled={!selected.length || (!companyId && !departmentId)} onClick={assign}>Assign {selected.length} selected</Button></div>
      </div>
      <div className="mb-3 max-w-sm"><Field label="Find people" hint={people && people.total > people.items.length ? `Showing ${people.items.length} of ${people.total} — search to narrow` : undefined}><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, company, mobile or ID…" /></Field></div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{people?.items.map((person) => <label key={person.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(person.id)} onChange={() => setSelected((ids) => ids.includes(person.id) ? ids.filter((id) => id !== person.id) : [...ids, person.id])} />{person.name} <span className="text-xs text-[var(--text-muted)]">{categoryLabel(person.category)}</span></label>)}</div>
    </Card>
  </div>;
}


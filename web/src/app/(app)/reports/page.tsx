"use client";

import { useState } from "react";
import { getApiBase, getToken, type AuditFacets, type DirectoryList, type ReportList, type ReportRun } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { dayOfMonthIst, formatDateInputIst, formatDateTime } from "@/lib/format";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Table } from "@/components/ui";
import { PersonAvatar } from "@/components/person-avatar";

// The report catalogue (Phase 4 Milestone 20).
//
// One page for every report, driven by the server's catalogue — the columns,
// filters and description all come from the definition. A new report appears
// here without a line of frontend change, which is the point of the registry.

const PAGE_SIZE = 50;

/** ISO-ish values render as dates; everything else as text. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDateTime(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function ReportsPage() {
  const { data: catalogue } = useApi<ReportList>("/api/reports");
  const [key, setKey] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [actorId, setActorId] = useState("");
  const [action, setAction] = useState("");
  const [category, setCategory] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const { data: companies } = useApi<DirectoryList>("/api/companies");
  const { data: departments } = useApi<DirectoryList>("/api/departments");

  const selected = catalogue?.items.find((r) => r.key === key);
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (actorId) params.set("actorId", actorId);
  if (action) params.set("action", action);
  if (category) params.set("category", category);
  if (companyId) params.set("companyId", companyId);
  if (departmentId) params.set("departmentId", departmentId);

  // Only fetched for the reports that offer these filters, and only by a role
  // allowed to read the audit log at all.
  const wantsFacets =
    selected?.filters.includes("actor") === true || selected?.filters.includes("action") === true;
  const { data: facets } = useApi<AuditFacets>(
    wantsFacets ? "/api/reports/meta/audit-facets" : null,
  );

  const { data, error, isLoading } = useApi<ReportRun>(
    selected ? `/api/reports/${selected.key}?${params.toString()}` : null,
  );

  const groups = [...new Set(catalogue?.items.map((r) => r.group) ?? [])];
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  // The export goes straight to the API rather than through fetch, so the
  // browser handles the download. The token rides in the query string, which
  // the guard already accepts for the same reason the SSE stream does.
  const csvHref = selected
    ? `${getApiBase()}/api/reports/${selected.key}?${params.toString()}&format=csv&token=${encodeURIComponent(getToken() ?? "")}`
    : "#";

  return (
    <div className="space-y-4">
      <Card title="Reports">
        {!catalogue ? (
          <Empty>Loading…</Empty>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group}>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  {group}
                </p>
                <div className="flex flex-wrap gap-2">
                  {catalogue.items
                    .filter((r) => r.group === group)
                    .map((r) => (
                      <button
                        key={r.key}
                        type="button"
                        onClick={() => {
                          setKey(r.key);
                          setPage(1);
                          // Filters belong to the report that declared them;
                          // carrying an actor filter onto a movement report
                          // would silently narrow it with no visible control.
                          setActorId("");
                          setAction("");
                        }}
                        className={`rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors ${
                          r.key === key
                            ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-contrast)]"
                            : "border-[var(--border)] hover:bg-[var(--surface-muted)]"
                        }`}
                      >
                        {r.title}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {selected && (
        <Card
          title={selected.title}
          action={
            <a
              href={csvHref}
              className="text-xs text-[var(--brand)] hover:underline"
              download
            >
              Download CSV
            </a>
          }
        >
          <p className="mb-3 text-sm text-[var(--text-muted)]">{selected.description}</p>

          {selected.filters.includes("dateRange") && (
            <div className="mb-3 space-y-3">
              {selected.key === "attendance" && <div className="flex flex-wrap gap-2">{[
                ["Today", 0], ["Week", 6], ["Month", dayOfMonthIst(new Date()) - 1],
              ].map(([label, days]) => <Button key={String(label)} onClick={() => { const end = new Date(); const start = new Date(end.getTime() - Number(days) * 86_400_000); setFrom(formatDateInputIst(start)); setTo(formatDateInputIst(end)); setPage(1); }}>{label}</Button>)}</div>}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="From">
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    setPage(1);
                  }}
                />
              </Field>
              <Field label="To">
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => {
                    setTo(e.target.value);
                    setPage(1);
                  }}
                />
              </Field>
              <div className="flex items-end">
                <Button
                  onClick={() => {
                    setFrom("");
                    setTo("");
                    setPage(1);
                  }}
                >
                  Clear dates
                </Button>
              </div>
            </div>
            </div>
          )}

          {(selected.filters.includes("category") || selected.filters.includes("company") || selected.filters.includes("department")) && <div className="mb-3 grid gap-3 sm:grid-cols-3">
            {selected.filters.includes("category") && <Field label="Category"><Select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}><option value="">Employees and visitors</option><option value="EMPLOYEE">Employees</option><option value="VISITOR">Visitors</option></Select></Field>}
            {selected.filters.includes("company") && <Field label="Company"><Select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setPage(1); }}><option value="">All companies</option>{companies?.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>}
            {selected.filters.includes("department") && <Field label="Department"><Select value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPage(1); }}><option value="">All departments</option>{departments?.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>}
          </div>}

          {(selected.filters.includes("actor") || selected.filters.includes("action")) && (
            <div className="mb-3 grid gap-3 sm:grid-cols-3">
              {selected.filters.includes("actor") && (
                <Field label="Operator">
                  <Select
                    value={actorId}
                    onChange={(e) => {
                      setActorId(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">Anyone</option>
                    {facets?.actors.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.email}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {selected.filters.includes("action") && (
                <Field label="Action">
                  <Select
                    value={action}
                    onChange={(e) => {
                      setAction(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">Any action</option>
                    {facets?.actions.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <div className="flex items-end">
                <Button
                  onClick={() => {
                    setActorId("");
                    setAction("");
                    setPage(1);
                  }}
                >
                  Clear
                </Button>
              </div>
            </div>
          )}

          {error && <Alert>{error instanceof Error ? error.message : "failed to run"}</Alert>}

          {isLoading && !data ? (
            <Empty>Running…</Empty>
          ) : !data || data.rows.length === 0 ? (
            <Empty>No rows for this report.</Empty>
          ) : (
            <>
              <Table head={data.columns.map((c) => c.label)}>
                {data.rows.map((row, i) => {
                  // person_id rides along in every row a report joins to the
                  // person table, whether or not it's a declared column — see
                  // backend/src/reports/registry.ts. Only used to build a
                  // photo thumbnail; never rendered as its own column.
                  const personName = typeof row.person === "string" ? row.person : null;
                  return (
                    <tr key={i} className="border-b border-[var(--border)] last:border-0">
                      {data.columns.map((c) => (
                        <td key={c.key} className="px-2 py-2 align-top">
                          {c.key === "person" ? (
                            <div className="flex items-center gap-2">
                              <PersonAvatar
                                personId={row.person_id as string | null | undefined}
                                name={personName ?? "?"}
                              />
                              <span>{personName ?? "—"}</span>
                            </div>
                          ) : (
                            c.key === "worked_seconds" && typeof row[c.key] === "number"
                              ? `${Math.floor((row[c.key] as number) / 3600)}h ${Math.floor(((row[c.key] as number) % 3600) / 60)}m`
                              : cell(row[c.key])
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </Table>

              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs text-[var(--text-muted)]">
                  {data.total} row{data.total === 1 ? "" : "s"} · page {data.page} of {lastPage}
                </span>
                <div className="flex gap-2">
                  <Button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <Button disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      )}

      {!selected && catalogue && (
        <Card title="Movement history survives retention">
          <p className="text-sm text-[var(--text-muted)]">
            Raw punches are summarised and deleted after the retention window, but the movement
            reports read those summaries too — so &ldquo;who was on site last March&rdquo; keeps
            working after the detail behind it has been rotated away.
          </p>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            One thing no report can show: <strong>denied entries</strong>. The terminal does not
            send them, so a blocked person&rsquo;s attempt leaves no trace anywhere.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone="info">{catalogue.total} reports</Badge>
            <Badge>CSV export on every one</Badge>
          </div>
        </Card>
      )}
    </div>
  );
}

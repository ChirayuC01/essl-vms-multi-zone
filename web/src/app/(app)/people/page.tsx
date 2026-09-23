"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { type Entry, type Paged, type Person } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { formatDateTime } from "@/lib/format";
import { Alert, Badge, Button, Card, Empty, Input, Select, Table, entryTone } from "@/components/ui";
import { UnclaimedEnrollments } from "@/components/unclaimed";

const PAGE_SIZE = 20;

export default function PeoplePage() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState("");

  // Debounced so typing in the search box does not fire a request per key.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (debounced) params.set("q", debounced);
  if (category) params.set("category", category);

  const { data, error } = useApi<Paged<Person>>(`/api/people?${params}`);
  // Which people are currently on a device — one batched lookup for the whole
  // page, never a request per row.
  const { data: active } = useApi<Paged<Entry>>("/api/entries?active=true&pageSize=100");

  const activeByPerson = new Map((active?.items ?? []).map((e) => [e.personId, e]));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      {error && <Alert>{error instanceof Error ? error.message : "failed to load people"}</Alert>}

      <UnclaimedEnrollments />

      <Card
        title="People"
        action={
          <Link href="/people/new">
            <Button variant="primary">Register person</Button>
          </Link>
        }
      >
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          placeholder="Search by name, company, mobile or ID…"
          className="mb-4"
        />
        <Select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} className="mb-4 max-w-xs"><option value="">Employees and visitors</option><option value="EMPLOYEE">Employees</option><option value="VISITOR">Visitors</option></Select>

        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.items.length === 0 ? (
          <Empty>No people match.</Empty>
        ) : (
          <>
            <Table head={["Name", "Category", "Company / department", "ID", "Photo", "Status", "Registered"]}>
              {data.items.map((person) => {
                const entry = activeByPerson.get(person.id);
                return (
                  <tr key={person.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-2 py-2">
                      <Link
                        href={`/people/${person.id}`}
                        className="font-medium text-[var(--brand)] hover:underline"
                      >
                        {person.name}
                      </Link>
                      {!person.isActive && (
                        <span className="ml-2 text-xs text-[var(--text-muted)]">(inactive)</span>
                      )}
                      {person.aadharNumber && <span className="ml-2"><Badge tone="ok">Aadhaar verified</Badge></span>}
                      {person.panNumber && <span className="ml-2"><Badge tone="ok">PAN verified</Badge></span>}
                    </td>
                    <td className="px-2 py-2"><Badge tone={person.category === "EMPLOYEE" ? "info" : undefined}>{person.category}</Badge>{person.needsDetails && <Badge tone="warn">needs details</Badge>}</td>
                    <td className="px-2 py-2 text-[var(--text-muted)]">{person.company?.name ?? "—"}<div className="text-xs">{person.department?.name ?? "—"}</div></td>
                    <td className="px-2 py-2 font-mono text-xs">{person.esslUserId}</td>
                    <td className="px-2 py-2">
                      {person.hasPhoto ? (
                        <Badge tone="ok">yes</Badge>
                      ) : (
                        // No photo means they cannot be provisioned at all —
                        // surfaced here so it is noticed before someone is
                        // standing at the gate.
                        <Badge tone="warn">missing</Badge>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {person.resignedAt ? (
                        <Badge tone="warn">resigned</Badge>
                      ) : person.category === "EMPLOYEE" ? (
                        <Badge tone="ok">permanent employee access</Badge>
                      ) : entry ? (
                        <span className="flex flex-wrap items-center gap-1">
                          <Badge tone={entryTone(entry.state)}>{entry.state}</Badge>
                          {entry.dayBlocked && <Badge tone="danger">blocked</Badge>}
                        </span>
                      ) : (
                        <Badge>not provisioned</Badge>
                      )}
                    </td>
                    <td className="px-2 py-2 text-xs text-[var(--text-muted)]">
                      {formatDateTime(person.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </Table>

            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-[var(--text-muted)]">
                {data.total} person{data.total === 1 ? "" : "s"}
              </span>
              <div className="flex items-center gap-2">
                <Button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span className="text-xs text-[var(--text-muted)]">
                  Page {page} of {totalPages}
                </span>
                <Button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

"use client";

import Link from "next/link";
import type { OutboxMessage, Paged } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useApi } from "@/lib/swr";
import { Alert, Badge, Card, Empty, Table } from "@/components/ui";

// Every SMS and email the system sent (Phase 5). Until the site's SMS and
// email providers are connected, nothing actually leaves the server: this is
// where links and codes are read for testing.
export default function OutboxPage() {
  const { data, error } = useApi<Paged<OutboxMessage>>("/api/messages?pageSize=100", { refreshInterval: 5000 });
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Outbox</h1>
      {data?.items.some((m) => m.transport === "console") && (
        <Alert tone="warn">No SMS or email provider is connected: these messages were recorded here but not delivered.</Alert>
      )}
      <Card title="Messages">
        {error && <Alert>{error.message}</Alert>}
        {data && data.items.length === 0 ? (
          <Empty>No messages yet.</Empty>
        ) : (
          <Table head={["Sent", "To", "Message", "Status"]}>
            {data?.items.map((m) => (
              <tr key={m.id} className="border-b border-[var(--border)] align-top last:border-0">
                <td className="px-2 py-2 whitespace-nowrap">{formatDateTime(m.createdAt)}</td>
                <td className="px-2 py-2">
                  <Badge>{m.channel}</Badge> {m.recipient}
                  {m.relatedType === "visit_request" && m.relatedId && (
                    <div className="text-xs"><Link className="hover:underline" href={`/requests/${m.relatedId}`}>request</Link></div>
                  )}
                </td>
                <td className="px-2 py-2 break-all">{m.body}</td>
                <td className="px-2 py-2"><Badge tone={m.status === "SENT" ? "ok" : "danger"}>{m.status.toLowerCase()}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

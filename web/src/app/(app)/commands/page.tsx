"use client";

import { useState } from "react";
import Link from "next/link";
import { api, type Command, type DeviceList, type Paged } from "@/lib/api";
import { useEventStream } from "@/lib/events";
import { useApi, refresh } from "@/lib/swr";
import { formatDateTime } from "@/lib/format";
import { Alert, Badge, Button, Card, Empty, Select, Table, commandTone } from "@/components/ui";
import { StreamStatus } from "@/components/stream-status";
import { PersonAvatar } from "@/components/person-avatar";

// The command queue — the primary debugging surface for the whole product.
// When a person is not recognised at the barrier, the answer is nearly always
// a command that never went out, or one that came back with a non-zero return.

const STATUSES = ["", "PENDING", "SENT", "SUCCESS", "FAILED", "RETRY"];

export default function CommandsPage() {
  const [status, setStatus] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  // Every status transition is broadcast, so the queue stays current without
  // polling — a command going SENT then SUCCESS updates in place.
  const { connected } = useEventStream({ onCommand: () => void refresh("/api/commands") });

  const params = new URLSearchParams({ pageSize: "50" });
  if (status) params.set("status", status);
  else if (openOnly) params.set("openOnly", "true");
  // Falls back to polling only while the stream is down.
  const { data, error: loadError } = useApi<Paged<Command>>(`/api/commands?${params}`, {
    refreshInterval: connected ? 0 : 5_000,
  });
  // A command sitting at PENDING almost always means the terminal is not
  // collecting it. Answer that here rather than making someone check another
  // page — and keep it distinct from the live-updates indicator above.
  const { data: devices } = useApi<DeviceList>("/api/devices", { refreshInterval: 15_000 });
  const offline = (devices?.items ?? []).filter((d) => !d.online);
  const waiting = (data?.items ?? []).filter(
    (c) => c.status === "PENDING" || c.status === "RETRY",
  ).length;

  async function retry(id: string) {
    setError(null);
    setRetrying(id);
    try {
      await api(`/api/commands/${id}/retry`, { method: "POST" });
      await refresh("/api/commands");
    } catch (e) {
      setError(e instanceof Error ? e.message : "retry failed");
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div className="space-y-4">
      {loadError && (
        <Alert>{loadError instanceof Error ? loadError.message : "failed to load commands"}</Alert>
      )}
      {error && <Alert>{error}</Alert>}

      {offline.length > 0 && waiting > 0 && (
        <Alert tone="warn">
          <strong>
            {offline.map((d) => d.name ?? d.serialNo).join(", ")}{" "}
            {offline.length === 1 ? "is" : "are"} offline.
          </strong>{" "}
          {waiting} command{waiting === 1 ? "" : "s"} will stay queued until the device checks in
          again — the server never pushes to a terminal, it waits to be polled. Nothing is lost.
        </Alert>
      )}

      <Card
        title="Command queue"
        action={
          <StreamStatus connected={connected} />
        }
      >
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Status</span>
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                if (e.target.value) setOpenOnly(false);
              }}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s || "Any"}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={openOnly}
              disabled={status !== ""}
              onChange={(e) => setOpenOnly(e.target.checked)}
            />
            Unfinished and failed only
          </label>
        </div>

        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.items.length === 0 ? (
          <Empty>
            Nothing queued.{openOnly && " Every command has completed successfully."}
          </Empty>
        ) : (
          <Table
            head={["Type", "Status", "Person", "Device", "Wire ID", "Attempts", "Created", ""]}
          >
            {data.items.map((c) => (
              <tr key={c.id} className="border-b border-[var(--border)] align-top last:border-0">
                <td className="px-2 py-2 font-medium whitespace-nowrap">{c.type}</td>
                <td className="px-2 py-2">
                  <Badge tone={commandTone(c.status)}>{c.status}</Badge>
                  {c.lastError && (
                    <div className="mt-1 max-w-xs text-xs text-[var(--danger)]">{c.lastError}</div>
                  )}
                </td>
                <td className="px-2 py-2">
                  {c.personId && c.person ? (
                    <div className="flex items-center gap-2">
                      <PersonAvatar personId={c.personId} name={c.person.name} />
                      <Link
                        href={`/people/${c.personId}`}
                        className="text-[var(--brand)] hover:underline"
                      >
                        {c.person.name}
                      </Link>
                    </div>
                  ) : (
                    <span className="text-[var(--text-muted)]">—</span>
                  )}
                </td>
                <td className="px-2 py-2 font-mono text-xs text-[var(--text-muted)]">
                  {c.device.name ?? c.device.serialNo ?? "—"}
                </td>
                {/* The protocol's own correlation number, sent as C:<id>: and
                    echoed back by the device — the value to grep for in a
                    device-side log. */}
                <td className="px-2 py-2 font-mono text-xs">{c.deviceCmdId ?? "—"}</td>
                <td className="px-2 py-2 text-xs">{c.attempts}</td>
                <td className="px-2 py-2 text-xs whitespace-nowrap text-[var(--text-muted)]">
                  {formatDateTime(c.createdAt)}
                </td>
                <td className="px-2 py-2">
                  {c.status === "FAILED" && (
                    <Button loading={retrying === c.id} onClick={() => retry(c.id)}>
                      Retry
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}

        <p className="mt-4 text-xs text-[var(--text-muted)]">
          <strong>SUCCESS</strong> means the device processed the command, not that the result is
          correct — <code>Return=0</code> is delivery-level truth only. Verifying the roster really
          matches is reconciliation&rsquo;s job in Phase&nbsp;3.
        </p>
      </Card>
    </div>
  );
}

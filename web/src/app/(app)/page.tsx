"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { type Board, type DeviceList, type Paged, type Punch } from "@/lib/api";
import { useEventStream } from "@/lib/events";
import { useApi, refresh } from "@/lib/swr";
import { formatRelative, formatTime, verifyModeLabel } from "@/lib/format";
import { Accordion, Alert, Badge, Empty, Stat, Table } from "@/components/ui";
import { AlertsPanel } from "@/components/alerts";
import { UnclaimedEnrollments } from "@/components/unclaimed";
import { StreamStatus } from "@/components/stream-status";
import { PersonAvatar } from "@/components/person-avatar";

// Operator dashboard: is the gate working, and who is walking through it.
//
// The punch feed is the reason this page exists. It is the fastest way to
// tell whether the whole chain — device, network, ingestion — is alive, and
// it is the seed of the Phase 2 live dashboard.

const FEED_LIMIT = 40;

export default function DashboardPage() {
  // Punches that arrived over the stream since load, newest first. Kept
  // separate from the fetched page so a revalidation cannot drop them.
  const [live, setLive] = useState<Punch[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const onPunch = useCallback((punch: Punch) => {
    setLive((current) => [punch, ...current].slice(0, FEED_LIMIT));
  }, []);

  const { connected } = useEventStream({
    onPunch: (punch) => {
      onPunch(punch);
      // A punch is what moves someone in or out, so the headline counts have
      // to follow it. Refetched rather than incremented locally: a direction
      // guessed in the browser could disagree with the state machine.
      void refresh("/api/entries/board");
    },
    onEntry: () => void refresh("/api/entries/board"),
    onCommand: () => void refresh("/api/devices"),
  });

  const { data: board } = useApi<Board>("/api/entries/board", {
    refreshInterval: connected ? 30_000 : 10_000,
  });

  const { data: devices, error: deviceError } = useApi<DeviceList>("/api/devices", {
    refreshInterval: 15_000,
  });
  // Polled only while the stream is down. A live feed that quietly stops
  // updating is worse than a slow one — if SSE drops, fall back to polling
  // rather than showing stale data as though it were current.
  const { data: history, error: punchError } = useApi<Paged<Punch>>(
    `/api/punches?pageSize=${FEED_LIMIT}`,
    { refreshInterval: connected ? 0 : 10_000 },
  );

  // Judged against the server's clock, sent with the board, so a gate PC with
  // a drifted clock cannot invent or hide an expiry. Zero before the board
  // loads, when there is nothing to judge.
  const boardNow = board ? new Date(board.serverTime).getTime() : 0;
  const overdueCount = (board?.inside ?? []).filter(
    (e) => e.retentionExpiresAt !== null && new Date(e.retentionExpiresAt).getTime() <= boardNow,
  ).length;

  const seen = new Set(live.map((p) => p.id));
  const punches = [...live, ...(history?.items ?? []).filter((p) => !seen.has(p.id))].slice(
    0,
    FEED_LIMIT,
  );
  const onlineDevices = devices?.items.filter((device) => device.online).length ?? 0;
  const offlineDevices = (devices?.items.length ?? 0) - onlineDevices;
  const deviceNames = devices?.items.map((device) => device.name ?? device.serialNo).join(", ");

  const error = deviceError ?? punchError;

  return (
    <div className="space-y-4">
      {error && <Alert>{error instanceof Error ? error.message : "failed to load"}</Alert>}

      <Accordion
        title="On site now"
        initiallyOpen
        summary={
          <span className="flex items-center gap-1">
            <Badge tone="info">{board ? `${board.inside.length} inside` : "…"}</Badge>
            {overdueCount > 0 && <Badge tone="warn">{overdueCount} overdue</Badge>}
            {(board?.dayBlocked.length ?? 0) > 0 && <Badge>{board?.dayBlocked.length} blocked</Badge>}
          </span>
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat
            label="Inside"
            value={board ? board.inside.length : "—"}
            sub="punched in, not yet out"
          />
          <Stat
            label="Past their window"
            value={board ? overdueCount : "—"}
            sub={overdueCount > 0 ? "de-provision deferred" : "none"}
          />
          <Stat
            label="Blocked for today"
            value={board ? board.dayBlocked.length : "—"}
            sub="single entry, used"
          />
        </div>
        <Link href="/inside" className="mt-4 inline-block text-xs text-[var(--brand)] hover:underline">
          Open full board
        </Link>
      </Accordion>

      <AlertsPanel />

      <UnclaimedEnrollments highlighted={false} />

      <Accordion
        title="Devices"
        summary={
          <span className="flex min-w-0 items-center gap-1">
            {deviceNames && <span className="max-w-48 truncate text-xs text-[var(--text-muted)]">{deviceNames}</span>}
            <Badge tone={offlineDevices > 0 ? "warn" : "ok"}>{onlineDevices} online</Badge>
            {offlineDevices > 0 && <Badge tone="danger">{offlineDevices} offline</Badge>}
          </span>
        }
      >
        {!devices ? (
          <Empty>Loading…</Empty>
        ) : devices.items.length === 0 ? (
          <Empty>No device registered yet.</Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {devices.items.map((device) => (
              <div
                key={device.id}
                className="rounded-[var(--radius)] border border-[var(--border)] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{device.name ?? device.serialNo}</span>
                  <Badge tone={device.online ? "ok" : "danger"}>
                    {device.online ? "online" : "offline"}
                  </Badge>
                </div>
                <p className="mt-1 font-mono text-xs text-[var(--text-muted)]">{device.serialNo}</p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <Stat
                    label="Faces"
                    value={`${device.facesUsed}${device.maxFaces ? ` / ${device.maxFaces}` : ""}`}
                    sub={device.maxFaces ? `${device.maxFaces - device.facesUsed} free` : undefined}
                  />
                  <Stat label="Last seen" value={formatRelative(device.lastSeenAt)} />
                </div>
                {(device.queue.pending > 0 ||
                  device.queue.sent > 0 ||
                  device.queue.retry > 0 ||
                  device.queue.failed > 0) && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {device.queue.pending > 0 && <Badge>{device.queue.pending} pending</Badge>}
                    {device.queue.sent > 0 && (
                      <Badge tone="info">{device.queue.sent} in flight</Badge>
                    )}
                    {device.queue.retry > 0 && <Badge tone="warn">{device.queue.retry} retry</Badge>}
                    {device.queue.failed > 0 && (
                      <Badge tone="danger">{device.queue.failed} failed</Badge>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {devices && devices.unregistered.length > 0 && (
          <div className="mt-4">
            <Alert tone="warn">
              <strong>Unregistered device checking in:</strong>{" "}
              {devices.unregistered.map((u) => u.serialNo).join(", ")} — never adopted
              automatically, because two owners of one roster cause mystery deletions.
            </Alert>
          </div>
        )}
        <Link href="/devices" className="mt-4 inline-block text-xs text-[var(--brand)] hover:underline">
          Device details
        </Link>
      </Accordion>

      <Accordion
        title="Live punch feed"
        summary={
          <span className="flex min-w-0 items-center gap-2">
            {punches[0] && (
              <span className="max-w-56 truncate text-xs text-[var(--text-muted)]">
                Latest: {punches[0].person?.name ?? punches[0].esslUserId} · {formatRelative(punches[0].receivedAt, now)}
              </span>
            )}
            <Badge>{punches.length} shown</Badge>
            <StreamStatus connected={connected} />
          </span>
        }
      >
        {punches.length === 0 ? (
          <Empty>No punches recorded yet. Walk up to the barrier — they appear here live.</Empty>
        ) : (
          <Table head={["Time", "Person", "PIN", "Device", "Verify"]}>
            {punches.map((punch) => (
              <tr
                key={punch.id}
                className={`border-b border-[var(--border)] last:border-0 ${
                  seen.has(punch.id) ? "flash-in" : ""
                }`}
              >
                <td className="px-2 py-2 whitespace-nowrap">
                  {formatTime(punch.punchedAtUtc)}
                  <span className="ml-2 text-xs text-[var(--text-muted)]">
                    {formatRelative(punch.receivedAt, now)}
                  </span>
                </td>
                <td className="px-2 py-2">
                  <div className="flex items-center gap-2">
                    <PersonAvatar personId={punch.person?.id} name={punch.person?.name ?? "?"} />
                    {punch.person ? (
                      <Link
                        href={`/people/${punch.person.id}`}
                        className="text-[var(--brand)] hover:underline"
                      >
                        {punch.person.name}
                      </Link>
                    ) : (
                      // Punches ingest even for a PIN no person claims — that is
                      // deliberate, and worth showing rather than hiding.
                      <span className="text-[var(--text-muted)]">unknown PIN</span>
                    )}
                  </div>
                </td>
                <td className="px-2 py-2 font-mono text-xs">{punch.esslUserId}</td>
                <td className="px-2 py-2 font-mono text-xs text-[var(--text-muted)]">
                  {punch.deviceName ?? punch.deviceSerialNo}
                </td>
                <td className="px-2 py-2">
                  <Badge tone={punch.verifyMode === 15 ? "ok" : "neutral"}>
                    {verifyModeLabel(punch.verifyMode)}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Denied attempts are not pushed by the device, so a blocked person&rsquo;s attempt leaves
          no trace here.
        </p>
      </Accordion>
    </div>
  );
}

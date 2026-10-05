"use client";

import { useCallback } from "react";
import Link from "next/link";
import { type Board, type BoardEntry, type ZoneList } from "@/lib/api";
import { useEventStream } from "@/lib/events";
import { useApi, refresh } from "@/lib/swr";
import { formatDuration, formatTime, formatWindow, titleCase } from "@/lib/format";
import { Alert, Badge, Card, Empty, Stat, Table } from "@/components/ui";
import { StreamStatus } from "@/components/stream-status";
import { PersonAvatar } from "@/components/person-avatar";

// Who is on site right now (Phase 2 Milestone 10).
//
// This is the screen an operator leaves open, so it is built to be read at a
// glance and to be honest about what it cannot know:
//
//   - Overdue is judged against the SERVER's clock, sent with the payload.
//     A gate PC whose time has drifted must not invent or hide an expiry.
//   - A person is INSIDE because a punch said so. The device suppresses
//     repeat punches inside its duplicate window, so someone who left very
//     soon after arriving can still be listed here. That is a real limit of
//     the data, and the page says so rather than implying certainty.

export default function InsidePage() {
  // Any entry transition can change this board — an arrival, a departure, a
  // day-block landing. Refetch rather than patching state locally: the board
  // is a small query and a wrong count here is worse than a slow one.
  const onEntry = useCallback(() => void refresh("/api/entries/board"), []);
  const { connected } = useEventStream({ onEntry, onPunch: onEntry });

  const { data: zoneList } = useApi<ZoneList>("/api/zones");
  const zoneName = (id: string | null | undefined) => (id ? zoneList?.items.find((z) => z.id === id)?.name ?? null : null);
  const { data, error } = useApi<Board>("/api/entries/board", {
    // Polled harder while the stream is down: this screen's whole value is
    // being current, and stale-but-silent is the one failure mode to avoid.
    refreshInterval: connected ? 30_000 : 5_000,
  });

  // The server's clock, never the browser's. Zero until the board loads, at
  // which point there are no rows to judge against it — reading the local
  // clock here would both break render purity and let a drifted gate PC
  // decide who is overdue.
  const now = data ? new Date(data.serverTime).getTime() : 0;
  const inside = data?.inside ?? [];
  const dayBlocked = data?.dayBlocked ?? [];
  const overdue = inside.filter(
    (e) => e.retentionExpiresAt !== null && new Date(e.retentionExpiresAt).getTime() <= now,
  );

  return (
    <div className="space-y-4">
      {error && <Alert>{error instanceof Error ? error.message : "failed to load"}</Alert>}

      <Card title="On site now" action={<StreamStatus connected={connected} />}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Inside" value={inside.length} sub="punched in, not yet out" />
          <Stat
            label="Past their window"
            value={overdue.length}
            sub={overdue.length > 0 ? "overstayed" : "none"}
          />
          <Stat
            label="Blocked for today"
            value={dayBlocked.length}
            sub="single entry, used"
          />
        </div>
      </Card>

      {overdue.length > 0 && (
        <Alert tone="warn">
          <strong>
            {overdue.length} {overdue.length === 1 ? "person is" : "people are"} inside after
            their pass ended (overstayed).
          </strong>{" "}
          Their entry terminals were cleared, but any exit terminal already loaded is kept so they
          can leave; the pass closes when they punch out. A single-entry visitor still waiting for
          an exit code can be released from their page (Security override). Worth chasing in person.
        </Alert>
      )}

      <Card title={`Inside (${inside.length})`}>
        {inside.length === 0 ? (
          <Empty>Nobody is on site. Entries appear here the moment someone punches in.</Empty>
        ) : (
          <Table head={["Person", "PIN", "Location", "Purpose", "In at", "Here for", "Window", "Mode"]}>
            {inside.map((entry) => (
              <BoardRow key={entry.id} entry={entry} now={now} location={zoneName(entry.locationZoneId) ?? "on site"} showDuration />
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Longest-present first. Someone who left very shortly after arriving may still be listed:
          the terminal drops a repeat punch by the same person inside its duplicate-punch window,
          so that exit never reached the server.
        </p>
      </Card>

      <Card title={`Blocked by an operator (${dayBlocked.length})`}>
        {dayBlocked.length === 0 ? (
          <Empty>Nobody is blocked.</Empty>
        ) : (
          <Table head={["Person", "PIN", "Location", "Purpose", "Out at", "Blocked for", "Window", "Mode"]}>
            {dayBlocked.map((entry) => (
              <BoardRow key={entry.id} entry={entry} now={now} />
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          These people are still loaded on the terminal and still recognised by it — it identifies
          them and then denies entry. Blocking never disturbs the stored face; Unblock on their page
          restores access instantly. (Single entry no longer blocks: the face simply leaves each
          terminal shortly after use.)
        </p>
      </Card>
    </div>
  );
}

function BoardRow({
  entry,
  now,
  showDuration = false,
  location = "—",
}: {
  entry: BoardEntry;
  now: number;
  showDuration?: boolean;
  location?: string;
}) {
  const lapsed =
    entry.retentionExpiresAt !== null && new Date(entry.retentionExpiresAt).getTime() <= now;
  const anchor = showDuration ? entry.inAt : entry.outAt;

  return (
    <tr className="border-b border-[var(--border)] last:border-0">
      <td className="px-2 py-2">
        <div className="flex items-center gap-2">
          <PersonAvatar personId={entry.person.id} name={entry.person.name} />
          <div>
            <Link
              href={`/people/${entry.person.id}`}
              className="text-[var(--brand)] hover:underline"
            >
              {entry.person.name}
            </Link>
            {entry.person.company && (
              <span className="ml-2 text-xs text-[var(--text-muted)]">{entry.person.company}</span>
            )}
          </div>
        </div>
      </td>
      <td className="px-2 py-2 font-mono text-xs">{entry.person.esslUserId}</td>
      <td className="px-2 py-2 text-xs">{location}</td>
      {/* Not truncated and not wrapped in a tooltip: an operator scanning this
          board for "who is in Block C" needs to read it, not hover it. */}
      <td className="px-2 py-2 text-xs">
        {entry.purposeOfVisit ?? <span className="text-[var(--text-muted)]">not recorded</span>}
      </td>
      <td className="px-2 py-2 whitespace-nowrap">{formatTime(anchor)}</td>
      <td className="px-2 py-2 whitespace-nowrap">{formatDuration(anchor, now)}</td>
      <td className="px-2 py-2 whitespace-nowrap">
        <Badge tone={lapsed ? "warn" : "neutral"}>
          {lapsed ? "overstayed" : formatWindow(entry.retentionExpiresAt, now)}
        </Badge>
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        <Badge tone={entry.entryMode === "SINGLE_ENTRY" ? "info" : "neutral"}>
          {titleCase(entry.entryMode)}
        </Badge>
      </td>
    </tr>
  );
}

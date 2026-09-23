"use client";

import Link from "next/link";
import { getApiBase, getToken } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { formatBytes, formatRelative } from "@/lib/format";
import { Badge, Button, Empty } from "@/components/ui";

// Enrollments waiting to be claimed.
//
// Someone enrolled on the terminal, the device pushed their photo, and no
// person owns it yet. Before this existed the only way to claim one was to
// remember the PIN typed on the device — the panel makes that state visible
// so registration never depends on memory.

export interface UnclaimedEnrollment {
  esslUserId: string;
  name: string | null;
  photoSizeBytes: number;
  arrivedAt: string;
  photoUrl: string;
}

export function UnclaimedEnrollments({ highlighted = true }: { highlighted?: boolean }) {
  const { data } = useApi<{ items: UnclaimedEnrollment[] }>("/api/enrollments/unclaimed", {
    refreshInterval: 15_000,
  });
  const items = data?.items ?? [];
  const token = getToken() ?? "";

  return (
    <details
      className={`group rounded-[var(--radius)] border bg-[var(--surface)] ${
        highlighted ? "border-[var(--warn)]" : "border-[var(--border)]"
      }`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm font-semibold tracking-wide">Unregistered people</span>
        <span className="flex items-center gap-2">
          <Badge tone={items.length > 0 ? "warn" : "neutral"}>{data ? items.length : "…"}</Badge>
          <span aria-hidden="true" className="text-sm transition-transform group-open:rotate-180">
            ▾
          </span>
        </span>
      </summary>
      <div className="border-t border-[var(--border)] p-4">
        <p className="mb-4 text-sm text-[var(--text-muted)]">
          Enrolled on the terminal, photo already received. Register each one to attach their photo
          automatically — no upload needed.
        </p>

        {items.length === 0 ? (
          <Empty>{data ? "No unregistered people." : "Loading unregistered people…"}</Empty>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <li
                key={item.esslUserId}
                className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- served by
                    the API behind a token from another origin; next/image cannot
                    carry the credential. */}
                <img
                  src={`${getApiBase()}${item.photoUrl}?token=${encodeURIComponent(token)}`}
                  alt={`Enrollment photo for PIN ${item.esslUserId}`}
                  className="h-16 w-16 shrink-0 rounded-[var(--radius)] border border-[var(--border)] object-cover"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {item.name ?? <span className="font-mono">PIN {item.esslUserId}</span>}
                  </div>
                  {item.name && (
                    <div className="font-mono text-xs text-[var(--text-muted)]">
                      PIN {item.esslUserId}
                    </div>
                  )}
                  <div className="text-xs text-[var(--text-muted)]">
                    {formatRelative(item.arrivedAt)} · {formatBytes(item.photoSizeBytes)}
                  </div>
                  <Link
                    href={`/people/new?pin=${item.esslUserId}${item.name ? `&name=${encodeURIComponent(item.name)}` : ""}`}
                  >
                    <Button variant="primary" className="mt-2 w-full">
                      Register
                    </Button>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

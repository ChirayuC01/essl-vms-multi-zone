"use client";

import { useState } from "react";
import { api, ApiError, getApiBase, getToken } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { refresh, useApi } from "@/lib/swr";
import { formatBytes, formatRelative } from "@/lib/format";
import { Alert, Badge, Button, Empty } from "@/components/ui";

// Hand enrolments: someone enrolled on a terminal directly, the device pushed
// their photo, and no person owns the ID. Two-zone sites register only in the
// console (F2 #2), so this is a warning to clean up, not a queue to register
// from: an Administrator deletes them (F3 F-j).

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
  const { can } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  // F3 F-j: discard a hand enrolment — the photo here, and the ID on every
  // terminal whose patterns cover it.
  const discard = async (pin: string) => {
    if (!window.confirm(`Delete enrolment ${pin}? Its photo is deleted and the ID is removed from the terminals.`)) return;
    setProblem(null);
    try {
      await api(`/api/enrollments/unclaimed/${encodeURIComponent(pin)}`, { method: "DELETE" });
      await refresh("/api/enrollments/unclaimed");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "delete failed");
    }
  };

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
          Enrolled directly on a terminal and not registered here. People are registered in the
          console (Register person or a visit request), so delete these; register the person
          properly if they need access.
        </p>

        {problem && <Alert>{problem}</Alert>}
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
                  {can("unclaimed:delete") && (
                    <Button variant="danger" className="mt-2 w-full" onClick={() => void discard(item.esslUserId)}>
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

"use client";
/* eslint-disable @next/next/no-img-element -- photos require a runtime credential that next/image cannot attach. */

import { useState } from "react";
import { getApiBase, getToken } from "@/lib/api";

// A small round thumbnail so a person is recognisable by face in a log row,
// not just by name or PIN. Row shapes here (punches, commands, the inside
// board) don't carry a "has photo" flag, so this always attempts the
// request and quietly falls back to an initial rather than showing a
// broken-image icon when one doesn't exist.

export function PersonAvatar({
  personId,
  name,
}: {
  personId: string | null | undefined;
  name: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  if (!personId || failed) {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-muted)] text-xs font-medium text-[var(--text-muted)]">
        {initial}
      </span>
    );
  }

  return (
    <img
      src={`${getApiBase()}/api/people/${personId}/photo?token=${encodeURIComponent(getToken() ?? "")}`}
      alt={name}
      onError={() => setFailed(true)}
      className="h-8 w-8 shrink-0 rounded-full border border-[var(--border)] object-cover"
    />
  );
}

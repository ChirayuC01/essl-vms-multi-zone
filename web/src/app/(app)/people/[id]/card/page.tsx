"use client";

import { use } from "react";
import { getApiBase, getToken, type PersonDetail } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { formatDateTime } from "@/lib/format";
import { Alert, Button, Card, Empty } from "@/components/ui";

// The person card — permanent, unlike the visitor pass.
//
// The pass covers one visit and carries a validity window. This carries the
// registration and, above all, the PIN: a returning person reads the number
// off it and the operator provisions them in seconds instead of guessing at
// the spelling of a name.
//
// **The PIN on this card is a lookup key, not a credential**, and the card
// says so. Anyone can read a number out; what authorizes the visit is the
// operator comparing the stored photo with the person in front of them. A card
// that implied otherwise would turn itself into an access token that can be
// photographed.

export default function PersonCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: person, error } = useApi<PersonDetail>(`/api/people/${id}`);

  if (error) return <Alert>Could not load this person.</Alert>;
  if (!person) return <Empty>Loading…</Empty>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-[var(--text-muted)]">
          Give this to a person who visits often. Next time they only need to read out the PIN.
        </p>
        <Button onClick={() => window.print()}>Print card</Button>
      </div>

      <Card title="">
        <div className="mx-auto max-w-md border border-[var(--border)] p-6 print:border-black">
          <p className="text-xs uppercase tracking-widest text-[var(--text-muted)]">Person card</p>

          <div className="mt-4 flex items-start gap-4">
            {person.biometric ? (
              /* eslint-disable-next-line @next/next/no-img-element -- the API
                 serves the JPEG behind a bearer token from another origin;
                 next/image cannot carry the auth header. */
              <img
                src={`${getApiBase()}/api/people/${person.id}/photo?token=${encodeURIComponent(getToken() ?? "")}`}
                alt={person.name}
                className="h-32 w-32 shrink-0 rounded border border-[var(--border)] object-cover print:border-black"
              />
            ) : (
              <div className="flex h-32 w-32 shrink-0 items-center justify-center rounded border border-dashed border-[var(--border)] text-xs text-[var(--text-muted)]">
                no photo
              </div>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold">{person.name}</h1>
              {person.company && (
                <p className="truncate text-sm text-[var(--text-muted)]">{person.company.name}</p>
              )}
              {person.mobile && <p className="mt-1 text-sm">{person.mobile}</p>}
            </div>
          </div>

          {/* The number the whole card exists to carry. Large enough to read
              across a desk without handing the card over. */}
          <div className="mt-6 rounded border border-[var(--border)] p-4 text-center print:border-black">
            <p className="text-xs uppercase tracking-widest text-[var(--text-muted)]">
              Quote this number on arrival
            </p>
            <p className="mt-1 font-mono text-5xl font-semibold tracking-widest">
              {person.esslUserId}
            </p>
          </div>

          <p className="mt-6 border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)] print:border-black">
            <strong>This card does not grant entry.</strong> It identifies you so the gate office
            can find your record quickly. Access is by face recognition, and every visit is
            authorized on the day. Registered {formatDateTime(person.createdAt)}.
          </p>
        </div>
      </Card>
    </div>
  );
}

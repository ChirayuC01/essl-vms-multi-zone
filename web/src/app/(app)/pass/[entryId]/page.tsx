"use client";

import { use } from "react";
import { getApiBase, getToken, type Entry, type PersonDetail } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { formatDateTime } from "@/lib/format";
import { Alert, Button, Card, Empty } from "@/components/ui";

// The visitor pass (Phase 4 Milestone 20).
//
// A printable identity artifact — NOT a credential, and the pass says so on
// its face. The barrier opens on a face match and nothing else; a laminated
// card with a photo on it looks exactly like an access badge, and someone
// waving one at a gate guard should not be able to imply it grants entry.
//
// No QR or barcode. `INFO` reports no QR support on this firmware, so a code
// here would be decoration that invites somebody to try scanning it.
//
// Plain HTML with a print stylesheet rather than generated PDF: it prints from
// any browser to any printer with nothing installed, which is what an
// on-premise gate office actually has.

export default function VisitorPassPage({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = use(params);
  const { data: entry, error } = useApi<Entry>(`/api/entries/${entryId}`);
  const { data: person } = useApi<PersonDetail>(
    entry ? `/api/people/${entry.personId}` : null,
  );

  if (error) return <Alert>Could not load this pass.</Alert>;
  if (!entry || !person) return <Empty>Loading…</Empty>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-[var(--text-muted)]">
          Print this and hand it over. It identifies the visitor — it does not open anything.
        </p>
        <Button onClick={() => window.print()}>Print pass</Button>
      </div>

      <Card title="">
        <div className="mx-auto max-w-md border border-[var(--border)] p-6 print:border-black">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-[var(--text-muted)]">
                Visitor pass
              </p>
              <h1 className="mt-1 text-2xl font-semibold">{person.name}</h1>
              {person.company && <p className="text-sm text-[var(--text-muted)]">{person.company.name}</p>}
            </div>
            {person.biometric && (
              /* eslint-disable-next-line @next/next/no-img-element -- the API
                 serves the JPEG behind a bearer token from another origin;
                 next/image cannot carry the auth header. */
              <img
                src={`${getApiBase()}/api/people/${person.id}/photo?token=${encodeURIComponent(getToken() ?? "")}`}
                alt={person.name}
                className="h-28 w-28 shrink-0 rounded border border-[var(--border)] object-cover print:border-black"
              />
            )}
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-[var(--text-muted)]">Reference</dt>
              <dd className="font-mono">{person.esslUserId}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--text-muted)]">Entry mode</dt>
              <dd>{entry.entryMode === "SINGLE_ENTRY" ? "One visit today" : "Multiple visits"}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--text-muted)]">Valid from</dt>
              <dd>{formatDateTime(entry.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--text-muted)]">Valid until</dt>
              <dd>
                {entry.retentionExpiresAt ? formatDateTime(entry.retentionExpiresAt) : "no expiry"}
              </dd>
            </div>
            {/* Spans both columns: it is a sentence, not a field, and the one
                thing on this pass a person at the gate reads to decide whether
                the holder is where they should be. Omitted entirely on older
                entries rather than printed as "not recorded" — a pass is
                handed to a visitor, and a blank on it invites a question
                nobody at the desk can answer. */}
            {entry.purposeOfVisit && (
              <div className="col-span-2">
                <dt className="text-xs text-[var(--text-muted)]">Purpose of visit</dt>
                <dd>{entry.purposeOfVisit}</dd>
              </div>
            )}
            {entry.personToMeet && (
              <div className="col-span-2">
                <dt className="text-xs text-[var(--text-muted)]">Person to meet</dt>
                <dd>{entry.personToMeet.name ?? entry.personToMeet.email}</dd>
              </div>
            )}
          </dl>

          {/* The whole reason this wording exists. A card with a photo reads as
              an access badge, and it is not one. */}
          <p className="mt-6 border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)] print:border-black">
            <strong>Entry is by face recognition.</strong> This pass identifies the holder and
            records the period they are authorized for. It does not open the barrier and it is not
            proof of access — if the terminal does not recognise the face, entry is refused.
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Issued {formatDateTime(new Date().toISOString())}
          </p>
        </div>
      </Card>
    </div>
  );
}

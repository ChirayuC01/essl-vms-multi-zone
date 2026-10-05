"use client";

import { useState } from "react";
import { api, type SiteSettings } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

const NUMBERS: { key: keyof SiteSettings; label: string; hint: string }[] = [
  { key: "entryLoadLeadMinutes", label: "Load face before visit (minutes)", hint: "how early a visitor's face reaches the entry gates" },
  { key: "unloadAfterPunchMinutes", label: "Remove after punch (minutes)", hint: "single entry: removal from a terminal after its punch" },
  { key: "outageGapMinutes", label: "Outage after (minutes)", hint: "a server silence longer than this counts as an outage" },
  { key: "linkExpiryHours", label: "Visitor link valid (hours)", hint: "pre-registration link lifetime" },
  { key: "otpTtlMinutes", label: "One-time code valid (minutes)", hint: "mobile and exit codes" },
  { key: "otpMaxAttempts", label: "One-time code attempts", hint: "wrong tries before a code is burned" },
  { key: "documentMaxMb", label: "Document size limit (MB)", hint: "per file" },
  { key: "documentMaxCount", label: "Documents per visit", hint: "0 turns uploads off" },
];
const DOC_TYPES = ["jpeg", "png", "webp", "pdf"];

// Site behaviour an Admin may change without a code change. Every save is
// audited with old and new values; unchanged fields are ignored server-side.
export function SiteSettingsCard({ editable }: { editable: boolean }) {
  const { data } = useApi<SiteSettings>("/api/settings");
  // The server copy until the first edit; no effect needed to seed it.
  const [edited, setDraft] = useState<SiteSettings | null>(null);
  const draft = edited ?? data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!draft) return <Card title="System settings"><p className="text-sm text-[var(--text-muted)]">Loading…</p></Card>;

  const set = <K extends keyof SiteSettings>(key: K, value: SiteSettings[K]) => { setSaved(false); setDraft({ ...draft, [key]: value }); };
  async function save() {
    if (!draft) return;
    setError(null);
    try {
      const { privacyNoticeVersion: _version, ...body } = draft;
      void _version;
      await api("/api/settings", { method: "PATCH", body });
      await refresh("/api/settings");
      setDraft(null);
      setSaved(true);
    } catch (err) { setError(err instanceof Error ? err.message : "save failed"); }
  }

  return (
    <Card title="System settings">
      {error && <Alert>{error}</Alert>}
      {saved && <Alert tone="info">Settings saved.</Alert>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {NUMBERS.map(({ key, label, hint }) => (
          <Field key={key} label={label} hint={hint}>
            <Input type="number" value={String(draft[key])} onChange={(e) => set(key, Number(e.target.value) as never)} />
          </Field>
        ))}
        <Field label="Visitor ID prefix" hint="letters/digits; must fit the terminals' visitor ID patterns">
          <Input value={draft.visitorIdPrefix} maxLength={8} onChange={(e) => set("visitorIdPrefix", e.target.value)} />
        </Field>
        <Field label="Walk-ins" hint="whether the host must Clear a walk-in first">
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.walkInRequiresHostClear} onChange={(e) => set("walkInRequiresHostClear", e.target.checked)} />
            Host must Clear before loading
          </label>
        </Field>
        <Field label="Document types" hint="accepted uploads">
          <div className="mt-2 flex flex-wrap gap-3">
            {DOC_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={draft.documentTypes.includes(t)}
                  onChange={() => set("documentTypes", draft.documentTypes.includes(t) ? draft.documentTypes.filter((x) => x !== t) : [...draft.documentTypes, t])}
                />
                {t.toUpperCase()}
              </label>
            ))}
          </div>
        </Field>
      </div>
      <div className="mt-4">
        <Field
          label="Privacy notice shown to visitors"
          hint={draft.privacyNoticeVersion ? `current version ${formatDateTime(draft.privacyNoticeVersion)} — changing the text starts a new version` : "not set yet; the site supplies this wording"}
        >
          <textarea
            className="min-h-32 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2 text-sm"
            value={draft.privacyNoticeText}
            onChange={(e) => set("privacyNoticeText", e.target.value)}
          />
        </Field>
      </div>
      {editable ? (
        <Button className="mt-3" variant="primary" onClick={save}>Save settings</Button>
      ) : (
        <p className="mt-3 text-xs text-[var(--text-muted)]">Read only: your access does not include changing settings.</p>
      )}
    </Card>
  );
}

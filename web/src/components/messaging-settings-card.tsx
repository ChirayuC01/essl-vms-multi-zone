"use client";

import { useState } from "react";
import { api, SMS_TEMPLATES, type SiteSettings } from "@/lib/api";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";

type Messaging = Pick<SiteSettings, "smsTransport" | "msg91AuthKey" | "msg91TemplateIds" | "emailEnabled" | "smtpHost" | "smtpPort" | "smtpSecure" | "smtpUser" | "smtpPassword" | "smtpFrom">;

// How SMS and email leave this site. Each site has its own MSG91 key and
// template IDs; secrets are never sent back, so a blank box keeps the stored one.
export function MessagingSettingsCard({ editable }: { editable: boolean }) {
  const { data } = useApi<SiteSettings>("/api/settings");
  const [edited, setDraft] = useState<Messaging | null>(null);
  const draft: Messaging | null = edited ?? data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testTo, setTestTo] = useState({ SMS: "", EMAIL: "" });
  if (!draft || !data) return <Card title="Messaging"><p className="text-sm text-[var(--text-muted)]">Loading…</p></Card>;

  const set = <K extends keyof Messaging>(key: K, value: Messaging[K]) => { setNotice(null); setDraft({ ...draft, [key]: value }); };
  async function save() {
    if (!draft) return;
    setError(null);
    try {
      const { smsTransport, msg91AuthKey, msg91TemplateIds, emailEnabled, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, smtpFrom } = draft;
      await api("/api/settings", { method: "PATCH", body: { smsTransport, msg91AuthKey, msg91TemplateIds, emailEnabled, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, smtpFrom } });
      await refresh("/api/settings");
      setDraft(null);
      setNotice("Messaging settings saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "save failed"); }
  }
  async function test(channel: "SMS" | "EMAIL") {
    setError(null);
    try {
      const r = await api<{ status: string; error: string | null; transport: string }>("/api/settings/test-message", { method: "POST", body: { channel, to: testTo[channel] } });
      if (r.error) setError(`Test failed: ${r.error}`);
      else setNotice(r.transport === "console" ? "Recorded on the Outbox page only — SMS sending is set to Outbox only." : `Test ${channel === "SMS" ? "SMS" : "email"} sent. Check it arrived.`);
    } catch (err) { setError(err instanceof Error ? err.message : "test failed"); }
  }
  const secretHint = (isSet: boolean) => (isSet ? "saved — leave blank to keep it, type to replace" : "not set");

  return (
    <Card title="Messaging">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}
      <h3 className="mb-2 text-sm font-semibold">SMS (MSG91)</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Send SMS" hint="Outbox only records messages without sending them">
          <Select value={draft.smsTransport} onChange={(e) => set("smsTransport", e.target.value as Messaging["smsTransport"])}>
            <option value="console">Outbox only (not sent)</option>
            <option value="msg91">Through MSG91</option>
          </Select>
        </Field>
        <Field label="MSG91 auth key" hint={secretHint(data.secretsSet.msg91AuthKey)}>
          <Input type="password" autoComplete="off" value={draft.msg91AuthKey} onChange={(e) => set("msg91AuthKey", e.target.value)} />
        </Field>
      </div>
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        MSG91 template ID for each DLT template (MSG91 → SMS → Templates; not the DLT ID). Name each template&apos;s variables var1, var2, … in the order they appear. A blank ID means that message is recorded as failed instead of sent.
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SMS_TEMPLATES.map(([key, label]) => (
          <Field key={key} label={label}>
            <Input value={draft.msg91TemplateIds[key] ?? ""} maxLength={64} onChange={(e) => set("msg91TemplateIds", { ...draft.msg91TemplateIds, [key]: e.target.value })} />
          </Field>
        ))}
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold">Email</h3>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.emailEnabled} onChange={(e) => set("emailEnabled", e.target.checked)} />
        Send email too (off: nothing is emailed; SMS carries every message)
      </label>
      {draft.emailEnabled && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="SMTP server" hint="e.g. smtp.office365.com"><Input value={draft.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} /></Field>
          <Field label="Port" hint="587 (STARTTLS) or 465 (TLS)"><Input type="number" value={String(draft.smtpPort)} onChange={(e) => set("smtpPort", Number(e.target.value))} /></Field>
          <Field label="Encryption">
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.smtpSecure} onChange={(e) => set("smtpSecure", e.target.checked)} />
              TLS from the start (port 465)
            </label>
          </Field>
          <Field label="Username" hint="blank if the server needs no sign-in"><Input autoComplete="off" value={draft.smtpUser} onChange={(e) => set("smtpUser", e.target.value)} /></Field>
          <Field label="Password" hint={secretHint(data.secretsSet.smtpPassword)}><Input type="password" autoComplete="off" value={draft.smtpPassword} onChange={(e) => set("smtpPassword", e.target.value)} /></Field>
          <Field label="From address" hint='e.g. Visitor desk <visitors@example.com>'><Input value={draft.smtpFrom} onChange={(e) => set("smtpFrom", e.target.value)} /></Field>
        </div>
      )}

      {editable ? (
        <>
          <Button className="mt-4" variant="primary" onClick={save}>Save messaging</Button>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Field label="Send a test SMS" hint="uses template 1 with code 123456; save first">
              <div className="flex gap-2">
                <Input type="tel" placeholder="mobile number" value={testTo.SMS} onChange={(e) => setTestTo({ ...testTo, SMS: e.target.value })} />
                <Button onClick={() => test("SMS")}>Send</Button>
              </div>
            </Field>
            {data.emailEnabled && (
              <Field label="Send a test email" hint="uses the saved SMTP settings">
                <div className="flex gap-2">
                  <Input type="email" placeholder="email address" value={testTo.EMAIL} onChange={(e) => setTestTo({ ...testTo, EMAIL: e.target.value })} />
                  <Button onClick={() => test("EMAIL")}>Send</Button>
                </div>
              </Field>
            )}
          </div>
        </>
      ) : (
        <p className="mt-3 text-xs text-[var(--text-muted)]">Read only: your access does not include changing settings.</p>
      )}
    </Card>
  );
}

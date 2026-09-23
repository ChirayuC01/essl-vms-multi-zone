"use client";
/* eslint-disable @next/next/no-img-element -- the logo is served by the runtime API, not a build-time image host. */

import { useState } from "react";
import { api, getApiBase, type Branding } from "@/lib/api";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

export default function SettingsPage() {
  const { data } = useApi<Branding>("/api/branding");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function saveName() {
    try { await api("/api/branding", { method: "PUT", body: { organizationName: name || data?.organizationName } }); await refresh("/api/branding"); }
    catch (err) { setError(err instanceof Error ? err.message : "save failed"); }
  }
  async function saveLogo(file: File) {
    try { await api("/api/branding/logo", { method: "PUT", blob: { data: file, contentType: file.type } }); await refresh("/api/branding"); }
    catch (err) { setError(err instanceof Error ? err.message : "upload failed"); }
  }
  return <Card title="Organization branding">
    {error && <Alert>{error}</Alert>}
    {data?.logoUrl && <img src={`${getApiBase()}${data.logoUrl}`} alt="Organization logo" className="mb-4 h-24 max-w-xs object-contain" />}
    <div className="space-y-4">
      <Field label="Organization name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={data?.organizationName} /></Field>
      <Button variant="primary" onClick={saveName}>Save name</Button>
      <Field label="Logo" hint="PNG, JPEG, or WebP; maximum 2 MB"><Input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const file = e.target.files?.[0]; if (file) void saveLogo(file); }} /></Field>
    </div>
  </Card>;
}

"use client";

import { useState } from "react";
import { api, type LicenseStatus } from "@/lib/api";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Badge, Button, Card, Field, Input, Stat } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";

export default function LicensePage() {
  const { can } = useAuth();
  const { data, error } = useApi<LicenseStatus>("/api/license");
  const [key, setKey] = useState("");
  const [installError, setInstallError] = useState<string | null>(null);
  async function install() {
    try { await api("/api/license", { method: "POST", body: { licenseKey: key.trim() } }); setKey(""); await refresh("/api/license"); }
    catch (err) { setInstallError(err instanceof Error ? err.message : "license installation failed"); }
  }
  return <div className="mx-auto max-w-2xl space-y-4">
    {(error || installError) && <Alert>{installError ?? (error instanceof Error ? error.message : "failed to load license")}</Alert>}
    {data?.expired && <Alert tone="warn">The software license expired. Device communication and safety jobs continue, but operator functions remain locked until renewal.</Alert>}
    <Card title="License status">
      {data && <div className="grid gap-3 sm:grid-cols-2"><Stat label="Type" value={data.kind ?? "Not started"} /><Stat label="Plan" value={data.plan ?? "—"} /><Stat label="Expires" value={formatDateTime(data.expiresAt)} /><Stat label="Days remaining" value={String(data.daysRemaining ?? "—")} /></div>}
      <div className="mt-4"><Badge tone={data?.expired ? "danger" : "ok"}>{data?.expired ? "expired" : "active"}</Badge></div>
    </Card>
    {can("license:manage") && <Card title="Install or renew"><Field label="License key"><Input value={key} onChange={(e) => setKey(e.target.value)} /></Field><Button className="mt-3" variant="primary" disabled={!key.trim()} onClick={install}>Install key</Button></Card>}
  </div>;
}

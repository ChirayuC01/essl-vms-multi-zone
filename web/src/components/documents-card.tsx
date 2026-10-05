"use client";

import { useState } from "react";
import { api, ApiError, getApiBase, getToken, type PersonDocument } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { refresh, useApi } from "@/lib/swr";
import { Alert, Button, Card, Field, Input, Select, Table } from "@/components/ui";

const KINDS = ["Govt ID", "Vehicle papers", "Police clearance", "Credential", "Other"];

// A person's documents. The server decides a file's type from its bytes and
// always serves it as a download; removing one hides it but keeps the record.
export function DocumentsCard({ personId }: { personId: string }) {
  const { can } = useAuth();
  const url = `/api/people/${personId}/documents`;
  const { data } = useApi<{ items: PersonDocument[] }>(url);
  const [kind, setKind] = useState(KINDS[0]!);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`${url}?kind=${encodeURIComponent(kind)}&fileName=${encodeURIComponent(file.name)}`, {
        method: "POST",
        blob: { data: file, contentType: "application/octet-stream" },
      });
      setFile(null);
      await refresh(url);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }
  async function remove(doc: PersonDocument) {
    setProblem(null);
    try {
      await api(`${url}/${doc.id}`, { method: "DELETE" });
      await refresh(url);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "remove failed");
    }
  }

  return (
    <Card title="Documents">
      {problem && <Alert>{problem}</Alert>}
      {(data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No documents.</p>
      ) : (
        <Table head={["Kind", "File", "Size", "Added", ""]}>
          {data!.items.map((d) => (
            <tr key={d.id} className="border-b border-[var(--border)] last:border-0">
              <td className="px-2 py-2">{d.kind}</td>
              <td className="px-2 py-2">{d.fileName}</td>
              <td className="px-2 py-2">{(d.sizeBytes / 1024).toFixed(0)} KB</td>
              <td className="px-2 py-2 text-xs text-[var(--text-muted)]">{formatDateTime(d.createdAt)}{d.source === "PORTAL" ? " · by visitor" : ""}</td>
              <td className="px-2 py-2">
                <div className="flex justify-end gap-2">
                  <a
                    className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-muted)]"
                    href={`${getApiBase()}${url}/${d.id}/file?token=${encodeURIComponent(getToken() ?? "")}`}
                  >
                    Download
                  </a>
                  {can("documents:delete") && <Button variant="danger" onClick={() => void remove(d)}>Remove</Button>}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {can("documents:create") && (
        <div className="mt-3 grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto]">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => <option key={k}>{k}</option>)}
            </Select>
          </Field>
          <Field label="File" hint="JPEG, PNG, WebP or PDF; limits are set in System settings. Prefer a masked Aadhaar.">
            <Input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <div className="flex items-end"><Button variant="primary" disabled={!file} loading={busy} onClick={() => void upload()}>Upload</Button></div>
        </div>
      )}
    </Card>
  );
}

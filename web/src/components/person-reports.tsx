"use client";

import { useState } from "react";
import { getApiBase, getToken, type DeviceList, type ReportList } from "@/lib/api";
import { useApi } from "@/lib/swr";
import { dayOfMonthIst, formatDateInputIst } from "@/lib/format";
import { Button, Card, Field, Input, SearchSelect, Select } from "@/components/ui";

// Every report that can be narrowed to one person, downloadable from that
// person's page. The person filter is fixed; company, department, category
// and search are omitted because one person already decides all four. Ported
// from 0.4.24 (F3 F-g); Monthly status is offered for employees only (F-f).

const MONTHLY = "monthly-status";

export function PersonReports({ personId, employee }: { personId: string; employee: boolean }) {
  const { data: catalogue } = useApi<ReportList>("/api/reports");
  const { data: deviceList } = useApi<DeviceList>("/api/devices");
  const today = new Date();
  const [key, setKey] = useState(employee ? MONTHLY : "punch-log");
  const [from, setFrom] = useState(formatDateInputIst(new Date(today.getTime() - (dayOfMonthIst(today) - 1) * 86_400_000)));
  const [to, setTo] = useState(formatDateInputIst(today));
  const [deviceId, setDeviceId] = useState("");

  const reports = (catalogue?.items ?? []).filter((r) => r.filters.includes("person"));
  const selected = reports.find((r) => r.key === key);
  const usesDates = key === MONTHLY || selected?.filters.includes("dateRange") === true;
  const usesDevice = selected?.filters.includes("device") === true;

  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  const invalid = !usesDates
    ? null
    : !from || !to || span < 1
      ? "Pick a From date on or before the To date."
      : key === MONTHLY && span > 31
        ? "The monthly status report covers at most 31 days."
        : null;

  const params = new URLSearchParams({ personId, token: getToken() ?? "" });
  if (usesDates) {
    params.set("from", from);
    params.set("to", to);
  }
  if (usesDevice && deviceId) params.set("deviceId", deviceId);
  const href = (format: string) => `${getApiBase()}/api/reports/${key}?${params.toString()}&format=${format}`;

  return (
    <Card title="Reports">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Report">
          <Select value={key} onChange={(e) => setKey(e.target.value)}>
            {employee && <option value={MONTHLY}>Monthly status (Excel / PDF)</option>}
            {reports.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}
          </Select>
        </Field>
        {usesDates && (
          <>
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </>
        )}
        {usesDevice && (
          <Field label="Device">
            <SearchSelect value={deviceId} onChange={setDeviceId} options={(deviceList?.items ?? []).map((d) => ({ value: d.id, label: d.name ?? d.serialNo }))} emptyLabel="All devices" />
          </Field>
        )}
      </div>
      {selected && <p className="mt-2 text-xs text-[var(--text-muted)]">{selected.description}</p>}
      {invalid ? (
        <p className="mt-3 text-sm text-[var(--danger)]">{invalid}</p>
      ) : (
        <div className="mt-3 flex gap-2">
          {key === MONTHLY ? (
            <>
              <a href={href("xlsx")} download><Button variant="primary">Download Excel</Button></a>
              <a href={href("pdf")} download><Button>Download PDF</Button></a>
            </>
          ) : (
            <a href={href("csv")} download><Button variant="primary">Download CSV</Button></a>
          )}
        </div>
      )}
    </Card>
  );
}

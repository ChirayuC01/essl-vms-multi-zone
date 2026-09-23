import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config/index.js";
import { REPORTS, findReport, runReport, runReportAll, type ReportFilters } from "../reports/registry.js";
import { prisma } from "../db/index.js";
import { Permission, can } from "./permissions.js";
import { getBranding } from "../services/branding.js";

// Reporting endpoints (Phase 4 Milestone 20).
//
// Two routes for twenty reports: list the catalogue, run one. Adding a report
// is a definition in the registry, not a route and not a page.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IST = "Asia/Kolkata";
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});
const IST_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function utcInstant(value: Date | string): Date {
  if (value instanceof Date) return value;
  const normalized = value.replace(" ", "T");
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}Z`);
}

/** Reports are presentation APIs. Convert timestamps once here so the web
 * table and the downloaded CSV cannot disagree or expose raw UTC strings. */
function reportValue(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date || (typeof value === "string" && ISO_TIMESTAMP.test(value))) {
    const parsed = utcInstant(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return key === "day" || key?.endsWith("_date")
      ? IST_DATE.format(parsed)
      : `${IST_DATE_TIME.format(parsed)} IST`;
  }
  if (Array.isArray(value)) return value.map((item) => reportValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([nestedKey, nested]) => [
        nestedKey,
        reportValue(nested, nestedKey),
      ]),
    );
  }
  return value;
}

function reportRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, reportValue(value, key)])),
  );
}

const querySchema = z.object({
  from: z.string().regex(DATE).optional(),
  to: z.string().regex(DATE).optional(),
  personId: z.string().min(1).optional(),
  deviceId: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  action: z.string().min(1).max(80).optional(),
  companyId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  category: z.enum(["EMPLOYEE", "VISITOR"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  format: z.enum(["json", "csv"]).default("json"),
});

/**
 * Does this value risk being executed as a spreadsheet formula?
 *
 * A leading `=`, `@`, tab or CR is always a formula start. `+` and `-` are
 * too, but they are also how phone numbers and negative numbers begin — and
 * the naive rule turned every `+919325474337` in the person register into
 * `'+919325474337`, visible in the cell, on every export.
 *
 * A dangerous payload needs a function or reference name after the sign
 * (`+HYPERLINK(...)`, `-cmd|...`), so a letter is what distinguishes them
 * from a phone number. Narrower than "escape everything", and it keeps the
 * mitigation off the values people actually read.
 */
function looksLikeFormula(raw: string): boolean {
  if (/^[=@\t\r]/.test(raw)) return true;
  return /^[+-]/.test(raw) && /[a-zA-Z]/.test(raw);
}

/**
 * One CSV field.
 *
 * Two separate problems, and both matter:
 *
 *  - Quoting. A person called "Smith, J" or a detail blob containing a
 *    newline would otherwise shift every following column.
 *  - Formula injection. A spreadsheet executes a cell beginning with `=` or
 *    `@`, so an exported value like `=HYPERLINK(...)` runs when the file is
 *    opened. These exports are opened in Excel by people with no reason to
 *    expect a cell to do anything, so the apostrophe prefix neutralises it.
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const timestamp =
    typeof value === "string" && ISO_TIMESTAMP.test(value)
      ? utcInstant(value)
      : value instanceof Date
        ? value
        : null;
  const raw =
    timestamp && !Number.isNaN(timestamp.getTime())
      ? `${IST_DATE_TIME.format(timestamp)} IST`
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  const safe = looksLikeFormula(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export const __test = { looksLikeFormula, csvField, reportValue, reportRows };

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  // The catalogue, filtered to what this operator may actually run. Listing a
  // report they cannot open would be an invitation to a 403.
  app.get("/reports", async (request, reply) => {
    const role = request.operator?.role;
    const items = REPORTS.filter((r) => role !== undefined && can(role, r.permission)).map((r) => ({
      key: r.key,
      title: r.title,
      description: r.description,
      group: r.group,
      filters: r.filters,
      columns: r.columns,
    }));
    return reply.send({ total: items.length, items });
  });

  // What the actor and action filters can be set to, taken from the log
  // itself rather than a hardcoded list. An action that has never been
  // recorded is not worth offering, and a new one appears here the first time
  // it happens without anyone remembering to add it.
  app.get("/reports/meta/audit-facets", async (request, reply) => {
    const role = request.operator?.role;
    if (role === undefined || !can(role, Permission.AUDIT_READ)) {
      return reply.code(403).send({ error: "your role is not permitted to read the audit log" });
    }
    const [actions, actors] = await Promise.all([
      prisma.auditLog.findMany({
        distinct: ["action"],
        select: { action: true },
        orderBy: { action: "asc" },
      }),
      prisma.$queryRaw<{ id: string | null; email: string | null }[]>`
        SELECT DISTINCT a."actor_id" AS id, u."email"
          FROM "audit_log" a
          LEFT JOIN "app_user" u ON u."id" = a."actor_id"
         ORDER BY u."email" ASC NULLS FIRST`,
    ]);
    return reply.send({
      actions: actions.map((a) => a.action),
      // A null actor is a scheduled job. Offered explicitly, because "what ran
      // unattended" is one of the more useful things to isolate.
      actors: actors.map((a) => ({ id: a.id ?? "system", email: a.email ?? "system" })),
    });
  });

  app.get("/reports/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    const def = findReport(key);
    if (!def) return reply.code(404).send({ error: "no such report" });

    const role = request.operator?.role;
    if (role === undefined || !can(role, def.permission)) {
      return reply.code(403).send({
        error: `your role is not permitted to run this report (${def.permission})`,
      });
    }

    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid query" });
    }
    const { page, pageSize, format, ...rest } = parsed.data;
    const filters: ReportFilters = rest;

    if (filters.from && filters.to && filters.from > filters.to) {
      return reply.code(400).send({ error: "`from` is after `to`" });
    }

    if (format === "csv") {
      // Bounded rather than streamed. A year of movement is hundreds of
      // thousands of rows, and an export that quietly truncates is worse than
      // one that says so — the caller is told the cap and can narrow the date
      // range, which is what they wanted anyway.
      const [rawRows, branding] = await Promise.all([
        runReportAll(def, filters, config.reportExportMaxRows),
        getBranding(),
      ]);
      const rows = reportRows(rawRows);
      const header = def.columns.map((c) => csvField(c.label)).join(",");
      const body = rows
        .map((row) => def.columns.map((c) => csvField(row[c.key])).join(","))
        .join("\r\n");
      const truncated = rows.length >= config.reportExportMaxRows;

      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="${def.key}-${new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date())}.csv"`,
        )
        .header("X-Report-Truncated", String(truncated))
        .header("X-Report-Rows", String(rows.length))
        // A BOM so Excel reads it as UTF-8. Without it, a person name with
        // any non-ASCII character opens as mojibake on a Windows machine,
        // which is where these will be opened.
        .send("﻿" + csvField(branding.organizationName) + "\r\n" + csvField(def.title) + "\r\n\r\n" + header + "\r\n" + body + "\r\n");
    }

    const result = await runReport(def, filters, page, pageSize);
    return reply.send({
      key: def.key,
      title: def.title,
      description: def.description,
      columns: def.columns,
      ...result,
      rows: reportRows(result.rows),
    });
  });
}

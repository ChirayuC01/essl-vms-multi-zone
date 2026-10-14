import { PersonCategory, Prisma } from "@prisma/client";
import { prisma } from "../db/index.js";

// Monthly Status report (Detailed Work Duration), F3 F-f: one grid per person,
// one column per day, laid out like the eTimeTrackLite report sites already
// use. Ported from 0.4.24 WITHOUT shifts (F4): status is P or A, and a day's
// work is its paired IN/OUT time. Late By, Early By, OT, WO and WOP come with
// the Shift master.
//
// Zones: the day's IN / OUT come only from punches whose terminal was in a
// TOP-LEVEL zone at the time (`punch_event.zone_id`, F-z), so a trip into the
// yard and back is not a second day-in/day-out. A punch with no zone (a site
// without zones, or an unplaced terminal) counts too. Days already rolled up
// by retention fall back to their summary, which has no zone.
//
// Times are device-local wall clock throughout. `punched_at_device` is a
// TIMESTAMP without zone, which Prisma hands back as a Date whose UTC fields
// ARE the local wall time — so every instant here is "local wall time as if
// UTC", and day boundaries are plain Date.UTC midnights.

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
/** attendance_day_summary stores UTC; reports are IST (see api/reports.ts). */
const IST_OFFSET_MINUTES = 330;

export interface Punch {
  at: number; // local wall-clock ms
  direction: "IN" | "OUT";
}

/** A pruned day: only the retention summary survives. Local wall-clock ms. */
export interface DaySummary {
  firstIn: number | null;
  lastOut: number | null;
  workedMinutes: number;
}

export type DayStatus = "P" | "A" | "";

export interface DayResult {
  status: DayStatus;
  inAt: number | null;
  outAt: number | null;
  workedMinutes: number;
}

export const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

/**
 * One person-day from their punches inside that calendar day. A future day
 * is blank. Same pairing as the Attendance report: each IN opens a cycle,
 * the next OUT closes it; an OUT with nothing open, or an IN never closed,
 * adds no time — deliberately unlike eTimeTrackLite, which counts an unclosed
 * IN up to the shift end (confirmed with the client in 0.4.24). Whole minutes.
 */
export function computeDay(day: string, punches: Punch[], today: string, summary?: DaySummary): DayResult {
  if (day > today) return { status: "", inAt: null, outAt: null, workedMinutes: 0 };
  const base = dayStart(day);
  const inDay = punches.filter((p) => p.at >= base && p.at < base + DAY);

  let openIn: number | null = null;
  let inAt: number | null = null;
  let outAt: number | null = null;
  let worked = 0;
  for (const p of inDay) {
    if (p.direction === "IN") {
      openIn ??= p.at;
      inAt ??= p.at;
    } else {
      outAt = p.at;
      if (openIn !== null) worked += p.at - openIn;
      openIn = null;
    }
  }
  let workedMinutes = Math.floor(worked / MINUTE);
  if (inDay.length === 0 && summary) {
    inAt = summary.firstIn;
    outAt = summary.lastOut;
    workedMinutes = summary.workedMinutes;
  }
  return { status: inAt !== null || outAt !== null ? "P" : "A", inAt, outAt, workedMinutes };
}

export interface PersonTotals {
  workMinutes: number;
  present: number;
  absent: number;
  averageMinutes: number;
}

export function totals(days: DayResult[]): PersonTotals {
  const t: PersonTotals = { workMinutes: 0, present: 0, absent: 0, averageMinutes: 0 };
  for (const d of days) {
    if (d.status === "P") t.present++;
    if (d.status === "A") t.absent++;
    t.workMinutes += d.workedMinutes;
  }
  t.averageMinutes = t.present === 0 ? 0 : Math.floor(t.workMinutes / t.present);
  return t;
}

export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = dayStart(from); t <= dayStart(to); t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

// --- loading ---------------------------------------------------------------

export interface MonthlyStatusFilters {
  from: string;
  to: string;
  category?: PersonCategory | undefined;
  companyId?: string | undefined;
  departmentId?: string | undefined;
  search?: string | undefined;
  personId?: string | undefined;
}

export interface PersonMonth {
  esslUserId: string;
  name: string;
  company: string;
  department: string;
  days: DayResult[];
  totals: PersonTotals;
}

export interface MonthlyStatus {
  from: string;
  to: string;
  days: string[];
  people: PersonMonth[];
}

/**
 * Everything for the report in three queries, whatever the head count —
 * never a query per person or per day (hard rule 4).
 */
export async function loadMonthlyStatus(f: MonthlyStatusFilters, today: string): Promise<MonthlyStatus> {
  const days = daysBetween(f.from, f.to);
  const where: Prisma.PersonWhereInput = {
    OR: [{ resignedAt: null }, { resignedAt: { gte: new Date(dayStart(f.from)) } }],
  };
  if (f.personId) where.id = f.personId;
  if (f.category) where.category = f.category;
  if (f.companyId) where.companyId = f.companyId;
  if (f.departmentId) where.departmentId = f.departmentId;
  if (f.search) {
    where.AND = [
      { OR: [{ name: { contains: f.search, mode: "insensitive" } }, { esslUserId: { contains: f.search, mode: "insensitive" } }] },
    ];
  }

  const people = await prisma.person.findMany({
    where,
    select: { id: true, name: true, esslUserId: true, company: { select: { name: true } }, department: { select: { name: true } } },
  });
  const keys = new Set(people.map((p) => p.esslUserId.toUpperCase()));

  // Bounds as strings cast in SQL: a JS Date interpolated against a TIMESTAMP
  // without zone goes through the session zone (see reports/registry.ts).
  const windowFrom = f.from;
  const windowTo = new Date(dayStart(f.to) + DAY).toISOString().slice(0, 10);
  const [punchRows, summaryRows] = await Promise.all([
    prisma.$queryRaw<{ key: string; at: Date; direction: "IN" | "OUT" }[]>`
      SELECT UPPER(p."essl_user_id") AS key, p."punched_at_device" AS at, p."direction"::text AS direction
        FROM "punch_event" p
        LEFT JOIN "zone" z ON z."id" = p."zone_id"
       WHERE p."direction" IS NOT NULL
         AND (p."zone_id" IS NULL OR z."parent_zone_id" IS NULL)
         AND p."punched_at_device" >= ${windowFrom}::timestamp
         AND p."punched_at_device" < ${windowTo}::timestamp
       ORDER BY p."punched_at_device", p."id"`,
    prisma.$queryRaw<{ key: string; day: string; first_in: Date | null; last_out: Date | null; worked: number }[]>`
      SELECT UPPER("essl_user_id") AS key, "local_date"::text AS day, "first_in_utc" AS first_in,
             "last_out_utc" AS last_out, "worked_seconds" AS worked
        FROM "attendance_day_summary"
       WHERE "local_date"::date BETWEEN ${f.from}::date AND ${f.to}::date`,
  ]);

  const punchesBy = new Map<string, Punch[]>();
  for (const r of punchRows) {
    if (!keys.has(r.key)) continue;
    const list = punchesBy.get(r.key) ?? [];
    list.push({ at: r.at.getTime(), direction: r.direction });
    punchesBy.set(r.key, list);
  }
  const toLocal = (d: Date | null) => (d === null ? null : d.getTime() + IST_OFFSET_MINUTES * MINUTE);
  const summaryBy = new Map<string, DaySummary>();
  for (const r of summaryRows) {
    const k = `${r.key}|${r.day.slice(0, 10)}`;
    const prev = summaryBy.get(k);
    summaryBy.set(k, {
      firstIn: prev?.firstIn ?? toLocal(r.first_in),
      lastOut: toLocal(r.last_out) ?? prev?.lastOut ?? null,
      workedMinutes: (prev?.workedMinutes ?? 0) + Math.floor(Number(r.worked) / 60),
    });
  }

  const result = people.map((p): PersonMonth => {
    const key = p.esslUserId.toUpperCase();
    const punches = punchesBy.get(key) ?? [];
    const dayResults = days.map((day) => computeDay(day, punches, today, summaryBy.get(`${key}|${day}`)));
    return {
      esslUserId: p.esslUserId,
      name: p.name,
      company: p.company?.name ?? "No company",
      department: p.department?.name ?? "No department",
      days: dayResults,
      totals: totals(dayResults),
    };
  });
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  result.sort(
    (a, b) =>
      collator.compare(a.company, b.company) ||
      collator.compare(a.department, b.department) ||
      collator.compare(a.esslUserId, b.esslUserId),
  );
  return { from: f.from, to: f.to, days, people: result };
}

import { Prisma } from "@prisma/client";
import type { PermissionKey } from "../services/access.js";
import { prisma } from "../db/index.js";

// The report catalogue (Phase 4 Milestone 20).
//
// Reports are DEFINITIONS in one table, not one route each. Twenty-odd
// bespoke handlers would mean twenty places to get pagination, CSV escaping
// and permission checks subtly different — and the twenty-first report would
// cost the same as the first. Here it costs a definition.
//
// Two things every report in this file must respect:
//
//   1. **Retention.** Raw punches are summarised and deleted after
//      PUNCH_RETENTION_DAYS (Phase 3 M14). Any report about movement must read
//      BOTH punch_event and attendance_day_summary, or it silently starts returning
//      nothing for older dates — a report that quietly loses history is worse
//      than one that refuses to answer.
//   2. **Timestamps.** `punched_at_utc` and friends are TIMESTAMP without
//      time zone. A JS Date interpolated into raw SQL is converted through the
//      session zone; that has produced a five-and-a-half-hour skew twice in
//      this codebase. Dates arrive here as YYYY-MM-DD strings and are compared
//      against DATE(...) expressions, which sidesteps it entirely.

export interface ReportFilters {
  from?: string | undefined;
  to?: string | undefined;
  personId?: string | undefined;
  deviceId?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  companyId?: string | undefined;
  departmentId?: string | undefined;
  category?: "EMPLOYEE" | "VISITOR" | undefined;
}

export type FilterName = "dateRange" | "person" | "device" | "actor" | "action" | "company" | "department" | "category";

export interface ReportColumn {
  key: string;
  label: string;
}

export interface ReportDef {
  key: string;
  title: string;
  description: string;
  group: "Movement" | "People" | "Exceptions" | "Operations";
  permission: PermissionKey;
  filters: FilterName[];
  columns: ReportColumn[];
  /** The rows, before paging. Ordering belongs here. */
  base: (f: ReportFilters) => Prisma.Sql;
}

// --- filter fragments ------------------------------------------------------
// `Prisma.empty` when unset, so an unfiltered report is a plain query rather
// than one wrapped in tautologies.

const dateAtLeast = (col: Prisma.Sql, from?: string) =>
  from ? Prisma.sql`AND ${col} >= ${from}::date` : Prisma.empty;
const dateAtMost = (col: Prisma.Sql, to?: string) =>
  to ? Prisma.sql`AND ${col} <= ${to}::date` : Prisma.empty;
const eqPerson = (col: Prisma.Sql, id?: string) =>
  id ? Prisma.sql`AND ${col} = ${id}` : Prisma.empty;
const eqDevice = (col: Prisma.Sql, id?: string) =>
  id ? Prisma.sql`AND ${col} = ${id}` : Prisma.empty;
const eqValue = (col: Prisma.Sql, value?: string) => value ? Prisma.sql`AND ${col} = ${value}` : Prisma.empty;

// "system" is the absence of an actor, not a value in app_user — a scheduled
// job has nobody behind it. Filtering for it has to mean IS NULL, or the one
// case worth isolating (what ran unattended) returns nothing.
const eqActor = (col: Prisma.Sql, id?: string) =>
  id === undefined
    ? Prisma.empty
    : id === "system"
      ? Prisma.sql`AND ${col} IS NULL`
      : Prisma.sql`AND ${col} = ${id}`;
const eqAction = (col: Prisma.Sql, action?: string) =>
  action ? Prisma.sql`AND ${col} = ${action}` : Prisma.empty;

// Database audit/application timestamps are UTC. Report date filters are
// calendar dates entered by Indian operators, so apply the same IST boundary
// used when those timestamps are displayed and exported.
const istDate = (col: Prisma.Sql) => Prisma.sql`DATE(${col} + INTERVAL '5 hours 30 minutes')`;

/**
 * Every movement day this installation can still account for.
 *
 * Raw punches and pruned summaries are ADDED rather than preferred one over
 * the other: retention can summarise part of a day and leave the rest raw
 * (the batch boundary does not respect midnight), so either source alone
 * undercounts. Adding is correct in every case, including no overlap at all.
 */
const movementDays = (f: ReportFilters) => Prisma.sql`
  SELECT pin, device_id, day,
         SUM(punches)::int AS punches,
         SUM(ins)::int     AS ins,
         SUM(outs)::int    AS outs,
         MIN(first_utc)    AS first_utc,
         MAX(last_utc)     AS last_utc
    FROM (
      SELECT p."essl_user_id" AS pin,
             p."device_id",
             DATE(p."punched_at_device") AS day,
             COUNT(*) AS punches,
             COUNT(*) FILTER (WHERE p."direction" = 'IN'::"PunchDirection")  AS ins,
             COUNT(*) FILTER (WHERE p."direction" = 'OUT'::"PunchDirection") AS outs,
             MIN(p."punched_at_utc") AS first_utc,
             MAX(p."punched_at_utc") AS last_utc
        FROM "punch_event" p
        JOIN "device" d ON d."id" = p."device_id"
       WHERE TRUE
         ${dateAtLeast(Prisma.sql`DATE(p."punched_at_device")`, f.from)}
         ${dateAtMost(Prisma.sql`DATE(p."punched_at_device")`, f.to)}
         ${eqDevice(Prisma.sql`p."device_id"`, f.deviceId)}
       GROUP BY 1, 2, 3
      UNION ALL
      SELECT s."essl_user_id", s."device_ids"[1], s."local_date"::date,
             s."punch_count", s."in_count", s."out_count",
             s."first_in_utc", s."last_out_utc"
        FROM "attendance_day_summary" s
       WHERE TRUE
         ${dateAtLeast(Prisma.sql`s."local_date"::date`, f.from)}
         ${dateAtMost(Prisma.sql`s."local_date"::date`, f.to)}
         ${f.deviceId ? Prisma.sql`AND ${f.deviceId} = ANY(s."device_ids")` : Prisma.empty}
    ) merged
   GROUP BY 1, 2, 3
`;

const PERSON_COLS: ReportColumn[] = [
  { key: "person", label: "Person" },
  { key: "company", label: "Company" },
  { key: "pin", label: "PIN" },
];

export const REPORTS: ReportDef[] = [
  // ------------------------------------------------------------------ movement
  {
    key: "attendance",
    title: "Attendance",
    description: "Daily attendance with paired IN/OUT work duration. Use Today, Week, Month, or a custom date range in the report screen.",
    group: "Movement",
    permission: "reports:view",
    filters: ["dateRange", "person", "device", "company", "department", "category"],
    columns: [
      { key: "day", label: "Date" },
      { key: "person", label: "Person" },
      { key: "pin", label: "ID" },
      { key: "category", label: "Category" },
      { key: "company", label: "Company" },
      { key: "department", label: "Department" },
      { key: "first_in_utc", label: "First IN" },
      { key: "last_out_utc", label: "Last OUT" },
      { key: "worked_seconds", label: "Worked seconds" },
      { key: "ins", label: "IN" },
      { key: "outs", label: "OUT" },
      { key: "punches", label: "Punches" },
      { key: "unmatched", label: "Unmatched" },
      { key: "quality", label: "Quality" },
    ],
    base: (f) => Prisma.sql`
      WITH directed AS (
        SELECT p."essl_user_id" AS pin, DATE(p."punched_at_device") AS day,
               p."device_id", p."punched_at_utc", p."direction",
               COUNT(*) FILTER (WHERE p."direction" = 'OUT'::"PunchDirection") OVER (
                 PARTITION BY UPPER(p."essl_user_id"), DATE(p."punched_at_device")
                 ORDER BY p."punched_at_utc", p."id"
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ) AS cycle
          FROM "punch_event" p
         WHERE p."direction" IS NOT NULL
           ${dateAtLeast(Prisma.sql`DATE(p."punched_at_device")`, f.from)}
           ${dateAtMost(Prisma.sql`DATE(p."punched_at_device")`, f.to)}
           ${eqDevice(Prisma.sql`p."device_id"`, f.deviceId)}
      ), cycles AS (
        SELECT pin, day, cycle,
               ARRAY_AGG(DISTINCT "device_id") AS device_ids,
               MIN("punched_at_utc") FILTER (WHERE "direction" = 'IN'::"PunchDirection") AS first_in,
               MIN("punched_at_utc") FILTER (WHERE "direction" = 'OUT'::"PunchDirection") AS out_at,
               COUNT(*) FILTER (WHERE "direction" = 'IN'::"PunchDirection")::int AS ins,
               COUNT(*) FILTER (WHERE "direction" = 'OUT'::"PunchDirection")::int AS outs
          FROM directed
         GROUP BY pin, day, cycle
      ), raw_devices AS (
        SELECT pin, day, ARRAY_AGG(DISTINCT device_id) AS device_ids
          FROM directed
         GROUP BY pin, day
      ), raw_counts AS (
        SELECT pin, day,
               MIN(first_in) AS first_in_utc, MAX(out_at) AS last_out_utc,
               COALESCE(SUM(EXTRACT(EPOCH FROM (out_at - first_in))) FILTER (WHERE first_in IS NOT NULL AND out_at IS NOT NULL), 0)::int AS worked_seconds,
               SUM(ins)::int AS ins, SUM(outs)::int AS outs, SUM(ins + outs)::int AS punches,
               SUM(GREATEST(ins - CASE WHEN out_at IS NULL THEN 0 ELSE 1 END, 0)
                 + GREATEST(outs - CASE WHEN first_in IS NULL THEN 0 ELSE 1 END, 0))::int AS unmatched,
               'EXACT'::text AS quality
          FROM cycles GROUP BY pin, day
      ), raw_days AS (
        SELECT c.pin, c.day, d.device_ids, c.first_in_utc, c.last_out_utc,
               c.worked_seconds, c.ins, c.outs, c.punches, c.unmatched, c.quality
          FROM raw_counts c
          JOIN raw_devices d ON UPPER(d.pin) = UPPER(c.pin) AND d.day = c.day
      ), all_days AS (
        SELECT * FROM raw_days
        UNION ALL
        SELECT s."essl_user_id", s."local_date"::date, s."device_ids", s."first_in_utc", s."last_out_utc",
               s."worked_seconds", s."in_count", s."out_count", s."punch_count",
               s."unmatched_in" + s."unmatched_out", s."quality"::text
          FROM "attendance_day_summary" s
         WHERE TRUE
           ${dateAtLeast(Prisma.sql`s."local_date"::date`, f.from)}
           ${dateAtMost(Prisma.sql`s."local_date"::date`, f.to)}
           ${f.deviceId ? Prisma.sql`AND ${f.deviceId} = ANY(s."device_ids")` : Prisma.empty}
      )
      SELECT a.day, p."id" AS person_id, p."name" AS person, a.pin,
             p."category", c."name" AS company, d."name" AS department,
             MIN(a.first_in_utc) AS first_in_utc, MAX(a.last_out_utc) AS last_out_utc,
             SUM(a.worked_seconds)::int AS worked_seconds, SUM(a.ins)::int AS ins,
             SUM(a.outs)::int AS outs, SUM(a.punches)::int AS punches,
             SUM(a.unmatched)::int AS unmatched,
             CASE WHEN BOOL_AND(a.quality = 'EXACT') THEN 'EXACT' ELSE 'LEGACY_COUNTS_ONLY' END AS quality
        FROM all_days a
        LEFT JOIN "person" p ON UPPER(p."essl_user_id") = UPPER(a.pin)
        LEFT JOIN "company" c ON c."id" = p."company_id"
        LEFT JOIN "department" d ON d."id" = p."department_id"
       WHERE TRUE
         ${eqPerson(Prisma.sql`p."id"`, f.personId)}
         ${eqValue(Prisma.sql`p."company_id"`, f.companyId)}
         ${eqValue(Prisma.sql`p."department_id"`, f.departmentId)}
         ${eqValue(Prisma.sql`p."category"::text`, f.category)}
       GROUP BY a.day, p."id", p."name", a.pin, p."category", c."name", d."name"
       ORDER BY a.day DESC, p."name" ASC NULLS LAST`,
  },
  {
    key: "daily-movement",
    title: "Daily movement log",
    description:
      "Who was on site each day, when they first arrived and last left, and how many crossings in each direction. Reads pruned summaries as well as raw punches, so it keeps answering for dates whose detail has been rotated away.",
    group: "Movement",
    permission: "reports:view",
    filters: ["dateRange", "person", "device"],
    columns: [
      { key: "day", label: "Date" },
      ...PERSON_COLS,
      { key: "device", label: "Device" },
      { key: "first_utc", label: "First seen" },
      { key: "last_utc", label: "Last seen" },
      { key: "ins", label: "In" },
      { key: "outs", label: "Out" },
      { key: "punches", label: "Punches" },
    ],
    base: (f) => Prisma.sql`
      SELECT m.day, v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), m.pin,
             COALESCE(d."name", d."serial_no") AS device, m.first_utc, m.last_utc, m.ins, m.outs, m.punches
        FROM (${movementDays(f)}) m
        LEFT JOIN "person" v ON UPPER(v."essl_user_id") = UPPER(m.pin)
        JOIN "device" d ON d."id" = m.device_id
       WHERE TRUE ${eqPerson(Prisma.sql`v."id"`, f.personId)}
       ORDER BY m.day DESC, v."name" ASC NULLS LAST`,
  },
  {
    key: "on-site-now",
    title: "On site now",
    description: "Everyone currently inside, and since when.",
    group: "Movement",
    permission: "reports:view",
    filters: ["person"],
    columns: [
      ...PERSON_COLS,
      { key: "in_at", label: "Entered" },
      { key: "purpose_of_visit", label: "Purpose" },
      { key: "entry_mode", label: "Mode" },
      { key: "retention_expires_at", label: "Window closes" },
    ],
    base: (f) => Prisma.sql`
      SELECT v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), v."essl_user_id" AS pin,
             e."in_at", e."purpose_of_visit", e."entry_mode", e."retention_expires_at"
        FROM "entry" e
        JOIN "person" v ON v."id" = e."person_id"
       WHERE e."state" = 'INSIDE'::"EntryState"
         ${eqPerson(Prisma.sql`v."id"`, f.personId)}
       ORDER BY e."in_at" ASC NULLS LAST`,
  },
  {
    key: "time-on-site",
    title: "Time on site",
    description:
      "How long each visit lasted, from first crossing to last on that day. A day with no OUT shows no duration rather than a guess — the terminal can suppress a repeat punch, so an absent exit is not evidence of a long stay.",
    group: "Movement",
    permission: "reports:view",
    filters: ["dateRange", "person", "device"],
    columns: [
      { key: "day", label: "Date" },
      ...PERSON_COLS,
      { key: "first_utc", label: "First seen" },
      { key: "last_utc", label: "Last seen" },
      { key: "minutes", label: "Minutes on site" },
    ],
    base: (f) => Prisma.sql`
      SELECT m.day, v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), m.pin,
             m.first_utc, m.last_utc,
             CASE WHEN m.outs > 0
                  THEN ROUND(EXTRACT(EPOCH FROM (m.last_utc - m.first_utc)) / 60)::int
                  ELSE NULL END AS minutes
        FROM (${movementDays(f)}) m
        LEFT JOIN "person" v ON UPPER(v."essl_user_id") = UPPER(m.pin)
       WHERE TRUE ${eqPerson(Prisma.sql`v."id"`, f.personId)}
       ORDER BY m.day DESC, minutes DESC NULLS LAST`,
  },
  {
    key: "busiest-days",
    title: "Busiest days",
    description: "Distinct people on site per day, and total crossings.",
    group: "Movement",
    permission: "reports:view",
    filters: ["dateRange", "device"],
    columns: [
      { key: "day", label: "Date" },
      { key: "people", label: "People" },
      { key: "punches", label: "Crossings" },
    ],
    base: (f) => Prisma.sql`
      SELECT m.day, COUNT(DISTINCT m.pin)::int AS people, SUM(m.punches)::int AS punches
        FROM (${movementDays(f)}) m
       GROUP BY m.day
       ORDER BY people DESC, m.day DESC`,
  },
  // ------------------------------------------------------------------- people
  {
    key: "person-register",
    title: "Person register",
    description: "Every person ever registered. The permanent record — nothing is deleted from it.",
    group: "People",
    permission: "reports:view",
    filters: ["person"],
    columns: [
      ...PERSON_COLS,
      { key: "mobile", label: "Mobile" },
      { key: "has_photo", label: "Photo" },
      { key: "is_active", label: "Active" },
      { key: "created_at", label: "Registered" },
    ],
    base: (f) => Prisma.sql`
      SELECT v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), v."essl_user_id" AS pin,
             v."mobile", (b."id" IS NOT NULL) AS has_photo, v."is_active", v."created_at"
        FROM "person" v
        LEFT JOIN "person_biometric" b ON b."person_id" = v."id"
       WHERE TRUE ${eqPerson(Prisma.sql`v."id"`, f.personId)}
       ORDER BY v."created_at" DESC`,
  },
  {
    key: "resigned-employees",
    title: "Resigned employees",
    description: "Employees who were resigned by an administrator and removed from every assigned device.",
    group: "People",
    permission: "reports:view",
    filters: ["dateRange", "person", "company", "department"],
    columns: [
      { key: "resigned_at", label: "Resigned" },
      { key: "person", label: "Employee" },
      { key: "pin", label: "Employee ID" },
      { key: "company", label: "Company" },
      { key: "department", label: "Department" },
      { key: "mobile", label: "Mobile" },
      { key: "reason", label: "Reason" },
      { key: "resigned_by", label: "Resigned by" },
    ],
    base: (f) => Prisma.sql`
      SELECT p."resigned_at", p."id" AS person_id, p."name" AS person,
             p."essl_user_id" AS pin, c."name" AS company, d."name" AS department,
             p."mobile", p."resigned_reason" AS reason, u."email" AS resigned_by
        FROM "person" p
        LEFT JOIN "company" c ON c."id" = p."company_id"
        LEFT JOIN "department" d ON d."id" = p."department_id"
        LEFT JOIN "app_user" u ON u."id" = p."resigned_by"
       WHERE p."category" = 'EMPLOYEE'::"PersonCategory"
         AND p."resigned_at" IS NOT NULL
         ${dateAtLeast(istDate(Prisma.sql`p."resigned_at"`), f.from)}
         ${dateAtMost(istDate(Prisma.sql`p."resigned_at"`), f.to)}
         ${eqPerson(Prisma.sql`p."id"`, f.personId)}
         ${eqValue(Prisma.sql`p."company_id"`, f.companyId)}
         ${eqValue(Prisma.sql`p."department_id"`, f.departmentId)}
       ORDER BY p."resigned_at" DESC`,
  },
  {
    key: "authorizations",
    title: "Authorizations issued",
    description:
      "Who authorized whom, when, for how long, in which entry mode, and why. Provisioning IS the authorization decision, so this is the record of who let each person through — filter by person, by date range, or both. Entries are never pruned, so it answers for any date the system has been running.",
    group: "People",
    permission: "reports:view",
    filters: ["dateRange", "person"],
    columns: [
      { key: "created_at", label: "Authorized" },
      ...PERSON_COLS,
      { key: "authorized_by", label: "By" },
      { key: "purpose_of_visit", label: "Purpose" },
      { key: "retention_policy", label: "Window" },
      { key: "retention_expires_at", label: "Closes" },
      { key: "entry_mode", label: "Mode" },
      { key: "state", label: "State" },
    ],
    base: (f) => Prisma.sql`
      SELECT e."created_at", v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"),
             v."essl_user_id" AS pin, u."email" AS authorized_by, e."purpose_of_visit",
             e."retention_policy",
             e."retention_expires_at", e."entry_mode", e."state"
        FROM "entry" e
        JOIN "person" v ON v."id" = e."person_id"
        LEFT JOIN "app_user" u ON u."id" = e."authorized_by"
       WHERE TRUE
         ${dateAtLeast(istDate(Prisma.sql`e."created_at"`), f.from)}
         ${dateAtMost(istDate(Prisma.sql`e."created_at"`), f.to)}
         ${eqPerson(Prisma.sql`v."id"`, f.personId)}
       ORDER BY e."created_at" DESC`,
  },
  {
    key: "active-authorizations",
    title: "Currently authorized",
    description: "People loaded on a device right now, and when their window closes.",
    group: "People",
    permission: "reports:view",
    filters: ["person"],
    columns: [
      ...PERSON_COLS,
      { key: "state", label: "State" },
      { key: "purpose_of_visit", label: "Purpose" },
      { key: "day_blocked", label: "Blocked today" },
      { key: "retention_expires_at", label: "Window closes" },
    ],
    base: (f) => Prisma.sql`
      SELECT v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), v."essl_user_id" AS pin,
             e."state", e."purpose_of_visit", e."day_blocked", e."retention_expires_at"
        FROM "entry" e
        JOIN "person" v ON v."id" = e."person_id"
       WHERE e."state" IN ('PROVISIONED'::"EntryState", 'INSIDE'::"EntryState")
         ${eqPerson(Prisma.sql`v."id"`, f.personId)}
       ORDER BY e."retention_expires_at" ASC NULLS LAST`,
  },
  {
    key: "expiring-soon",
    title: "Expiring soon",
    description:
      "Windows closing within 24 hours. The sweeper removes these automatically; the list is for anyone who wants to extend one first.",
    group: "People",
    permission: "reports:view",
    filters: [],
    columns: [
      ...PERSON_COLS,
      { key: "state", label: "State" },
      { key: "retention_expires_at", label: "Closes" },
    ],
    base: () => Prisma.sql`
      SELECT v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), v."essl_user_id" AS pin,
             e."state", e."retention_expires_at"
        FROM "entry" e
        JOIN "person" v ON v."id" = e."person_id"
       WHERE e."state" IN ('PROVISIONED'::"EntryState", 'INSIDE'::"EntryState")
         AND e."retention_expires_at" IS NOT NULL
         AND e."retention_expires_at" <= (NOW() AT TIME ZONE 'UTC') + INTERVAL '24 hours'
       ORDER BY e."retention_expires_at" ASC`,
  },
  {
    key: "never-visited",
    title: "Authorized but never arrived",
    description:
      "People provisioned onto a device who never punched. Each one occupies a face slot on hardware that holds 3,000.",
    group: "People",
    permission: "reports:view",
    filters: ["dateRange"],
    columns: [
      { key: "created_at", label: "Authorized" },
      ...PERSON_COLS,
      { key: "state", label: "State" },
    ],
    base: (f) => Prisma.sql`
      SELECT e."created_at", v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"),
             v."essl_user_id" AS pin, e."state"
        FROM "entry" e
        JOIN "person" v ON v."id" = e."person_id"
       WHERE NOT EXISTS (SELECT 1 FROM "punch_event" p WHERE p."entry_id" = e."id")
         ${dateAtLeast(istDate(Prisma.sql`e."created_at"`), f.from)}
         ${dateAtMost(istDate(Prisma.sql`e."created_at"`), f.to)}
       ORDER BY e."created_at" DESC`,
  },
  {
    key: "frequent-visitors",
    title: "Frequent visitors",
    description: "Days on site per person, most frequent first.",
    group: "People",
    permission: "reports:view",
    filters: ["dateRange", "device"],
    columns: [
      ...PERSON_COLS,
      { key: "days", label: "Days on site" },
      { key: "punches", label: "Crossings" },
      { key: "last_seen", label: "Last seen" },
    ],
    base: (f) => Prisma.sql`
      SELECT v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), m.pin,
             COUNT(DISTINCT m.day)::int AS days,
             SUM(m.punches)::int AS punches,
             MAX(m.last_utc) AS last_seen
        FROM (${movementDays(f)}) m
        LEFT JOIN "person" v ON UPPER(v."essl_user_id") = UPPER(m.pin)
       GROUP BY v."id", v."name", (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), m.pin
       ORDER BY days DESC, punches DESC`,
  },
  // ---------------------------------------------------------------- exceptions
  {
    key: "overdue-inside",
    title: "Inside past their window",
    description:
      "Windows that closed while the person was still on site. They are deliberately not removed — taking a credential away mid-visit would strand someone at the exit — so removal waits for their OUT punch.",
    group: "Exceptions",
    permission: "reports:view",
    filters: ["person"],
    columns: [
      ...PERSON_COLS,
      { key: "in_at", label: "Entered" },
      { key: "purpose_of_visit", label: "Purpose" },
      { key: "retention_expires_at", label: "Window closed" },
      { key: "overdue_minutes", label: "Overdue (min)" },
    ],
    base: (f) => Prisma.sql`
      SELECT v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), v."essl_user_id" AS pin,
             e."in_at", e."purpose_of_visit", e."retention_expires_at",
             ROUND(EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - e."retention_expires_at")) / 60)::int
               AS overdue_minutes
        FROM "entry" e
        JOIN "person" v ON v."id" = e."person_id"
       WHERE e."state" = 'INSIDE'::"EntryState"
         AND e."retention_expires_at" IS NOT NULL
         AND e."retention_expires_at" <= (NOW() AT TIME ZONE 'UTC')
         ${eqPerson(Prisma.sql`v."id"`, f.personId)}
       ORDER BY e."retention_expires_at" ASC`,
  },
  {
    key: "no-exit",
    title: "Arrived without leaving",
    description:
      "Days with an entry and no exit. Often a genuinely missed punch-out — but the terminal also drops a repeat punch by the same person inside its duplicate window, so an absent exit is not proof anyone is still there.",
    group: "Exceptions",
    permission: "reports:view",
    filters: ["dateRange", "person", "device"],
    columns: [
      { key: "day", label: "Date" },
      ...PERSON_COLS,
      { key: "first_utc", label: "Entered" },
      { key: "ins", label: "In" },
      { key: "outs", label: "Out" },
    ],
    base: (f) => Prisma.sql`
      SELECT m.day, v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), m.pin,
             m.first_utc, m.ins, m.outs
        FROM (${movementDays(f)}) m
        LEFT JOIN "person" v ON UPPER(v."essl_user_id") = UPPER(m.pin)
       WHERE m.ins > 0 AND m.outs = 0
         ${eqPerson(Prisma.sql`v."id"`, f.personId)}
       ORDER BY m.day DESC`,
  },
  {
    key: "day-blocked",
    title: "Single-entry blocks",
    description:
      "People currently blocked for the day after using their single entry. The daily reset releases them; they remain loaded on the device and recognised by it, then denied.",
    group: "Exceptions",
    permission: "reports:view",
    filters: ["person"],
    columns: [
      ...PERSON_COLS,
      { key: "out_at", label: "Left at" },
      { key: "state", label: "State" },
      { key: "retention_expires_at", label: "Window closes" },
    ],
    base: (f) => Prisma.sql`
      SELECT v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"), v."essl_user_id" AS pin,
             e."out_at", e."state", e."retention_expires_at"
        FROM "entry" e
        JOIN "person" v ON v."id" = e."person_id"
       WHERE e."day_blocked" = TRUE
         ${eqPerson(Prisma.sql`v."id"`, f.personId)}
       ORDER BY e."out_at" DESC NULLS LAST`,
  },
  {
    key: "reconciliation",
    title: "Reconciliation events",
    description:
      "Drift between the database and a terminal — what was found, and what was corrected automatically. A person still loaded after their authorization ended is the case this exists to catch.",
    group: "Exceptions",
    permission: "reports:view",
    filters: ["dateRange"],
    columns: [
      { key: "created_at", label: "When" },
      { key: "action", label: "Event" },
      { key: "detail", label: "Detail" },
    ],
    base: (f) => Prisma.sql`
      SELECT a."created_at", a."action", a."detail"
        FROM "audit_log" a
       WHERE a."action" IN ('RECONCILE_DRIFT_FOUND', 'RECONCILE_HEALED')
         ${dateAtLeast(istDate(Prisma.sql`a."created_at"`), f.from)}
         ${dateAtMost(istDate(Prisma.sql`a."created_at"`), f.to)}
       ORDER BY a."created_at" DESC`,
  },
  {
    key: "direction-conflicts",
    title: "Direction conflicts",
    description:
      "Punches whose status code contradicted the gate they arrived at. The gate's role wins, but a run of these means a terminal is configured as the wrong direction.",
    group: "Exceptions",
    permission: "reports:view",
    filters: ["dateRange"],
    columns: [
      { key: "created_at", label: "When" },
      { key: "detail", label: "Detail" },
    ],
    base: (f) => Prisma.sql`
      SELECT a."created_at", a."detail"
        FROM "audit_log" a
       WHERE a."action" = 'PUNCH_DIRECTION_CONFLICT'
         ${dateAtLeast(istDate(Prisma.sql`a."created_at"`), f.from)}
         ${dateAtMost(istDate(Prisma.sql`a."created_at"`), f.to)}
       ORDER BY a."created_at" DESC`,
  },
  // ---------------------------------------------------------------- operations
  {
    key: "command-history",
    title: "Device command history",
    description:
      "Every write sent to a terminal, with its outcome and how long it took to be collected.",
    group: "Operations",
    permission: "reports:view",
    filters: ["dateRange", "person", "device"],
    columns: [
      { key: "created_at", label: "Queued" },
      { key: "type", label: "Command" },
      { key: "status", label: "Status" },
      { key: "person", label: "Person" },
      { key: "device", label: "Device" },
      { key: "initiated_by", label: "By" },
      { key: "seconds_to_complete", label: "Seconds" },
      { key: "last_error", label: "Error" },
    ],
    base: (f) => Prisma.sql`
      SELECT c."created_at", c."type", c."status", v."id" AS person_id, v."name" AS person,
             COALESCE(d."name", d."serial_no") AS device,
             COALESCE(u."email", 'system') AS initiated_by,
             CASE WHEN c."completed_at" IS NOT NULL
                  THEN ROUND(EXTRACT(EPOCH FROM (c."completed_at" - c."created_at")))::int
                  ELSE NULL END AS seconds_to_complete,
             c."last_error"
        FROM "sync_command" c
        JOIN "device" d ON d."id" = c."target_device_id"
        LEFT JOIN "person" v ON v."id" = c."person_id"
        LEFT JOIN "app_user" u ON u."id" = c."initiated_by"
       WHERE TRUE
         ${dateAtLeast(istDate(Prisma.sql`c."created_at"`), f.from)}
         ${dateAtMost(istDate(Prisma.sql`c."created_at"`), f.to)}
         ${eqPerson(Prisma.sql`v."id"`, f.personId)}
         ${eqDevice(Prisma.sql`c."target_device_id"`, f.deviceId)}
       ORDER BY c."created_at" DESC`,
  },
  {
    key: "failed-commands",
    title: "Failed commands",
    description:
      "Changes that never reached a terminal. Each one means the device and the database disagree about somebody's access until it is dealt with.",
    group: "Operations",
    permission: "reports:view",
    filters: ["device"],
    columns: [
      { key: "created_at", label: "Queued" },
      { key: "type", label: "Command" },
      { key: "person", label: "Person" },
      { key: "device", label: "Device" },
      { key: "attempts", label: "Attempts" },
      { key: "last_error", label: "Error" },
    ],
    base: (f) => Prisma.sql`
      SELECT c."created_at", c."type", v."id" AS person_id, v."name" AS person,
             COALESCE(d."name", d."serial_no") AS device, c."attempts", c."last_error"
        FROM "sync_command" c
        JOIN "device" d ON d."id" = c."target_device_id"
        LEFT JOIN "person" v ON v."id" = c."person_id"
       WHERE c."status" = 'FAILED'::"CommandStatus"
         ${eqDevice(Prisma.sql`c."target_device_id"`, f.deviceId)}
       ORDER BY c."created_at" DESC`,
  },
  {
    key: "audit-trail",
    title: "Audit trail",
    description: "Every recorded action, by whom, against what.",
    group: "Operations",
    permission: "audit:view",
    filters: ["dateRange", "actor", "action"],
    columns: [
      { key: "created_at", label: "When" },
      { key: "actor", label: "Actor" },
      { key: "action", label: "Action" },
      { key: "entity_type", label: "Entity" },
      { key: "entity_id", label: "Id" },
      { key: "detail", label: "Detail" },
    ],
    base: (f) => Prisma.sql`
      SELECT a."created_at", COALESCE(u."email", 'system') AS actor, a."action",
             a."entity_type",
             CASE WHEN a."entity_type" = 'license' THEN 'hidden' ELSE a."entity_id" END AS entity_id,
             a."detail"
        FROM "audit_log" a
        LEFT JOIN "app_user" u ON u."id" = a."actor_id"
       WHERE TRUE
         ${dateAtLeast(istDate(Prisma.sql`a."created_at"`), f.from)}
         ${dateAtMost(istDate(Prisma.sql`a."created_at"`), f.to)}
         ${eqActor(Prisma.sql`a."actor_id"`, f.actorId)}
         ${eqAction(Prisma.sql`a."action"`, f.action)}
       ORDER BY a."created_at" DESC`,
  },
  {
    key: "permission-denials",
    title: "Refused actions",
    description:
      "Operators attempting something their role does not allow. A misconfigured role and someone probing look identical here; both are worth knowing about.",
    group: "Operations",
    permission: "audit:view",
    filters: ["dateRange", "actor"],
    columns: [
      { key: "created_at", label: "When" },
      { key: "actor", label: "Operator" },
      { key: "detail", label: "Attempted" },
    ],
    base: (f) => Prisma.sql`
      SELECT a."created_at", COALESCE(u."email", 'unknown') AS actor, a."detail"
        FROM "audit_log" a
        LEFT JOIN "app_user" u ON u."id" = a."actor_id"
       WHERE a."action" = 'PERMISSION_DENIED'
         ${dateAtLeast(istDate(Prisma.sql`a."created_at"`), f.from)}
         ${dateAtMost(istDate(Prisma.sql`a."created_at"`), f.to)}
         ${eqActor(Prisma.sql`a."actor_id"`, f.actorId)}
       ORDER BY a."created_at" DESC`,
  },
  {
    key: "retention-activity",
    title: "Retention activity",
    description:
      "Movement days that have been summarised and had their raw punches deleted. The DPDP answer to “what do you still hold, and for how long”.",
    group: "Operations",
    permission: "reports:view",
    filters: ["dateRange"],
    columns: [
      { key: "local_date", label: "Date" },
      ...PERSON_COLS,
      { key: "punch_count", label: "Punches kept as counts" },
      { key: "created_at", label: "Summarised" },
    ],
    base: (f) => Prisma.sql`
      SELECT s."local_date", v."id" AS person_id, v."name" AS person, (SELECT c."name" FROM "company" c WHERE c."id" = v."company_id"),
             s."essl_user_id" AS pin, s."punch_count", s."created_at"
        FROM "attendance_day_summary" s
        LEFT JOIN "person" v ON v."id" = s."person_id"
       WHERE TRUE
         ${dateAtLeast(Prisma.sql`s."local_date"::date`, f.from)}
         ${dateAtMost(Prisma.sql`s."local_date"::date`, f.to)}
       ORDER BY s."local_date" DESC`,
  },
];

export function findReport(key: string): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key);
}

export interface ReportPage {
  total: number;
  page: number;
  pageSize: number;
  rows: Record<string, unknown>[];
}

/**
 * Run a report.
 *
 * The definition supplies the rows and their order; paging and counting are
 * applied here so every report gets them identically. Two queries: the page
 * and the count.
 */
export async function runReport(
  def: ReportDef,
  filters: ReportFilters,
  page: number,
  pageSize: number,
): Promise<ReportPage> {
  const base = def.base(filters);
  const offset = (page - 1) * pageSize;

  const [rows, counted] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`SELECT * FROM (${base}) r LIMIT ${pageSize} OFFSET ${offset}`,
    ),
    prisma.$queryRaw<{ n: bigint }[]>(
      Prisma.sql`SELECT COUNT(*)::bigint AS n FROM (${base}) r`,
    ),
  ]);

  return { total: Number(counted[0]?.n ?? 0), page, pageSize, rows };
}

/** Every row, for export. Bounded — see the caller. */
export async function runReportAll(
  def: ReportDef,
  filters: ReportFilters,
  limit: number,
): Promise<Record<string, unknown>[]> {
  return prisma.$queryRaw<Record<string, unknown>[]>(
    Prisma.sql`SELECT * FROM (${def.base(filters)}) r LIMIT ${limit}`,
  );
}

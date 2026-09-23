import { createHash } from "node:crypto";
import { parseUserId } from "../user-id.js";

// Pure parsers for the ADMS/PUSH wire formats, as verified on real hardware
// (ZAM180_TFT / FW 3.4.10 / Push 2.0.33S — see VMS_PROJECT_CONTEXT.md §4).
// Every fixture in parsers.test.ts is a genuine captured payload; if a parser
// and a fixture disagree, the fixture wins.
//
// Format rules that bit us in Phase 0 and are load-bearing here:
//   - Fields are TAB-separated. Names may contain spaces, so never split on
//     whitespace.
//   - Values may contain '=' (base64 padding in Tmp/Content) — always split
//     key from value on the FIRST '=' only.
//   - The first token of a record line is "TYPE FIRSTKEY=..." — type and
//     first field share one tab-separated cell, separated by a space.
//   - Timestamps are DEVICE LOCAL time, not UTC.

// ---------------------------------------------------------------------------
// Generic key=value record (USER / BIOPHOTO / BIODATA / OPLOG ...)
// ---------------------------------------------------------------------------

export interface KvRecord {
  type: string | null;
  fields: Record<string, string>;
}

export function parseKvRecord(line: string): KvRecord | null {
  const parts = line
    .replace(/\r$/, "")
    .split("\t")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const fields: Record<string, string> = {};
  let type: string | null = null;

  parts.forEach((part, i) => {
    if (i === 0) {
      const sp = part.indexOf(" ");
      if (sp > -1 && !part.slice(0, sp).includes("=")) {
        type = part.slice(0, sp);
        part = part.slice(sp + 1).trim();
      }
    }
    const eq = part.indexOf("=");
    if (eq > -1) fields[part.slice(0, eq).trim()] = part.slice(eq + 1);
  });

  return { type, fields };
}

// ---------------------------------------------------------------------------
// ATTLOG — punches. Tab-separated positional fields, no key=value.
//   9001 <TAB> 2026-07-28 22:40:21 <TAB> 1 <TAB> 15 <TAB> 0 ...
// ---------------------------------------------------------------------------

export interface AttlogRecord {
  pin: string;
  /** As sent by the device — device-local wall time, format YYYY-MM-DD HH:MM:SS. */
  timestampRaw: string;
  statusCode: number;
  verifyMode: number;
  workCode: number;
  raw: string;
}

const ATTLOG_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function parseAttlog(line: string): AttlogRecord | null {
  const raw = line.replace(/\r$/, "");
  const parts = raw.split("\t").map((s) => s.trim());
  if (parts.length < 2) return null;

  // Text, not a number: `WCTPL070` is a perfectly ordinary user ID on a real
  // roster, and Number() turned every punch by one into NaN and dropped it.
  const pin = parseUserId(parts[0]);
  const timestampRaw = parts[1] ?? "";
  if (pin === null) return null;
  if (!ATTLOG_TS.test(timestampRaw)) return null;

  return {
    pin,
    timestampRaw,
    statusCode: toInt(parts[2]),
    verifyMode: toInt(parts[3]),
    workCode: toInt(parts[4]),
    raw,
  };
}

function toInt(v: string | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// OPLOG (table=OPERLOG) — operation-audit records, positional like ATTLOG,
// not key=value:
//   OPLOG <opcode> <TAB> 0 <TAB> <YYYY-MM-DD HH:MM:SS> <TAB> <subject> <TAB> 0 0 0
//
// `subject` is whatever the operation was about — a PIN for a user-affecting
// operation (enroll, edit), or a bare setting name ("KeyPadBeep", "VoiceOn")
// for a menu toggle that has nothing to do with any user. There is no
// reliable opcode-to-meaning map (VMS_PROJECT_CONTEXT.md §4: "opcodes seen:
// 4, 30, 70, 101, 103 around enroll events" — observed, not documented by
// eSSL, and firmware varies by batch), so this deliberately does not try to
// classify by opcode. It only extracts a PIN when `subject` looks like one;
// the caller decides what a PIN-shaped subject is worth doing.
// ---------------------------------------------------------------------------

export interface OplogRecord {
  opcode: number;
  timestampRaw: string;
  subject: string;
  /** Set when `subject` looks like a user ID rather than a setting name. */
  pin: string | null;
  raw: string;
}

export function parseOplog(line: string): OplogRecord | null {
  const raw = line.replace(/\r$/, "");
  const parts = raw.split("\t").map((s) => s.trim());
  if (parts.length < 4) return null;

  const head = parts[0] ?? "";
  const sp = head.indexOf(" ");
  if (sp === -1 || head.slice(0, sp).toUpperCase() !== "OPLOG") return null;

  const opcode = Number(head.slice(sp + 1));
  if (!Number.isInteger(opcode)) return null;

  const timestampRaw = parts[2] ?? "";
  const subject = parts[3] ?? "";
  // OPLOG's subject is a user ID for a user-affecting operation and a bare
  // setting name ("KeyPadBeep", "VoiceOn") otherwise, with nothing in the
  // record to say which. While IDs were numeric that was self-evident; now
  // that they are text, the only signal left is that every user ID observed in
  // the field carries at least one digit (`WCTPL070`, `ye01`, `1001`) while
  // the setting names do not.
  //
  // Wrong in the harmless direction: a purely alphabetic ID is missed HERE and
  // still found by a scan or by its USER record, whereas treating every menu
  // toggle as an enrollment would queue a junk device query for each one.
  const candidate = parseUserId(subject);
  const pin = candidate !== null && /[0-9]/.test(candidate) ? candidate : null;

  return { opcode, timestampRaw, subject, pin, raw };
}

// ---------------------------------------------------------------------------
// USER (table=OPERLOG)
// ---------------------------------------------------------------------------

export interface UserRecord {
  pin: string;
  name: string;
  pri: number;
  grp: number | null;
  tz: string | null;
  verify: number | null;
  startDatetime: string | null;
  endDatetime: string | null;
  raw: string;
}

export function parseUserRecord(line: string): UserRecord | null {
  const rec = parseKvRecord(line);
  if (!rec || rec.type !== "USER") return null;
  const f = rec.fields;
  const pin = parseUserId(f["PIN"] ?? f["Pin"]);
  if (pin === null) return null;
  return {
    pin,
    name: f["Name"] ?? "",
    pri: toInt(f["Pri"]),
    grp: f["Grp"] !== undefined ? toInt(f["Grp"]) : null,
    tz: f["TZ"] ?? null,
    verify: f["Verify"] !== undefined ? toInt(f["Verify"]) : null,
    startDatetime: f["StartDatetime"] ?? null,
    endDatetime: f["EndDatetime"] ?? null,
    raw: line,
  };
}

// ---------------------------------------------------------------------------
// BIOPHOTO (table=OPERLOG) — the durable artifact.
// Size is the BASE64 CHARACTER COUNT, not the decoded byte count.
// ---------------------------------------------------------------------------

export interface BiophotoRecord {
  pin: string;
  fileName: string;
  type: number;
  /** Base64 character count as reported by the device. */
  size: number;
  contentBase64: string;
}

export function parseBiophoto(line: string): BiophotoRecord | null {
  const rec = parseKvRecord(line);
  if (!rec || rec.type !== "BIOPHOTO") return null;
  const f = rec.fields;
  const pin = parseUserId(f["PIN"] ?? f["Pin"]);
  const content = f["Content"];
  if (pin === null || !content) return null;
  return {
    pin,
    fileName: f["FileName"] ?? `${pin}.jpg`,
    type: toInt(f["Type"]),
    size: toInt(f["Size"]),
    contentBase64: content,
  };
}

// ---------------------------------------------------------------------------
// BIODATA (table=BIODATA) — algorithm-bound template, cache only.
// ---------------------------------------------------------------------------

export interface BiodataRecord {
  pin: string;
  type: number;
  majorVer: number;
  minorVer: number;
  templateBase64: string;
}

export function parseBiodata(line: string): BiodataRecord | null {
  const rec = parseKvRecord(line);
  if (!rec || rec.type !== "BIODATA") return null;
  const f = rec.fields;
  const pin = parseUserId(f["Pin"] ?? f["PIN"]);
  const tmp = f["Tmp"];
  if (pin === null || !tmp) return null;
  return {
    pin,
    type: toInt(f["Type"]),
    majorVer: toInt(f["MajorVer"]),
    minorVer: toInt(f["MinorVer"]),
    templateBase64: tmp,
  };
}

// ---------------------------------------------------------------------------
// INFO response — key=value lines (keys may carry a leading '~').
// ---------------------------------------------------------------------------

export function parseDeviceInfoKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.includes("&")) continue; // skip the ID=&Return= reply line
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// devicecmd reply:  ID=<n>&Return=<code>&CMD=<name>
// Return=0 means "processed" — NOT "valid". Never treat it as validation.
// ---------------------------------------------------------------------------

export interface DevicecmdReply {
  id: number | null;
  returnCode: number | null;
  cmd: string | null;
}

export function parseDevicecmdReply(text: string): DevicecmdReply {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const params = new URLSearchParams(firstLine);
  const id = params.get("ID");
  const ret = params.get("Return");
  return {
    id: id !== null && id !== "" ? Number(id) : null,
    returnCode: ret !== null && ret !== "" ? Number(ret) : null,
    cmd: params.get("CMD"),
  };
}

// ---------------------------------------------------------------------------
// Timestamps. The device sends local wall time; the device row carries the
// offset. We store both: the wall time (as a naive timestamp) and true UTC.
// ---------------------------------------------------------------------------

export function deviceTimestamps(
  timestampRaw: string,
  timezoneOffsetMinutes: number,
): { punchedAtDevice: Date; punchedAtUtc: Date } {
  // Interpret the wall time as if it were UTC to get a stable, server-tz-
  // independent representation of "what the device clock read".
  const wallAsUtc = new Date(timestampRaw.replace(" ", "T") + "Z");
  return {
    punchedAtDevice: wallAsUtc,
    punchedAtUtc: new Date(wallAsUtc.getTime() - timezoneOffsetMinutes * 60_000),
  };
}

/** Dedup key: one device re-sending the same ATTLOG line must not double-count. */
export function attlogHash(serialNo: string, rawLine: string): string {
  return createHash("sha256").update(`${serialNo}|${rawLine}`).digest("hex");
}

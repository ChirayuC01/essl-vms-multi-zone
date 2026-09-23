import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attlogHash,
  deviceTimestamps,
  parseAttlog,
  parseBiodata,
  parseBiophoto,
  parseDevicecmdReply,
  parseDeviceInfoKv,
  parseKvRecord,
  parseOplog,
  parseUserRecord,
} from "./parsers.js";

// Fixtures below are genuine payloads captured from the real device in
// Phase 0 (VMS_PROJECT_CONTEXT.md §4.5, PHASE_0_CHECKLIST.md B5/B6). If a
// parser and a fixture disagree, the fixture wins.

const REAL_ATTLOG = "9001\t2026-07-28 22:40:21\t1\t15\t0\t0\t0\t0\t0\t0";

const REAL_USER =
  "USER PIN=9001\tName=TEST ONE\tPri=0\tPasswd=\tCard=\tGrp=1\t" +
  "TZ=0000000100000000\tVerify=-1\tViceCard=\tStartDatetime=0\tEndDatetime=0";

// Content shortened; structure identical to the ~59 KB real record. Note the
// base64 '=' padding — the value itself contains the key/value separator.
const REAL_BIOPHOTO =
  "BIOPHOTO PIN=9001\tFileName=9001.jpg\tType=9\tSize=8\tContent=/9j/4A==";

const REAL_BIODATA =
  "BIODATA Pin=9001\tNo=0\tIndex=0\tValid=1\tDuress=0\tType=9\t" +
  "MajorVer=39\tMinorVer=3\tFormat=0\tTmp=TWFsZm9y bWVkPT0=";

// Captured live (Phase 6 field testing) enrolling a face directly on the
// terminal, bypassing the VMS — no USER/BIOPHOTO record ever arrived for it,
// only this OPLOG line. Second fixture is a menu toggle from the same
// session (VoiceOn/KeyPadBeep), whose subject is not a PIN at all.
const REAL_OPLOG_ENROLL = "OPLOG 103\t0\t2026-08-08 06:38:56\t10000\t0\t0\t0";
const REAL_OPLOG_TOGGLE = "OPLOG 108\t0\t2026-08-08 06:38:34\tKeyPadBeep\t0\t0\t0";

test("parseAttlog decodes the real punch line", () => {
  const rec = parseAttlog(REAL_ATTLOG);
  assert.ok(rec);
  assert.equal(rec.pin, "9001");
  assert.equal(rec.timestampRaw, "2026-07-28 22:40:21");
  assert.equal(rec.statusCode, 1);
  assert.equal(rec.verifyMode, 15); // 15 = face
  assert.equal(rec.workCode, 0);
  assert.equal(rec.raw, REAL_ATTLOG);
});

test("parseAttlog rejects garbage and empty lines", () => {
  assert.equal(parseAttlog(""), null);
  assert.equal(parseAttlog("OPERLOG stuff"), null);
  assert.equal(parseAttlog("9001\tnot-a-timestamp\t1\t15"), null);
  assert.equal(parseAttlog("-5\t2026-07-28 22:40:21\t1\t15"), null);
});

test("parseUserRecord decodes the real USER record", () => {
  const rec = parseUserRecord(REAL_USER);
  assert.ok(rec);
  assert.equal(rec.pin, "9001");
  assert.equal(rec.name, "TEST ONE"); // space inside a value — tab-splitting only
  assert.equal(rec.pri, 0);
  assert.equal(rec.grp, 1);
  assert.equal(rec.tz, "0000000100000000");
  assert.equal(rec.verify, -1);
  assert.equal(rec.startDatetime, "0");
  assert.equal(rec.endDatetime, "0");
});

test("parseBiophoto keeps base64 padding intact (split on first '=' only)", () => {
  const rec = parseBiophoto(REAL_BIOPHOTO);
  assert.ok(rec);
  assert.equal(rec.pin, "9001");
  assert.equal(rec.fileName, "9001.jpg");
  assert.equal(rec.type, 9);
  assert.equal(rec.size, 8); // base64 char count, not decoded bytes
  assert.equal(rec.contentBase64, "/9j/4A==");
});

test("parseBiodata keeps '=' inside the template value", () => {
  const rec = parseBiodata(REAL_BIODATA);
  assert.ok(rec);
  assert.equal(rec.pin, "9001");
  assert.equal(rec.type, 9);
  assert.equal(rec.majorVer, 39);
  assert.equal(rec.minorVer, 3); // matches Face VX3.9
  assert.equal(rec.templateBase64, "TWFsZm9y bWVkPT0=");
});

test("parseOplog extracts a PIN from an enrollment-shaped subject", () => {
  const rec = parseOplog(REAL_OPLOG_ENROLL);
  assert.ok(rec);
  assert.equal(rec.opcode, 103);
  assert.equal(rec.timestampRaw, "2026-08-08 06:38:56");
  assert.equal(rec.subject, "10000");
  assert.equal(rec.pin, "10000");
});

test("parseOplog leaves pin null for a setting name, which is now also alphanumeric", () => {
  const rec = parseOplog(REAL_OPLOG_TOGGLE);
  assert.ok(rec);
  assert.equal(rec.opcode, 108);
  assert.equal(rec.subject, "KeyPadBeep");
  assert.equal(rec.pin, null);
});

test("parseOplog rejects non-OPLOG and malformed lines", () => {
  assert.equal(parseOplog(""), null);
  assert.equal(parseOplog("USER PIN=9001\tName=X"), null);
  assert.equal(parseOplog("OPLOG notanumber\t0\t2026-08-08 06:38:56\t10000"), null);
});

test("parseKvRecord splits type from first field on the leading space", () => {
  const rec = parseKvRecord("BIOPHOTO PIN=9001\tFileName=9001.jpg");
  assert.ok(rec);
  assert.equal(rec.type, "BIOPHOTO");
  assert.equal(rec.fields["PIN"], "9001");
});

test("parseDevicecmdReply decodes the real acknowledgement", () => {
  const rep = parseDevicecmdReply("ID=1&Return=0&CMD=DATA");
  assert.equal(rep.id, 1);
  assert.equal(rep.returnCode, 0);
  assert.equal(rep.cmd, "DATA");
});

test("parseDevicecmdReply tolerates missing fields", () => {
  const rep = parseDevicecmdReply("Return=-1");
  assert.equal(rep.id, null);
  assert.equal(rep.returnCode, -1);
});

test("parseDeviceInfoKv reads INFO keys incl. '~'-prefixed ones", () => {
  const kv = parseDeviceInfoKv(
    "FWVersion=ZAM180-NF50VA-Ver3.4.10\n~MaxFaceCount=3000\nFaceCount=1\nMainTime=1970-01-01 00:00:00",
  );
  assert.equal(kv["FWVersion"], "ZAM180-NF50VA-Ver3.4.10");
  assert.equal(kv["~MaxFaceCount"], "3000");
  assert.equal(kv["FaceCount"], "1");
});

test("deviceTimestamps: +330 offset reproduces the observed 22:40 local / 17:10 UTC pair", () => {
  // Phase 0 B5: device reported 22:40:21 while the server logged 17:10:21 UTC.
  const { punchedAtDevice, punchedAtUtc } = deviceTimestamps("2026-07-28 22:40:21", 330);
  assert.equal(punchedAtDevice.toISOString(), "2026-07-28T22:40:21.000Z");
  assert.equal(punchedAtUtc.toISOString(), "2026-07-28T17:10:21.000Z");
});

test("attlogHash is stable and device-scoped", () => {
  const a = attlogHash("NCD8252500406", REAL_ATTLOG);
  assert.equal(a, attlogHash("NCD8252500406", REAL_ATTLOG));
  assert.notEqual(a, attlogHash("OTHERSN", REAL_ATTLOG));
});

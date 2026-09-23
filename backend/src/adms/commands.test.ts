import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateUser,
  buildDeleteUser,
  buildDeviceInfo,
  buildPushPhoto,
  buildQueryUser,
  buildSetGroup,
  CommandValidationError,
} from "./commands.js";

// A tiny but real JPEG header (FF D8 magic) for photo-command tests.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test("buildCreateUser emits the verified syntax, TAB-separated", () => {
  assert.equal(
    buildCreateUser({ pin: "9001", name: "TEST ONE", grp: 1 }),
    "DATA UPDATE USERINFO PIN=9001\tName=TEST ONE\tPri=0\tGrp=1",
  );
});

test("buildSetGroup emits the verified block/unblock syntax", () => {
  assert.equal(buildSetGroup({ pin: "9001", grp: 100 }), "DATA UPDATE USERINFO PIN=9001\tGrp=100");
  assert.equal(buildSetGroup({ pin: "9001", grp: 1 }), "DATA UPDATE USERINFO PIN=9001\tGrp=1");
});

test("buildDeleteUser / buildQueryUser / buildDeviceInfo", () => {
  assert.equal(buildDeleteUser({ pin: "9001" }), "DATA DELETE USERINFO PIN=9001");
  // An alphanumeric roster is ordinary in the field, and the ID goes out in
  // exactly the casing the device knows it by - never folded.
  assert.equal(buildQueryUser({ pin: "wctpl070" }), "DATA QUERY USERINFO PIN=wctpl070");
  assert.equal(buildQueryUser({ pin: "9001" }), "DATA QUERY USERINFO PIN=9001");
  assert.equal(buildDeviceInfo(), "INFO");
});

test("buildPushPhoto: Size is the base64 character count, not byte count", () => {
  const cmd = buildPushPhoto({ pin: "9001", jpeg: FAKE_JPEG });
  const b64 = FAKE_JPEG.toString("base64");
  assert.equal(
    cmd,
    `DATA UPDATE BIOPHOTO PIN=9001\tFileName=9001.jpg\tType=9\tSize=${b64.length}\tContent=${b64}`,
  );
  assert.notEqual(b64.length, FAKE_JPEG.length); // the two counts genuinely differ
});

test("validation: the device accepts nonsense, so we must not produce it", () => {
  // "0" is a legitimate ID now that IDs are text; what must still be refused
  // is anything outside the letters-and-digits whitelist, because the value
  // goes onto the wire inside a TAB-separated command.
  assert.throws(() => buildCreateUser({ pin: "", name: "X", grp: 1 }), CommandValidationError);
  assert.throws(() => buildCreateUser({ pin: "WC TPL", name: "X", grp: 1 }), CommandValidationError);
  assert.throws(() => buildCreateUser({ pin: "A	B", name: "X", grp: 1 }), CommandValidationError);
  assert.throws(() => buildCreateUser({ pin: "../etc", name: "X", grp: 1 }), CommandValidationError);
  assert.throws(() => buildCreateUser({ pin: "9001", name: "", grp: 1 }), CommandValidationError);
  // TAB inside a name would silently corrupt the whole command
  assert.throws(
    () => buildCreateUser({ pin: "9001", name: "A\tB", grp: 1 }),
    CommandValidationError,
  );
  assert.throws(
    () => buildCreateUser({ pin: "9001", name: "A\nB", grp: 1 }),
    CommandValidationError,
  );
  assert.throws(() => buildSetGroup({ pin: "9001", grp: -1 }), CommandValidationError);
  assert.throws(() => buildPushPhoto({ pin: "9001", jpeg: Buffer.alloc(0) }), CommandValidationError);
  // not a JPEG — device would accept it with Return=0 and produce a broken template
  assert.throws(
    () => buildPushPhoto({ pin: "9001", jpeg: Buffer.from("hello") }),
    CommandValidationError,
  );
});

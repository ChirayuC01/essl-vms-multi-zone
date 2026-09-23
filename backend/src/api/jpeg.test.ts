import { test } from "node:test";
import assert from "node:assert/strict";
import { isJpeg, jpegDimensions } from "./jpeg.js";

// Hand-built minimal JPEG: SOI, APP0 (empty-ish), SOF0 declaring 240x320.
function tinyJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]); // len=4
  const sof0 = Buffer.alloc(2 + 2 + 6);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(8, 2); // segment length
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([soi, app0, sof0]);
}

test("isJpeg checks the FF D8 magic", () => {
  assert.equal(isJpeg(tinyJpeg(320, 240)), true);
  assert.equal(isJpeg(Buffer.from("nope")), false);
  assert.equal(isJpeg(Buffer.alloc(0)), false);
});

test("jpegDimensions reads width/height from SOF0", () => {
  const dims = jpegDimensions(tinyJpeg(320, 240));
  assert.deepEqual(dims, { width: 320, height: 240 });
});

test("jpegDimensions returns null for truncated or non-JPEG data", () => {
  assert.equal(jpegDimensions(Buffer.from([0xff, 0xd8, 0xff])), null);
  assert.equal(jpegDimensions(Buffer.from("definitely not a jpeg")), null);
});

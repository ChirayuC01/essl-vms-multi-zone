import assert from "node:assert/strict";
import { test } from "node:test";
import { detectDocumentType, safeFileName } from "./documents.js";

const ALL = ["jpeg", "png", "webp", "pdf"];

test("each allowed type is recognised by its bytes", () => {
  assert.equal(detectDocumentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]), ALL), "jpeg");
  assert.equal(detectDocumentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), ALL), "png");
  assert.equal(detectDocumentType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), ALL), "webp");
  assert.equal(detectDocumentType(Buffer.from("%PDF-1.7\n"), ALL), "pdf");
});

test("an HTML page or a program is refused whatever it is called", () => {
  assert.equal(detectDocumentType(Buffer.from("<html><script>alert(1)</script>"), ALL), null);
  assert.equal(detectDocumentType(Buffer.from("MZ\x90\0", "latin1"), ALL), null);
});

test("a type the site has switched off is refused", () => {
  assert.equal(detectDocumentType(Buffer.from("%PDF-1.7\n"), ["jpeg"]), null);
});

test("display names lose path and header-breaking characters and get the real extension", () => {
  assert.equal(safeFileName("../../etc/pass\"wd.exe", "pdf"), ".._.._etc_pass_wd.pdf");
  assert.equal(safeFileName("Aadhaar card.JPG", "jpg"), "Aadhaar card.jpg");
  assert.equal(safeFileName(undefined, "png"), "document.png");
});

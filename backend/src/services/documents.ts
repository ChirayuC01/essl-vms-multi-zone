// Person documents (two-zone rebuild, Phase 3).
//
// A file's type is decided by its first bytes, never by its name or the
// Content-Type the uploader claimed: anything else lets an HTML page or a
// program in under a ".pdf" name, and a colleague who opens it runs it.

export const DOCUMENT_SIGNATURES = {
  jpeg: { mime: "image/jpeg", ext: "jpg", match: (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: "image/png", ext: "png", match: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  webp: { mime: "image/webp", ext: "webp", match: (b: Buffer) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  pdf: { mime: "application/pdf", ext: "pdf", match: (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
} as const;
export type DocumentType = keyof typeof DOCUMENT_SIGNATURES;

/** The document type these bytes really are, among the allowed ones; null if none. */
export function detectDocumentType(bytes: Buffer, allowed: readonly string[]): DocumentType | null {
  for (const [type, sig] of Object.entries(DOCUMENT_SIGNATURES) as [DocumentType, (typeof DOCUMENT_SIGNATURES)[DocumentType]][]) {
    if (allowed.includes(type) && sig.match(bytes)) return type;
  }
  return null;
}

/** A display file name safe to echo back in a Content-Disposition header. */
export function safeFileName(name: string | undefined, ext: string): string {
  const base = (name ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^A-Za-z0-9 ._-]/g, "_").trim().slice(0, 80);
  return `${base || "document"}.${ext}`;
}

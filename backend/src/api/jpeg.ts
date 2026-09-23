// Minimal JPEG inspection — enough to reject obviously bad enrollment photos
// early (photo quality determines template quality; the device itself will
// accept garbage with Return=0 and produce an unreliable face template).

export interface JpegInfo {
  width: number;
  height: number;
}

export function isJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * Extract pixel dimensions from a JPEG by walking its segments to the first
 * SOF (start-of-frame) marker. Returns null for anything unparseable.
 */
export function jpegDimensions(buf: Buffer): JpegInfo | null {
  if (!isJpeg(buf)) return null;

  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1]!;

    // Standalone markers without a length field.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;

    // SOF0–SOF15 carry dimensions, except the DHT/JPG/DAC markers in range.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // Segment payload: [precision u8][height u16][width u16]...
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }

    offset += 2 + segmentLength;
  }
  return null;
}

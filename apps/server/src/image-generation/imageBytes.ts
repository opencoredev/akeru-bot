/**
 * Image byte inspection for generated artifacts. Providers report formats
 * loosely, so the stored MIME type and dimensions always come from the bytes
 * themselves. Unknown or truncated data is rejected rather than guessed.
 */
export type SniffedImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface SniffedImage {
  readonly mimeType: SniffedImageMime;
  readonly width: number;
  readonly height: number;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) + bytes[offset + 1]!;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + (bytes[offset + 1]! << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sniffPng(bytes: Uint8Array): SniffedImage | undefined {
  if (bytes.length < 24) return undefined;
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return undefined;
  // IHDR is always the first chunk: length(4) type(4) width(4) height(4).
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  return width > 0 && height > 0 ? { mimeType: "image/png", width, height } : undefined;
}

function sniffJpeg(bytes: Uint8Array): SniffedImage | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = readUint16BE(bytes, offset + 2);
    // SOF0..SOF15 carry dimensions, except DHT (C4), JPG (C8), and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = readUint16BE(bytes, offset + 5);
      const width = readUint16BE(bytes, offset + 7);
      return width > 0 && height > 0 ? { mimeType: "image/jpeg", width, height } : undefined;
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

function sniffWebp(bytes: Uint8Array): SniffedImage | undefined {
  if (bytes.length < 30) return undefined;
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return undefined;
  const chunk = tag(12);
  if (chunk === "VP8X") {
    return {
      mimeType: "image/webp",
      width: readUint24LE(bytes, 24) + 1,
      height: readUint24LE(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8 ") {
    return {
      mimeType: "image/webp",
      width: readUint16LE(bytes, 26) & 0x3fff,
      height: readUint16LE(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return {
      mimeType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  return undefined;
}

/**
 * Largest pixel count accepted. Generated images stay far below it; a small file that declares
 * more would make every client that decodes or copies it allocate an enormous canvas.
 */
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

/** Returns the real format and pixel size, or undefined for anything else. */
export function sniffImage(bytes: Uint8Array): SniffedImage | undefined {
  const sniffed = sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes);
  return sniffed && sniffed.width * sniffed.height <= MAX_IMAGE_PIXELS ? sniffed : undefined;
}

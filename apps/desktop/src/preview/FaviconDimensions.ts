export const MAX_FAVICON_SOURCE_PIXELS = 1_048_576;

export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export function safeDimensions(dimensions: ImageDimensions | null): dimensions is ImageDimensions {
  return (
    dimensions !== null &&
    Number.isSafeInteger(dimensions.width) &&
    Number.isSafeInteger(dimensions.height) &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width * dimensions.height <= MAX_FAVICON_SOURCE_PIXELS
  );
}

export function pngDimensions(buffer: Buffer): ImageDimensions | null {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || buffer.byteLength < 24) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function skipGifSubBlocks(buffer: Buffer, startOffset: number): number | null {
  let offset = startOffset;
  while (offset < buffer.byteLength) {
    const blockLength = buffer[offset]!;
    offset += 1;
    if (blockLength === 0) return offset;
    if (offset + blockLength > buffer.byteLength) return null;
    offset += blockLength;
  }
  return null;
}

export function gifDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.byteLength < 13 || !/^GIF8[79]a$/u.test(buffer.subarray(0, 6).toString("ascii"))) {
    return null;
  }
  const logicalWidth = buffer.readUInt16LE(6);
  const logicalHeight = buffer.readUInt16LE(8);
  if (!safeDimensions({ width: logicalWidth, height: logicalHeight })) return null;
  const packed = buffer[10]!;
  let offset = 13 + ((packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1));
  if (offset > buffer.byteLength) return null;
  let width = logicalWidth;
  let height = logicalHeight;
  let frameCount = 0;
  let framePixels = 0;
  while (offset < buffer.byteLength) {
    const marker = buffer[offset];
    if (marker === 0x3b) return frameCount > 0 ? { width, height } : null;
    if (marker === 0x2c) {
      if (offset + 10 > buffer.byteLength) return null;
      const left = buffer.readUInt16LE(offset + 1);
      const top = buffer.readUInt16LE(offset + 3);
      const frameWidth = buffer.readUInt16LE(offset + 5);
      const frameHeight = buffer.readUInt16LE(offset + 7);
      if (frameWidth === 0 || frameHeight === 0) return null;
      framePixels += frameWidth * frameHeight;
      if (framePixels > MAX_FAVICON_SOURCE_PIXELS) return null;
      width = Math.max(width, left + frameWidth);
      height = Math.max(height, top + frameHeight);
      if (!safeDimensions({ width, height })) return null;
      const framePacked = buffer[offset + 9]!;
      offset += 10;
      if ((framePacked & 0x80) !== 0) {
        offset += 3 * 2 ** ((framePacked & 0x07) + 1);
      }
      if (offset >= buffer.byteLength) return null;
      const minimumCodeSize = buffer[offset]!;
      if (minimumCodeSize < 2 || minimumCodeSize > 8) return null;
      offset += 1;
      const nextOffset = skipGifSubBlocks(buffer, offset);
      if (nextOffset === null) return null;
      offset = nextOffset;
      frameCount += 1;
      continue;
    }
    if (marker !== 0x21 || offset + 2 > buffer.byteLength) return null;
    const nextOffset = skipGifSubBlocks(buffer, offset + 2);
    if (nextOffset === null) return null;
    offset = nextOffset;
  }
  return null;
}

export interface JpegExifMetadata {
  readonly complete: boolean;
  readonly orientation: number | null;
}

export function jpegExifMetadata(segment: Buffer): JpegExifMetadata | null {
  if (segment.byteLength <= 6 || segment.subarray(0, 5).toString("binary") !== "Exif\0") {
    return null;
  }
  const metadataWithoutOrientation = (): JpegExifMetadata => ({
    complete: true,
    orientation: null,
  });
  if (segment.byteLength < 14) return metadataWithoutOrientation();
  const tiffOffset = 6;
  const littleEndian = segment[tiffOffset] === 0x49 && segment[tiffOffset + 1] === 0x49;
  const bigEndian = segment[tiffOffset] === 0x4d && segment[tiffOffset + 1] === 0x4d;
  if (!littleEndian && !bigEndian) return metadataWithoutOrientation();
  const readUInt16 = (offset: number): number | null => {
    if (offset < 0 || offset + 2 > segment.byteLength) return null;
    return littleEndian ? segment.readUInt16LE(offset) : segment.readUInt16BE(offset);
  };
  const readUInt32 = (offset: number): number | null => {
    if (offset < 0 || offset + 4 > segment.byteLength) return null;
    return littleEndian ? segment.readUInt32LE(offset) : segment.readUInt32BE(offset);
  };
  const relativeIfdOffset = readUInt32(tiffOffset + 4);
  if (relativeIfdOffset === null) return metadataWithoutOrientation();
  // Keep untrusted metadata parsing linear even when IFD pointers overlap.
  let remainingIfdEntryVisits = Math.ceil(segment.byteLength / 12);
  const budgetExhausted = Symbol("ifd-entry-budget-exhausted");
  type IfdOrientation = number | null | typeof budgetExhausted;
  const subIfdOrientationByOffset = new Map<number, number | null>();
  const readIfdOrientation = (ifdOffset: number, isRoot: boolean): IfdOrientation => {
    if (!isRoot && subIfdOrientationByOffset.has(ifdOffset)) {
      return subIfdOrientationByOffset.get(ifdOffset) ?? null;
    }
    const entryCount = readUInt16(ifdOffset);
    if (entryCount === null) return null;
    let result: IfdOrientation = null;
    for (let index = 0; index < entryCount; index += 1) {
      if (remainingIfdEntryVisits === 0) return budgetExhausted;
      remainingIfdEntryVisits -= 1;
      const entryOffset = ifdOffset + 2 + index * 12;
      if (entryOffset + 12 > segment.byteLength) break;
      const tag = readUInt16(entryOffset);
      const type = readUInt16(entryOffset + 2);
      const count = readUInt32(entryOffset + 4);
      if (tag === 0x0112 && type === 3 && count === 1) {
        const orientation = readUInt16(entryOffset + 8);
        if (orientation !== null && orientation >= 1 && orientation <= 8) {
          result = orientation;
          break;
        }
      } else if (isRoot && tag === 0x8769 && type === 4 && count === 1) {
        const relativeSubIfdOffset = readUInt32(entryOffset + 8);
        if (relativeSubIfdOffset !== null) {
          const orientation = readIfdOrientation(tiffOffset + relativeSubIfdOffset, false);
          if (orientation === budgetExhausted) return budgetExhausted;
          if (orientation !== null) {
            result = orientation;
            break;
          }
        }
      }
    }
    if (!isRoot) subIfdOrientationByOffset.set(ifdOffset, result);
    return result;
  };
  const orientation = readIfdOrientation(tiffOffset + relativeIfdOffset, true);
  return orientation === budgetExhausted
    ? { complete: false, orientation: null }
    : { complete: true, orientation };
}

export function jpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.byteLength < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  let dimensions: ImageDimensions | null = null;
  let exifMetadata: JpegExifMetadata | null = null;
  while (offset + 3 < buffer.byteLength) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 1 >= buffer.byteLength) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.byteLength) return null;
    if (marker === 0xe1 && exifMetadata === null) {
      exifMetadata = jpegExifMetadata(buffer.subarray(offset + 2, offset + length));
    }
    if (startOfFrameMarkers.has(marker)) {
      if (length < 7) return null;
      if (dimensions !== null) return null;
      dimensions = {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  if (!dimensions) return null;
  if (exifMetadata?.complete === false) return null;
  const orientation = exifMetadata?.orientation;
  return orientation !== undefined && orientation !== null && orientation >= 5 && orientation <= 8
    ? { width: dimensions.height, height: dimensions.width }
    : dimensions;
}

export function webpDimensions(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.byteLength < 30 ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return null;
  }
  const kind = buffer.subarray(12, 16).toString("ascii");
  if (kind === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (kind === "VP8 " && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === "VP8L" && buffer[20] === 0x2f) {
    return {
      width: 1 + buffer[21]! + ((buffer[22]! & 0x3f) << 8),
      height: 1 + (buffer[22]! >> 6) + (buffer[23]! << 2) + ((buffer[24]! & 0x0f) << 10),
    };
  }
  return null;
}

export function dibDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.byteLength < 12) return null;
  const headerSize = buffer.readUInt32LE(0);
  if (headerSize === 12) {
    return {
      width: buffer.readUInt16LE(4),
      height: buffer.readUInt16LE(6),
    };
  }
  if (headerSize < 40 || buffer.byteLength < 12) return null;
  return {
    width: Math.abs(buffer.readInt32LE(4)),
    height: Math.abs(buffer.readInt32LE(8)),
  };
}

export function icoDimensions(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.byteLength < 22 ||
    buffer.readUInt16LE(0) !== 0 ||
    (buffer.readUInt16LE(2) !== 1 && buffer.readUInt16LE(2) !== 2)
  ) {
    return null;
  }
  const count = buffer.readUInt16LE(4);
  if (count === 0 || count > 256 || buffer.byteLength < 6 + count * 16) return null;
  let width = 0;
  let height = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    width = Math.max(width, buffer[offset] === 0 ? 256 : buffer[offset]!);
    height = Math.max(height, buffer[offset + 1] === 0 ? 256 : buffer[offset + 1]!);
    if (!safeDimensions({ width, height })) return null;
    const byteLength = buffer.readUInt32LE(offset + 8);
    const imageOffset = buffer.readUInt32LE(offset + 12);
    if (
      byteLength === 0 ||
      imageOffset < 6 + count * 16 ||
      imageOffset > buffer.byteLength ||
      byteLength > buffer.byteLength - imageOffset
    )
      return null;
    const embedded = buffer.subarray(imageOffset, imageOffset + byteLength);
    const embeddedDimensions = pngDimensions(embedded) ?? dibDimensions(embedded);
    if (!safeDimensions(embeddedDimensions)) return null;
  }
  return { width, height };
}

export function sourceDimensions(buffer: Buffer): ImageDimensions | null {
  return (
    pngDimensions(buffer) ??
    gifDimensions(buffer) ??
    jpegDimensions(buffer) ??
    webpDimensions(buffer) ??
    icoDimensions(buffer)
  );
}

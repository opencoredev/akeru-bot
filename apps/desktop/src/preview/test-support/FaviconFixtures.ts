import { expect, vi } from "vite-plus/test";

import { captureFavicon } from "../FaviconCapture.ts";

export const PNG = "data:image/png;base64,cG5n";

export const SOURCE_PNG = Buffer.alloc(24);

Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(SOURCE_PNG);

SOURCE_PNG.writeUInt32BE(1, 16);

SOURCE_PNG.writeUInt32BE(1, 20);

export const SOURCE_PNG_URL = `data:image/png;base64,${SOURCE_PNG.toString("base64")}`;

export function sourceGif(
  width: number,
  height: number,
  frameWidth = width,
  frameHeight = height,
  additionalFrames: ReadonlyArray<{
    readonly left?: number;
    readonly top?: number;
    readonly width: number;
    readonly height: number;
  }> = [],
): Buffer {
  const frames = [{ width: frameWidth, height: frameHeight }, ...additionalFrames];
  const buffer = Buffer.alloc(13 + frames.length * 12 + 1);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  let offset = 13;

  for (const frame of frames) {
    buffer[offset] = 0x2c;
    buffer.writeUInt16LE(frame.left ?? 0, offset + 1);
    buffer.writeUInt16LE(frame.top ?? 0, offset + 3);
    buffer.writeUInt16LE(frame.width, offset + 5);
    buffer.writeUInt16LE(frame.height, offset + 7);
    offset += 10;
    buffer[offset] = 2;
    buffer[offset + 1] = 0;
    offset += 2;
  }

  buffer[offset] = 0x3b;

  return buffer;
}

export function sourceJpeg(
  width: number,
  height: number,
  orientations: number | ReadonlyArray<number> = [],
): Buffer {
  const frame = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x07,
    0x08,
    height >>> 8,
    height & 0xff,
    width >>> 8,
    width & 0xff,
  ]);

  const app1Segments = (typeof orientations === "number" ? [orientations] : orientations).map(
    (orientation) => sourceJpegExifSegment([orientation]),
  );

  return Buffer.concat([frame.subarray(0, 2), ...app1Segments, frame.subarray(2)]);
}

export function sourceJpegApp1Segment(payload: Buffer): Buffer {
  const app1 = Buffer.alloc(4 + payload.byteLength);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.byteLength + 2, 2);
  payload.copy(app1, 4);

  return app1;
}

export function sourceJpegExifSegment(
  orientations: ReadonlyArray<number>,
  options?: {
    readonly byteOrder?: "II" | "MM";
    readonly magic?: number;
    readonly padding?: number;
  },
): Buffer {
  const exif = Buffer.alloc(20 + orientations.length * 12);
  exif.write("Exif\0\0", 0, "binary");
  exif[5] = options?.padding ?? 0;
  const littleEndian = options?.byteOrder !== "MM";
  exif.write(littleEndian ? "II" : "MM", 6, "ascii");

  const writeUInt16 = (value: number, offset: number) =>
    littleEndian ? exif.writeUInt16LE(value, offset) : exif.writeUInt16BE(value, offset);

  const writeUInt32 = (value: number, offset: number) =>
    littleEndian ? exif.writeUInt32LE(value, offset) : exif.writeUInt32BE(value, offset);

  writeUInt16(options?.magic ?? 42, 8);
  writeUInt32(8, 10);
  writeUInt16(orientations.length, 14);
  orientations.forEach((orientation, index) => {
    const entryOffset = 16 + index * 12;
    writeUInt16(0x0112, entryOffset);
    writeUInt16(3, entryOffset + 2);
    writeUInt32(1, entryOffset + 4);
    writeUInt16(orientation, entryOffset + 8);
  });

  return sourceJpegApp1Segment(exif);
}

export function sourceJpegWithApp1Segments(
  width: number,
  height: number,
  segments: ReadonlyArray<Buffer>,
): Buffer {
  const frame = sourceJpeg(width, height);

  return Buffer.concat([frame.subarray(0, 2), ...segments, frame.subarray(2)]);
}

export function sourceJpegWithOrientationEntries(
  width: number,
  height: number,
  orientations: ReadonlyArray<number>,
): Buffer {
  return sourceJpegWithApp1Segments(width, height, [sourceJpegExifSegment(orientations)]);
}

export function sourceJpegWithEndianAlias(alias: number, byteOrder: "II" | "MM"): Buffer {
  const exif = sourceJpegExifSegment([6], { byteOrder });
  exif[10] = alias;
  exif[11] = alias;

  return sourceJpegWithApp1Segments(64, 32, [exif]);
}

export function sourceJpegExifWithSubIfd(options: {
  readonly rootOrientation?: number;
  readonly subIfdFirst?: boolean;
  readonly subIfdOrientation: number;
}): Buffer {
  const rootEntries = options.rootOrientation === undefined ? 1 : 2;
  const rootIfdOffset = 14;
  const subIfdOffset = rootIfdOffset + 2 + rootEntries * 12 + 4;
  const exif = Buffer.alloc(subIfdOffset + 2 + 12 + 4);
  exif.write("Exif\0\0", 0, "binary");
  exif.write("II", 6, "ascii");
  exif.writeUInt16LE(42, 8);
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(rootEntries, rootIfdOffset);

  const writeOrientation = (offset: number, orientation: number) => {
    exif.writeUInt16LE(0x0112, offset);
    exif.writeUInt16LE(3, offset + 2);
    exif.writeUInt32LE(1, offset + 4);
    exif.writeUInt16LE(orientation, offset + 8);
  };

  const writeSubIfdPointer = (offset: number) => {
    exif.writeUInt16LE(0x8769, offset);
    exif.writeUInt16LE(4, offset + 2);
    exif.writeUInt32LE(1, offset + 4);
    exif.writeUInt32LE(subIfdOffset - 6, offset + 8);
  };

  const firstRootEntryOffset = rootIfdOffset + 2;

  if (options.rootOrientation === undefined) {
    writeSubIfdPointer(firstRootEntryOffset);
  } else if (options.subIfdFirst) {
    writeSubIfdPointer(firstRootEntryOffset);
    writeOrientation(firstRootEntryOffset + 12, options.rootOrientation);
  } else {
    writeOrientation(firstRootEntryOffset, options.rootOrientation);
    writeSubIfdPointer(firstRootEntryOffset + 12);
  }

  exif.writeUInt16LE(1, subIfdOffset);
  writeOrientation(subIfdOffset + 2, options.subIfdOrientation);

  return sourceJpegApp1Segment(exif);
}

export function sourceJpegExifWithSubIfdPointers(options: {
  readonly pointerCount: number;
  readonly subIfdEntries: number;
}): Buffer {
  const { pointerCount, subIfdEntries } = options;
  const rootIfdOffset = 14;
  const rootEntries = pointerCount + 1;
  const subIfdOffset = rootIfdOffset + 2 + rootEntries * 12 + 4;
  const exif = Buffer.alloc(subIfdOffset + 2 + subIfdEntries * 12 + 4);
  exif.write("Exif\0\0", 0, "binary");
  exif.write("II", 6, "ascii");
  exif.writeUInt16LE(42, 8);
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(rootEntries, rootIfdOffset);

  for (let index = 0; index < pointerCount; index += 1) {
    const entryOffset = rootIfdOffset + 2 + index * 12;
    exif.writeUInt16LE(0x8769, entryOffset);
    exif.writeUInt16LE(4, entryOffset + 2);
    exif.writeUInt32LE(1, entryOffset + 4);
    exif.writeUInt32LE(subIfdOffset - 6, entryOffset + 8);
  }

  const orientationOffset = rootIfdOffset + 2 + pointerCount * 12;
  exif.writeUInt16LE(0x0112, orientationOffset);
  exif.writeUInt16LE(3, orientationOffset + 2);
  exif.writeUInt32LE(1, orientationOffset + 4);
  exif.writeUInt16LE(6, orientationOffset + 8);

  exif.writeUInt16LE(subIfdEntries, subIfdOffset);

  for (let index = 0; index < subIfdEntries; index += 1) {
    const entryOffset = subIfdOffset + 2 + index * 12;
    exif.writeUInt16LE(1, entryOffset);
    exif.writeUInt16LE(3, entryOffset + 2);
    exif.writeUInt32LE(1, entryOffset + 4);
  }

  return sourceJpegApp1Segment(exif);
}

export function sourceJpegExifWithOverlappingSubIfds(
  pointerCount: number,
  subIfdEntries: number,
): Buffer {
  const rootIfdOffset = 14;
  const rootEntries = pointerCount + 1;
  const subIfdOffset = rootIfdOffset + 2 + rootEntries * 12 + 4;
  const exif = Buffer.alloc(subIfdOffset + pointerCount * 2 + 2 + subIfdEntries * 12);
  exif.write("Exif\0\0", 0, "binary");
  exif.write("II", 6, "ascii");
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(rootEntries, rootIfdOffset);

  for (let index = 0; index < pointerCount; index += 1) {
    const entryOffset = rootIfdOffset + 2 + index * 12;
    exif.writeUInt16LE(0x8769, entryOffset);
    exif.writeUInt16LE(4, entryOffset + 2);
    exif.writeUInt32LE(1, entryOffset + 4);
    exif.writeUInt32LE(subIfdOffset + index * 2 - 6, entryOffset + 8);
    exif.writeUInt16LE(subIfdEntries, subIfdOffset + index * 2);
  }

  const orientationOffset = rootIfdOffset + 2 + pointerCount * 12;
  exif.writeUInt16LE(0x0112, orientationOffset);
  exif.writeUInt16LE(3, orientationOffset + 2);
  exif.writeUInt32LE(1, orientationOffset + 4);
  exif.writeUInt16LE(6, orientationOffset + 8);

  return sourceJpegApp1Segment(exif);
}

export function sourceWebp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);

  return buffer;
}

export function sourceIco(embedded: Buffer): Buffer {
  const buffer = Buffer.alloc(22 + embedded.byteLength);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt32LE(embedded.byteLength, 14);
  buffer.writeUInt32LE(22, 18);
  embedded.copy(buffer, 22);

  return buffer;
}

export function makeUnsafePng(): Buffer {
  const buffer = Buffer.from(SOURCE_PNG);
  buffer.writeUInt32BE(4096, 16);
  buffer.writeUInt32BE(4096, 20);

  return buffer;
}

export function sourcePng(width: number, height: number): Buffer {
  const buffer = Buffer.from(SOURCE_PNG);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);

  return buffer;
}

export function makeUnsafeDib(): Buffer {
  const buffer = Buffer.alloc(40);
  buffer.writeUInt32LE(40, 0);
  buffer.writeInt32LE(4096, 4);
  buffer.writeInt32LE(4096, 8);

  return buffer;
}

export function makeWebContents(options?: {
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly rasterize?: (code: string) => Promise<unknown>;
}) {
  const fetch = vi.fn(
    options?.fetch ??
      (async () =>
        new Response(new Uint8Array(SOURCE_PNG), {
          headers: { "content-type": "image/png" },
        })),
  );

  const executeJavaScriptInIsolatedWorld = vi.fn(
    async (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) =>
      options?.rasterize ? options.rasterize(scripts[0]?.code ?? "") : PNG,
  );

  return {
    webContents: {
      session: { fetch },
      executeJavaScriptInIsolatedWorld,
    } as never,
    executeJavaScriptInIsolatedWorld,
    fetch,
  };
}

export const JPEG_LANDSCAPE_LAYOUT = {
  draw: "context.drawImage(bitmap, 0, 8, 32, 16)",
  resizeHeight: 16,
  resizeWidth: 32,
} as const;

export const JPEG_PORTRAIT_LAYOUT = {
  draw: "context.drawImage(bitmap, 8, 0, 16, 32)",
  resizeHeight: 32,
  resizeWidth: 16,
} as const;

export async function expectJpegLayout(
  source: Buffer,
  layout: typeof JPEG_LANDSCAPE_LAYOUT | typeof JPEG_PORTRAIT_LAYOUT,
): Promise<void> {
  const { webContents } = makeWebContents({
    rasterize: async (code) => {
      expect(code).toContain(`resizeWidth: ${layout.resizeWidth}`);
      expect(code).toContain(`resizeHeight: ${layout.resizeHeight}`);
      expect(code).toContain(layout.draw);

      return PNG;
    },
  });

  expect(
    await captureFavicon({
      webContents,
      pageUrl: "https://example.com/page",
      candidates: [`data:image/jpeg;base64,${source.toString("base64")}`],
      signal: new AbortController().signal,
    }),
  ).toEqual({ kind: "captured", dataUrl: PNG });
}

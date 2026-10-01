import { describe, expect, it } from "vite-plus/test";

import { captureFavicon } from "./FaviconCapture.ts";

import {
  PNG,
  SOURCE_PNG,
  sourceGif,
  sourceJpeg,
  sourceJpegApp1Segment,
  sourceJpegExifSegment,
  sourceJpegWithApp1Segments,
  sourceJpegWithOrientationEntries,
  sourceJpegWithEndianAlias,
  sourceJpegExifWithSubIfd,
  sourceJpegExifWithSubIfdPointers,
  sourceJpegExifWithOverlappingSubIfds,
  sourceWebp,
  sourceIco,
  makeUnsafePng,
  sourcePng,
  makeUnsafeDib,
  makeWebContents,
  JPEG_LANDSCAPE_LAYOUT,
  JPEG_PORTRAIT_LAYOUT,
  expectJpegLayout,
} from "./test-support/FaviconFixtures.ts";

describe("captureFavicon", () => {
  it("retains bounded compatibility with common favicon formats", async () => {
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents();
    for (const [mime, buffer] of [
      ["image/gif", sourceGif(32, 32)],
      ["image/jpeg", sourceJpeg(32, 32)],
      ["image/webp", sourceWebp(32, 32)],
      ["image/x-icon", sourceIco(SOURCE_PNG)],
    ] as const) {
      expect(
        await captureFavicon({
          webContents,
          pageUrl: "https://example.com/page",
          candidates: [`data:${mime};base64,${buffer.toString("base64")}`],
          signal: new AbortController().signal,
        }),
      ).toEqual({ kind: "captured", dataUrl: PNG });
    }
    expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      label: "landscape",
      source: sourcePng(64, 32),
      resizeWidth: 32,
      resizeHeight: 16,
      draw: "context.drawImage(bitmap, 0, 8, 32, 16)",
    },
    {
      label: "portrait",
      source: sourcePng(32, 64),
      resizeWidth: 16,
      resizeHeight: 32,
      draw: "context.drawImage(bitmap, 8, 0, 16, 32)",
    },
  ])("preserves $label aspect ratio within the 32x32 output", async (testCase) => {
    const { webContents } = makeWebContents({
      rasterize: async (code) => {
        expect(code).toContain(`resizeWidth: ${testCase.resizeWidth}`);
        expect(code).toContain(`resizeHeight: ${testCase.resizeHeight}`);
        expect(code).toContain('resizeQuality: "high"');
        expect(code).toContain(testCase.draw);
        return PNG;
      },
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [`data:image/png;base64,${testCase.source.toString("base64")}`],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "captured", dataUrl: PNG });
  });

  it.each([
    ...[1, 2, 3, 4].map((orientation) => ({
      label: `keeps stored dimensions for orientation ${orientation}`,
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpeg(64, 32, orientation),
    })),
    ...[5, 6, 7, 8].map((orientation) => ({
      label: `uses display dimensions for orientation ${orientation}`,
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpeg(64, 32, orientation),
    })),
    {
      label: "uses the first separate EXIF segment when it is transposed",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpeg(64, 32, [6, 1]),
    },
    {
      label: "uses the first separate EXIF segment when it is untransposed",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpeg(64, 32, [1, 6]),
    },
    {
      label: "does not consult a later EXIF segment after an invalid orientation",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpeg(64, 32, [9, 6]),
    },
    {
      label: "uses a later valid orientation in the same IFD",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithOrientationEntries(64, 32, [9, 6]),
    },
    {
      label: "skips a non-EXIF APP1 segment",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegApp1Segment(Buffer.from("not-exif")),
        sourceJpegExifSegment([6]),
      ]),
    },
    {
      label: "skips an empty EXIF APP1 segment",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegApp1Segment(Buffer.from("Exif\0\0", "binary")),
        sourceJpegExifSegment([6]),
      ]),
    },
    {
      label: "stops after a malformed qualifying EXIF APP1 segment",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegApp1Segment(Buffer.from("Exif\0\0broken", "binary")),
        sourceJpegExifSegment([6]),
      ]),
    },
    {
      label: "ignores the EXIF padding byte",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [sourceJpegExifSegment([6], { padding: 0xff })]),
    },
    {
      label: "reads big-endian EXIF",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [sourceJpegExifSegment([6], { byteOrder: "MM" })]),
    },
    {
      label: "matches Chromium for a nonstandard TIFF magic field",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [sourceJpegExifSegment([6], { magic: 0 })]),
    },
    {
      label: "rejects a high-bit little-endian alias",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpegWithEndianAlias(0xc9, "II"),
    },
    {
      label: "rejects a high-bit big-endian alias",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpegWithEndianAlias(0xcd, "MM"),
    },
    {
      label: "reads an orientation from a SubIFD",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegExifWithSubIfd({ subIfdOrientation: 6 }),
      ]),
    },
    {
      label: "uses a SubIFD orientation before a later root orientation",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegExifWithSubIfd({
          rootOrientation: 1,
          subIfdFirst: true,
          subIfdOrientation: 6,
        }),
      ]),
    },
    {
      label: "uses a root orientation before a later SubIFD orientation",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegExifWithSubIfd({ rootOrientation: 1, subIfdOrientation: 6 }),
      ]),
    },
    {
      label: "memoizes repeated aliases to the same SubIFD",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegExifWithSubIfdPointers({ pointerCount: 32, subIfdEntries: 32 }),
      ]),
    },
  ])("matches Chromium JPEG layout: $label", async ({ source, layout }) => {
    await expectJpegLayout(source, layout);
  });

  it("rejects JPEG metadata when distinct SubIFDs exhaust the linear work budget", async () => {
    const source = sourceJpegWithApp1Segments(64, 32, [
      sourceJpegExifWithOverlappingSubIfds(32, 32),
    ]);
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents();

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [`data:image/jpeg;base64,${source.toString("base64")}`],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("rejects JPEGs with multiple frame headers before rasterization", async () => {
    const buffer = Buffer.concat([sourceJpeg(4096, 4096), sourceJpeg(1, 1).subarray(2)]);
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents();

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [`data:image/jpeg;base64,${buffer.toString("base64")}`],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("rejects an unsafe PNG size before rasterization", async () => {
    const buffer = makeUnsafePng();
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents({
      fetch: async () =>
        new Response(new Uint8Array(buffer), {
          headers: { "content-type": "image/png" },
        }),
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/favicon.png"],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it.each([
    ["GIF", "image/gif", sourceGif(4096, 4096)],
    ["GIF frame", "image/gif", sourceGif(1, 1, 4096, 4096)],
    ["GIF later frame", "image/gif", sourceGif(1, 1, 1, 1, [{ width: 4096, height: 4096 }])],
    [
      "GIF cumulative frames",
      "image/gif",
      sourceGif(
        64,
        64,
        64,
        64,
        Array.from({ length: 256 }, () => ({ width: 64, height: 64 })),
      ),
    ],
    ["JPEG", "image/jpeg", sourceJpeg(4096, 4096)],
    ["WebP", "image/webp", sourceWebp(4096, 4096)],
    ["ICO with PNG", "image/x-icon", sourceIco(makeUnsafePng())],
    ["ICO with DIB", "image/x-icon", sourceIco(makeUnsafeDib())],
    ["SVG", "image/svg+xml", Buffer.from('<svg width="1" height="1"/>')],
    [
      "SVG with embedded bitmap",
      "image/svg+xml",
      Buffer.from(
        `<svg width="1" height="1"><image href="data:image/png;base64,${makeUnsafePng().toString("base64")}"/></svg>`,
      ),
    ],
    [
      "ICO invalid payload span",
      "image/x-icon",
      (() => {
        const buffer = Buffer.alloc(22);
        buffer.writeUInt16LE(1, 2);
        buffer.writeUInt16LE(1, 4);
        buffer.writeUInt32LE(100, 14);
        buffer.writeUInt32LE(22, 18);
        return buffer;
      })(),
    ],
  ])("rejects unsafe or unsupported %s before rasterization", async (_label, mime, buffer) => {
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents();
    const candidate = `data:${mime};base64,${buffer.toString("base64")}`;
    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [candidate],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });
});

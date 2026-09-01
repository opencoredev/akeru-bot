import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vite-plus/test";
import { redactSensitiveText } from "@t3tools/shared/sensitiveDataRedaction";

import {
  redactComputerScreenshot,
  redactPreviewSnapshot,
  redactProviderVisiblePreviewResult,
} from "./PreviewSnapshotRedaction.ts";

function testScreenshot() {
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(255);
  return {
    mimeType: "image/png" as const,
    data: PNG.sync.write(png).toString("base64"),
    width: 2,
    height: 2,
  };
}

function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return chunk;
}

describe("preview snapshot redaction", () => {
  it("redacts headers, tokens, emails, phone numbers, and home paths", () => {
    const result = redactSensitiveText(
      [
        "leo@example.com",
        "Authorization: Basic dXNlcjpwYXNz",
        "Cookie: a=one; b=two",
        "token=secret-value",
        "/Users/leo/.ssh/id_rsa",
        "+442071234567",
      ].join("\n"),
    );

    expect(result.redacted).toBe(true);
    expect(result.value).not.toContain("leo@example.com");
    expect(result.value).not.toContain("dXNlcjpwYXNz");
    expect(result.value).not.toContain("secret-value");
    expect(result.value).not.toContain("Users/leo");
    expect(result.value).not.toContain("442071234567");
  });

  it("redacts secret fields and blanks the screenshot", () => {
    const result = redactPreviewSnapshot(
      {
        cookie: ["opaque"],
        password: 1234,
        visible: "safe",
        consoleOutput: '{"token":"secret-value"}',
      },
      testScreenshot(),
    );

    expect(result.page).toEqual({
      cookie: "[REDACTED]",
      password: "[REDACTED]",
      visible: "safe",
      consoleOutput: '{"[REDACTED]}',
    });
    const png = PNG.sync.read(Buffer.from(result.screenshot));
    expect([...png.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
  });

  it("rejects oversized dimensions before decoding pixels", () => {
    const screenshot = testScreenshot();
    const bytes = Buffer.from(screenshot.data, "base64");
    bytes.writeUInt32BE(20_000, 16);
    bytes.writeUInt32BE(20_000, 20);
    const decode = vi.spyOn(PNG.sync, "read");

    expect(() => redactComputerScreenshot({ mediaType: "image/png", data: bytes })).toThrow(
      "Screenshot dimensions are invalid.",
    );
    expect(decode).not.toHaveBeenCalled();
  });

  it("fails closed on malformed or mismatched screenshots", () => {
    const screenshot = testScreenshot();
    expect(() =>
      redactComputerScreenshot({
        mediaType: "image/png",
        data: Buffer.from("not-a-png"),
      }),
    ).toThrow();
    expect(() => redactPreviewSnapshot({ visible: "safe" }, { ...screenshot, width: 3 })).toThrow(
      "Preview screenshot dimensions are invalid.",
    );
  });

  it("strips PNG ancillary metadata while re-encoding", () => {
    const screenshot = testScreenshot();
    const text = Buffer.from("secret metadata", "utf8");
    const original = Buffer.from(screenshot.data, "base64");
    const iend = original.length - 12;
    const bytes = Buffer.concat([
      original.subarray(0, iend),
      pngChunk("tEXt", Buffer.concat([Buffer.from("Comment\0"), text])),
      original.subarray(iend),
    ]);

    const result = redactComputerScreenshot({ mediaType: "image/png", data: bytes });
    expect(Buffer.from(result.data).includes(text)).toBe(false);
  });

  it("sanitizes snapshots before they reach a provider", () => {
    const result = redactProviderVisiblePreviewResult("snapshot", {
      url: "http://example.test/",
      title: "leo@example.com",
      loading: false,
      visibleText: "token=visible-secret",
      interactiveElements: [
        {
          tag: "input",
          role: "textbox",
          name: "leo@example.com",
          selector: "#email",
          x: 0,
          y: 0,
          width: 100,
          height: 20,
        },
      ],
      accessibilityTree: {
        nodes: [{ name: { value: "AX name secret" }, value: { value: "AX value secret" } }],
      },
      consoleEntries: [
        { level: "log", text: "token=console-secret", timestamp: "2026-01-01T00:00:00Z" },
      ],
      networkEntries: [],
      actionTimeline: [],
      screenshot: testScreenshot(),
    }) as {
      readonly accessibilityTree: unknown;
      readonly title: string;
      readonly visibleText: string;
      readonly interactiveElements: ReadonlyArray<{ readonly name: string }>;
      readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      readonly screenshot: { readonly data: string };
    };

    expect(result.accessibilityTree).toEqual({
      redactionStatus: "omitted-unverified-accessibility-tree",
    });
    expect(result.title).toBe("[REDACTED]");
    expect(result.visibleText).toBe("[REDACTED]");
    expect(result.interactiveElements[0]?.name).toBe("[REDACTED]");
    expect(result.consoleEntries[0]?.text).toBe("[REDACTED]");
    const png = PNG.sync.read(Buffer.from(result.screenshot.data, "base64"));
    expect([...png.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
  });

  it("omits arbitrary evaluation output and redacts local artifact paths", () => {
    expect(
      redactProviderVisiblePreviewResult("evaluate", {
        arbitrary: "unrecognizable-secret",
        screenshot: testScreenshot(),
      }),
    ).toEqual({ redactionStatus: "omitted-unverified-preview-evaluation" });

    expect(
      redactProviderVisiblePreviewResult("recordingStop", {
        id: "recording-1",
        tabId: "tab-1",
        path: "/Users/leo/.akeru/browser-artifacts/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 123,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).toMatchObject({ path: "[REDACTED]" });

    expect(
      redactProviderVisiblePreviewResult("status", {
        chatPath: "/tmp/chat.json",
        logPath: "/tmp/browser.log",
        uploadPath: "/tmp/upload.png",
      }),
    ).toEqual({
      chatPath: "[REDACTED]",
      logPath: "[REDACTED]",
      uploadPath: "[REDACTED]",
    });
  });

  it("fails closed when a provider screenshot cannot be masked", () => {
    expect(() =>
      redactProviderVisiblePreviewResult("snapshot", {
        url: "http://example.test/",
        title: "Example",
        loading: false,
        visibleText: "safe",
        interactiveElements: [],
        accessibilityTree: {},
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
        screenshot: { ...testScreenshot(), data: Buffer.from("raw pixels").toString("base64") },
      }),
    ).toThrow();
  });

  it("rejects screenshot strings and nested image data", () => {
    expect(() =>
      redactProviderVisiblePreviewResult("status", { screenshot: "raw-base64-data" }),
    ).toThrow("Unredacted screenshot data is not provider-safe.");
    expect(() =>
      redactProviderVisiblePreviewResult("status", { image: { data: "raw-base64-data" } }),
    ).toThrow("Unredacted screenshot data is not provider-safe.");
    expect(() =>
      redactProviderVisiblePreviewResult("status", {
        screenshot: [{ data: "raw-base64-data" }],
      }),
    ).toThrow("Unredacted screenshot data is not provider-safe.");
  });
});

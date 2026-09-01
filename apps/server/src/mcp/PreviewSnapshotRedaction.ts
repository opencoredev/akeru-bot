import { PNG } from "pngjs";

import { redactSensitiveText } from "./SensitiveDataRedaction.ts";

const REDACTED = "[REDACTED]";
export const MAX_SCREENSHOT_BYTES = 20 * 1_024 * 1_024;
const MAX_SCREENSHOT_PIXELS = 16_000_000;
const secretField =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|set-cookie|session|sessionId|clientSecret|awsSecretAccessKey)$/i;

function redactValue(value: unknown, fieldName?: string): { value: unknown; redacted: boolean } {
  if (fieldName && secretField.test(fieldName)) return { value: REDACTED, redacted: true };
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    let redacted = false;
    const items = value.map((item) => {
      const result = redactValue(item);
      redacted ||= result.redacted;
      return result.value;
    });
    return { value: items, redacted };
  }
  if (typeof value !== "object" || value === null) return { value, redacted: false };

  let redacted = false;
  const object: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const result = redactValue(item, key);
    redacted ||= result.redacted;
    object[key] = result.value;
  }
  return { value: object, redacted };
}

function readPngDimensions(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length === 0 || buffer.length > MAX_SCREENSHOT_BYTES) {
    throw new Error("Screenshot size is invalid.");
  }
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Screenshot is not a valid PNG.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0 || width * height > MAX_SCREENSHOT_PIXELS) {
    throw new Error("Screenshot dimensions are invalid.");
  }
  return { width, height };
}

function decodePng(data: Uint8Array) {
  readPngDimensions(data);
  return PNG.sync.read(Buffer.from(data), { checkCRC: true });
}

function blankPng(data: Uint8Array) {
  const png = decodePng(data);
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = 0;
    png.data[offset + 1] = 0;
    png.data[offset + 2] = 0;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
}

export interface PreviewScreenshotInput {
  readonly mimeType: "image/png";
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

export function redactComputerScreenshot(input: {
  readonly mediaType: "image/png";
  readonly data: Uint8Array;
}) {
  return { mediaType: input.mediaType, data: blankPng(input.data) };
}

export function redactPreviewSnapshot(
  page: Readonly<Record<string, unknown>>,
  screenshot: PreviewScreenshotInput,
) {
  const bytes = Buffer.from(screenshot.data, "base64");
  const dimensions = readPngDimensions(bytes);
  if (dimensions.width !== screenshot.width || dimensions.height !== screenshot.height) {
    throw new Error("Preview screenshot dimensions are invalid.");
  }
  const redactedPage = redactValue(page);
  if (typeof redactedPage.value !== "object" || redactedPage.value === null) {
    throw new Error("Preview snapshot data is invalid.");
  }
  return {
    page: redactedPage.value as Readonly<Record<string, unknown>>,
    screenshot: blankPng(bytes),
    frameRedacted: true,
  };
}

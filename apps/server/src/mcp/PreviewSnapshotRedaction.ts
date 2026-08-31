import {
  PreviewAutomationRecordingArtifact,
  PreviewAutomationSnapshot,
  type PreviewAutomationOperation,
} from "@t3tools/contracts";
import { redactSensitiveText } from "@t3tools/shared/sensitiveDataRedaction";
import * as Schema from "effect/Schema";
import { PNG } from "pngjs";

const REDACTED = "[REDACTED]";
export const MAX_SCREENSHOT_BYTES = 20 * 1_024 * 1_024;
const MAX_SCREENSHOT_PIXELS = 16_000_000;
const screenshotField = /^(?:screenshot|image|frame)$/i;
const secretField =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|set-cookie|session|sessionId|clientSecret|awsSecretAccessKey|(?:artifact|chat|file|log|recording|upload)?path)$/i;
const decodeSnapshot = Schema.decodeUnknownSync(PreviewAutomationSnapshot);
const decodeRecordingArtifact = Schema.decodeUnknownSync(PreviewAutomationRecordingArtifact);

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
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    const result = redactValue(item, key);
    redacted ||= result.redacted;
    entries.push([key, result.value]);
  }
  return { value: Object.fromEntries(entries), redacted };
}

function rejectScreenshotPayload(value: unknown, fieldName?: string): void {
  if (typeof value === "string" && fieldName && screenshotField.test(fieldName)) {
    throw new Error("Unredacted screenshot data is not provider-safe.");
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectScreenshotPayload(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (
    Object.hasOwn(value, "data") &&
    ((fieldName !== undefined && screenshotField.test(fieldName)) ||
      Object.hasOwn(value, "mimeType"))
  ) {
    throw new Error("Unredacted screenshot data is not provider-safe.");
  }
  for (const [key, item] of Object.entries(value)) rejectScreenshotPayload(item, key);
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
    screenshot: redactComputerScreenshot({ mediaType: "image/png", data: bytes }).data,
    frameRedacted: true,
  };
}

export function redactProviderVisiblePreviewResult(
  operation: PreviewAutomationOperation,
  input: unknown,
): unknown {
  if (operation === "evaluate") {
    return { redactionStatus: "omitted-unverified-preview-evaluation" };
  }
  if (operation === "snapshot") {
    const snapshot = decodeSnapshot(input);
    const { accessibilityTree: _accessibilityTree, screenshot, ...page } = snapshot;
    const redacted = redactPreviewSnapshot(page, screenshot);
    return {
      ...redacted.page,
      accessibilityTree: { redactionStatus: "omitted-unverified-accessibility-tree" },
      screenshot: {
        ...screenshot,
        data: Buffer.from(redacted.screenshot).toString("base64"),
      },
    };
  }

  rejectScreenshotPayload(input);
  if (operation === "recordingStop") {
    return { ...decodeRecordingArtifact(input), path: REDACTED };
  }
  return redactValue(input).value;
}

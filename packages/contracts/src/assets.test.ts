import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AttachmentCreateUploadUrlInput } from "./assets.ts";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "./orchestration.ts";

const isUploadInput = Schema.is(AttachmentCreateUploadUrlInput);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 3,
} as const;

describe("AttachmentCreateUploadUrlInput", () => {
  it("accepts supported image attachments", () => {
    expect(isUploadInput(uploadInput)).toBe(true);
  });

  it("accepts supported document attachments", () => {
    expect(isUploadInput({ name: "notes.md", mimeType: "text/markdown", sizeBytes: 3 })).toBe(true);
    expect(isUploadInput({ name: "report.pdf", mimeType: "application/pdf", sizeBytes: 3 })).toBe(
      true,
    );
  });

  it("rejects image types that providers do not support", () => {
    expect(isUploadInput({ ...uploadInput, mimeType: "image/svg+xml" })).toBe(false);
  });

  it("rejects active document content", () => {
    expect(isUploadInput({ name: "page.html", mimeType: "text/html", sizeBytes: 3 })).toBe(false);
  });

  it("rejects empty and oversized uploads", () => {
    expect(isUploadInput({ ...uploadInput, sizeBytes: 0 })).toBe(false);
    expect(
      isUploadInput({ ...uploadInput, sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 }),
    ).toBe(false);
  });
});

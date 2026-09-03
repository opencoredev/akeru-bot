import { describe, expect, it } from "vite-plus/test";

import { resolveBotFileAttachment } from "./botFileAttachment";

describe("resolveBotFileAttachment", () => {
  it("accepts supported images and documents", () => {
    expect(resolveBotFileAttachment({ name: "image.png", size: 3, type: "image/png" })).toEqual({
      type: "image",
      mimeType: "image/png",
    });
    expect(resolveBotFileAttachment({ name: "notes.md", size: 3, type: "" })).toEqual({
      type: "file",
      mimeType: "text/markdown",
    });
    expect(
      resolveBotFileAttachment({ name: "report.pdf", size: 3, type: "application/pdf" }),
    ).toEqual({ type: "file", mimeType: "application/pdf" });
  });

  it("rejects active content, unknown files, and empty files", () => {
    expect(resolveBotFileAttachment({ name: "page.html", size: 3, type: "text/html" })).toBeNull();
    expect(
      resolveBotFileAttachment({ name: "vector.svg", size: 3, type: "image/svg+xml" }),
    ).toBeNull();
    expect(resolveBotFileAttachment({ name: "notes.txt", size: 0, type: "text/plain" })).toBeNull();
  });
});

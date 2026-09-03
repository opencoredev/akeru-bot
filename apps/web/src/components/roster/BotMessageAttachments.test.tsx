import type { ChatAttachment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBotMessageAttachmentPreview } from "./BotMessageAttachments";

const attachments: ChatAttachment[] = [
  {
    type: "image",
    id: "attachment-first",
    name: "first.png",
    mimeType: "image/png",
    sizeBytes: 10,
  },
  {
    type: "image",
    id: "attachment-second",
    name: "second.png",
    mimeType: "image/png",
    sizeBytes: 20,
  },
];
const fileAttachment: ChatAttachment = {
  type: "file",
  id: "attachment-notes",
  name: "notes.md",
  mimeType: "text/markdown",
  sizeBytes: 30,
};

describe("sent bot message attachments", () => {
  it("preserves image order and opens the selected image", () => {
    expect(
      buildBotMessageAttachmentPreview(
        attachments,
        ["http://example.test/first", "http://example.test/second"],
        "attachment-second",
      ),
    ).toEqual({
      images: [
        { src: "http://example.test/first", name: "first.png" },
        { src: "http://example.test/second", name: "second.png" },
      ],
      index: 1,
    });
  });

  it("excludes unresolved and failed images from the preview", () => {
    expect(
      buildBotMessageAttachmentPreview(
        attachments,
        [null, "http://example.test/second"],
        "attachment-first",
      ),
    ).toBeNull();
    expect(
      buildBotMessageAttachmentPreview(
        attachments,
        ["http://example.test/first", "http://example.test/second"],
        "attachment-second",
        new Set(["attachment-second"]),
      ),
    ).toBeNull();
  });

  it("keeps documents out of the image lightbox", () => {
    expect(
      buildBotMessageAttachmentPreview(
        [...attachments, fileAttachment],
        ["http://example.test/first", "http://example.test/second", "http://example.test/notes"],
        fileAttachment.id,
      ),
    ).toBeNull();
  });
});

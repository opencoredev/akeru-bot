// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { stagePreviewSnapshot } from "../mcp/PreviewSnapshotCaptureBuffer.ts";
import { persistAkeruPreviewSnapshot } from "./AkeruPreviewSnapshotAttachment.ts";

const directories = new Set<string>();

function attachmentsDir() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-preview-attachment-"));
  directories.add(directory);
  return directory;
}

describe("persistAkeruPreviewSnapshot", () => {
  afterEach(() => {
    for (const directory of directories) {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
    directories.clear();
  });

  it("persists a PNG image block and removes its bytes from the activity result", () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const directory = attachmentsDir();
    const persisted = persistAkeruPreviewSnapshot({
      attachmentsDir: directory,
      threadId: "thread-1",
      result: {
        structuredContent: { url: "https://example.com", title: "Example" },
        content: [
          { type: "text", text: "page details" },
          { type: "image", mimeType: "image/png", data: png.toString("base64") },
        ],
      },
    });

    expect(persisted.attachment).toMatchObject({
      type: "image",
      name: "browser-screenshot.png",
      mimeType: "image/png",
      sizeBytes: png.byteLength,
    });
    expect(persisted.activityResult).toEqual({
      url: "https://example.com",
      title: "Example",
      screenshot: {
        attachmentId: persisted.attachment?.id,
        mimeType: "image/png",
        sizeBytes: png.byteLength,
      },
    });
    expect(JSON.stringify(persisted.activityResult)).not.toContain(png.toString("base64"));
    expect(
      NodeFS.readFileSync(NodePath.join(directory, `${persisted.attachment?.id}.png`)),
    ).toEqual(png);
  });

  it("persists the non-enumerable image content returned by Mastra MCP tools", () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
    const directory = attachmentsDir();
    const result = { url: "https://example.com", title: "Example Domain" };
    Object.defineProperty(result, Symbol.for("mastra.mcp.callToolContent"), {
      value: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
      enumerable: false,
    });

    const persisted = persistAkeruPreviewSnapshot({
      attachmentsDir: directory,
      threadId: "thread-1",
      result,
    });

    expect(persisted.attachment).toMatchObject({
      mimeType: "image/png",
      sizeBytes: png.byteLength,
    });
    expect(persisted.activityResult).toMatchObject({
      url: "https://example.com",
      title: "Example Domain",
      screenshot: { attachmentId: persisted.attachment?.id },
    });
  });

  it("persists the local original instead of the provider-safe masked image", () => {
    const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 10, 11, 12]);
    const masked = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0]);
    const directory = attachmentsDir();
    const threadId = "thread-local-original";
    stagePreviewSnapshot(threadId, {
      screenshot: { mimeType: "image/png", data: original.toString("base64") },
    });

    const persisted = persistAkeruPreviewSnapshot({
      attachmentsDir: directory,
      threadId,
      result: {
        structuredContent: { title: "Example Domain" },
        content: [{ type: "image", mimeType: "image/png", data: masked.toString("base64") }],
      },
    });

    expect(
      NodeFS.readFileSync(NodePath.join(directory, `${persisted.attachment?.id}.png`)),
    ).toEqual(original);
    expect(NodeFS.readdirSync(directory).some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("does not fail the tool when the attachment cannot be written", () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 7, 8, 9]);
    const directory = attachmentsDir();
    NodeFS.writeFileSync(NodePath.join(directory, "blocked"), "file");

    expect(
      persistAkeruPreviewSnapshot({
        attachmentsDir: NodePath.join(directory, "blocked"),
        threadId: "thread-1",
        result: {
          structuredContent: { title: "Example Domain" },
          content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
        },
      }),
    ).toEqual({
      attachment: null,
      activityResult: {
        title: "Example Domain",
        screenshot: { status: "not-persisted" },
      },
    });
  });

  it("ignores malformed image results", () => {
    const directory = attachmentsDir();
    expect(
      persistAkeruPreviewSnapshot({
        attachmentsDir: directory,
        threadId: "thread-1",
        result: {
          content: [{ type: "image", mimeType: "image/png", data: "not-a-png" }],
        },
      }),
    ).toEqual({
      attachment: null,
      activityResult: { screenshot: { status: "not-persisted" } },
    });
    expect(NodeFS.readdirSync(directory)).toEqual([]);
  });
});

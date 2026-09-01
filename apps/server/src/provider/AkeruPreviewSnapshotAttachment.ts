// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type ChatImageAttachment } from "@t3tools/contracts";

import { createAttachmentId } from "../attachmentStore.ts";
import { takePreviewSnapshot } from "../mcp/PreviewSnapshotCaptureBuffer.ts";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MCP_CALL_TOOL_CONTENT = Symbol.for("mastra.mcp.callToolContent");

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function imageBytes(value: unknown): Buffer | null {
  if (typeof value === "string") {
    const encoded = value.startsWith("data:image/png;base64,")
      ? value.slice("data:image/png;base64,".length)
      : value;
    return Buffer.from(encoded, "base64");
  }
  return value instanceof Uint8Array ? Buffer.from(value) : null;
}

function findPngImage(result: unknown): Buffer | null {
  const root = record(result);
  if (!root) return null;

  const hiddenContent = Reflect.get(root, MCP_CALL_TOOL_CONTENT) as unknown;
  const content = Array.isArray(root.content)
    ? root.content
    : Array.isArray(hiddenContent)
      ? hiddenContent
      : [];
  for (const block of content) {
    const image = record(block);
    if (!image || image.type !== "image" || image.mimeType !== "image/png") continue;
    const bytes = imageBytes(image.data);
    if (bytes) return bytes;
  }

  const screenshot = record(root.screenshot);
  if (screenshot?.mimeType !== "image/png") return null;
  return imageBytes(screenshot.data);
}

function validPng(bytes: Buffer): boolean {
  return (
    bytes.byteLength > 0 &&
    bytes.byteLength <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES &&
    bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  );
}

export interface PersistedPreviewSnapshot {
  readonly attachment: ChatImageAttachment | null;
  readonly activityResult: unknown;
}

export function persistAkeruPreviewSnapshot(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly result: unknown;
}): PersistedPreviewSnapshot {
  const bytes = takePreviewSnapshot(input.threadId) ?? findPngImage(input.result);
  const root = record(input.result);
  const structuredResult =
    record(root?.structuredContent) ??
    (root && Array.isArray(Reflect.get(root, MCP_CALL_TOOL_CONTENT)) ? root : {});
  if (!bytes || !validPng(bytes)) {
    return {
      attachment: null,
      activityResult: {
        ...structuredResult,
        screenshot: { status: "not-persisted" },
      },
    };
  }

  const attachmentId = createAttachmentId(input.threadId);
  if (!attachmentId) {
    return {
      attachment: null,
      activityResult: { screenshot: { status: "not-persisted" } },
    };
  }
  try {
    NodeFS.mkdirSync(input.attachmentsDir, { recursive: true });
    const finalPath = NodePath.join(input.attachmentsDir, `${attachmentId}.png`);
    const temporaryPath = `${finalPath}.part`;
    try {
      NodeFS.writeFileSync(temporaryPath, bytes, { flag: "wx" });
      NodeFS.renameSync(temporaryPath, finalPath);
    } catch (cause) {
      NodeFS.rmSync(temporaryPath, { force: true });
      throw cause;
    }
  } catch {
    return {
      attachment: null,
      activityResult: {
        ...structuredResult,
        screenshot: { status: "not-persisted" },
      },
    };
  }

  const attachment = {
    type: "image",
    id: attachmentId,
    name: "browser-screenshot.png",
    mimeType: "image/png",
    sizeBytes: bytes.byteLength,
  } as const satisfies ChatImageAttachment;
  return {
    attachment,
    activityResult: {
      ...structuredResult,
      screenshot: {
        attachmentId,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      },
    },
  };
}

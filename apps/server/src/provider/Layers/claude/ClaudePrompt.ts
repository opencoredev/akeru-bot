import { type SettingSource, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderInstanceId, type ProviderSendTurnInput } from "@akeru/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelSelectionStringOptionValue,
  resolvePromptInjectedEffort,
} from "@akeru/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import { planClaudeSkillDispatch } from "../../Drivers/ClaudeSkillDispatch.ts";
import { getClaudeModelCapabilities } from "./ClaudeModels.ts";
import { ProviderAdapterRequestError } from "../../Errors.ts";

import { PROVIDER } from "./ClaudeAdapterState.ts";

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const isSupportedClaudeImageMimeType = (
  mimeType: string,
): mimeType is Parameters<typeof buildClaudeImageContentBlock>[0]["mimeType"] =>
  SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(mimeType);

export const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

export function buildPromptText(
  input: ProviderSendTurnInput,
  boundInstanceId: ProviderInstanceId,
): string {
  const rawEffort =
    input.modelSelection?.instanceId === boundInstanceId
      ? getModelSelectionStringOptionValue(input.modelSelection, "effort")
      : null;

  const claudeModel =
    input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection.model : undefined;

  const caps = getClaudeModelCapabilities(claudeModel);

  const promptEffort = resolvePromptInjectedEffort(caps, rawEffort);

  return applyClaudePromptEffortPrefix(input.input?.trim() ?? "", promptEffort);
}

export function buildUserMessage(input: {
  readonly sdkContent: Exclude<SDKUserMessage["message"]["content"], string>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent,
    },
  };
}

export function buildClaudeImageContentBlock(input: {
  readonly mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  readonly bytes: Uint8Array;
}): Exclude<SDKUserMessage["message"]["content"], string>[number] {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

export const buildUserMessageEffect = Effect.fn("buildUserMessageEffect")(function* (
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
    readonly boundInstanceId: ProviderInstanceId;
    readonly skillNames: ReadonlySet<string>;
  },
) {
  const text = buildPromptText(input, dependencies.boundInstanceId);
  const sdkContent: Exclude<SDKUserMessage["message"]["content"], string> = [];

  // Claude Code expands a skill only from the last text block, and only when
  // `/name` is its first character. Split a `$skill` mention into leading text
  // and a trailing slash command so the surrounding prose survives.
  const dispatch = planClaudeSkillDispatch(text, dependencies.skillNames);

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }

    const imageMimeType = attachment.mimeType;

    if (!isSupportedClaudeImageMimeType(imageMimeType)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
      });
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    });

    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: "Failed to read attachment file.",
            cause,
          }),
      ),
    );

    sdkContent.push(
      buildClaudeImageContentBlock({
        mimeType: imageMimeType,
        bytes,
      }),
    );
  }

  // Images go first so the slash command remains the last text block.
  if (dispatch) {
    if (dispatch.leadingText !== undefined) {
      sdkContent.push({ type: "text", text: dispatch.leadingText });
    }

    sdkContent.push({ type: "text", text: dispatch.commandText });
  } else if (text.length > 0) {
    sdkContent.push({ type: "text", text });
  }

  return buildUserMessage({ sdkContent });
});

/**
 * Bounds image-tool content before it reaches sinks outside the caller's
 * chat transcript: work-log activities, approval activities, observational
 * memory, and every consumer of the event store (analytics, logs).
 *
 * Routing fields stay published (`operation`, `provider`, `allowProvider`,
 * `count`, `quality`, `aspectRatio`) so activities and approval records keep
 * their meaning. The prompt text and input-image references never leave.
 */
import type { MastraDBMessage } from "@mastra/core/agent-controller";
import * as Predicate from "effect/Predicate";
import { decodeImageGenerationRequest } from "@akeru/contracts";
import type { ProviderRuntimeEvent } from "@akeru/contracts";

import { IMAGE_PROVIDER_LABELS } from "./router.ts";

/** Catalog tool ids whose input can carry prompt text and image references. */
const IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "GenerateImage",
  // Legacy MCP registration for the same tool.
  "generate_image",
]);

/** Image-request fields that carry user content, not routing or shape. */
const IMAGE_TOOL_CONTENT_KEYS: ReadonlySet<string> = new Set(["prompt", "inputImages"]);

export const isImageToolName = (toolName: string | undefined): boolean =>
  toolName !== undefined && IMAGE_TOOL_NAMES.has(toolName);

/** Tool args as they arrive on runtime events (`item.started`, `request.opened`). */
type RuntimeEventArgs = Extract<
  ProviderRuntimeEvent,
  { type: "request.opened" }
>["payload"]["args"];

/**
 * Tool args safe to publish or persist for an image call. Non-image tools and
 * non-object args pass through unchanged.
 */
export function boundedImageToolArgs(
  toolName: string | undefined,
  args: RuntimeEventArgs,
): RuntimeEventArgs {
  if (!isImageToolName(toolName) || !Predicate.isObject(args) || Array.isArray(args)) {
    return args;
  }

  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !IMAGE_TOOL_CONTENT_KEYS.has(key)),
  );
}

/**
 * Approval-card detail for an image call that sends the user's chat images to
 * a named provider. Returns undefined when the input does not name a provider
 * for an image-sending request, so generic tool details still apply.
 */
export function imageConsentDetail(toolInput: RuntimeEventArgs): string | undefined {
  const decoded = decodeImageGenerationRequest(toolInput);

  if (!decoded.ok) return undefined;

  const { request } = decoded;
  const provider = request.allowProvider ?? request.provider;

  if (!provider) return undefined;

  const sendsImages = request.operation === "edit" || (request.inputImages?.length ?? 0) > 0;

  if (!sendsImages) return undefined;

  return `Send the chat images to ${IMAGE_PROVIDER_LABELS[provider]}?`;
}

const boundInvocation = <T extends { toolName?: unknown; args?: unknown; rawInput?: unknown }>(
  invocation: T,
): T => {
  if (!Predicate.isString(invocation.toolName) || !isImageToolName(invocation.toolName)) {
    return invocation;
  }

  return {
    ...invocation,
    ...(invocation.args !== undefined
      ? { args: boundedImageToolArgs(invocation.toolName, invocation.args) }
      : {}),
    ...(invocation.rawInput !== undefined
      ? { rawInput: boundedImageToolArgs(invocation.toolName, invocation.rawInput) }
      : {}),
  };
};

/**
 * Bounds image-tool args inside one persisted Mastra message: `tool-invocation`
 * parts and the legacy `content.toolInvocations` mirror. Tool results stay
 * untouched; the image result contract carries no prompt.
 */
export function boundedImageToolMessage(message: MastraDBMessage): MastraDBMessage {
  const content = message.content;
  const parts = Array.isArray(content?.parts) ? content.parts : [];

  let changed = false;

  const boundedParts = parts.map((part) => {
    if (part.type !== "tool-invocation") return part;

    const bounded = boundInvocation(part.toolInvocation);
    changed ||= bounded !== part.toolInvocation;

    return bounded === part.toolInvocation ? part : { ...part, toolInvocation: bounded };
  });

  const toolInvocations = content?.toolInvocations;

  const boundedToolInvocations = Array.isArray(toolInvocations)
    ? toolInvocations.map((invocation) => {
        const bounded = boundInvocation(invocation);
        changed ||= bounded !== invocation;

        return bounded;
      })
    : toolInvocations;

  if (!changed) return message;

  return {
    ...message,
    content: {
      ...content,
      parts: boundedParts,
      ...(boundedToolInvocations !== toolInvocations
        ? { toolInvocations: boundedToolInvocations }
        : {}),
    },
  };
}

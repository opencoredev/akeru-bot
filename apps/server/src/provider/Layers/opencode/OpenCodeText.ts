import * as DateTime from "effect/DateTime";
import type { Part } from "@opencode-ai/sdk/v2";
import * as Option from "effect/Option";

import {
  type OpenCodeTextPart,
  type OpenCodeTextPartState,
  type OpenCodeSessionContext,
} from "./OpenCodeAdapterState.ts";

export function forgetOpenCodeTextPart(context: OpenCodeSessionContext, partID: string): void {
  const part = context.textPartById.get(partID);
  if (!part) {
    return;
  }
  context.textPartById.delete(partID);
  const parts = context.textPartsByMessageId.get(part.messageID);
  parts?.delete(partID);
  if (parts?.size === 0) {
    context.textPartsByMessageId.delete(part.messageID);
  }
}

export function retainOpenCodeTextPart(
  context: OpenCodeSessionContext,
  part: OpenCodeTextPart,
): OpenCodeTextPartState {
  const previous = context.textPartById.get(part.id);
  const previousInMessage = previous?.messageID === part.messageID ? previous : undefined;
  if (previous && !previousInMessage) {
    forgetOpenCodeTextPart(context, part.id);
  }
  const parts =
    context.textPartsByMessageId.get(part.messageID) ?? new Map<string, OpenCodeTextPartState>();
  const state: OpenCodeTextPartState = {
    id: part.id,
    messageID: part.messageID,
    type: part.type,
    text: part.text,
    ...(part.time !== undefined ? { time: part.time } : {}),
    emittedText: previousInMessage?.emittedText,
    completed: previousInMessage?.completed ?? false,
  };
  parts.set(part.id, state);
  context.textPartsByMessageId.set(part.messageID, parts);
  context.textPartById.set(part.id, state);
  return state;
}

export function forgetOpenCodeTextMessage(
  context: OpenCodeSessionContext,
  messageID: string,
): void {
  const parts = context.textPartsByMessageId.get(messageID);
  if (!parts) {
    return;
  }
  for (const partId of parts.keys()) {
    context.textPartById.delete(partId);
  }
  context.textPartsByMessageId.delete(messageID);
}

export function resolveTextStreamKind(
  part: Pick<Part, "type">,
): "assistant_text" | "reasoning_text" {
  return part.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

export function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

export function resolveLatestAssistantText(
  previousText: string | undefined,
  nextText: string,
): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  return {
    nextText: previousText + delta,
    deltaToEmit: delta,
  };
}

export const isoFromEpochMs = (value: number) =>
  DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );

export function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

export function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

export function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

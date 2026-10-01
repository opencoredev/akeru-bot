import type * as EffectAcpSchema from "effect-acp/schema";
import { deriveToolActivityPresentation } from "@akeru/shared/toolActivity";
import type { ToolLifecycleItemType } from "@akeru/contracts";

import { isRecord } from "./AcpProtocolValues.ts";
import {
  type AcpToolCallState,
  type AcpToolCallUpdate,
  type AcpToolCallEmitDecisionInput,
  type AcpToolCallEmitDecision,
} from "./AcpRuntimeTypes.ts";

export function normalizeToolCallStatus(
  raw: unknown,
  fallback?: "pending" | "inProgress" | "completed" | "failed",
): "pending" | "inProgress" | "completed" | "failed" | undefined {
  switch (raw) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return fallback;
  }
}

export function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const parts: Array<string> = [];

  for (const entry of value) {
    if (typeof entry === "string") {
      const part = entry.trim();

      if (part.length > 0) {
        parts.push(part);
      }
    }
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }

  const match = /`([^`]+)`/.exec(title);

  return match?.[1]?.trim() || undefined;
}

export function extractToolCallCommand(
  rawInput: unknown,
  title: string | undefined,
): string | undefined {
  if (isRecord(rawInput)) {
    const directCommand = normalizeCommandValue(rawInput.command);

    if (directCommand) {
      return directCommand;
    }

    const executable = typeof rawInput.executable === "string" ? rawInput.executable.trim() : "";
    const args = normalizeCommandValue(rawInput.args);

    if (executable && args) {
      return `${executable} ${args}`;
    }

    if (executable) {
      return executable;
    }
  }

  return extractCommandFromTitle(title);
}

// Some ACP agents (observed with Grok's CLI) resend the ENTIRE accumulated tool-call
// output on every `tool_call_update` notification instead of a delta, so a redrawing
// terminal progress bar can balloon a single tool call to hundreds of KB per update at
// several updates per second. Cap what we retain/emit to a bounded tail so one busy tool
// call cannot flood runtime event ingestion. We always keep the tail: `tool_call_update`
// deltas routinely omit `kind`, so there is no reliable way to tell a redrawing terminal
// from another tool here, and the end is the useful part of any live-growing output.
export const TOOL_CALL_CONTENT_MAX_CHARS = 8_000;

export const TOOL_CALL_CONTENT_TRUNCATION_MARKER = "[Earlier output truncated]\n\n";

export function boundToolCallOutputText(text: string): string {
  if (text.length <= TOOL_CALL_CONTENT_MAX_CHARS) {
    return text;
  }

  const tail = text.slice(text.length - TOOL_CALL_CONTENT_MAX_CHARS);

  return `${TOOL_CALL_CONTENT_TRUNCATION_MARKER}${tail}`;
}

export const RAW_OUTPUT_TEXT_FIELDS = ["content", "stdout", "stderr", "output"] as const;

// `rawOutput` is provider-defined and, for terminal-shaped tools, mirrors the same
// cumulative text-growth problem as `content` (see the comment above). Bound its known
// text-bearing fields the same way so a chatty provider cannot smuggle unbounded output
// through this field instead.
export function boundToolCallRawOutput(rawOutput: unknown): unknown {
  if (!isRecord(rawOutput)) {
    return rawOutput;
  }

  let changed = false;
  const bounded: Record<string, unknown> = { ...rawOutput };

  for (const field of RAW_OUTPUT_TEXT_FIELDS) {
    const value = rawOutput[field];

    if (typeof value === "string" && value.length > TOOL_CALL_CONTENT_MAX_CHARS) {
      bounded[field] = boundToolCallOutputText(value);
      changed = true;
    }
  }

  return changed ? bounded : rawOutput;
}

export interface ExtractedToolCallContent {
  readonly text: string | undefined;
  readonly content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | undefined;
}

export function toolCallContentText(entry: EffectAcpSchema.ToolCallContent): string | undefined {
  if (entry.type !== "content" || entry.content.type !== "text") {
    return undefined;
  }

  return entry.content.text;
}

export function extractTextContentFromToolCallContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): ExtractedToolCallContent {
  if (!content) {
    return { text: undefined, content: undefined };
  }

  const chunks: Array<string> = [];

  for (const entry of content) {
    const text = toolCallContentText(entry)?.trim();

    if (text) {
      chunks.push(text);
    }
  }

  if (chunks.length === 0) {
    return { text: undefined, content };
  }

  const joined = chunks.join("\n");

  if (joined.length <= TOOL_CALL_CONTENT_MAX_CHARS) {
    return { text: joined, content };
  }

  const bounded = boundToolCallOutputText(joined);

  // Collapse the text entries into a single bounded one at the final contributing text entry,
  // and leave every other entry kind (diffs, images, resource links) in its original relative
  // order. The retained tail came from that text entry, so placing it there also preserves its
  // ordering relative to interleaved non-text content and ignores later blank text entries.
  const lastContributingTextIndex = content.reduce(
    (lastIndex, entry, index) => (toolCallContentText(entry)?.trim() ? index : lastIndex),
    -1,
  );

  const boundedContent = content.flatMap((entry, index) => {
    if (toolCallContentText(entry) === undefined) {
      return [entry];
    }

    if (index !== lastContributingTextIndex) {
      return [];
    }

    return [{ type: "content", content: { type: "text", text: bounded } } as const];
  });

  return { text: bounded, content: boundedContent };
}

export function normalizeToolKind(kind: unknown): string | undefined {
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : undefined;
}

export function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

export function makeToolCallState(
  input: {
    readonly toolCallId: string;
    readonly title?: string | null | undefined;
    readonly kind?: EffectAcpSchema.ToolKind | null | undefined;
    readonly status?: EffectAcpSchema.ToolCallStatus | null | undefined;
    readonly rawInput?: unknown;
    readonly rawOutput?: unknown;
    readonly content?: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined;
    readonly locations?: ReadonlyArray<EffectAcpSchema.ToolCallLocation> | null | undefined;
  },
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  const toolCallId = input.toolCallId.trim();

  if (!toolCallId) {
    return undefined;
  }

  const title = input.title?.trim() || undefined;
  const command = extractToolCallCommand(input.rawInput, title);
  const extractedContent = extractTextContentFromToolCallContent(input.content);
  const textContent = extractedContent.text;

  const normalizedTitle =
    title && title.toLowerCase() !== "terminal" && title.toLowerCase() !== "tool call"
      ? title
      : undefined;

  const data: Record<string, unknown> = { toolCallId };
  const kind = normalizeToolKind(input.kind);

  if (kind) {
    data.kind = kind;
  }

  if (command) {
    data.command = command;
  }

  if (input.rawInput !== undefined) {
    data.rawInput = input.rawInput;
  }

  if (input.rawOutput !== undefined) {
    data.rawOutput = boundToolCallRawOutput(input.rawOutput);
  }

  if (input.content !== undefined) {
    data.content = extractedContent.content ?? input.content;
  }

  if (input.locations !== undefined) {
    data.locations = input.locations;
  }

  const fallbackDetail = command ?? normalizedTitle ?? textContent;

  const hasPresentationSeed =
    title !== undefined ||
    kind !== undefined ||
    command !== undefined ||
    normalizedTitle !== undefined ||
    textContent !== undefined;

  const presentation = hasPresentationSeed
    ? deriveToolActivityPresentation({
        itemType: canonicalItemTypeFromAcpToolKind(kind),
        title,
        detail: fallbackDetail,
        data,
        fallbackSummary: title ?? "Tool",
      })
    : undefined;

  const status = normalizeToolCallStatus(input.status, options?.fallbackStatus);

  return {
    toolCallId,
    ...(kind ? { kind } : {}),
    ...(presentation?.summary ? { title: presentation.summary } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(presentation?.detail ? { detail: presentation.detail } : {}),
    data,
  };
}

export function parseTypedToolCallState(
  event: AcpToolCallUpdate,
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  return makeToolCallState(
    {
      toolCallId: event.toolCallId,
      title: event.title,
      kind: event.kind,
      status: event.status,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      content: event.content,
      locations: event.locations,
    },
    options,
  );
}

export function mergeToolCallState(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): AcpToolCallState {
  const nextKind = typeof next.data.kind === "string" ? next.data.kind : undefined;
  const kind = nextKind ?? previous?.kind;
  const title = next.title ?? previous?.title;
  const status = next.status ?? previous?.status;
  const command = next.command ?? previous?.command;
  const detail = next.detail ?? previous?.detail;

  return {
    toolCallId: next.toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data: {
      ...previous?.data,
      ...next.data,
    },
  };
}

// Even with bounded content (see TOOL_CALL_CONTENT_MAX_CHARS above), a redrawing terminal
// can still shift its bounded tail window on nearly every notification, which would emit
// a runtime event per redraw. Coalesce those: only emit early when the tool call's detail
// has grown meaningfully since the last emission, otherwise batch up to a small number of
// skipped updates before emitting anyway, so the UI still gets periodic progress and the
// final (completed/failed) state is always emitted immediately.
export const TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS = 256;

export const TOOL_CALL_UPDATE_COALESCE_LIMIT = 10;

export function decideToolCallUpdateEmission(
  input: AcpToolCallEmitDecisionInput,
): AcpToolCallEmitDecision {
  const { previous, next, lastEmittedDetailLength, skippedSinceEmit } = input;

  if (next.status === "completed" || next.status === "failed") {
    return { emit: true, skippedSinceEmit: 0 };
  }

  if (!next.detail) {
    return { emit: false, skippedSinceEmit };
  }

  if (previous === undefined || previous.title !== next.title) {
    return { emit: true, skippedSinceEmit: 0 };
  }

  if (previous.detail === next.detail) {
    return { emit: false, skippedSinceEmit };
  }

  const grewMeaningfully =
    lastEmittedDetailLength === undefined ||
    Math.abs(next.detail.length - lastEmittedDetailLength) >=
      TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS;

  if (grewMeaningfully || skippedSinceEmit + 1 >= TOOL_CALL_UPDATE_COALESCE_LIMIT) {
    return { emit: true, skippedSinceEmit: 0 };
  }

  return { emit: false, skippedSinceEmit: skippedSinceEmit + 1 };
}

// The parsed AcpToolCallState already carries bounded content (see makeToolCallState /
// extractTextContentFromToolCallContent above), but the raw JSON-RPC notification is also
// threaded through as `rawPayload` for logging/debugging and ends up persisted on the
// runtime event. Substitute the same bounded `content`/`rawOutput` there so an oversized
// cumulative update cannot smuggle the unbounded buffer back in through the raw payload.
export function boundToolCallRawPayload(
  params: EffectAcpSchema.SessionNotification,
  update: AcpToolCallUpdate,
  toolCall: AcpToolCallState,
): unknown {
  const boundedContent = toolCall.data.content;
  const boundedRawOutput = toolCall.data.rawOutput;
  const contentBounded = update.content !== undefined && boundedContent !== update.content;
  const rawOutputBounded = update.rawOutput !== undefined && boundedRawOutput !== update.rawOutput;

  if (!contentBounded && !rawOutputBounded) {
    return params;
  }

  return {
    ...params,
    update: {
      ...update,
      ...(contentBounded ? { content: boundedContent } : {}),
      ...(rawOutputBounded ? { rawOutput: boundedRawOutput } : {}),
    },
  };
}

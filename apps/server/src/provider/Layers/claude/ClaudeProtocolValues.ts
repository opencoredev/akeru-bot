import { type PermissionUpdate, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  ProviderItemId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { normalizeClaudeCliEffort } from "./ClaudeModels.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../../Errors.ts";

import {
  PROVIDER,
  type ClaudeTextStreamKind,
  type ClaudeToolResultStreamKind,
  type ClaudeSdkEffort,
  type ClaudeResumeState,
  type ClaudeSessionContext,
} from "./ClaudeAdapterState.ts";

export const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(
  Schema.fromJsonString(Schema.Unknown),
);

export const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Unknown),
);

export function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);

  return Exit.isSuccess(result) ? result.value : undefined;
}

/**
 * Permission updates applied for an "Always allow this session" decision.
 *
 * Claude Code's suggestions are reused when present but rescoped to
 * `destination: "session"` — echoing them verbatim would persist the
 * session-only choice as a permanent rule (suggestions typically target
 * `localSettings`, i.e. `.claude/settings.local.json`). When Claude Code
 * offers no suggestion — common for MCP tools — fall back to a whole-tool
 * session allow rule so the decision still sticks for the session instead of
 * silently degrading into a one-shot accept.
 */
export function toSessionPermissionUpdates(
  toolName: string,
  suggestions: ReadonlyArray<PermissionUpdate> | undefined,
): Array<PermissionUpdate> {
  const sessionScoped = (suggestions ?? []).map(
    (suggestion): PermissionUpdate => ({ ...suggestion, destination: "session" }),
  );

  if (sessionScoped.length > 0) {
    return sessionScoped;
  }

  return [
    {
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session",
    },
  ];
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

export function hasDurableClaudeSessionId(message: SDKMessage): boolean {
  if (message.type !== "system") {
    return true;
  }

  return (
    message.subtype !== "hook_started" &&
    message.subtype !== "hook_progress" &&
    message.subtype !== "hook_response"
  );
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }

  return fallback;
}

export function normalizeClaudeStreamMessages(
  cause: Cause.Cause<ProviderAdapterProcessError>,
): ReadonlyArray<string> {
  const errors: Array<string> = [];

  for (const error of Cause.prettyErrors(cause)) {
    const message = error.message.trim();

    if (message.length > 0) {
      errors.push(message);
    }
  }

  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();

  return squashed.length > 0 ? [squashed] : [];
}

export function getEffectiveClaudeAgentEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): ClaudeSdkEffort | null {
  const normalized = normalizeClaudeCliEffort(effort, model);

  return normalized ? (normalized as ClaudeSdkEffort) : null;
}

export function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.make(value);
}

export function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

export function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.make(value);
}

export function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }

  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;

  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.make(threadIdCandidate)
      : undefined;

  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;

  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;

  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;

  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

export function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();

  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }

  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }

  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }

  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }

  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }

  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }

  if (normalized.includes("image")) {
    return "image_view";
  }

  return "dynamic_tool_call";
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();

  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }

  const itemType = classifyToolItemType(toolName);

  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;

  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  // For agent/subagent tools, prefer the human-readable description or prompt
  // over raw JSON. The structured subagent_type is carried separately on the
  // task.* payloads (role) — the label is display-only.
  const itemType = classifyToolItemType(toolName);

  if (itemType === "collab_agent_tool_call") {
    const description =
      typeof input.description === "string" ? input.description.trim() : undefined;

    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : undefined;
    const label = description || (prompt ? prompt.slice(0, 200) : undefined);

    if (label) {
      return label;
    }
  }

  const serialized = encodeJsonStringForDiagnostics(input) ?? "[unserializable input]";

  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }

  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

export function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

export function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.make(options.providerItemId),
    };
  }

  return {};
}

export function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;

  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const candidate = block as { type?: unknown; text?: unknown };

    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

export function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };

  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

export function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

export function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };

  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

export function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  const result = decodeUnknownJsonStringExit(value);

  if (!Exit.isSuccess(result)) {
    return undefined;
  }

  const parsed = result.value;

  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

export function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  return encodeJsonStringForDiagnostics(input);
}

export function toolResultStreamKind(
  itemType: CanonicalItemType,
): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

export function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;

    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;

    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

export function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();

  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }

  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }

  return undefined;
}

export function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);

  if (sessionError) {
    return sessionError;
  }

  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `${method} failed`,
    cause,
  });
}

export function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as { type?: unknown };

  return typeof record.type === "string" ? record.type : undefined;
}

export function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as { subtype?: unknown };

  return typeof record.subtype === "string" ? record.subtype : undefined;
}

export function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);

  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);

    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;

      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }

      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

// Discriminator/identity keys carry no human-readable content; everything else
// on an unmodeled SDK message is potentially worth surfacing in the work log.
export const SDK_MESSAGE_NOISE_KEYS = new Set([
  "type",
  "subtype",
  "uuid",
  "parent_uuid",
  "session_id",
  "parent_tool_use_id",
  "request_id",
]);

// Pull the salient scalar content out of a message the adapter doesn't model
// yet, so the work-log row shows what actually arrived (e.g. a notification's
// text) instead of an opaque "unhandled subtype" placeholder. Nested structures
// are left to the full payload retained in the event's `detail`.
export function previewUnknownSdkContent(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const parts: string[] = [];

  for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
    if (SDK_MESSAGE_NOISE_KEYS.has(key)) {
      continue;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();

      if (trimmed.length > 0) {
        parts.push(`${key}: ${trimmed}`);
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  const joined = parts.join(" · ");

  return joined.length > 280 ? `${joined.slice(0, 279)}…` : joined;
}

export function describeUnknownSdkMessage(kind: string, message: unknown): string {
  const preview = previewUnknownSdkContent(message);

  return preview ? `${kind} — ${preview}` : `${kind} (no displayable text content)`;
}

export function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;

    if (typeof maybeId === "string") {
      return maybeId;
    }

    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };

    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

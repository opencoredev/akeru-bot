import * as Match from "effect/Match";
import { readProtocolRecord } from "../ProtocolJson.ts";
import { isProtocolRecord } from "../ProtocolJson.ts";
import { readProtocolJson } from "../ProtocolJson.ts";
import * as Predicate from "effect/Predicate";
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
  Schema.fromJsonString(Schema.Json),
);

export function encodeJsonStringForDiagnostics<Input>(input: Input): string | undefined {
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

  return normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "max" ||
    normalized === "xhigh"
    ? normalized
    : null;
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

export function readClaudeResumeState<Input0>(
  resumeCursorInput: Input0,
): ClaudeResumeState | undefined {
  const resumeCursor = readProtocolJson(resumeCursorInput);

  if (!resumeCursor || !isProtocolRecord(resumeCursor)) {
    return undefined;
  }

  const cursor = resumeCursor;

  const threadIdCandidate = Predicate.isString(cursor.threadId) ? cursor.threadId : undefined;

  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.make(threadIdCandidate)
      : undefined;

  const resumeCandidate = Predicate.isString(cursor.resume)
    ? cursor.resume
    : Predicate.isString(cursor.sessionId)
      ? cursor.sessionId
      : undefined;

  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;

  const resumeSessionAt = Predicate.isString(cursor.resumeSessionAt)
    ? cursor.resumeSessionAt
    : undefined;

  const turnCountValue = Predicate.isNumber(cursor.turnCount) ? cursor.turnCount : undefined;

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

  return Match.value(itemType).pipe(
    Match.when("command_execution", () => "command_execution_approval" as const),
    Match.when("file_change", () => "file_change_approval" as const),
    Match.orElse(() => "dynamic_tool_call" as const),
  );
}

export function summarizeToolRequest(toolName: string, input: Schema.JsonObject): string {
  const commandValue = input.command ?? input.cmd;
  const command = Predicate.isString(commandValue) ? commandValue : undefined;

  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  // For agent/subagent tools, prefer the human-readable description or prompt
  // over raw JSON. The structured subagent_type is carried separately on the
  // task.* payloads (role) — the label is display-only.
  const itemType = classifyToolItemType(toolName);

  if (itemType === "collab_agent_tool_call") {
    const description = Predicate.isString(input.description)
      ? input.description.trim()
      : undefined;

    const prompt = Predicate.isString(input.prompt) ? input.prompt.trim() : undefined;
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

  const content = message.message?.content;

  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];

  for (const block of content) {
    if (!block || !isProtocolRecord(block)) {
      continue;
    }

    const candidate = block;

    if (
      candidate.type === "text" &&
      Predicate.isString(candidate.text) &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

export function extractContentBlockText<Input0>(blockInput: Input0): string {
  const block = readProtocolJson(blockInput);

  if (!block || !isProtocolRecord(block)) {
    return "";
  }

  const candidate = block;

  return candidate.type === "text" && Predicate.isString(candidate.text) ? candidate.text : "";
}

export function extractTextContent<Input>(input: Input): string {
  return textContent(readProtocolJson(input));
}

function isJsonArray(value: Schema.Json | undefined): value is Schema.JsonArray {
  return Array.isArray(value);
}

function textContent(value: Schema.Json | undefined): string {
  if (Predicate.isString(value)) {
    return value;
  }

  if (isJsonArray(value)) {
    return value.map(textContent).join("");
  }

  if (!value || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    return "";
  }

  const record = value;

  if (Predicate.isString(record.text)) {
    return record.text;
  }

  return textContent(record.content);
}

export function extractExitPlanModePlan<Input0>(valueInput: Input0): string | undefined {
  const value = readProtocolJson(valueInput);

  if (!value || !isProtocolRecord(value)) {
    return undefined;
  }

  const record = value;

  return Predicate.isString(record.plan) && record.plan.trim().length > 0
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

export function tryParseJsonRecord(value: string): Schema.JsonObject | undefined {
  const result = decodeUnknownJsonStringExit(value);

  if (!Exit.isSuccess(result)) {
    return undefined;
  }

  const parsed = readProtocolJson(result.value);

  return parsed && isProtocolRecord(parsed) && !Array.isArray(parsed) ? parsed : undefined;
}

export function toolInputFingerprint(input: Schema.JsonObject): string | undefined {
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
  readonly block: Schema.JsonObject;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = message.message?.content;

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Schema.JsonObject;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || !isProtocolRecord(entry)) {
      continue;
    }

    const block = readProtocolRecord(entry);

    if (!block) continue;

    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = Predicate.isString(block.tool_use_id) ? block.tool_use_id : undefined;

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

export function sdkMessageType<Input0>(valueInput: Input0): string | undefined {
  const value = readProtocolJson(valueInput);

  if (!value || !isProtocolRecord(value)) {
    return undefined;
  }

  const record = value;

  return Predicate.isString(record.type) ? record.type : undefined;
}

export function sdkMessageSubtype<Input0>(valueInput: Input0): string | undefined {
  const value = readProtocolJson(valueInput);

  if (!value || !isProtocolRecord(value)) {
    return undefined;
  }

  const record = value;

  return Predicate.isString(record.subtype) ? record.subtype : undefined;
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
          ? sdkMessageType("delta" in message.event ? message.event.delta : undefined)
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
export function previewUnknownSdkContent<Input0>(messageInput: Input0): string | undefined {
  const message = readProtocolJson(messageInput);

  if (!message || !isProtocolRecord(message)) {
    return undefined;
  }

  const parts: string[] = [];

  for (const [key, value] of Object.entries(message)) {
    if (SDK_MESSAGE_NOISE_KEYS.has(key)) {
      continue;
    }

    if (Predicate.isString(value)) {
      const trimmed = value.trim();

      if (trimmed.length > 0) {
        parts.push(`${key}: ${trimmed}`);
      }
    } else if (Predicate.isNumber(value) || Predicate.isBoolean(value)) {
      parts.push(`${key}: ${String(value)}`);
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  const joined = parts.join(" · ");

  return joined.length > 280 ? `${joined.slice(0, 279)}…` : joined;
}

export function describeUnknownSdkMessage<Input0>(kind: string, messageInput: Input0): string {
  const message = readProtocolJson(messageInput);

  const preview = previewUnknownSdkContent(message);

  return preview ? `${kind} — ${preview}` : `${kind} (no displayable text content)`;
}

export function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = message.message.id;

    if (Predicate.isString(maybeId)) {
      return maybeId;
    }

    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event;

    if (
      event.type === "content_block_start" &&
      "id" in event.content_block &&
      Predicate.isString(event.content_block.id)
    ) {
      return event.content_block.id;
    }
  }

  return undefined;
}

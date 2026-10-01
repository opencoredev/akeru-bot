import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderEvent,
  type ProviderRequestKind,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ProviderApprovalDecision,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  type CodexLifecycleItem,
  type CodexToolUserInputQuestion,
  type CodexTurnTokenUsage,
} from "./CodexAdapterState.ts";

export const ApprovalDecisionPayload = Schema.Struct({
  decision: ProviderApprovalDecision,
});

export function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  const isPayload = Schema.is(schema);
  return isPayload(payload) ? payload : undefined;
}

export function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeCodexTokenUsage(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
  previous: CodexTurnTokenUsage | undefined,
):
  | { readonly snapshot: ThreadTokenUsageSnapshot; readonly total: CodexTurnTokenUsage }
  | undefined {
  const totalProcessedTokens = usage.total.totalTokens;
  const usedTokens = usage.last.totalTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const isNewModelCall =
    previous === undefined || totalProcessedTokens > previous.threadTotalTokens;
  const total = isNewModelCall
    ? {
        threadTotalTokens: totalProcessedTokens,
        totalTokens: (previous?.totalTokens ?? 0) + usedTokens,
        inputTokens: (previous?.inputTokens ?? 0) + usage.last.inputTokens,
        cachedInputTokens: (previous?.cachedInputTokens ?? 0) + usage.last.cachedInputTokens,
        outputTokens: (previous?.outputTokens ?? 0) + usage.last.outputTokens,
        reasoningOutputTokens:
          (previous?.reasoningOutputTokens ?? 0) + usage.last.reasoningOutputTokens,
      }
    : previous;
  const maxTokens = usage.modelContextWindow ?? undefined;
  const inputTokens = usage.last.inputTokens;
  const cachedInputTokens = usage.last.cachedInputTokens;
  const outputTokens = usage.last.outputTokens;
  const reasoningOutputTokens = usage.last.reasoningOutputTokens;

  return {
    total,
    snapshot: {
      usedTokens,
      ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
        ? { totalProcessedTokens }
        : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
      lastUsedTokens: total.totalTokens,
      lastInputTokens: total.inputTokens,
      lastCachedInputTokens: total.cachedInputTokens,
      lastOutputTokens: total.outputTokens,
      lastReasoningOutputTokens: total.reasoningOutputTokens,
      compactsAutomatically: true,
    },
  };
}

export function toTurnStatus(
  value: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"] | "cancelled",
): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

export function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

export function itemTitle(
  itemType: CanonicalItemType,
  item?: CodexLifecycleItem,
): string | undefined {
  if (itemType === "mcp_tool_call" && item?.type === "mcpToolCall") {
    return `${item.server} · ${item.tool}`;
  }
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

export function itemDetail(
  itemType: CanonicalItemType,
  item: CodexLifecycleItem,
): string | undefined {
  const itemRecord = item as Record<string, unknown>;
  const action = itemRecord.action as Record<string, unknown> | undefined;
  const actionQueries = Array.isArray(action?.queries) ? action.queries : [];
  const candidates = [
    ...(itemType === "web_search"
      ? [itemRecord.query, action?.query, ...actionQueries, action?.pattern, action?.url]
      : []),
    "command" in item ? item.command : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
    "path" in item ? item.path : undefined,
    "prompt" in item ? item.prompt : undefined,
  ];

  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

export function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "mcpServer/elicitation/request":
      return "mcp_elicitation_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromKind(kind: ProviderRequestKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    case "mcp-elicitation":
      return "mcp_elicitation_approval";
    default:
      return "unknown";
  }
}

export function toCanonicalUserInputAnswers(
  answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => {
      const normalizedAnswers = value.answers.length === 1 ? value.answers[0]! : [...value.answers];
      return [questionId, normalizedAnswers] as const;
    }),
  );
}

export function toUserInputQuestions(questions: ReadonlyArray<CodexToolUserInputQuestion>) {
  const parsedQuestions = questions.flatMap((question) => {
    const options =
      question.options?.flatMap((option) => {
        const label = trimText(option.label);
        const description = trimText(option.description);
        if (!label || !description) {
          return [];
        }
        return [{ label, description }];
      }) ?? [];

    const id = trimText(question.id);
    const header = trimText(question.header);
    const prompt = trimText(question.question);
    if (!id || !header || !prompt || options.length === 0) {
      return [];
    }
    return [
      {
        id,
        header,
        question: prompt,
        options,
        multiSelect: false,
      },
    ];
  });

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

export function toThreadState(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

export function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

export function asRuntimeItemId(itemId: ProviderEvent["itemId"] & string): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

export function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

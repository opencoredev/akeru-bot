import { asRecord } from "../../ActivityPayloadBounds.ts";
import type { TaskAgentLinkage, RuntimeTaskUsage, RuntimeTaskStatus } from "@akeru/contracts";
import * as Predicate from "effect/Predicate";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  ChatAttachment,
  AkeruCreateRoutineInput,
  RoutineTimeZone,
  ApprovalRequestId,
  MessageId,
  type OrchestrationEvent,
  classifyTaskAgentKind,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationCheckpointSummary,
  type ProviderRuntimeEvent,
  ProductFeedbackToolDraft,
} from "@akeru/contracts";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

export const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`;

// Fallback when the in-memory description cache no longer has the task name
// (server restart, session-exit sweep, TTL/capacity eviction): earlier
// task.started/task.progress activities for the task are persisted with it.
export function findTaskTitleInActivities(
  activities:
    | ReadonlyArray<{
        readonly kind: string;
        readonly payload: unknown;
      }>
    | undefined,
  taskId: string,
): string | undefined {
  if (!activities) {
    return undefined;
  }

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];

    if (!activity || (activity.kind !== "task.started" && activity.kind !== "task.progress")) {
      continue;
    }

    const payload = asRecord(activity.payload) ?? undefined;

    if (payload?.taskId !== taskId) {
      continue;
    }

    const title = Predicate.isString(payload.title)
      ? payload.title
      : activity.kind === "task.started" && Predicate.isString(payload.detail)
        ? payload.detail
        : undefined;

    if (title && title.trim().length > 0) {
      return title;
    }
  }

  return undefined;
}

export interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

export const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;

export const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);

export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;

export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);

export const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;

export const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);

export const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000;

export const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120);

export const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;

export const STRICT_PROVIDER_LIFECYCLE_GUARD =
  process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

export const decodeProductFeedbackToolDraft = Schema.decodeUnknownExit(ProductFeedbackToolDraft, {
  onExcessProperty: "error",
});

export const decodeRuntimeChatAttachment = Schema.decodeUnknownOption(
  Schema.Struct({ chatAttachment: ChatAttachment }),
);

export function runtimeChatAttachment(event: ProviderRuntimeEvent) {
  if (event.type !== "item.completed") return undefined;
  const data = decodeRuntimeChatAttachment(event.payload.data);

  return Option.isSome(data) ? data.value.chatAttachment : undefined;
}

export const decodeCreateRoutineInput = Schema.decodeUnknownExit(
  Schema.Struct({
    ...AkeruCreateRoutineInput.fields,
    timezone: Schema.optional(RoutineTimeZone),
  }),
  {
    onExcessProperty: "error",
  },
);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Tool arguments enter through the tool-specific schema decoders here.
export function boundedApprovalArgs(toolName: string | undefined, args: unknown) {
  if (args === undefined) return undefined;

  if (toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME) {
    const decoded = decodeProductFeedbackToolDraft(args);

    return Exit.isSuccess(decoded) ? decoded.value : undefined;
  }

  if (toolName === AKERU_CREATE_ROUTINE_TOOL_NAME) {
    const decoded = decodeCreateRoutineInput(args);

    return Exit.isSuccess(decoded) ? decoded.value : undefined;
  }

  return undefined;
}

export type ChannelSessionDomainEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;

export type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: ChannelSessionDomainEvent;
    };

export function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

export function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

export function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }

  return left === right;
}

export function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }

  return false;
}

export function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): number {
  let maxTurnCount = 0;

  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];

    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
  }

  return maxTurnCount;
}

export function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

export function normalizeProposedPlanMarkdown(
  planMarkdown: string | undefined,
): string | undefined {
  const trimmed = planMarkdown?.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

export function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

export function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

export function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);

  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }

  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }

  return `plan:${threadId}:event:${event.eventId}`;
}

export function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

export function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}

export function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }

  return event.payload.usage;
}

export function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

export function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

export function sessionStatusAllowsActiveTurn(
  status: ReturnType<typeof orchestrationSessionStatusFromRuntimeState>,
): boolean {
  return status === "starting" || status === "running";
}

export function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | "mcp-elicitation" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    default:
      return undefined;
  }
}

type TaskLinkagePayload = TaskAgentLinkage & {
  readonly typedUsage?: RuntimeTaskUsage | undefined;
  readonly status?: RuntimeTaskStatus | "stopped" | undefined;
  readonly error?: string | undefined;
};

interface TaskLinkageFields {
  [key: string]: TaskLinkagePayload[keyof TaskLinkagePayload];
}

export /**
 * Copies the optional TaskAgentLinkage bundle from a task.* runtime payload
 * into the persisted activity payload. Identity fields ride on every row so
 * client folds survive activity retention; absent fields stay absent.
 */
function taskLinkageActivityFields(payload: TaskLinkagePayload): TaskLinkageFields {
  const fields: TaskLinkageFields = {
    // Server-stamped classification: persisted rows are self-describing, so
    // clients trust the stamp instead of re-deriving agent-vs-background
    // from taskType denylists and marker heuristics (legacy rows without a
    // stamp keep the client fallback).
    agentKind: classifyTaskAgentKind({
      taskType: Predicate.isString(payload.taskType) ? payload.taskType : undefined,
      agentId: Predicate.isString(payload.agentId) ? payload.agentId : undefined,
    }),
  };

  for (const key of [
    "taskType",
    "agentId",
    "title",
    "role",
    "model",
    "effort",
    "toolUseId",
    "parentAgentId",
    "workflowName",
    "agentIndex",
    "phaseIndex",
    "phaseTitle",
    "phases",
    "attempt",
    "runHandles",
    "outputFile",
    "agentPath",
    "timelineBypass",
    "typedUsage",
    "status",
    "error",
  ] as const) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }

  return fields;
}

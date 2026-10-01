import * as Schema from "effect/Schema";
import { AkeruToolReceipt } from "../akeruTools/receipts.ts";
import { IsoDateTime, NonNegativeInt, RuntimeTaskId } from "../baseSchemas.ts";
import {
  TrimmedNonEmptyStringSchema,
  UnknownRecordSchema,
  RuntimeTurnState,
  RuntimePlanStepStatus,
  RuntimeItemStatus,
  RuntimeContentStreamKind,
  RuntimeErrorClass,
  CanonicalItemType,
  TurnStartedType,
  TurnCompletedType,
  TurnAbortedType,
  TurnPlanUpdatedType,
  TurnProposedDeltaType,
  TurnProposedCompletedType,
  TurnDiffUpdatedType,
  ItemStartedType,
  ItemUpdatedType,
  ItemCompletedType,
  ContentDeltaType,
  TaskStartedType,
  TaskProgressType,
  TaskUpdatedType,
  TaskCompletedType,
  HookStartedType,
  HookProgressType,
  HookCompletedType,
  ToolProgressType,
  ToolSummaryType,
  ToolDeniedType,
  ToolReceiptType,
  RuntimeWarningType,
  RuntimeErrorType,
  ProviderRuntimeEventBase,
} from "./base.ts";

const TurnStartedPayload = Schema.Struct({
  hiddenWake: Schema.optional(Schema.Boolean),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
});

export type TurnStartedPayload = typeof TurnStartedPayload.Type;

const TurnCompletedPayload = Schema.Struct({
  state: RuntimeTurnState,
  stopReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  usage: Schema.optional(Schema.Unknown),
  modelUsage: Schema.optional(UnknownRecordSchema),
  totalCostUsd: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(TrimmedNonEmptyStringSchema),
});

export type TurnCompletedPayload = typeof TurnCompletedPayload.Type;

const TurnAbortedPayload = Schema.Struct({
  reason: TrimmedNonEmptyStringSchema,
});

export type TurnAbortedPayload = typeof TurnAbortedPayload.Type;

const RuntimePlanStep = Schema.Struct({
  step: TrimmedNonEmptyStringSchema,
  status: RuntimePlanStepStatus,
});

export type RuntimePlanStep = typeof RuntimePlanStep.Type;

const TurnPlanUpdatedPayload = Schema.Struct({
  explanation: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  plan: Schema.Array(RuntimePlanStep),
});

export type TurnPlanUpdatedPayload = typeof TurnPlanUpdatedPayload.Type;

const TurnProposedDeltaPayload = Schema.Struct({
  delta: Schema.String,
});

export type TurnProposedDeltaPayload = typeof TurnProposedDeltaPayload.Type;

const TurnProposedCompletedPayload = Schema.Struct({
  planMarkdown: TrimmedNonEmptyStringSchema,
});

export type TurnProposedCompletedPayload = typeof TurnProposedCompletedPayload.Type;

const TurnDiffUpdatedPayload = Schema.Struct({
  unifiedDiff: Schema.String,
});

export type TurnDiffUpdatedPayload = typeof TurnDiffUpdatedPayload.Type;

export const ItemLifecyclePayload = Schema.Struct({
  itemType: CanonicalItemType,
  status: Schema.optional(RuntimeItemStatus),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(Schema.Unknown),
  /**
   * Owning agent when this item ran inside a subagent (resolved from the
   * SDK's parent_tool_use_id). Clients re-home attributed items out of the
   * main timeline and into the owning agent's Agents-surface row.
   */
  agentId: Schema.optional(TrimmedNonEmptyStringSchema),
  parentToolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
});

export type ItemLifecyclePayload = typeof ItemLifecyclePayload.Type;

const ContentDeltaPayload = Schema.Struct({
  streamKind: RuntimeContentStreamKind,
  delta: Schema.String,
  contentIndex: Schema.optional(Schema.Int),
  summaryIndex: Schema.optional(Schema.Int),
});

export type ContentDeltaPayload = typeof ContentDeltaPayload.Type;

/**
 * Typed per-task usage rollup. Field names match the orchestration-v2 subagent
 * usage vocabulary (#4779) so the eventual migration is a rename, not a remap.
 * Claude reports per-activation deltas; Codex reports cumulative totals — the
 * merge strategy is provider-specific and lives in client-runtime.
 */
export const RuntimeTaskUsage = Schema.Struct({
  totalTokens: NonNegativeInt,
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
});

export type RuntimeTaskUsage = typeof RuntimeTaskUsage.Type;

export const TaskWorkflowPhase = Schema.Struct({
  index: NonNegativeInt,
  title: TrimmedNonEmptyStringSchema,
});

export type TaskWorkflowPhase = typeof TaskWorkflowPhase.Type;

export const TaskRunHandles = Schema.Struct({
  runId: Schema.optional(TrimmedNonEmptyStringSchema),
  scriptPath: Schema.optional(TrimmedNonEmptyStringSchema),
  transcriptDir: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Only http/https URLs may be stored here — sanitized at the adapter. */
  sessionUrl: Schema.optional(TrimmedNonEmptyStringSchema),
});

export type TaskRunHandles = typeof TaskRunHandles.Type;

/**
 * Watch-loop task types: Monitor-tool tasks plus background shells (a shell
 * that outlives its turn is in practice a watch loop). Canonical single copy —
 * the server liveness registry, ingestion's agentKind stamp, and the client
 * fold's legacy fallback all classify with these sets.
 */
export const MONITOR_TASK_TYPES: ReadonlySet<string> = new Set([
  "monitor",
  "monitor_mcp",
  "local_bash",
  "shell",
]);

/** Task types that are neither agents nor watch loops (plan-mode bookkeeping). */
export const INERT_TASK_TYPES: ReadonlySet<string> = new Set(["plan", "dream"]);

/**
 * Agent-vs-background classification, stamped by ingestion as `agentKind` so
 * persisted rows are self-describing. A deliberate denylist: the SDK's
 * agent-flavored type names drift (subagent, local_agent, local_workflow, …)
 * and an allowlist silently dropped real subagents when "local_agent"
 * appeared. A task launched from inside a subagent (agentId set) is
 * agent-internal background work UNLESS it is itself agent-flavored — a
 * nested agent can outlive its parent and stays in the roster.
 */
export function classifyTaskAgentKind(input: {
  readonly taskType?: string | undefined;
  readonly agentId?: string | undefined;
}): "agent" | "background" {
  const { taskType, agentId } = input;

  const nonAgentType =
    taskType !== undefined && (MONITOR_TASK_TYPES.has(taskType) || INERT_TASK_TYPES.has(taskType));

  if (agentId !== undefined && agentId.trim().length > 0) {
    return taskType === undefined || nonAgentType ? "background" : "agent";
  }

  return nonAgentType ? "background" : "agent";
}

/**
 * Optional agent-identity linkage carried on every task lifecycle payload.
 * Repeated on progress and terminal rows (not just start) so client folds can
 * reconstruct an agent even when its start row aged out of activity retention.
 * All fields optional: old emitters and old rows decode unchanged.
 */
const taskAgentLinkageFields = {
  /** SDK task_type (subagent/shell/monitor/local_workflow/…), repeated on
   * every row so folds can classify without the start row. */
  taskType: Schema.optional(TrimmedNonEmptyStringSchema),
  /**
   * Server-stamped classification (classifyTaskAgentKind at ingestion).
   * Clients trust this stamp outright; rows without it (legacy, pre-stamp)
   * fall back to client-side heuristics.
   */
  agentKind: Schema.optional(Schema.Literals(["agent", "background"])),
  /**
   * Owning agent when the task itself was launched from inside a subagent
   * (e.g. a subagent's background shell). Clients treat such tasks as
   * agent-internal and keep them out of the parent work log.
   */
  agentId: Schema.optional(TrimmedNonEmptyStringSchema),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  role: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Reasoning effort when known (e.g. "high"). Open string: provider vocabularies differ. */
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  parentAgentId: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowName: Schema.optional(TrimmedNonEmptyStringSchema),
  agentIndex: Schema.optional(NonNegativeInt),
  phaseIndex: Schema.optional(NonNegativeInt),
  phaseTitle: Schema.optional(TrimmedNonEmptyStringSchema),
  phases: Schema.optional(Schema.Array(TaskWorkflowPhase)),
  attempt: Schema.optional(NonNegativeInt),
  runHandles: Schema.optional(TaskRunHandles),
  outputFile: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Codex agent hierarchy path, e.g. "/root/marlow". */
  agentPath: Schema.optional(TrimmedNonEmptyStringSchema),
  /**
   * Set on provider-synthesized child-agent events (Codex) whose activity
   * belongs in the Agents surface, never the parent timeline.
   */
  timelineBypass: Schema.optional(Schema.Boolean),
} as const;

export const TaskAgentLinkage = Schema.Struct(taskAgentLinkageFields);

export type TaskAgentLinkage = typeof TaskAgentLinkage.Type;

const TaskStartedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  ...taskAgentLinkageFields,
});

export type TaskStartedPayload = typeof TaskStartedPayload.Type;

export const RuntimeTaskStatus = Schema.Literals([
  "pending",
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export type RuntimeTaskStatus = typeof RuntimeTaskStatus.Type;

const TaskProgressPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: TrimmedNonEmptyStringSchema,
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
  typedUsage: Schema.optional(RuntimeTaskUsage),
  lastToolName: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Present on synthesized member/child progress rows that carry state. */
  status: Schema.optional(RuntimeTaskStatus),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
  ...taskAgentLinkageFields,
});

export type TaskProgressPayload = typeof TaskProgressPayload.Type;

/**
 * Non-terminal status patch (from the Claude SDK's task_updated, which main
 * previously dropped). killed→cancelled and paused→idle are mapped at the
 * adapter so the wire only carries the shared vocabulary.
 */
const TaskUpdatedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.optional(RuntimeTaskStatus),
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
  endedAt: Schema.optional(IsoDateTime),
  isBackgrounded: Schema.optional(Schema.Boolean),
  ...taskAgentLinkageFields,
});

export type TaskUpdatedPayload = typeof TaskUpdatedPayload.Type;

const TaskCompletedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.Literals(["completed", "failed", "stopped"]),
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
  typedUsage: Schema.optional(RuntimeTaskUsage),
  ...taskAgentLinkageFields,
});

export type TaskCompletedPayload = typeof TaskCompletedPayload.Type;

const HookStartedPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  hookName: TrimmedNonEmptyStringSchema,
  hookEvent: TrimmedNonEmptyStringSchema,
});

export type HookStartedPayload = typeof HookStartedPayload.Type;

const HookProgressPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
});

export type HookProgressPayload = typeof HookProgressPayload.Type;

const HookCompletedPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  outcome: Schema.Literals(["success", "error", "cancelled"]),
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Int),
});

export type HookCompletedPayload = typeof HookCompletedPayload.Type;

const ToolProgressPayload = Schema.Struct({
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  toolName: Schema.optional(TrimmedNonEmptyStringSchema),
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  elapsedSeconds: Schema.optional(Schema.Number),
  /** Owning task/agent when the tool ran inside a subagent. */
  taskId: Schema.optional(RuntimeTaskId),
  parentToolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
});

export type ToolProgressPayload = typeof ToolProgressPayload.Type;

const ToolSummaryPayload = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
  precedingToolUseIds: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
});

export type ToolSummaryPayload = typeof ToolSummaryPayload.Type;

const ToolDeniedPayload = Schema.Struct({
  toolName: TrimmedNonEmptyStringSchema,
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  agentId: Schema.optional(TrimmedNonEmptyStringSchema),
});

export type ToolDeniedPayload = typeof ToolDeniedPayload.Type;

const ToolReceiptPayload = AkeruToolReceipt;

export type ToolReceiptPayload = typeof ToolReceiptPayload.Type;

const RuntimeWarningPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(Schema.Unknown),
  key: Schema.optional(TrimmedNonEmptyStringSchema),
  resolved: Schema.optional(Schema.Boolean),
});

export type RuntimeWarningPayload = typeof RuntimeWarningPayload.Type;

const RuntimeErrorPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  class: Schema.optional(RuntimeErrorClass),
  detail: Schema.optional(Schema.Unknown),
});

export type RuntimeErrorPayload = typeof RuntimeErrorPayload.Type;

export const ProviderRuntimeTurnStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnStartedType,
  payload: TurnStartedPayload,
});

export type ProviderRuntimeTurnStartedEvent = typeof ProviderRuntimeTurnStartedEvent.Type;

export const ProviderRuntimeTurnCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnCompletedType,
  payload: TurnCompletedPayload,
});

export type ProviderRuntimeTurnCompletedEvent = typeof ProviderRuntimeTurnCompletedEvent.Type;

export const ProviderRuntimeTurnAbortedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnAbortedType,
  payload: TurnAbortedPayload,
});

export type ProviderRuntimeTurnAbortedEvent = typeof ProviderRuntimeTurnAbortedEvent.Type;

export const ProviderRuntimeTurnPlanUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnPlanUpdatedType,
  payload: TurnPlanUpdatedPayload,
});

export type ProviderRuntimeTurnPlanUpdatedEvent = typeof ProviderRuntimeTurnPlanUpdatedEvent.Type;

export const ProviderRuntimeTurnProposedDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnProposedDeltaType,
  payload: TurnProposedDeltaPayload,
});

export type ProviderRuntimeTurnProposedDeltaEvent =
  typeof ProviderRuntimeTurnProposedDeltaEvent.Type;

export const ProviderRuntimeTurnProposedCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnProposedCompletedType,
  payload: TurnProposedCompletedPayload,
});

export type ProviderRuntimeTurnProposedCompletedEvent =
  typeof ProviderRuntimeTurnProposedCompletedEvent.Type;

export const ProviderRuntimeTurnDiffUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnDiffUpdatedType,
  payload: TurnDiffUpdatedPayload,
});

export type ProviderRuntimeTurnDiffUpdatedEvent = typeof ProviderRuntimeTurnDiffUpdatedEvent.Type;

export const ProviderRuntimeItemStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemStartedType,
  payload: ItemLifecyclePayload,
});

export type ProviderRuntimeItemStartedEvent = typeof ProviderRuntimeItemStartedEvent.Type;

export const ProviderRuntimeItemUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemUpdatedType,
  payload: ItemLifecyclePayload,
});

export type ProviderRuntimeItemUpdatedEvent = typeof ProviderRuntimeItemUpdatedEvent.Type;

export const ProviderRuntimeItemCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemCompletedType,
  payload: ItemLifecyclePayload,
});

export type ProviderRuntimeItemCompletedEvent = typeof ProviderRuntimeItemCompletedEvent.Type;

export const ProviderRuntimeContentDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ContentDeltaType,
  payload: ContentDeltaPayload,
});

export type ProviderRuntimeContentDeltaEvent = typeof ProviderRuntimeContentDeltaEvent.Type;

export const ProviderRuntimeTaskStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskStartedType,
  payload: TaskStartedPayload,
});

export type ProviderRuntimeTaskStartedEvent = typeof ProviderRuntimeTaskStartedEvent.Type;

export const ProviderRuntimeTaskProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskProgressType,
  payload: TaskProgressPayload,
});

export type ProviderRuntimeTaskProgressEvent = typeof ProviderRuntimeTaskProgressEvent.Type;

export const ProviderRuntimeTaskUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskUpdatedType,
  payload: TaskUpdatedPayload,
});

export type ProviderRuntimeTaskUpdatedEvent = typeof ProviderRuntimeTaskUpdatedEvent.Type;

export const ProviderRuntimeTaskCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskCompletedType,
  payload: TaskCompletedPayload,
});

export type ProviderRuntimeTaskCompletedEvent = typeof ProviderRuntimeTaskCompletedEvent.Type;

export const ProviderRuntimeHookStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookStartedType,
  payload: HookStartedPayload,
});

export type ProviderRuntimeHookStartedEvent = typeof ProviderRuntimeHookStartedEvent.Type;

export const ProviderRuntimeHookProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookProgressType,
  payload: HookProgressPayload,
});

export type ProviderRuntimeHookProgressEvent = typeof ProviderRuntimeHookProgressEvent.Type;

export const ProviderRuntimeHookCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookCompletedType,
  payload: HookCompletedPayload,
});

export type ProviderRuntimeHookCompletedEvent = typeof ProviderRuntimeHookCompletedEvent.Type;

export const ProviderRuntimeToolProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolProgressType,
  payload: ToolProgressPayload,
});

export type ProviderRuntimeToolProgressEvent = typeof ProviderRuntimeToolProgressEvent.Type;

export const ProviderRuntimeToolSummaryEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolSummaryType,
  payload: ToolSummaryPayload,
});

export type ProviderRuntimeToolSummaryEvent = typeof ProviderRuntimeToolSummaryEvent.Type;

export const ProviderRuntimeToolDeniedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolDeniedType,
  payload: ToolDeniedPayload,
});

export type ProviderRuntimeToolDeniedEvent = typeof ProviderRuntimeToolDeniedEvent.Type;

export const ProviderRuntimeToolReceiptEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolReceiptType,
  payload: ToolReceiptPayload,
});

export type ProviderRuntimeToolReceiptEvent = typeof ProviderRuntimeToolReceiptEvent.Type;

export const ProviderRuntimeWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeWarningType,
  payload: RuntimeWarningPayload,
});

export type ProviderRuntimeWarningEvent = typeof ProviderRuntimeWarningEvent.Type;

export const ProviderRuntimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeErrorType,
  payload: RuntimeErrorPayload,
});

export type ProviderRuntimeErrorEvent = typeof ProviderRuntimeErrorEvent.Type;

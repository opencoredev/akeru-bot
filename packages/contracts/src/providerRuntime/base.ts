import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../baseSchemas.ts";
import { ProviderInstanceId, ProviderDriverKind } from "../providerInstance.ts";

export const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

export const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const RuntimeEventRawSource = Schema.Union([
  Schema.Literal("codex.app-server.notification"),
  Schema.Literal("codex.app-server.request"),
  Schema.Literal("codex.eventmsg"),
  Schema.Literal("claude.sdk.message"),
  Schema.Literal("claude.sdk.permission"),
  Schema.Literal("codex.sdk.thread-event"),
  Schema.Literal("opencode.sdk.event"),
  Schema.Literal("acp.jsonrpc"),
  Schema.TemplateLiteral(["acp.", Schema.String, ".extension"]),
]);

export type RuntimeEventRawSource = typeof RuntimeEventRawSource.Type;

export const RuntimeEventRaw = Schema.Struct({
  source: RuntimeEventRawSource,
  method: Schema.optional(TrimmedNonEmptyStringSchema),
  messageType: Schema.optional(TrimmedNonEmptyStringSchema),
  payload: Schema.Unknown,
});

export type RuntimeEventRaw = typeof RuntimeEventRaw.Type;

const ProviderRequestId = TrimmedNonEmptyStringSchema;

export type ProviderRequestId = typeof ProviderRequestId.Type;

const ProviderRefs = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerItemId: Schema.optional(ProviderItemId),
  providerRequestId: Schema.optional(ProviderRequestId),
});

export type ProviderRefs = typeof ProviderRefs.Type;

export const RuntimeSessionState = Schema.Literals([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);

export type RuntimeSessionState = typeof RuntimeSessionState.Type;

export const RuntimeThreadState = Schema.Literals([
  "active",
  "idle",
  "archived",
  "closed",
  "compacted",
  "error",
]);

export type RuntimeThreadState = typeof RuntimeThreadState.Type;

export const RuntimeTurnState = Schema.Literals([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

export type RuntimeTurnState = typeof RuntimeTurnState.Type;

export const RuntimePlanStepStatus = Schema.Literals(["pending", "inProgress", "completed"]);

export type RuntimePlanStepStatus = typeof RuntimePlanStepStatus.Type;

export const RuntimeItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);

export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

export const RuntimeContentStreamKind = Schema.Literals([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "file_change_output",
  "unknown",
]);

export type RuntimeContentStreamKind = typeof RuntimeContentStreamKind.Type;

export const RuntimeSessionExitKind = Schema.Literals(["graceful", "error"]);

export type RuntimeSessionExitKind = typeof RuntimeSessionExitKind.Type;

export const RuntimeErrorClass = Schema.Literals([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);

export type RuntimeErrorClass = typeof RuntimeErrorClass.Type;

export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;

export const ToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);

export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.some((itemType) => itemType === value);
}

export const CanonicalItemType = Schema.Literals([
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  ...TOOL_LIFECYCLE_ITEM_TYPES,
  "review_entered",
  "review_exited",
  "context_compaction",
  "error",
  "unknown",
]);

export type CanonicalItemType = typeof CanonicalItemType.Type;

export const CanonicalRequestType = Schema.Literals([
  "command_execution_approval",
  "file_read_approval",
  "file_change_approval",
  "apply_patch_approval",
  "exec_command_approval",
  "mcp_elicitation_approval",
  "tool_user_input",
  "dynamic_tool_call",
  "auth_tokens_refresh",
  "unknown",
]);

export type CanonicalRequestType = typeof CanonicalRequestType.Type;

const ProviderRuntimeEventType = Schema.Literals([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.metadata.updated",
  "thread.token-usage.updated",
  "thread.realtime.started",
  "thread.realtime.item-added",
  "thread.realtime.audio.delta",
  "thread.realtime.error",
  "thread.realtime.closed",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.proposed.completed",
  "turn.diff.updated",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "hook.started",
  "hook.progress",
  "hook.completed",
  "tool.progress",
  "tool.summary",
  "tool.receipt",
  "auth.status",
  "account.updated",
  "account.rate-limits.updated",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "model.rerouted",
  "config.warning",
  "deprecation.notice",
  "files.persisted",
  "runtime.warning",
  "runtime.error",
]);

export type ProviderRuntimeEventType = typeof ProviderRuntimeEventType.Type;

export const SessionStartedType = Schema.Literal("session.started");

export const SessionConfiguredType = Schema.Literal("session.configured");

export const SessionStateChangedType = Schema.Literal("session.state.changed");

export const SessionExitedType = Schema.Literal("session.exited");

export const ThreadStartedType = Schema.Literal("thread.started");

export const ThreadStateChangedType = Schema.Literal("thread.state.changed");

export const ThreadMetadataUpdatedType = Schema.Literal("thread.metadata.updated");

export const ThreadTokenUsageUpdatedType = Schema.Literal("thread.token-usage.updated");

export const ThreadRealtimeStartedType = Schema.Literal("thread.realtime.started");

export const ThreadRealtimeItemAddedType = Schema.Literal("thread.realtime.item-added");

export const ThreadRealtimeAudioDeltaType = Schema.Literal("thread.realtime.audio.delta");

export const ThreadRealtimeErrorType = Schema.Literal("thread.realtime.error");

export const ThreadRealtimeClosedType = Schema.Literal("thread.realtime.closed");

export const TurnStartedType = Schema.Literal("turn.started");

export const TurnCompletedType = Schema.Literal("turn.completed");

export const TurnAbortedType = Schema.Literal("turn.aborted");

export const TurnPlanUpdatedType = Schema.Literal("turn.plan.updated");

export const TurnProposedDeltaType = Schema.Literal("turn.proposed.delta");

export const TurnProposedCompletedType = Schema.Literal("turn.proposed.completed");

export const TurnDiffUpdatedType = Schema.Literal("turn.diff.updated");

export const ItemStartedType = Schema.Literal("item.started");

export const ItemUpdatedType = Schema.Literal("item.updated");

export const ItemCompletedType = Schema.Literal("item.completed");

export const ContentDeltaType = Schema.Literal("content.delta");

export const RequestOpenedType = Schema.Literal("request.opened");

export const RequestResolvedType = Schema.Literal("request.resolved");

export const UserInputRequestedType = Schema.Literal("user-input.requested");

export const UserInputResolvedType = Schema.Literal("user-input.resolved");

export const TaskStartedType = Schema.Literal("task.started");

export const TaskProgressType = Schema.Literal("task.progress");

export const TaskUpdatedType = Schema.Literal("task.updated");

export const TaskCompletedType = Schema.Literal("task.completed");

export const HookStartedType = Schema.Literal("hook.started");

export const HookProgressType = Schema.Literal("hook.progress");

export const HookCompletedType = Schema.Literal("hook.completed");

export const ToolProgressType = Schema.Literal("tool.progress");

export const ToolSummaryType = Schema.Literal("tool.summary");

export const AuthStatusType = Schema.Literal("auth.status");

export const AccountUpdatedType = Schema.Literal("account.updated");

export const AccountRateLimitsUpdatedType = Schema.Literal("account.rate-limits.updated");

export const McpStatusUpdatedType = Schema.Literal("mcp.status.updated");

export const McpOauthCompletedType = Schema.Literal("mcp.oauth.completed");

export const ModelReroutedType = Schema.Literal("model.rerouted");

export const ConfigWarningType = Schema.Literal("config.warning");

export const DeprecationNoticeType = Schema.Literal("deprecation.notice");

export const FilesPersistedType = Schema.Literal("files.persisted");

export const ToolDeniedType = Schema.Literal("tool.denied");

export const ToolReceiptType = Schema.Literal("tool.receipt");

export const RuntimeWarningType = Schema.Literal("runtime.warning");

export const RuntimeErrorType = Schema.Literal("runtime.error");

export const ProviderRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. See providerInstance.ts
  // for the routing-key-vs-driver-id distinction. Once every emitter
  // populates it (post-slice-4), routing flips to instance-id-only.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  environmentId: Schema.optional(EnvironmentId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(RuntimeItemId),
  requestId: Schema.optional(RuntimeRequestId),
  providerRefs: Schema.optional(ProviderRefs),
  raw: Schema.optional(RuntimeEventRaw),
});

export type ProviderRuntimeEventBase = typeof ProviderRuntimeEventBase.Type;

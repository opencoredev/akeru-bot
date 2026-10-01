import * as Schema from "effect/Schema";
import {
  BotAvatar,
  BotEngine,
  ClientOrchestrationCommand,
  ModelSelection,
  OrchestrationBot,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProjectCreateCommand,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
} from "./orchestration.ts";

export const decodeBotAvatar = Schema.decodeUnknownEffect(BotAvatar);

export const decodeBotEngine = Schema.decodeUnknownEffect(BotEngine);

export const decodeOrchestrationBot = Schema.decodeUnknownEffect(OrchestrationBot);

export const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);

export const decodeFullThreadDiffInput = Schema.decodeUnknownEffect(
  OrchestrationGetFullThreadDiffInput,
);

export const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);

export const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);

export const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);

export const decodeProjectMetaUpdatedPayload =
  Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);

export const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);

export const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(
  ClientOrchestrationCommand,
);

export const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);

export const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);

export const decodeOrchestrationReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);

export const decodeOrchestrationShellSnapshot = Schema.decodeUnknownEffect(
  OrchestrationShellSnapshot,
);

export const decodeOrchestrationProposedPlan =
  Schema.decodeUnknownEffect(OrchestrationProposedPlan);

export const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);

export const decodeOrchestrationThread = Schema.decodeUnknownEffect(OrchestrationThread);

export const decodeOrchestrationThreadShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);

export const encodeThreadCreatedPayload = Schema.encodeEffect(ThreadCreatedPayload);

export function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}

export const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);

export const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);

export const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

export const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);

export const decodeDispatchCommandError = Schema.decodeUnknownEffect(
  OrchestrationDispatchCommandError,
);

// ── ModelSelection: instance-keyed wire shape + legacy decoder ────────
//
// `ModelSelection` is routing-keyed on `instanceId` — never a driver kind.
// Persisted and in-flight payloads from pre-instance builds carry a
// `provider` field whose value was a driver kind; those payloads are migrated
// at the wire boundary by
// promoting `provider` to the default instance id for that driver
// (built-in drivers use the driver kind slug as their default instance id, so
// the migration is a 1:1 rename).
//
// These tests pin the rollback/fork tolerance invariant: legacy payloads
// decode cleanly for fork-provided drivers, and the decoded form uses
// `instanceId` uniformly regardless of origin.

export const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

export const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);

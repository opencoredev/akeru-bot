import {
  BotId,
  DelegationId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";

export const NOW = "2026-08-31T12:00:00.000Z";

export const LATER = "2026-08-31T12:01:00.000Z";

export const PARENT_BOT_ID = BotId.make("bot-parent");

export const CHILD_BOT_ID = BotId.make("bot-child");

export const OTHER_BOT_ID = BotId.make("bot-other");

export const PARENT_THREAD_ID = ThreadId.make("thread-parent");

export const CHILD_THREAD_ID = ThreadId.make("thread-child");

export const CHILD_TURN_ID = TurnId.make("turn-child");

export type PlannedDelegationEvent = Omit<
  Extract<OrchestrationEvent, { type: "delegation.created" | "delegation.updated" }>,
  "sequence"
>;

export function makeBot(id: BotId): OrchestrationBot {
  return {
    id,
    name: id,
    title: "Agent",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "dither", seed: id },
    engine: null,
    sandbox: "local",
    runtimeMode: "approval-required",
    usageCap: null,
    imageProvider: null,
    voiceEnabled: false,
    channelBindings: [],
    groupId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function makeThread(id: ThreadId, botId: BotId): OrchestrationThread {
  return {
    id,
    projectId: ProjectId.make("project-1"),
    botId,
    groupId: null,
    respondingBotId: null,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

export function makeDelegation(
  overrides: Partial<AkeruDelegationRecord> = {},
): AkeruDelegationRecord {
  return {
    delegationId: DelegationId.make("delegation-1"),
    parentDelegationId: null,
    parentBotId: PARENT_BOT_ID,
    childBotId: CHILD_BOT_ID,
    parentThreadId: PARENT_THREAD_ID,
    parentTurnId: TurnId.make("turn-parent"),
    ancestorBotIds: [PARENT_BOT_ID],
    depth: 1,
    task: "Compare three flights.",
    expectedResult: "A short comparison with sources.",
    deadline: null,
    access: {
      allowedToolIds: ["Read"],
      memoryScopes: ["project"],
      sandbox: "daytona",
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "send",
    },
    billedBotId: CHILD_BOT_ID,
    keep: false,
    anchorMessageId: null,
    retryOfDelegationId: null,
    trigger: "bot" as const,
    createdAt: NOW,
    updatedAt: NOW,
    phase: { _tag: "Queued" },
    ...overrides,
  };
}

export function makeReadModel(
  delegations: ReadonlyArray<AkeruDelegationRecord> = [],
): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(NOW),
    bots: [makeBot(PARENT_BOT_ID), makeBot(CHILD_BOT_ID), makeBot(OTHER_BOT_ID)],
    threads: [
      makeThread(PARENT_THREAD_ID, PARENT_BOT_ID),
      makeThread(CHILD_THREAD_ID, CHILD_BOT_ID),
    ],
    delegations,
  };
}

export const decideOne = Effect.fn("decideDelegationTestCommand")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const decided = yield* decideOrchestrationCommand({ readModel, command });
  const event = Array.isArray(decided) ? decided[0] : decided;
  if (event === undefined) throw new Error("Expected one event");
  if (event.type !== "delegation.created" && event.type !== "delegation.updated") {
    throw new Error(`Expected a delegation event, received '${event.type}'`);
  }
  return event as PlannedDelegationEvent;
});

export const project = Effect.fn("projectDelegationTestEvent")(function* (
  readModel: OrchestrationReadModel,
  event: PlannedDelegationEvent,
) {
  return yield* projectEvent(readModel, {
    ...event,
    sequence: readModel.snapshotSequence + 1,
  });
});

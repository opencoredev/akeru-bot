/** Read-model builders and a decider-backed harness for delegation runtime tests. */
import {
  AuthSessionId,
  BotId,
  DelegationId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AkeruDelegationAccessGrant,
  type AkeruDelegationRecord,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { decideOrchestrationCommand } from "../../orchestration/decider.ts";
import { projectEvent } from "../../orchestration/projector.ts";
import {
  createAkeruDelegationRuntime,
  type AkeruDelegationChildOutcome,
  type AkeruDelegationParent,
  type AkeruDelegationRuntimeOptions,
} from "../AkeruDelegationRuntime.ts";

export const NOW = "2026-08-31T12:00:00.000Z";
export const PROJECT_ID = ProjectId.make("project-1");
export const PARENT_BOT_ID = BotId.make("bot-parent");
export const CHILD_BOT_ID = BotId.make("bot-child");
export const OTHER_BOT_ID = BotId.make("bot-other");
export const PARENT_THREAD_ID = ThreadId.make("thread-parent");
export const PARENT_TURN_ID = TurnId.make("turn-parent");
export const CHILD_TURN_ID = TurnId.make("turn-child");

export const access = (overrides: Partial<AkeruDelegationAccessGrant> = {}) => ({
  allowedToolIds: ["Read", "Shell", "SendToAgent"] as const,
  memoryScopes: ["private", "bot", "project"] as const,
  sandbox: "local" as const,
  runtimeMode: "approval-required" as const,
  hasUserComputer: false,
  enabledMcpServerIds: [],
  disabledMcpServerIds: [],
  approvalCeiling: "send" as const,
  ...overrides,
});

export function bot(id: BotId, overrides: Partial<OrchestrationBot> = {}): OrchestrationBot {
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
    ...overrides,
  };
}

export function thread(
  id: ThreadId,
  botId: BotId | null,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread {
  return {
    id,
    projectId: PROJECT_ID,
    botId,
    groupId: null,
    respondingBotId: null,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
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
    ...overrides,
  };
}

export function delegation(
  delegationId: DelegationId,
  overrides: Partial<AkeruDelegationRecord> = {},
): AkeruDelegationRecord {
  return {
    delegationId,
    parentDelegationId: null,
    parentBotId: PARENT_BOT_ID,
    childBotId: CHILD_BOT_ID,
    parentThreadId: PARENT_THREAD_ID,
    parentTurnId: PARENT_TURN_ID,
    ancestorBotIds: [PARENT_BOT_ID],
    depth: 1,
    task: "Research the answer.",
    expectedResult: "A concise answer.",
    deadline: null,
    access: access(),
    phase: { _tag: "Queued" },
    billedBotId: CHILD_BOT_ID,
    keep: false,
    anchorMessageId: null,
    retryOfDelegationId: null,
    trigger: "bot" as const,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<OrchestrationReadModel> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    bots: [bot(PARENT_BOT_ID), bot(CHILD_BOT_ID), bot(OTHER_BOT_ID)],
    groups: [],
    delegations: [],
    mcpServers: [],
    routines: [],
    routineRuns: [],
    skillAssignments: [],
    threads: [thread(PARENT_THREAD_ID, PARENT_BOT_ID)],
    updatedAt: NOW,
    ...overrides,
  };
}

export const parent = (overrides: Partial<AkeruDelegationParent> = {}): AkeruDelegationParent => ({
  threadId: PARENT_THREAD_ID,
  turnId: PARENT_TURN_ID,
  botId: PARENT_BOT_ID,
  parentDelegationId: null,
  ancestorBotIds: [],
  depth: 0,
  access: access(),
  ...overrides,
});

export const request = (overrides: Record<string, unknown> = {}) => ({
  botId: CHILD_BOT_ID,
  task: "Research the answer.",
  expectedResult: "A concise answer.",
  ...overrides,
});

export function harness(
  initial = snapshot(),
  outcome: AkeruDelegationChildOutcome = {
    state: "completed",
    turnId: CHILD_TURN_ID,
    summary: "The delegated answer.",
  },
  options: Partial<AkeruDelegationRuntimeOptions> = {},
) {
  const state = {
    ...initial,
    delegations: [...initial.delegations],
    threads: [...initial.threads],
  };
  const commands: OrchestrationCommand[] = [];
  const interrupts: Array<{ threadId: ThreadId; turnId: TurnId | null }> = [];
  const usage: Array<Record<string, unknown>> = [];
  let nextId = 0;
  // Runs every command through the real decider and projects its events back
  // into `state`, so illegal phase transitions (for example Canceled -> Failed)
  // surface as OrchestrationCommandInvariantError instead of passing silently.
  const dispatch = vi.fn(async (command: OrchestrationCommand) => {
    commands.push(command);
    await Effect.runPromise(
      Effect.gen(function* () {
        const decided = yield* decideOrchestrationCommand({
          command:
            command.type === "thread.turn.start"
              ? {
                  ...command,
                  senderPersonId: AuthSessionId.make("person-1"),
                  senderCanManageGroups: true,
                }
              : command,
          readModel: state as OrchestrationReadModel,
        });
        const events = Array.isArray(decided) ? decided : [decided];
        let model = state as OrchestrationReadModel;
        for (const event of events) {
          model = yield* projectEvent(model, {
            ...event,
            sequence: model.snapshotSequence + 1,
          });
        }
        Object.assign(state, model);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });
  const recordUsage = vi.fn(async (entry: Record<string, unknown>) => {
    usage.push(entry);
  });
  const runtime = createAkeruDelegationRuntime({
    readSnapshot: async () => state as OrchestrationReadModel,
    dispatch,
    awaitChild: async () => outcome,
    interruptChild: async (threadId, turnId) => {
      interrupts.push({ threadId, turnId });
    },
    recordUsage,
    now: () => NOW,
    id: () => String(++nextId),
    ...options,
  });
  return { runtime, state, commands, interrupts, usage, recordUsage, dispatch };
}

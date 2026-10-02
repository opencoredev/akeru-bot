import {
  BotId,
  GroupId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
  type OrchestrationBot,
  type OrchestrationGroup,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@akeru/contracts";
import { createEmptyReadModel } from "../projector.ts";

export const NOW = "2026-09-29T12:00:00.000Z";

export const BOT_ID = BotId.make("bot-main");

export const OTHER_BOT_ID = BotId.make("bot-other");

export const THIRD_BOT_ID = BotId.make("bot-third");

export const GROUP_ID = GroupId.make("group-team");

export function makeBot(input: {
  readonly id: OrchestrationBot["id"];
  readonly archivedAt?: OrchestrationBot["archivedAt"];
}): OrchestrationBot {
  return {
    id: input.id,
    name: input.id,
    title: "Agent",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "dither", seed: input.id },
    engine: null,
    sandbox: "local",
    runtimeMode: "full-access",
    usageCap: null,
    imageProvider: null,
    voiceEnabled: false,
    channelBindings: [],
    groupId: null,
    archivedAt: input.archivedAt ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function makeBotThread(botId: OrchestrationBot["id"]): OrchestrationThread {
  return {
    id: ThreadId.make(`thread-${botId}`),
    projectId: ProjectId.make("project-1"),
    botId,
    groupId: null,
    respondingBotId: null,
    title: "Bot chat",
    modelSelection: { instanceId: ProviderInstanceId.make("default"), model: "default-model" },
    runtimeMode: "full-access",
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

export function makeGroup(
  input: {
    readonly bossBotId?: OrchestrationGroup["bossBotId"];
    readonly members?: OrchestrationGroup["members"];
  } = {},
): OrchestrationGroup {
  return {
    id: GROUP_ID,
    name: "Team",
    bossBotId: input.bossBotId ?? BOT_ID,
    members: input.members ?? [
      { kind: "bot", botId: BOT_ID, role: "boss" },
      { kind: "bot", botId: OTHER_BOT_ID, role: "specialist" },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function makeReadModel(input: {
  readonly bots?: ReadonlyArray<OrchestrationBot>;
  readonly groups?: ReadonlyArray<OrchestrationGroup>;
  readonly threads?: ReadonlyArray<OrchestrationThread>;
  readonly delegations?: ReadonlyArray<AkeruDelegationRecord>;
}): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(NOW),
    bots: input.bots ?? [],
    groups: input.groups ?? [],
    threads: input.threads ?? [],
    delegations: input.delegations ?? [],
  };
}

export function createSession(
  threadId: OrchestrationThread["id"],
  status: OrchestrationSession["status"],
): OrchestrationSession {
  return {
    threadId,
    status,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: status === "running" ? TurnId.make(`turn-${threadId}`) : null,
    lastError: null,
    updatedAt: NOW,
  };
}

export function makeDelegation(
  input: Pick<AkeruDelegationRecord, "delegationId" | "parentBotId" | "childBotId" | "phase">,
): AkeruDelegationRecord {
  return {
    ...input,
    parentDelegationId: null,
    parentThreadId: ThreadId.make(`thread-${input.parentBotId}`),
    parentTurnId: TurnId.make(`turn-${input.parentBotId}`),
    ancestorBotIds: [input.parentBotId],
    depth: 1,
    task: "Compare three flights.",
    expectedResult: "A short comparison.",
    deadline: null,
    access: {
      allowedToolIds: [],
      memoryScopes: [],
      sandbox: null,
      runtimeMode: "full-access",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "send",
    },
    billedBotId: input.childBotId,
    keep: false,
    anchorMessageId: null,
    retryOfDelegationId: null,
    trigger: "bot",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

import {
  AuthSessionId,
  BotId,
  ClientOrchestrationCommand,
  CommandId,
  GroupId,
  MessageId,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationGroup,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";

export const NOW = "2026-08-27T12:00:00.000Z";

export const BOSS_ID = BotId.make("bot-boss");

export const SPECIALIST_ID = BotId.make("bot-specialist");

export const OTHER_SPECIALIST_ID = BotId.make("bot-other-specialist");

export const GROUP_ID = GroupId.make("group-product");

export const PERSON_ID = AuthSessionId.make("person-member");

export const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

export const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);

// Decides one command and projects its events, the same order the engine uses.
export const applyCommand = Effect.fn("applyCommand")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const result = yield* decideOrchestrationCommand({ command, readModel });
  const events = Array.isArray(result) ? result : [result];
  let next = readModel;
  for (const event of events) {
    next = yield* projectEvent(next, {
      ...event,
      sequence: next.snapshotSequence + 1,
    } as OrchestrationEvent);
  }
  return { readModel: next, events };
});

export function makeBot(input: {
  readonly id: OrchestrationBot["id"];
  readonly groupId?: OrchestrationBot["groupId"];
  readonly archivedAt?: OrchestrationBot["archivedAt"];
  readonly provider?: string;
  readonly model?: string;
}): OrchestrationBot {
  return {
    id: input.id,
    name: input.id,
    title: "Agent",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "dither", seed: input.id },
    engine: input.provider && input.model ? { provider: input.provider, model: input.model } : null,
    sandbox: "local",
    runtimeMode: "full-access",
    usageCap: null,
    imageProvider: null,
    voiceEnabled: false,
    channelBindings: [],
    groupId: input.groupId ?? null,
    archivedAt: input.archivedAt ?? null,
    createdAt: NOW,
    updatedAt: NOW,
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
    name: "Product",
    bossBotId: input.bossBotId ?? BOSS_ID,
    members: input.members ?? [
      { kind: "bot", botId: BOSS_ID, role: "boss" },
      { kind: "bot", botId: SPECIALIST_ID, role: "specialist" },
      { kind: "person", personId: PERSON_ID, displayName: "Member" },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function makeGroupThread(): OrchestrationThread {
  return {
    id: ThreadId.make("thread-group"),
    projectId: ProjectId.make("project-1"),
    botId: null,
    groupId: GROUP_ID,
    respondingBotId: null,
    title: "Group thread",
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

export function makeReadModel(input: {
  readonly bots?: ReadonlyArray<OrchestrationBot>;
  readonly groups?: ReadonlyArray<OrchestrationGroup>;
  readonly threads?: ReadonlyArray<OrchestrationThread>;
}): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(NOW),
    bots: input.bots ?? [],
    groups: input.groups ?? [],
    threads: input.threads ?? [],
  };
}

export const startTurnCommand = (
  respondingBotId?: BotId,
  senderPersonId: AuthSessionId | null = PERSON_ID,
) => ({
  type: "thread.turn.start" as const,
  commandId: CommandId.make("cmd-turn-start"),
  threadId: ThreadId.make("thread-group"),
  message: {
    messageId: MessageId.make("message-1"),
    role: "user" as const,
    text: "Please investigate.",
    attachments: [],
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  ...(respondingBotId !== undefined ? { respondingBotId } : {}),
  ...(senderPersonId !== null
    ? { senderPersonId, senderDisplayName: senderPersonId === PERSON_ID ? "Member" : "Outsider" }
    : {}),
  createdAt: NOW,
});

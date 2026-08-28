import {
  BotId,
  CommandId,
  EventId,
  GroupId,
  MessageId,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationBot,
  type OrchestrationGroup,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const BOSS_ID = BotId.make("bot-boss");
const SPECIALIST_ID = BotId.make("bot-specialist");
const GROUP_ID = GroupId.make("group-product");
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

function makeBot(input: {
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
    voiceEnabled: false,
    groupId: input.groupId ?? null,
    archivedAt: input.archivedAt ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeGroup(
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
      { botId: BOSS_ID, role: "boss" },
      { botId: SPECIALIST_ID, role: "specialist" },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeGroupThread(): OrchestrationThread {
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

function makeReadModel(input: {
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

const startTurnCommand = (respondingBotId?: BotId) => ({
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
  createdAt: NOW,
});

it.layer(NodeServices.layer)("group membership decider", (it) => {
  it.effect("rejects group creation without a boss", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "group.create",
          commandId: CommandId.make("cmd-group-create"),
          groupId: GROUP_ID,
          name: "Product",
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected group creation invariant error");
      }
      expect(error.detail).toContain("requires a boss");
    }),
  );

  it.effect("creates the boss membership and bot assignment together", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "group.create",
          commandId: CommandId.make("cmd-group-create"),
          groupId: GROUP_ID,
          name: "Product",
          bossBotId: BOSS_ID,
          specialistBotIds: [SPECIALIST_ID],
          createdAt: NOW,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
        }),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "group.created",
        "bot.updated",
        "bot.updated",
      ]);
      const created = events[0];
      if (created?.type !== "group.created") throw new Error("Expected group.created");
      expect(created.payload.bossBotId).toBe(BOSS_ID);
      expect(created.payload.members).toEqual([
        { botId: BOSS_ID, role: "boss" },
        { botId: SPECIALIST_ID, role: "specialist" },
      ]);
    }),
  );

  it.effect("rejects assigning an archived bot", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "group.member.assign",
          commandId: CommandId.make("cmd-member-assign"),
          groupId: GROUP_ID,
          botId: SPECIALIST_ID,
          role: "specialist",
        },
        readModel: makeReadModel({
          bots: [
            makeBot({ id: BOSS_ID, groupId: GROUP_ID }),
            makeBot({
              id: SPECIALIST_ID,
              archivedAt: NOW,
            }),
          ],
          groups: [makeGroup({ members: [{ botId: BOSS_ID, role: "boss" }] })],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected archived bot invariant error");
      }
      expect(error.detail).toContain("is archived");
    }),
  );

  it.effect("rejects unassigning the last boss", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "group.member.unassign",
          commandId: CommandId.make("cmd-member-unassign"),
          groupId: GROUP_ID,
          botId: BOSS_ID,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID, groupId: GROUP_ID })],
          groups: [makeGroup({ members: [{ botId: BOSS_ID, role: "boss" }] })],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected last boss invariant error");
      }
      expect(error.detail).toContain("last boss");
      expect(error.detail).toContain("group.boss.set");
    }),
  );

  it.effect("sets a new boss and unassigns the previous boss atomically", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "group.boss.set",
          commandId: CommandId.make("cmd-boss-set"),
          groupId: GROUP_ID,
          bossBotId: SPECIALIST_ID,
          unassignPreviousBoss: true,
        },
        readModel: makeReadModel({
          bots: [
            makeBot({ id: BOSS_ID, groupId: GROUP_ID }),
            makeBot({ id: SPECIALIST_ID, groupId: GROUP_ID }),
          ],
          groups: [makeGroup()],
        }),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual(["group.boss-set", "bot.updated"]);
      const bossSet = events[0];
      if (bossSet?.type !== "group.boss-set") throw new Error("Expected group.boss-set");
      expect(bossSet.payload.previousBossRole).toBe("unassigned");
    }),
  );

  it.effect("routes a group turn to the boss by default and a mentioned specialist once", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        bots: [
          makeBot({
            id: BOSS_ID,
            groupId: GROUP_ID,
            provider: "boss-provider",
            model: "boss-model",
          }),
          makeBot({
            id: SPECIALIST_ID,
            groupId: GROUP_ID,
            provider: "specialist-provider",
            model: "specialist-model",
          }),
        ],
        groups: [makeGroup()],
        threads: [makeGroupThread()],
      });

      const defaultResult = yield* decideOrchestrationCommand({
        command: startTurnCommand(),
        readModel,
      });
      const mentionedResult = yield* decideOrchestrationCommand({
        command: startTurnCommand(SPECIALIST_ID),
        readModel,
      });
      const defaultEvent = (Array.isArray(defaultResult) ? defaultResult : [defaultResult]).find(
        (event) => event.type === "thread.turn-start-requested",
      );
      const mentionedEvent = (
        Array.isArray(mentionedResult) ? mentionedResult : [mentionedResult]
      ).find((event) => event.type === "thread.turn-start-requested");

      if (defaultEvent?.type !== "thread.turn-start-requested") {
        throw new Error("Expected default turn start");
      }
      if (mentionedEvent?.type !== "thread.turn-start-requested") {
        throw new Error("Expected mentioned turn start");
      }
      expect(defaultEvent.payload.respondingBotId).toBe(BOSS_ID);
      expect(defaultEvent.payload.modelSelection).toEqual({
        instanceId: "boss-provider",
        model: "boss-model",
      });
      expect(mentionedEvent.payload.respondingBotId).toBe(SPECIALIST_ID);
      expect(mentionedEvent.payload.modelSelection).toEqual({
        instanceId: "specialist-provider",
        model: "specialist-model",
      });
    }),
  );

  it.effect("rejects a mention for a non-member or archived member", () =>
    Effect.gen(function* () {
      const outsiderId = BotId.make("bot-outsider");
      const base = makeReadModel({
        bots: [
          makeBot({ id: BOSS_ID, groupId: GROUP_ID }),
          makeBot({ id: SPECIALIST_ID, groupId: GROUP_ID, archivedAt: NOW }),
          makeBot({ id: outsiderId }),
        ],
        groups: [makeGroup()],
        threads: [makeGroupThread()],
      });

      const outsiderError = yield* decideOrchestrationCommand({
        command: startTurnCommand(outsiderId),
        readModel: base,
      }).pipe(Effect.flip);
      const archivedError = yield* decideOrchestrationCommand({
        command: startTurnCommand(SPECIALIST_ID),
        readModel: base,
      }).pipe(Effect.flip);

      if (
        outsiderError._tag !== "OrchestrationCommandInvariantError" ||
        archivedError._tag !== "OrchestrationCommandInvariantError"
      ) {
        throw new Error("Expected mention routing invariant errors");
      }
      expect(outsiderError.detail).toContain("not a member");
      expect(archivedError.detail).toContain("archived");
    }),
  );

  it.effect("replays group.created events from before membership", () =>
    Effect.gen(function* () {
      const event = yield* decodeOrchestrationEvent({
        sequence: 1,
        eventId: EventId.make("event-old-group"),
        aggregateKind: "group",
        aggregateId: GROUP_ID,
        type: "group.created",
        occurredAt: NOW,
        commandId: CommandId.make("cmd-old-group"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-old-group"),
        metadata: {},
        payload: {
          groupId: GROUP_ID,
          name: "Legacy group",
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      const replayed = yield* projectEvent(createEmptyReadModel(NOW), event);

      expect(replayed.groups).toEqual([
        {
          id: GROUP_ID,
          name: "Legacy group",
          bossBotId: null,
          members: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);
    }),
  );
});

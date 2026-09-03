import {
  AuthSessionId,
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
  type OrchestrationCommand,
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
const OTHER_SPECIALIST_ID = BotId.make("bot-other-specialist");
const GROUP_ID = GroupId.make("group-product");
const PERSON_ID = AuthSessionId.make("person-member");
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
    channelBindings: [],
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
      { kind: "bot", botId: BOSS_ID, role: "boss" },
      { kind: "bot", botId: SPECIALIST_ID, role: "specialist" },
      { kind: "person", personId: PERSON_ID, displayName: "Member" },
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

const startTurnCommand = (
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

      expect(events.map((event) => event.type)).toEqual(["group.created"]);
      const created = events[0];
      if (created?.type !== "group.created") throw new Error("Expected group.created");
      expect(created.payload.bossBotId).toBe(BOSS_ID);
      expect(created.payload.members).toEqual([
        { kind: "bot", botId: BOSS_ID, role: "boss" },
        { kind: "bot", botId: SPECIALIST_ID, role: "specialist" },
      ]);
    }),
  );

  it.effect("rejects group creation with fewer than two distinct active bots", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "group.create",
          commandId: CommandId.make("cmd-group-create-one-bot"),
          groupId: GROUP_ID,
          name: "Product",
          bossBotId: BOSS_ID,
          specialistBotIds: [BOSS_ID],
          createdAt: NOW,
        },
        readModel: makeReadModel({ bots: [makeBot({ id: BOSS_ID })] }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected minimum group size invariant error");
      }
      expect(error.detail).toContain("at least two active bots");
    }),
  );

  it.effect("adds the creator as a person member", () =>
    Effect.gen(function* () {
      const creator = {
        kind: "person" as const,
        personId: AuthSessionId.make("person-creator"),
        displayName: "Creator",
      };
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "group.create",
          commandId: CommandId.make("cmd-group-create-with-creator"),
          groupId: GROUP_ID,
          name: "Product",
          bossBotId: BOSS_ID,
          specialistBotIds: [SPECIALIST_ID],
          creator,
          createdAt: NOW,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      const created = events.find((event) => event.type === "group.created");

      if (created?.type !== "group.created") throw new Error("Expected group.created");
      expect(created.payload.members).toContainEqual(creator);
    }),
  );

  it.effect("assigns one bot to several groups", () =>
    Effect.gen(function* () {
      const otherGroupId = GroupId.make("group-other");
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "group.member.assign",
          commandId: CommandId.make("cmd-multi-group-member"),
          groupId: GROUP_ID,
          botId: SPECIALIST_ID,
          role: "specialist",
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID, groupId: otherGroupId })],
          groups: [
            makeGroup({ members: [{ kind: "bot", botId: BOSS_ID, role: "boss" }] }),
            {
              ...makeGroup({
                bossBotId: SPECIALIST_ID,
                members: [{ kind: "bot", botId: SPECIALIST_ID, role: "boss" }],
              }),
              id: otherGroupId,
            },
          ],
        }),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual(["group.member-assigned"]);
    }),
  );

  it.effect("rejects archiving a current group boss", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "bot.archive",
          commandId: CommandId.make("cmd-archive-group-boss"),
          botId: BOSS_ID,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID })],
          groups: [makeGroup()],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected boss archive invariant error");
      }
      expect(error.detail).toContain("Set a new boss before archiving it");
    }),
  );

  it.effect("rejects archiving a bot when its group would have fewer than two active bots", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "bot.archive",
          commandId: CommandId.make("cmd-archive-group-specialist"),
          botId: SPECIALIST_ID,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
          groups: [makeGroup()],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected minimum group size invariant error");
      }
      expect(error.detail).toContain("at least two active bots");
    }),
  );

  it.effect("rejects a legacy bot group move that would leave one active bot", () =>
    Effect.gen(function* () {
      const targetGroupId = GroupId.make("group-target");
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "bot.update",
          commandId: CommandId.make("cmd-move-group-specialist"),
          botId: SPECIALIST_ID,
          groupId: targetGroupId,
        },
        readModel: makeReadModel({
          bots: [
            makeBot({ id: BOSS_ID, groupId: GROUP_ID }),
            makeBot({ id: SPECIALIST_ID, groupId: GROUP_ID }),
            makeBot({ id: OTHER_SPECIALIST_ID, groupId: targetGroupId }),
          ],
          groups: [
            makeGroup(),
            {
              ...makeGroup({
                bossBotId: OTHER_SPECIALIST_ID,
                members: [{ kind: "bot", botId: OTHER_SPECIALIST_ID, role: "boss" }],
              }),
              id: targetGroupId,
            },
          ],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected minimum group size invariant error");
      }
      expect(error.detail).toContain("at least two active bots");
    }),
  );

  it.effect("clears group-owned thread ownership when deleting a group", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "group.delete",
          commandId: CommandId.make("cmd-delete-group"),
          groupId: GROUP_ID,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
          groups: [makeGroup()],
          threads: [makeGroupThread()],
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      const ownership = events.find((event) => event.type === "thread.ownership-updated");

      if (ownership?.type !== "thread.ownership-updated") {
        throw new Error("Expected thread.ownership-updated");
      }
      expect(ownership.payload).toMatchObject({ botId: null, groupId: null });
    }),
  );

  it.effect("lets paired clients configure groups but not create group-owned threads", () =>
    Effect.gen(function* () {
      const outsiderId = AuthSessionId.make("person-outsider");
      const actor = { personId: outsiderId, canManageGroups: false } as const;
      const readModel = {
        ...makeReadModel({
          bots: [
            makeBot({ id: BOSS_ID }),
            makeBot({ id: SPECIALIST_ID }),
            makeBot({ id: OTHER_SPECIALIST_ID }),
          ],
          groups: [
            makeGroup({
              members: [
                { kind: "bot", botId: BOSS_ID, role: "boss" },
                { kind: "bot", botId: SPECIALIST_ID, role: "specialist" },
                { kind: "bot", botId: OTHER_SPECIALIST_ID, role: "specialist" },
                { kind: "person", personId: PERSON_ID, displayName: "Member" },
              ],
            }),
          ],
        }),
        projects: [
          {
            id: ProjectId.make("project-1"),
            title: "Project",
            workspaceRoot: "/tmp/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt: null,
          },
        ],
      };
      const results = yield* Effect.all([
        Effect.result(
          decideOrchestrationCommand({
            command: {
              type: "group.rename",
              commandId: CommandId.make("cmd-outsider-rename"),
              groupId: GROUP_ID,
              name: "Renamed",
            },
            readModel,
            actor,
          }),
        ),
        Effect.result(
          decideOrchestrationCommand({
            command: {
              type: "group.delete",
              commandId: CommandId.make("cmd-outsider-delete"),
              groupId: GROUP_ID,
            },
            readModel,
            actor,
          }),
        ),
        Effect.result(
          decideOrchestrationCommand({
            command: {
              type: "group.member.assign",
              commandId: CommandId.make("cmd-outsider-assign"),
              groupId: GROUP_ID,
              botId: SPECIALIST_ID,
              role: "specialist",
            },
            readModel,
            actor,
          }),
        ),
        Effect.result(
          decideOrchestrationCommand({
            command: {
              type: "group.member.unassign",
              commandId: CommandId.make("cmd-outsider-unassign"),
              groupId: GROUP_ID,
              botId: SPECIALIST_ID,
            },
            readModel,
            actor,
          }),
        ),
        Effect.result(
          decideOrchestrationCommand({
            command: {
              type: "group.boss.set",
              commandId: CommandId.make("cmd-outsider-boss"),
              groupId: GROUP_ID,
              bossBotId: SPECIALIST_ID,
            },
            readModel,
            actor,
          }),
        ),
        Effect.result(
          decideOrchestrationCommand({
            command: {
              type: "thread.create",
              commandId: CommandId.make("cmd-outsider-thread"),
              threadId: ThreadId.make("thread-outsider"),
              projectId: ProjectId.make("project-1"),
              groupId: GROUP_ID,
              title: "Outsider thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("default"),
                model: "default-model",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: NOW,
            },
            readModel,
            actor,
          }),
        ),
      ]);

      expect(results.map((result) => result._tag)).toEqual([
        "Success",
        "Success",
        "Success",
        "Success",
        "Success",
        "Failure",
      ]);
    }),
  );

  it.effect("lets an administrator mutate a group without membership", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "group.rename",
          commandId: CommandId.make("cmd-admin-rename"),
          groupId: GROUP_ID,
          name: "Admin renamed",
        },
        readModel: makeReadModel({ groups: [makeGroup()] }),
        actor: {
          personId: AuthSessionId.make("person-admin"),
          canManageGroups: true,
        },
      });

      if (!("type" in result)) throw new Error("Expected one group.renamed event");
      expect(result.type).toBe("group.renamed");
    }),
  );

  it.effect("rejects group-owned thread mutations from an authenticated outsider", () =>
    Effect.gen(function* () {
      const actor = {
        personId: AuthSessionId.make("person-outsider"),
        canManageGroups: false,
      } as const;
      const readModel = makeReadModel({
        groups: [makeGroup()],
        threads: [makeGroupThread()],
      });
      const commands = [
        {
          type: "thread.delete",
          commandId: CommandId.make("cmd-outsider-thread-delete"),
          threadId: ThreadId.make("thread-group"),
        },
        {
          type: "thread.archive",
          commandId: CommandId.make("cmd-outsider-thread-archive"),
          threadId: ThreadId.make("thread-group"),
        },
        {
          type: "thread.unarchive",
          commandId: CommandId.make("cmd-outsider-thread-unarchive"),
          threadId: ThreadId.make("thread-group"),
        },
        {
          type: "thread.settle",
          commandId: CommandId.make("cmd-outsider-thread-settle"),
          threadId: ThreadId.make("thread-group"),
        },
        {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-outsider-thread-meta"),
          threadId: ThreadId.make("thread-group"),
          title: "Outsider title",
        },
        {
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-outsider-thread-stop"),
          threadId: ThreadId.make("thread-group"),
          createdAt: NOW,
        },
        {
          type: "thread.message.reaction.set",
          commandId: CommandId.make("cmd-outsider-thread-reaction"),
          threadId: ThreadId.make("thread-group"),
          messageId: MessageId.make("message-1"),
          botId: BOSS_ID,
          emoji: "👍",
          present: true,
          updatedAt: NOW,
        },
      ] satisfies ReadonlyArray<OrchestrationCommand>;
      const errors = yield* Effect.all(
        commands.map((command) =>
          decideOrchestrationCommand({ command, readModel, actor }).pipe(Effect.flip),
        ),
      );

      for (const error of errors) {
        if (error._tag !== "OrchestrationCommandInvariantError") {
          throw new Error("Expected group thread authorization error");
        }
        expect(error.detail).toContain(`Person '${actor.personId}' is not a member`);
      }
    }),
  );

  it.effect("lets a member mutate a group-owned thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-member-thread-meta"),
          threadId: ThreadId.make("thread-group"),
          title: "Member title",
        },
        readModel: makeReadModel({ groups: [makeGroup()], threads: [makeGroupThread()] }),
        actor: { personId: PERSON_ID, canManageGroups: false },
      });

      if (!("type" in result)) throw new Error("Expected one thread.meta-updated event");
      expect(result.type).toBe("thread.meta-updated");
    }),
  );

  it.effect("lets an administrator mutate a group-owned thread without membership", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: CommandId.make("cmd-admin-thread-delete"),
          threadId: ThreadId.make("thread-group"),
        },
        readModel: makeReadModel({ groups: [makeGroup()], threads: [makeGroupThread()] }),
        actor: {
          personId: AuthSessionId.make("person-admin"),
          canManageGroups: true,
        },
      });

      if (!("type" in result)) throw new Error("Expected one thread.deleted event");
      expect(result.type).toBe("thread.deleted");
    }),
  );

  it.effect("keeps trusted internal group-thread mutations actorless", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-internal-thread-stop"),
          threadId: ThreadId.make("thread-group"),
          createdAt: NOW,
        },
        readModel: makeReadModel({ groups: [makeGroup()], threads: [makeGroupThread()] }),
      });

      if (!("type" in result)) throw new Error("Expected one thread.session-stop-requested event");
      expect(result.type).toBe("thread.session-stop-requested");
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
          groups: [makeGroup({ members: [{ kind: "bot", botId: BOSS_ID, role: "boss" }] })],
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
          groups: [makeGroup({ members: [{ kind: "bot", botId: BOSS_ID, role: "boss" }] })],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected last boss invariant error");
      }
      expect(error.detail).toContain("last boss");
      expect(error.detail).toContain("group.boss.set");
    }),
  );

  it.effect("rejects unassigning a bot when the group would have fewer than two active bots", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "group.member.unassign",
          commandId: CommandId.make("cmd-member-unassign-specialist"),
          groupId: GROUP_ID,
          botId: SPECIALIST_ID,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
          groups: [makeGroup()],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected minimum group size invariant error");
      }
      expect(error.detail).toContain("at least two active bots");
    }),
  );

  it.effect("rejects replacing and removing the boss when one active bot would remain", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "group.boss.set",
          commandId: CommandId.make("cmd-boss-set-one-remaining"),
          groupId: GROUP_ID,
          bossBotId: SPECIALIST_ID,
          unassignPreviousBoss: true,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
          groups: [makeGroup()],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected minimum group size invariant error");
      }
      expect(error.detail).toContain("at least two active bots");
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
            makeBot({ id: OTHER_SPECIALIST_ID, groupId: GROUP_ID }),
          ],
          groups: [
            makeGroup({
              members: [
                { kind: "bot", botId: BOSS_ID, role: "boss" },
                { kind: "bot", botId: SPECIALIST_ID, role: "specialist" },
                { kind: "bot", botId: OTHER_SPECIALIST_ID, role: "specialist" },
              ],
            }),
          ],
        }),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual(["group.boss-set"]);
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

  it.effect("rejects a group turn from a person who is not a member", () =>
    Effect.gen(function* () {
      const outsiderId = AuthSessionId.make("person-outsider");
      const error = yield* decideOrchestrationCommand({
        command: {
          ...startTurnCommand(),
          senderPersonId: outsiderId,
          senderDisplayName: "Outsider",
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
          groups: [makeGroup()],
          threads: [makeGroupThread()],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected sender membership invariant error");
      }
      expect(error.detail).toContain(`Person '${outsiderId}' is not a member`);
    }),
  );

  it.effect("lets an administrator claim a legacy bot-only group on the first turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          ...startTurnCommand(),
          senderCanManageGroups: true,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
          groups: [
            makeGroup({
              members: [
                { kind: "bot", botId: BOSS_ID, role: "boss" },
                { kind: "bot", botId: SPECIALIST_ID, role: "specialist" },
              ],
            }),
          ],
          threads: [makeGroupThread()],
        }),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "group.person-assigned",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const assigned = events[0];
      if (assigned?.type !== "group.person-assigned") {
        throw new Error("Expected group person assignment");
      }
      expect(assigned.payload.person.personId).toBe(PERSON_ID);
      expect(assigned.payload.person.displayName).toBe("Member");
    }),
  );

  it.effect("rejects an ordinary person from a legacy bot-only group", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          ...startTurnCommand(),
          senderCanManageGroups: false,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
          groups: [
            makeGroup({
              members: [
                { kind: "bot", botId: BOSS_ID, role: "boss" },
                { kind: "bot", botId: SPECIALIST_ID, role: "specialist" },
              ],
            }),
          ],
          threads: [makeGroupThread()],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected sender membership invariant error");
      }
      expect(error.detail).toContain(`Person '${PERSON_ID}' is not a member`);
    }),
  );

  it.effect("rejects a group turn without an authenticated sender", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: startTurnCommand(undefined, null),
        readModel: makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
          groups: [makeGroup()],
          threads: [makeGroupThread()],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected missing sender invariant error");
      }
      expect(error.detail).toContain("A person member must send turns");
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

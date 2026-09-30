import {
  AuthSessionId,
  BotId,
  ClientOrchestrationCommand,
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

import { applyAuthenticatedCommandActor } from "./AuthenticatedCommand.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const BOSS_ID = BotId.make("bot-boss");
const SPECIALIST_ID = BotId.make("bot-specialist");
const OTHER_SPECIALIST_ID = BotId.make("bot-other-specialist");
const GROUP_ID = GroupId.make("group-product");
const PERSON_ID = AuthSessionId.make("person-member");
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);

// Decides one command and projects its events, the same order the engine uses.
const applyCommand = Effect.fn("applyCommand")(function* (
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
    imageProvider: null,
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

  it.effect("binds client group reactions to the authenticated person", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-1");
      const readModel = makeReadModel({
        bots: [
          makeBot({ id: BOSS_ID, groupId: GROUP_ID }),
          makeBot({ id: SPECIALIST_ID, groupId: GROUP_ID }),
        ],
        groups: [makeGroup()],
        threads: [
          {
            ...makeGroupThread(),
            respondingBotId: BOSS_ID,
            messages: [
              {
                id: messageId,
                role: "user",
                text: "Please investigate.",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          },
        ],
      });
      const command = {
        type: "thread.message.reaction.set",
        commandId: CommandId.make("cmd-member-thread-reaction"),
        threadId: ThreadId.make("thread-group"),
        messageId,
        botId: SPECIALIST_ID,
        emoji: "👍",
        present: true,
        updatedAt: NOW,
      } as const;

      const result = yield* decideOrchestrationCommand({
        command,
        readModel,
        actor: { personId: PERSON_ID, canManageGroups: false },
      });

      const event = (Array.isArray(result) ? result : [result]).find(
        (candidate) => candidate.type === "thread.message-reaction-set",
      );
      if (event?.type !== "thread.message-reaction-set") {
        throw new Error("Expected thread.message-reaction-set");
      }
      expect(event.payload).toMatchObject({ personId: PERSON_ID, emoji: "👍", present: true });
      expect(event.payload.botId).toBeUndefined();
    }),
  );

  it.effect("keeps trusted internal group reactions bot-authored", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-1");
      const readModel = makeReadModel({
        bots: [makeBot({ id: BOSS_ID, groupId: GROUP_ID })],
        groups: [makeGroup()],
        threads: [
          {
            ...makeGroupThread(),
            respondingBotId: BOSS_ID,
            messages: [
              {
                id: messageId,
                role: "user",
                text: "Please investigate.",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          },
        ],
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.reaction.set",
          commandId: CommandId.make("cmd-internal-thread-reaction"),
          threadId: ThreadId.make("thread-group"),
          messageId,
          botId: BOSS_ID,
          emoji: "👍",
          present: true,
          updatedAt: NOW,
        },
        readModel,
      });

      const event = (Array.isArray(result) ? result : [result]).find(
        (candidate) => candidate.type === "thread.message-reaction-set",
      );
      if (event?.type !== "thread.message-reaction-set") {
        throw new Error("Expected thread.message-reaction-set");
      }
      expect(event.payload).toMatchObject({ botId: BOSS_ID, emoji: "👍", present: true });
      expect(event.payload.personId).toBeUndefined();
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

  it.effect("routes an @bot:<id> token to that member when the client sends no responder", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        bots: [
          makeBot({ id: BOSS_ID, groupId: GROUP_ID }),
          makeBot({ id: SPECIALIST_ID, groupId: GROUP_ID }),
          makeBot({ id: BotId.make("bot-outsider") }),
        ],
        groups: [makeGroup()],
        threads: [makeGroupThread()],
      });
      const responderFor = (text: string) =>
        decideOrchestrationCommand({
          command: {
            ...startTurnCommand(),
            message: { ...startTurnCommand().message, text },
          },
          readModel,
        }).pipe(
          Effect.map((result) => {
            const event = (Array.isArray(result) ? result : [result]).find(
              (entry) => entry.type === "thread.turn-start-requested",
            );
            if (event?.type !== "thread.turn-start-requested") {
              throw new Error("Expected turn start");
            }
            return event.payload.respondingBotId;
          }),
        );

      expect(yield* responderFor(`@bot:${SPECIALIST_ID} look`)).toBe(SPECIALIST_ID);
      expect(yield* responderFor("@bot:bot-outsider look")).toBe(BOSS_ID);
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
  it.effect("walks every bot-only group action forward and back", () =>
    Effect.gen(function* () {
      const groupState = (model: OrchestrationReadModel) =>
        model.groups.find((group) => group.id === GROUP_ID);
      let model = makeReadModel({
        bots: [
          makeBot({ id: BOSS_ID }),
          makeBot({ id: SPECIALIST_ID }),
          makeBot({ id: OTHER_SPECIALIST_ID }),
        ],
      });

      ({ readModel: model } = yield* applyCommand(model, {
        type: "group.create",
        commandId: CommandId.make("cmd-lifecycle-create"),
        groupId: GROUP_ID,
        name: "Product",
        bossBotId: BOSS_ID,
        specialistBotIds: [SPECIALIST_ID],
        createdAt: NOW,
      }));
      expect(groupState(model)?.bossBotId).toBe(BOSS_ID);

      ({ readModel: model } = yield* applyCommand(model, {
        type: "group.rename",
        commandId: CommandId.make("cmd-lifecycle-rename"),
        groupId: GROUP_ID,
        name: "Launch crew",
      }));
      expect(groupState(model)?.name).toBe("Launch crew");

      ({ readModel: model } = yield* applyCommand(model, {
        type: "group.member.assign",
        commandId: CommandId.make("cmd-lifecycle-add"),
        groupId: GROUP_ID,
        botId: OTHER_SPECIALIST_ID,
        role: "specialist",
      }));
      expect(groupState(model)?.members).toContainEqual({
        kind: "bot",
        botId: OTHER_SPECIALIST_ID,
        role: "specialist",
      });

      ({ readModel: model } = yield* applyCommand(model, {
        type: "group.member.unassign",
        commandId: CommandId.make("cmd-lifecycle-remove"),
        groupId: GROUP_ID,
        botId: OTHER_SPECIALIST_ID,
      }));
      expect(
        groupState(model)?.members.some(
          (member) => member.kind === "bot" && member.botId === OTHER_SPECIALIST_ID,
        ),
      ).toBe(false);

      // Add the bot back so the old boss can step down and leave afterwards.
      ({ readModel: model } = yield* applyCommand(model, {
        type: "group.member.assign",
        commandId: CommandId.make("cmd-lifecycle-readd"),
        groupId: GROUP_ID,
        botId: OTHER_SPECIALIST_ID,
        role: "specialist",
      }));
      ({ readModel: model } = yield* applyCommand(model, {
        type: "group.boss.set",
        commandId: CommandId.make("cmd-lifecycle-boss"),
        groupId: GROUP_ID,
        bossBotId: SPECIALIST_ID,
        unassignPreviousBoss: false,
      }));
      expect(groupState(model)?.bossBotId).toBe(SPECIALIST_ID);
      expect(groupState(model)?.members).toContainEqual({
        kind: "bot",
        botId: BOSS_ID,
        role: "specialist",
      });

      ({ readModel: model } = yield* applyCommand(model, {
        type: "group.member.unassign",
        commandId: CommandId.make("cmd-lifecycle-remove-old-boss"),
        groupId: GROUP_ID,
        botId: BOSS_ID,
      }));
      expect(
        groupState(model)
          ?.members.filter((member) => member.kind === "bot")
          .map((member) => member.botId)
          .toSorted(),
      ).toEqual([OTHER_SPECIALIST_ID, SPECIALIST_ID].toSorted());

      ({ readModel: model } = yield* applyCommand(model, {
        type: "group.delete",
        commandId: CommandId.make("cmd-lifecycle-delete"),
        groupId: GROUP_ID,
      }));
      expect(groupState(model)).toBeUndefined();
      expect(model.bots.map((bot) => bot.id)).toEqual([
        BOSS_ID,
        SPECIALIST_ID,
        OTHER_SPECIALIST_ID,
      ]);
    }),
  );

  it.effect("lets a person leave a group and rejects a second leave", () =>
    Effect.gen(function* () {
      const leave = {
        type: "group.leave" as const,
        commandId: CommandId.make("cmd-group-leave"),
        groupId: GROUP_ID,
        personId: PERSON_ID,
      };
      const { readModel } = yield* applyCommand(
        makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
          groups: [makeGroup()],
        }),
        leave,
      );

      expect(readModel.groups[0]?.members.some((member) => member.kind === "person")).toBe(false);
      const error = yield* decideOrchestrationCommand({ command: leave, readModel }).pipe(
        Effect.flip,
      );
      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected group leave invariant error");
      }
      expect(error.detail).toContain("not a member");
    }),
  );

  it.effect("clears the mentioned responder when the group is deleted", () =>
    Effect.gen(function* () {
      const mentioned = yield* applyCommand(
        makeReadModel({
          bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
          groups: [makeGroup()],
          threads: [makeGroupThread()],
        }),
        startTurnCommand(SPECIALIST_ID),
      );
      expect(mentioned.readModel.threads[0]?.respondingBotId).toBe(SPECIALIST_ID);

      const { readModel } = yield* applyCommand(mentioned.readModel, {
        type: "group.delete",
        commandId: CommandId.make("cmd-delete-after-mention"),
        groupId: GROUP_ID,
      });

      expect(readModel.threads[0]).toMatchObject({
        botId: null,
        groupId: null,
        respondingBotId: null,
      });
    }),
  );

  it.effect("routes a client @mention to that bot's engine, then back to the boss", () =>
    Effect.gen(function* () {
      let model = makeReadModel({
        bots: [
          makeBot({ id: BOSS_ID, provider: "claudeAgent", model: "claude-opus-5-5" }),
          makeBot({ id: SPECIALIST_ID, provider: "grok", model: "grok-5" }),
        ],
        groups: [makeGroup()],
        threads: [makeGroupThread()],
      });
      const actor = { personId: PERSON_ID, displayName: "Member", canManageGroups: false };
      // The web composer resolves "@bot-specialist" to respondingBotId before it sends.
      const clientTurn = (messageId: string, text: string, respondingBotId?: BotId) =>
        Effect.gen(function* () {
          const decoded = yield* decodeClientCommand({
            type: "thread.turn.start",
            commandId: `cmd-${messageId}`,
            threadId: "thread-group",
            message: { messageId, role: "user", text, attachments: [] },
            runtimeMode: "full-access",
            interactionMode: "default",
            ...(respondingBotId !== undefined ? { respondingBotId } : {}),
            // A client cannot claim to be someone else; the server sets the sender.
            senderPersonId: "person-forged",
            createdAt: NOW,
          });
          if (decoded.type !== "thread.turn.start") throw new Error("Expected a turn start");
          return applyAuthenticatedCommandActor(
            { ...decoded, message: { ...decoded.message, attachments: [] } },
            actor,
          );
        });
      const turnStart = (events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>) => {
        const event = events.find((entry) => entry.type === "thread.turn-start-requested");
        if (event?.type !== "thread.turn-start-requested") {
          throw new Error("Expected thread.turn-start-requested");
        }
        return event.payload;
      };

      const mentioned = yield* applyCommand(
        model,
        yield* clientTurn("message-mention", "@bot-specialist check the logs", SPECIALIST_ID),
      );
      model = mentioned.readModel;
      expect(turnStart(mentioned.events)).toMatchObject({
        respondingBotId: SPECIALIST_ID,
        modelSelection: { instanceId: "grok", model: "grok-5" },
      });
      expect(model.threads[0]?.respondingBotId).toBe(SPECIALIST_ID);
      expect(
        mentioned.events.find((entry) => entry.type === "thread.message-sent")?.payload,
      ).toMatchObject({ authorPersonId: PERSON_ID, text: "@bot-specialist check the logs" });

      const unmentioned = yield* applyCommand(
        model,
        yield* clientTurn("message-plain", "Thanks @Leo, what next?"),
      );
      expect(turnStart(unmentioned.events)).toMatchObject({
        respondingBotId: BOSS_ID,
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      });
      expect(unmentioned.readModel.threads[0]?.respondingBotId).toBe(BOSS_ID);
    }),
  );

  it.effect("attributes a server-authored group message to a named member bot", () =>
    Effect.gen(function* () {
      const outsiderId = BotId.make("bot-outsider");
      const base = makeReadModel({
        bots: [
          makeBot({ id: BOSS_ID, groupId: GROUP_ID }),
          makeBot({ id: SPECIALIST_ID, groupId: GROUP_ID }),
          makeBot({ id: outsiderId }),
        ],
        groups: [makeGroup()],
        threads: [{ ...makeGroupThread(), respondingBotId: BOSS_ID }],
      });
      const message = (botId: BotId, type: "delta" | "complete") =>
        type === "delta"
          ? ({
              type: "thread.message.assistant.delta",
              commandId: CommandId.make(`cmd-delta-${botId}`),
              threadId: ThreadId.make("thread-group"),
              messageId: MessageId.make("message-result"),
              delta: "Finished work for Boss: Research\n\nDone.",
              respondingBotId: botId,
              createdAt: NOW,
            } as const)
          : ({
              type: "thread.message.assistant.complete",
              commandId: CommandId.make(`cmd-complete-${botId}`),
              threadId: ThreadId.make("thread-group"),
              messageId: MessageId.make("message-result"),
              respondingBotId: botId,
              createdAt: NOW,
            } as const);

      const delta = yield* applyCommand(base, message(SPECIALIST_ID, "delta"));
      const complete = yield* applyCommand(delta.readModel, message(SPECIALIST_ID, "complete"));
      expect(complete.readModel.threads[0]?.messages).toEqual([
        expect.objectContaining({
          id: MessageId.make("message-result"),
          role: "assistant",
          respondingBotId: SPECIALIST_ID,
          turnId: null,
          streaming: false,
        }),
      ]);
      // The group's own responder is unchanged by an attributed message.
      expect(complete.readModel.threads[0]?.respondingBotId).toBe(BOSS_ID);

      const outsiderError = yield* decideOrchestrationCommand({
        command: message(outsiderId, "delta"),
        readModel: base,
      }).pipe(Effect.flip);
      expect(outsiderError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects attributing a direct chat message to another bot", () =>
    Effect.gen(function* () {
      const base = makeReadModel({
        bots: [makeBot({ id: BOSS_ID }), makeBot({ id: SPECIALIST_ID })],
        threads: [{ ...makeGroupThread(), groupId: null, botId: BOSS_ID }],
      });
      const command = {
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-direct-delta"),
        threadId: ThreadId.make("thread-group"),
        messageId: MessageId.make("message-direct"),
        delta: "Hello",
        createdAt: NOW,
      } as const;
      const error = yield* decideOrchestrationCommand({
        command: { ...command, respondingBotId: SPECIALIST_ID },
        readModel: base,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      const own = yield* applyCommand(base, { ...command, respondingBotId: BOSS_ID });
      expect(own.readModel.threads[0]?.messages[0]?.respondingBotId).toBe(BOSS_ID);
    }),
  );
});

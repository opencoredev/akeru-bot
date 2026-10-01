import {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@akeru/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import {
  makeReadModel,
  makeBot,
  BOSS_ID,
  SPECIALIST_ID,
  OTHER_SPECIALIST_ID,
  makeGroup,
  PERSON_ID,
  NOW,
  GROUP_ID,
  makeGroupThread,
  startTurnCommand,
} from "./test-support/GroupDeciderFixtures.ts";

it.layer(NodeServices.layer)("group membership decider", (it) => {
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
});

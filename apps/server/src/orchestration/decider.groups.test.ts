import { AuthSessionId, CommandId, GroupId, type OrchestrationReadModel } from "@akeru/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import {
  GROUP_ID,
  NOW,
  makeReadModel,
  BOSS_ID,
  SPECIALIST_ID,
  makeBot,
  makeGroup,
  OTHER_SPECIALIST_ID,
  makeGroupThread,
  applyCommand,
  PERSON_ID,
  startTurnCommand,
} from "./test-support/GroupDeciderFixtures.ts";

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
});

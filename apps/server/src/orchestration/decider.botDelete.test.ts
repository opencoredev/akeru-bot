import {
  CommandId,
  DelegationId,
  EventId,
  ThreadId,
  TurnId,
  isGroupBotMember,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import {
  makeReadModel,
  makeBot,
  BOT_ID,
  makeBotThread,
  createSession,
  OTHER_BOT_ID,
  THIRD_BOT_ID,
  makeDelegation,
  NOW,
  GROUP_ID,
  makeGroup,
} from "./test-support/BotDeleteFixtures.ts";

it.layer(NodeServices.layer)("bot delete decider", (it) => {
  it.effect("deletes a bot and detaches its chats", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        bots: [makeBot({ id: BOT_ID })],
        threads: [makeBotThread(BOT_ID)],
      });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "bot.delete",
          commandId: CommandId.make("cmd-bot-delete"),
          botId: BOT_ID,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.ownership-updated",
        "bot.deleted",
      ]);
      const ownership = events[0];
      if (ownership?.type !== "thread.ownership-updated") {
        throw new Error("Expected thread.ownership-updated");
      }
      expect(ownership.payload.botId).toBeNull();
      expect(ownership.payload.groupId).toBeNull();

      let next = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of events) {
        sequence += 1;
        next = yield* projectEvent(next, {
          ...event,
          sequence,
          eventId: EventId.make(`evt-${sequence}`),
        });
      }
      expect(next.bots).toHaveLength(0);
      expect(next.threads[0]?.botId).toBeNull();
    }),
  );

  it.effect("stops the bot's sessions, child chats, and in-flight delegations", () =>
    Effect.gen(function* () {
      const botThread = {
        ...makeBotThread(BOT_ID),
        session: createSession(ThreadId.make(`thread-${BOT_ID}`), "running"),
      };
      const idleThread = {
        ...makeBotThread(BOT_ID),
        id: ThreadId.make("thread-idle"),
        session: createSession(ThreadId.make("thread-idle"), "stopped"),
      };
      const childThread = {
        ...makeBotThread(OTHER_BOT_ID),
        id: ThreadId.make("thread-child"),
        parentThreadId: botThread.id,
        session: createSession(ThreadId.make("thread-child"), "running"),
      };
      const unrelatedThread = {
        ...makeBotThread(THIRD_BOT_ID),
        session: createSession(ThreadId.make(`thread-${THIRD_BOT_ID}`), "running"),
      };
      const sent = makeDelegation({
        delegationId: DelegationId.make("delegation-sent"),
        parentBotId: BOT_ID,
        childBotId: OTHER_BOT_ID,
        phase: {
          _tag: "Running",
          childThreadId: childThread.id,
          childTurnId: TurnId.make("turn-child"),
          startedAt: NOW,
          progress: null,
        },
      });
      const received = makeDelegation({
        delegationId: DelegationId.make("delegation-received"),
        parentBotId: OTHER_BOT_ID,
        childBotId: BOT_ID,
        phase: { _tag: "Queued" },
      });
      const finished = makeDelegation({
        delegationId: DelegationId.make("delegation-finished"),
        parentBotId: BOT_ID,
        childBotId: OTHER_BOT_ID,
        phase: {
          _tag: "Canceled",
          childThreadId: null,
          childTurnId: null,
          startedAt: null,
          completedAt: NOW,
          canceledBy: "user",
        },
      });
      const unrelated = makeDelegation({
        delegationId: DelegationId.make("delegation-unrelated"),
        parentBotId: OTHER_BOT_ID,
        childBotId: THIRD_BOT_ID,
        phase: { _tag: "Queued" },
      });
      const readModel = makeReadModel({
        bots: [
          makeBot({ id: BOT_ID }),
          makeBot({ id: OTHER_BOT_ID }),
          makeBot({ id: THIRD_BOT_ID }),
        ],
        threads: [botThread, idleThread, childThread, unrelatedThread],
        delegations: [sent, received, finished, unrelated],
      });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "bot.delete",
          commandId: CommandId.make("cmd-bot-delete-working"),
          botId: BOT_ID,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "delegation.updated",
        "delegation.updated",
        "thread.session-stop-requested",
        "thread.session-stop-requested",
        "thread.ownership-updated",
        "thread.ownership-updated",
        "bot.deleted",
      ]);
      expect(
        events.flatMap((event) =>
          event.type === "thread.session-stop-requested" ? [event.payload.threadId] : [],
        ),
      ).toEqual([botThread.id, childThread.id]);

      let next = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of events) {
        sequence += 1;
        next = yield* projectEvent(next, {
          ...event,
          sequence,
          eventId: EventId.make(`evt-${sequence}`),
        });
      }
      const phases = Object.fromEntries(
        next.delegations.map((delegation) => [delegation.delegationId, delegation.phase]),
      );
      expect(phases[sent.delegationId]).toMatchObject({
        _tag: "Canceled",
        childThreadId: childThread.id,
        childTurnId: TurnId.make("turn-child"),
      });
      expect(phases[received.delegationId]?._tag).toBe("Canceled");
      expect(phases[finished.delegationId]).toEqual(finished.phase);
      expect(phases[unrelated.delegationId]?._tag).toBe("Queued");
    }),
  );

  it.effect("clears a deleted group responder without detaching the chat", () =>
    Effect.gen(function* () {
      const groupThread = {
        ...makeBotThread(BOT_ID),
        id: ThreadId.make("thread-group"),
        botId: null,
        groupId: GROUP_ID,
        respondingBotId: BOT_ID,
        session: createSession(ThreadId.make("thread-group"), "ready"),
      };
      const readModel = makeReadModel({
        bots: [
          makeBot({ id: BOT_ID }),
          makeBot({ id: OTHER_BOT_ID }),
          makeBot({ id: THIRD_BOT_ID }),
        ],
        groups: [
          makeGroup({
            bossBotId: OTHER_BOT_ID,
            members: [
              { kind: "bot", botId: OTHER_BOT_ID, role: "boss" },
              { kind: "bot", botId: THIRD_BOT_ID, role: "specialist" },
              { kind: "bot", botId: BOT_ID, role: "specialist" },
            ],
          }),
        ],
        threads: [groupThread],
      });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "bot.delete",
          commandId: CommandId.make("cmd-delete-responder"),
          botId: BOT_ID,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.session-stop-requested",
        "group.member-unassigned",
        "thread.ownership-updated",
        "bot.deleted",
      ]);

      let next = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of events) {
        sequence += 1;
        next = yield* projectEvent(next, {
          ...event,
          sequence,
          eventId: EventId.make(`evt-${sequence}`),
        });
      }
      const thread = next.threads.find((entry) => entry.id === groupThread.id);
      expect(thread?.groupId).toBe(GROUP_ID);
      expect(thread?.botId).toBeNull();
      expect(thread?.respondingBotId).toBeNull();
    }),
  );

  it.effect("rejects deleting a group boss", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "bot.delete",
          commandId: CommandId.make("cmd-delete-boss"),
          botId: BOT_ID,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOT_ID }), makeBot({ id: OTHER_BOT_ID })],
          groups: [makeGroup()],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected boss delete invariant error");
      }
      expect(error.detail).toContain("Set a new boss before deleting it");
    }),
  );

  it.effect("rejects deleting a bot when its group would have fewer than two active bots", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "bot.delete",
          commandId: CommandId.make("cmd-delete-specialist"),
          botId: OTHER_BOT_ID,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOT_ID }), makeBot({ id: OTHER_BOT_ID })],
          groups: [makeGroup()],
        }),
      }).pipe(Effect.flip);

      if (error._tag !== "OrchestrationCommandInvariantError") {
        throw new Error("Expected minimum group size invariant error");
      }
      expect(error.detail).toContain("at least two active bots");
    }),
  );

  it.effect("unassigns group membership when deleting a member bot", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        bots: [
          makeBot({ id: BOT_ID }),
          makeBot({ id: OTHER_BOT_ID }),
          makeBot({ id: THIRD_BOT_ID }),
        ],
        groups: [
          makeGroup({
            members: [
              { kind: "bot", botId: BOT_ID, role: "boss" },
              { kind: "bot", botId: OTHER_BOT_ID, role: "specialist" },
              { kind: "bot", botId: THIRD_BOT_ID, role: "specialist" },
            ],
          }),
        ],
      });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "bot.delete",
          commandId: CommandId.make("cmd-delete-member"),
          botId: THIRD_BOT_ID,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual(["group.member-unassigned", "bot.deleted"]);

      let next = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of events) {
        sequence += 1;
        next = yield* projectEvent(next, {
          ...event,
          sequence,
          eventId: EventId.make(`evt-${sequence}`),
        });
      }
      expect(next.bots).toHaveLength(2);
      const memberIds = next.groups[0]?.members
        .filter(isGroupBotMember)
        .map((member) => member.botId);
      expect(memberIds).toEqual([BOT_ID, OTHER_BOT_ID]);
    }),
  );
});

import * as Predicate from "effect/Predicate";
import {
  BotId,
  CommandId,
  EventId,
  MessageId,
  OrchestrationEvent,
  ThreadId,
} from "@akeru/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { applyAuthenticatedCommandActor } from "./AuthenticatedCommand.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import {
  makeReadModel,
  makeBot,
  BOSS_ID,
  GROUP_ID,
  SPECIALIST_ID,
  makeGroup,
  makeGroupThread,
  startTurnCommand,
  NOW,
  decodeOrchestrationEvent,
  PERSON_ID,
  decodeClientCommand,
  applyCommand,
} from "./test-support/GroupDeciderFixtures.ts";

it.layer(NodeServices.layer)("group membership decider", (it) => {
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
        !Predicate.isTagged(outsiderError, "OrchestrationCommandInvariantError") ||
        !Predicate.isTagged(archivedError, "OrchestrationCommandInvariantError")
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

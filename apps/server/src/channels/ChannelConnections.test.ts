import {
  failureOf,
  expectFailureMessage,
  connectChannel,
  disconnectChannel,
  detachChannelConnection,
  reconnectChannel,
  restoreConnectedChannels,
  sendChannelMessage,
  stopChannelsForBot,
  shutdownAllChannels,
  stopArchivedBotChannels,
  NOW,
  BOT_ID,
  PROJECT_ID,
  MISSING_PROJECT_ID,
  makeBot,
  makeMessage,
  makeThread,
  makeHarness,
  telegramConnect,
  imessageConnect,
  whatsappConnect,
} from "./testUtils/channelRuntime.ts";
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type ChannelBinding,
  type OrchestrationMessage,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT,
  ChannelPostRejectedError,
  channelBindingsForRuntime as channelBindingsWith,
  type ChannelRuntimeDependencies,
} from "./ChannelRuntime.ts";
describe("channel runtime", () => {
  it.effect("clears the connecting binding when a start is interrupted", () =>
    Effect.gen(function* () {
      const starting = Promise.withResolvers<void>();
      const harness = makeHarness({
        startTransport: () => {
          starting.resolve();
          return new Promise(() => {});
        },
      });
      const attempt = yield* Effect.forkChild(
        connectChannel(harness.dependencies, telegramConnect(BOT_ID)),
      );
      yield* Effect.promise(() => starting.promise);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.status).toBe("connecting");
      yield* Fiber.interrupt(attempt);
      expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
    }),
  );

  it.effect("stops routing messages from a disconnected transport that fails to shut down", () =>
    Effect.gen(function* () {
      const callbacks: Array<
        Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1]
      > = [];
      let stops = 0;
      const harness = makeHarness({
        startTransport: async (_input, onDirectMessage) => {
          callbacks.push(onDirectMessage);
          return {
            externalIdentity: "@akeru",
            runtime: {
              post: async () => undefined,
              shutdown: async () => {
                stops += 1;
                throw new Error("shutdown failed");
              },
            },
          };
        },
      });
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

      yield* expectFailureMessage(
        disconnectChannel(harness.dependencies, BOT_ID, "telegram"),
        "Channel provider request failed.",
      );
      expect(harness.readModel().bots[0]?.channelBindings[0]?.status).toBe("disconnected");
      yield* Effect.promise(async () =>
        callbacks[0]?.({
          externalThreadId: "telegram:retired",
          externalMessageId: "late",
          text: "Late event",
        }),
      );
      expect(
        harness.commands.filter((command) => command.type === "thread.turn.start"),
      ).toHaveLength(0);
      yield* stopChannelsForBot(BOT_ID);
      expect(stops).toBe(1);
    }),
  );

  it.effect("ignores callbacks from a disconnected or replaced transport", () =>
    Effect.gen(function* () {
      const callbacks: Array<
        Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1]
      > = [];
      const harness = makeHarness({
        startTransport: async (_input, onDirectMessage) => {
          callbacks.push(onDirectMessage);
          return {
            externalIdentity: "@akeru",
            runtime: {
              post: async () => undefined,
              shutdown: async () => undefined,
            },
          };
        },
      });
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* disconnectChannel(harness.dependencies, BOT_ID, "telegram");
      const message = {
        externalThreadId: "telegram:retired",
        externalMessageId: "late",
        text: "Late event",
      };
      yield* Effect.promise(async () => callbacks[0]?.(message));
      expect(
        harness.commands.filter((command) => command.type === "thread.turn.start"),
      ).toHaveLength(0);

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* Effect.promise(async () => callbacks[0]?.(message));
      expect(
        harness.commands.filter((command) => command.type === "thread.turn.start"),
      ).toHaveLength(0);
      yield* Effect.promise(async () =>
        callbacks[1]?.({ ...message, externalMessageId: "current" }),
      );
      expect(
        harness.commands.filter((command) => command.type === "thread.turn.start"),
      ).toHaveLength(1);
    }),
  );

  it("shows connected persisted bindings as needing reconnect until transport starts", () => {
    const binding: ChannelBinding = {
      botId: BOT_ID,
      provider: "telegram",
      status: "connected",
      externalIdentity: "@akeru",
      connectedAt: NOW,
      sentMessageIds: [],
    };

    expect(channelBindingsWith([binding], () => false)).toEqual([
      { ...binding, status: "needs-reconnect" },
    ]);
    expect(channelBindingsWith([binding], () => true)).toEqual([binding]);
  });

  it.effect("rejects archived bot connections and skips them during restore", () =>
    Effect.gen(function* () {
      let starts = 0;
      const binding: ChannelBinding = {
        botId: BOT_ID,
        provider: "telegram",
        status: "connected",
        externalIdentity: "@akeru",
        connectedAt: NOW,
        sentMessageIds: [],
      };
      const harness = makeHarness({
        bots: [makeBot(BOT_ID, { archivedAt: NOW, channelBindings: [binding] })],
        startTransport: async () => {
          starts += 1;
          throw new Error("Transport must not start.");
        },
      });

      yield* expectFailureMessage(
        connectChannel(harness.dependencies, telegramConnect(BOT_ID)),
        "unavailable",
      );
      expect(yield* restoreConnectedChannels(harness.dependencies)).toEqual([]);
      expect(starts).toBe(0);
    }),
  );

  it.effect("records a truthful failed state when restore cannot start the transport", () =>
    Effect.gen(function* () {
      const binding: ChannelBinding = {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "telegram",
        status: "connected",
        externalIdentity: "@akeru",
        connectedAt: NOW,
        sentMessageIds: [],
      };
      const harness = makeHarness({
        bots: [makeBot(BOT_ID, { channelBindings: [binding] })],
        startTransport: async () => {
          throw new Error("invalid secret value must not be stored in health");
        },
      });

      expect(yield* restoreConnectedChannels(harness.dependencies)).toHaveLength(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
        status: "failed",
        lastError: "Connection restore failed. Reconnect with updated credentials.",
      });
    }),
  );

  it.effect("keeps a deleted project blocked when restore cannot start the transport", () =>
    Effect.gen(function* () {
      const binding: ChannelBinding = {
        botId: BOT_ID,
        projectId: MISSING_PROJECT_ID,
        provider: "telegram",
        status: "connected",
        externalIdentity: "@akeru",
        connectedAt: NOW,
        sentMessageIds: [],
      };
      const harness = makeHarness({
        bots: [makeBot(BOT_ID, { channelBindings: [binding] })],
      });

      expect(yield* restoreConnectedChannels(harness.dependencies)).toHaveLength(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
        status: "blocked",
        lastError: "The selected project is unavailable. Choose another project.",
      });
    }),
  );

  it.effect("stops every live transport on bot archive events without stopping restored bots", () =>
    Effect.gen(function* () {
      let stops = 0;
      const harness = makeHarness({ shutdown: async () => void (stops += 1) });
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* connectChannel(harness.dependencies, imessageConnect(BOT_ID));
      const eventBase = {
        sequence: 13,
        eventId: EventId.make("event-bot-lifecycle"),
        aggregateKind: "bot" as const,
        aggregateId: BOT_ID,
        occurredAt: NOW,
        commandId: CommandId.make("command-bot-lifecycle"),
        causationEventId: null,
        correlationId: CommandId.make("command-bot-lifecycle"),
        metadata: {},
      };

      yield* stopArchivedBotChannels(
        Stream.make({
          ...eventBase,
          type: "bot.restored",
          payload: { botId: BOT_ID, updatedAt: NOW },
        }),
      );
      expect(stops).toBe(0);

      yield* stopArchivedBotChannels(
        Stream.make({
          ...eventBase,
          type: "bot.archived",
          payload: { botId: BOT_ID, archivedAt: NOW, updatedAt: NOW },
        }),
      );
      expect(stops).toBe(2);
    }),
  );

  it.effect("connects, disconnects, reconnects, restores, and stops a bot runtime", () =>
    Effect.gen(function* () {
      let starts = 0;
      let stops = 0;
      const harness = makeHarness({
        startTransport: async () => {
          starts += 1;
          return {
            externalIdentity: "@akeru",
            runtime: {
              post: async () => undefined,
              shutdown: async () => void (stops += 1),
            },
          };
        },
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      expect(harness.readModel().bots[0]?.channelBindings?.[0]?.status).toBe("connected");
      yield* stopChannelsForBot(BOT_ID);
      expect(stops).toBe(1);
      yield* reconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* stopChannelsForBot(BOT_ID);
      yield* restoreConnectedChannels(harness.dependencies);
      yield* disconnectChannel(harness.dependencies, BOT_ID, "telegram");

      expect(starts).toBe(3);
      expect(stops).toBe(3);
      expect(harness.readModel().bots[0]?.channelBindings?.[0]?.status).toBe("disconnected");
      expect(harness.secrets.size).toBe(1);
      yield* detachChannelConnection(harness.dependencies, BOT_ID, "telegram");
      expect(harness.secrets.size).toBe(0);
    }),
  );

  it.effect("allows not-live WhatsApp replies but blocks other not-live channels", () =>
    Effect.gen(function* () {
      for (const provider of ["telegram", "whatsapp"] as const) {
        const messageId = MessageId.make(`not-live-reply-${provider}`);
        const threadId = ThreadId.make(`thread-not-live-${provider}`);
        let posts = 0;
        const harness = makeHarness({
          threads: [
            makeThread(threadId, BOT_ID, [
              makeMessage(MessageId.make(`not-live-inbound-${provider}`), "user", "Question", {
                provider,
                externalThreadId: `${provider}:conversation`,
              }),
              makeMessage(messageId, "assistant", "Answer"),
            ]),
          ],
          post: async () => void (posts += 1),
        });
        yield* connectChannel(
          harness.dependencies,
          provider === "telegram" ? telegramConnect(BOT_ID) : whatsappConnect(BOT_ID),
        );
        const update = harness.commands.findLast((command) => command.type === "bot.update");
        if (!update) throw new Error("Expected a connected channel binding");
        yield* harness.dependencies.engine.dispatch({
          ...update,
          commandId: CommandId.make(`mark-not-live-${provider}`),
          channelBindings: update.channelBindings?.map((binding) => ({
            ...binding,
            status: "not-live" as const,
          })),
        });

        const send = sendChannelMessage(harness.dependencies, {
          botId: BOT_ID,
          threadId,
          messageId,
        });
        if (provider === "telegram") {
          yield* expectFailureMessage(send, "Reconnect this channel before sending a reply.");
          expect(posts).toBe(0);
        } else {
          yield* send;
          expect(posts).toBe(1);
        }
      }
    }),
  );

  it.effect("stops a started transport when the live-bot projection read fails", () =>
    Effect.gen(function* () {
      let failNextRead = false;
      let stops = 0;
      const harness = makeHarness({
        startTransport: async () => {
          failNextRead = true;
          return {
            externalIdentity: "@akeru",
            runtime: {
              post: async () => undefined,
              shutdown: async () => void (stops += 1),
            },
          };
        },
      });
      const readModel = harness.dependencies.readModel;
      const dependencies = {
        ...harness.dependencies,
        readModel: Effect.suspend(() => {
          if (!failNextRead) return readModel;
          failNextRead = false;
          return Effect.die(new Error("projection read failed"));
        }),
      };

      yield* expectFailureMessage(
        connectChannel(dependencies, telegramConnect(BOT_ID)),
        "projection read failed",
      );
      expect(stops).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings?.[0]?.status).not.toBe("connected");
    }),
  );

  it.effect("retries a definite provider rejection and serializes concurrent approvals", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-definite-rejection");
      const threadId = ThreadId.make("thread-definite-rejection");
      let posts = 0;
      const harness = makeHarness({
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-definite-rejection"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-definite-rejection",
            }),
            makeMessage(messageId, "assistant", "Send once"),
          ]),
        ],
        post: async () => {
          posts += 1;
          if (posts === 1)
            throw new ChannelPostRejectedError({ message: "provider rejected secret-token" });
        },
      });
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      const input = { botId: BOT_ID, threadId, messageId };
      expect(yield* failureOf(sendChannelMessage(harness.dependencies, input))).toMatchObject({
        _tag: "ChannelPostRejectedError",
      });
      expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
        status: "connected",
        lastError: "The channel rejected this reply. Correct the channel problem, then retry.",
        failureCategory: "credentials",
      });
      yield* Effect.all(
        Array.from({ length: 8 }, () => sendChannelMessage(harness.dependencies, input)),
        { concurrency: "unbounded" },
      );
      expect(posts).toBe(2);
      const sent = harness.readModel().bots[0]?.channelBindings[0];
      expect(sent?.sentMessageIds).toEqual([messageId]);
      expect(sent).not.toHaveProperty("lastError");
      expect(sent).not.toHaveProperty("failureCategory");
    }),
  );

  it.effect("releases a pre-transport failure so approval can retry after reconnect", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-before-transport");
      const threadId = ThreadId.make("thread-before-transport");
      let posts = 0;
      const harness = makeHarness({
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-before-transport"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-before-transport",
            }),
            makeMessage(messageId, "assistant", "Send once"),
          ]),
        ],
        post: async () => void (posts += 1),
      });
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* shutdownAllChannels();

      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
        "needs reconnect",
      );
      expect(posts).toBe(0);
      yield* reconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });
      expect(posts).toBe(1);
    }),
  );

  it.effect("fills the sent binding on retry after binding persistence fails", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-binding-retry");
      const threadId = ThreadId.make("thread-binding-retry");
      let posts = 0;
      const harness = makeHarness({
        failBotUpdate: (updateIndex) =>
          updateIndex === 3 ? new Error("binding persistence failed") : undefined,
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-binding"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-binding",
            }),
            makeMessage(messageId, "assistant", "Send once and recover"),
          ]),
        ],
        post: async () => void (posts += 1),
      });
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
        "binding persistence failed",
      );
      expect(
        yield* sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
      ).toBeGreaterThan(0);

      expect(posts).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toContain(messageId);
    }),
  );

  it.effect("bounds sent-message recovery metadata", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-recovery-bound");
      const messages: OrchestrationMessage[] = [];
      const assistantIds: MessageId[] = [];
      for (let index = 0; index < CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT + 2; index += 1) {
        messages.push(
          makeMessage(MessageId.make(`inbound-${index}`), "user", `Question ${index}`, {
            provider: "telegram",
            externalThreadId: "chat-recovery-bound",
          }),
        );
        const assistantId = MessageId.make(`assistant-${index}`);
        assistantIds.push(assistantId);
        messages.push(makeMessage(assistantId, "assistant", `Answer ${index}`));
      }
      let posts = 0;
      const harness = makeHarness({
        threads: [makeThread(threadId, BOT_ID, messages)],
        post: async () => void (posts += 1),
      });
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

      for (const messageId of assistantIds) {
        yield* sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });
      }

      const sent = harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds ?? [];
      expect(sent).toHaveLength(CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT);
      expect(sent).not.toContain(assistantIds[0]);
      expect(sent).toContain(assistantIds.at(-1));
      yield* sendChannelMessage(harness.dependencies, {
        botId: BOT_ID,
        threadId,
        messageId: assistantIds[0]!,
      });
      expect(posts).toBe(assistantIds.length);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toHaveLength(
        CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT,
      );
    }),
  );
});

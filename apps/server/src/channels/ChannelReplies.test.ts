import {
  runWith,
  failureOf,
  expectFailureMessage,
  expectProviderFailure,
  connectChannel,
  disconnectChannel,
  reconnectChannel,
  restoreConnectedChannels,
  sendChannelMessage,
  sendCompletedChannelReply,
  shutdownAllChannels,
  NOW,
  BOT_ID,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  makeBot,
  makeMessage,
  makeThread,
  makeHarness,
  makeAdapterDeliveryHarness,
  telegramConnect,
  imessageConnect,
  slackConnect,
  externalAdapters,
} from "./testUtils/channelRuntime.ts";
import {
  BotId,
  MessageId,
  ThreadId,
  TurnId,
  type ChannelBinding,
  type OrchestrationThread,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeMemoryChannelDeliveryStore } from "./ChannelDeliveryStore.ts";
import { type ChannelRuntimeDependencies } from "./ChannelRuntime.ts";

describe("channel runtime", () => {
  it.effect("rejects a reply after its channel moves to another project", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("old-project-reply");
      const messageId = MessageId.make("old-project-assistant");
      let posts = 0;

      const harness = makeHarness({
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("old-project-request"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "telegram:old-project-chat",
            }),
            makeMessage(messageId, "assistant", "Answer"),
          ]),
        ],
        post: async () => void (posts += 1),
      });

      yield* connectChannel(harness.dependencies, {
        ...telegramConnect(BOT_ID),
        targetProjectId: SECOND_PROJECT_ID,
      });

      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
        "previous channel project assignment",
      );
      expect(posts).toBe(0);
    }),
  );

  it.effect("does not send a local turn to an earlier channel conversation", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-local-after-channel");
      const inboundMessageId = MessageId.make("inbound-before-local-turn");
      const localMessageId = MessageId.make("local-request");
      const assistantMessageId = MessageId.make("local-assistant");
      const threadId = ThreadId.make("thread-local-after-channel");
      let posts = 0;

      const thread: OrchestrationThread = {
        ...makeThread(threadId, BOT_ID, [
          makeMessage(inboundMessageId, "user", "Channel question", {
            provider: "imessage",
            externalThreadId: "iMessage;-;sender",
          }),
          makeMessage(localMessageId, "user", "Local question"),
          { ...makeMessage(assistantMessageId, "assistant", "Local answer"), turnId },
        ]),
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId,
          requestMessageId: localMessageId,
          respondingBotId: BOT_ID,
        },
      };

      const harness = makeHarness({
        threads: [thread],
        post: async () => void (posts += 1),
      });

      yield* connectChannel(harness.dependencies, imessageConnect(BOT_ID));

      expect(yield* sendCompletedChannelReply(harness.dependencies, threadId, turnId)).toBeNull();

      expect(posts).toBe(0);
    }),
  );

  it.effect.each([
    new Error("timeout with secret-token; channel_not_found"),
    { status: 200, data: { ok: false, error: "internal_error", detail: "secret-token" } },
    { status: 200, data: { ok: false, error: "request_timeout" } },
    { status: 503, data: "secret-token" },
  ])("retains an ambiguous Slack post without SDK retries: %j", (response) =>
    Effect.gen(function* () {
      const { harness, input } = makeAdapterDeliveryHarness("slack", "slack:C123:1");
      externalAdapters.slackResponses.push(response);
      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
      const failure = yield* failureOf(sendChannelMessage(harness.dependencies, input));
      expect(failure).toMatchObject({
        message:
          "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
      });
      expect(failure).not.toHaveProperty("cause");
      yield* disconnectChannel(harness.dependencies, BOT_ID, "slack");
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toContain(
        "Check the channel",
      );
      yield* reconnectChannel(harness.dependencies, BOT_ID, "slack");
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toContain(
        "Check the channel",
      );
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "unfinished delivery attempt",
      );
      expect(externalAdapters.slackPostRequests).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([]);
    }),
  );

  it.effect("serializes normal concurrent approvals with the delivery store as the authority", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-concurrent");
      const threadId = ThreadId.make("thread-concurrent");
      let posts = 0;

      const harness = makeHarness({
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-concurrent"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-concurrent",
            }),
            makeMessage(messageId, "assistant", "Send once"),
          ]),
        ],
        post: async () => void (posts += 1),
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      const input = { botId: BOT_ID, threadId, messageId };
      yield* Effect.all(
        Array.from({ length: 8 }, () => sendChannelMessage(harness.dependencies, input)),
        { concurrency: "unbounded" },
      );
      expect(posts).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([messageId]);
    }),
  );

  it.effect("retains an ambiguous post after reconnect so explicit approval cannot repost", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-retry");
      const threadId = ThreadId.make("thread-retry");
      let posts = 0;

      const harness = makeHarness({
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-retry",
            }),
            makeMessage(messageId, "assistant", "Retry me"),
          ]),
        ],
        post: async () => {
          posts += 1;
          throw new Error("timeout after remote acceptance");
        },
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

      yield* expectProviderFailure(
        sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
        "timeout after remote acceptance",
      );
      expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
        status: "connected",
        lastAttemptAt: NOW,
        lastError:
          "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
      });
      yield* shutdownAllChannels();
      yield* reconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
        "unfinished delivery attempt",
      );
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toContain(
        "Check the channel",
      );
      expect(posts).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).not.toContain(
        messageId,
      );
    }),
  );

  it.effect("does not mark, release, or repost an unresolved failed delivery", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-release-failed");
      const threadId = ThreadId.make("thread-release-failed");
      let status: "requested" | "sent" | undefined;
      let posts = 0;
      let marks = 0;

      const deliveryStore: ChannelRuntimeDependencies["deliveryStore"] = {
        claim: () =>
          Effect.sync(() => {
            if (status) return status;
            status = "requested";

            return "claimed";
          }),
        listRequestedClaims: () => Effect.succeed([]),
        releaseRequested: () => Effect.die(new Error("release failed")),
        markSent: () => Effect.sync(() => void (marks += 1)),
      };

      const harness = makeHarness({
        deliveryStore,
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-release"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-release",
            }),
            makeMessage(messageId, "assistant", "Do not mark me sent"),
          ]),
        ],
        post: async () => {
          posts += 1;
          throw new Error("post failed");
        },
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

      yield* expectProviderFailure(
        sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
        "post failed",
      );
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
        "unfinished delivery attempt",
      );

      expect(posts).toBe(1);
      expect(marks).toBe(0);
    }),
  );

  it.effect("does not repost after transport succeeds and mark-sent fails", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-mark-sent-retry");
      const threadId = ThreadId.make("thread-mark-sent-retry");
      let deliveryStatus: "requested" | "sent" | undefined;
      let markAttempts = 0;
      let posts = 0;

      const deliveryStore: ChannelRuntimeDependencies["deliveryStore"] = {
        claim: () =>
          Effect.sync(() => {
            if (deliveryStatus) return deliveryStatus;
            deliveryStatus = "requested";

            return "claimed";
          }),
        listRequestedClaims: () => Effect.succeed([]),
        releaseRequested: () => Effect.sync(() => void (deliveryStatus = undefined)),
        markSent: () =>
          Effect.sync(() => {
            markAttempts += 1;

            if (markAttempts === 1) throw new Error("database unavailable");
            deliveryStatus = "sent";
          }),
      };

      const harness = makeHarness({
        deliveryStore,
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-mark"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-mark",
            }),
            makeMessage(messageId, "assistant", "Send once"),
          ]),
        ],
        post: async () => void (posts += 1),
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
        "database unavailable",
      );
      expect(
        yield* sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
      ).toBeGreaterThan(0);
      expect(posts).toBe(1);
      expect(markAttempts).toBe(2);
    }),
  );

  it.effect("marks the delivery sent when the post lands but mark-sent fails", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-mark-sent-delivery");
      const threadId = ThreadId.make("thread-mark-sent-delivery");

      const deliveryStore: ChannelRuntimeDependencies["deliveryStore"] = {
        claim: () => Effect.succeed("claimed" as const),
        listRequestedClaims: () => Effect.succeed([]),
        releaseRequested: () => Effect.void,
        markSent: () => Effect.die(new Error("database unavailable")),
      };

      const harness = makeHarness({
        deliveryStore,
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-mark-delivery"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-mark-delivery",
            }),
            makeMessage(messageId, "assistant", "Send once"),
          ]),
        ],
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
        "database unavailable",
      );

      const deliveries = harness.commands
        .filter((command) => command.type === "thread.channel-delivery.set")
        .map((command) => (command.type === "thread.channel-delivery.set" ? command.delivery : ""));

      expect(deliveries).toEqual(["pending", "sent"]);
    }),
  );

  it.effect("reconciles interrupted sends to unknown during restore", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-restore-unknown");
      const threadId = ThreadId.make("thread-restore-unknown");
      const deliveryStore = makeMemoryChannelDeliveryStore();
      yield* deliveryStore.claim({
        messageId,
        botId: BOT_ID,
        threadId,
        provider: "telegram",
        externalThreadId: "chat-restore-unknown",
        requestedAt: NOW,
      });

      const assistantMessage = {
        ...makeMessage(messageId, "assistant", "Interrupted reply"),
        channelDelivery: "pending" as const,
      };

      const binding: ChannelBinding = {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "telegram",
        status: "disconnected",
        externalIdentity: "@akeru",
        connectedAt: NOW,
        sentMessageIds: [],
      };

      const harness = makeHarness({
        deliveryStore,
        bots: [makeBot(BOT_ID, { channelBindings: [binding] })],
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-restore-unknown"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-restore-unknown",
            }),
            assistantMessage,
          ]),
        ],
      });

      yield* restoreConnectedChannels(harness.dependencies);

      const deliveries = harness.commands
        .filter((command) => command.type === "thread.channel-delivery.set")
        .map((command) => (command.type === "thread.channel-delivery.set" ? command.delivery : ""));

      expect(deliveries).toEqual(["unknown"]);
    }),
  );

  it.effect("reconciles interrupted sends with sent binding evidence to sent during restore", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-restore-sent");
      const threadId = ThreadId.make("thread-restore-sent");
      const deliveryStore = makeMemoryChannelDeliveryStore();
      yield* deliveryStore.claim({
        messageId,
        botId: BOT_ID,
        threadId,
        provider: "telegram",
        externalThreadId: "chat-restore-sent",
        requestedAt: NOW,
      });

      const harness = makeHarness({
        deliveryStore,
        bots: [
          makeBot(BOT_ID, {
            channelBindings: [
              {
                botId: BOT_ID,
                projectId: PROJECT_ID,
                provider: "telegram",
                status: "disconnected",
                externalIdentity: "@akeru",
                connectedAt: NOW,
                sentMessageIds: [messageId],
              },
            ],
          }),
        ],
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-restore-sent"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-restore-sent",
            }),
            { ...makeMessage(messageId, "assistant", "Landed reply"), channelDelivery: "pending" },
          ]),
        ],
      });

      yield* restoreConnectedChannels(harness.dependencies);

      const deliveries = harness.commands
        .filter((command) => command.type === "thread.channel-delivery.set")
        .map((command) => (command.type === "thread.channel-delivery.set" ? command.delivery : ""));

      expect(deliveries).toEqual(["sent"]);
    }),
  );

  it.effect("restores channels when delivery reconciliation cannot read its claims", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        deliveryStore: {
          ...makeMemoryChannelDeliveryStore(),
          listRequestedClaims: () => Effect.die(new Error("database unavailable")),
        },
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

      expect(yield* restoreConnectedChannels(harness.dependencies)).toEqual([]);
    }),
  );

  it.effect("repairs a missing delivery record from sent binding evidence without reposting", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-sent-evidence");
      const threadId = ThreadId.make("thread-sent-evidence");
      let posts = 0;

      const harness = makeHarness({
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-sent-evidence"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-sent-evidence",
            }),
            makeMessage(messageId, "assistant", "Send once"),
          ]),
        ],
        post: async () => void (posts += 1),
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });
      const deliveryStore = makeMemoryChannelDeliveryStore();
      const restored = { ...harness.dependencies, deliveryStore };
      yield* sendChannelMessage(restored, { botId: BOT_ID, threadId, messageId });
      expect(posts).toBe(1);
      expect(
        yield* deliveryStore.claim({
          messageId,
          botId: BOT_ID,
          threadId,
          provider: "telegram",
          externalThreadId: "chat-sent-evidence",
          requestedAt: NOW,
        }),
      ).toBe("sent");
    }),
  );

  describe("reply ownership", () => {
    const delegatedThread = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly parentThreadId?: ThreadId;
      readonly respondingBotId: BotId;
    }): OrchestrationThread => {
      const requestMessageId = MessageId.make(`${input.threadId}-request`);
      const assistantMessageId = MessageId.make(`${input.threadId}-reply`);

      return {
        ...makeThread(input.threadId, BOT_ID, [
          makeMessage(requestMessageId, "user", "Please delegate", {
            provider: "telegram",
            externalThreadId: "chat-delegation",
          }),
          { ...makeMessage(assistantMessageId, "assistant", "Done"), turnId: input.turnId },
        ]),
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        latestTurn: {
          turnId: input.turnId,
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId,
          requestMessageId,
          respondingBotId: input.respondingBotId,
        },
      };
    };

    it.effect("sends only the owner reply when the bot delegates", () =>
      Effect.gen(function* () {
        const helperId = BotId.make("bot-helper");
        const ownerThreadId = ThreadId.make("thread-owner");
        const childThreadId = ThreadId.make("thread-child");
        const subagentThreadId = ThreadId.make("thread-subagent");
        const ownerTurn = TurnId.make("turn-owner");
        const childTurn = TurnId.make("turn-child");
        const subagentTurn = TurnId.make("turn-subagent");
        let posts = 0;

        const harness = makeHarness({
          bots: [makeBot(BOT_ID), makeBot(helperId)],
          threads: [
            delegatedThread({
              threadId: ownerThreadId,
              turnId: ownerTurn,
              respondingBotId: BOT_ID,
            }),
            delegatedThread({
              threadId: childThreadId,
              turnId: childTurn,
              parentThreadId: ownerThreadId,
              respondingBotId: helperId,
            }),
            delegatedThread({
              threadId: subagentThreadId,
              turnId: subagentTurn,
              parentThreadId: ownerThreadId,
              respondingBotId: BOT_ID,
            }),
          ],
          post: async () => void (posts += 1),
        });

        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

        const resolve = (threadId: ThreadId, turnId: TurnId) =>
          runWith(harness.dependencies, (runtime) =>
            runtime.resolveCompletedChannelReply(threadId, turnId),
          );

        expect(yield* resolve(childThreadId, childTurn)).toBeNull();
        expect(yield* resolve(subagentThreadId, subagentTurn)).toBeNull();
        expect(yield* resolve(ownerThreadId, ownerTurn)).toEqual({
          botId: BOT_ID,
          threadId: ownerThreadId,
          messageId: MessageId.make(`${ownerThreadId}-reply`),
        });

        yield* sendCompletedChannelReply(harness.dependencies, childThreadId, childTurn);
        yield* sendCompletedChannelReply(harness.dependencies, subagentThreadId, subagentTurn);
        expect(posts).toBe(0);
        yield* sendCompletedChannelReply(harness.dependencies, ownerThreadId, ownerTurn);
        expect(posts).toBe(1);
      }),
    );

    it.effect("does not send a turn another bot answered in the owner's thread", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-other-responder");
        const turnId = TurnId.make("turn-other-responder");

        const harness = makeHarness({
          bots: [makeBot(BOT_ID), makeBot(BotId.make("bot-other"))],
          threads: [
            delegatedThread({ threadId, turnId, respondingBotId: BotId.make("bot-other") }),
          ],
        });

        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

        expect(
          yield* runWith(harness.dependencies, (runtime) =>
            runtime.resolveCompletedChannelReply(threadId, turnId),
          ),
        ).toBeNull();
      }),
    );
  });
});

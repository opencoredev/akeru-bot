import {
  failureOf,
  expectFailureMessage,
  connectChannel,
  disconnectChannel,
  reconnectChannel,
  sendChannelMessage,
  finishChannelTurn,
  clearChannelThreadStatuses,
  NOW,
  BOT_ID,
  PROJECT_ID,
  makeMessage,
  makeThread,
  makeHarness,
  telegramConnect,
  imessageConnect,
  whatsappConnect,
  slackConnect,
  discordConnect,
  externalAdapters,
} from "./testUtils/channelRuntime.ts";
import { MessageId, ThreadId, TurnId, type OrchestrationThread } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { ChannelPostRejectedError, channelThreadId } from "./ChannelRuntime.ts";

describe("channel runtime", () => {
  it.effect.each(["slack", "discord"] as const)(
    "cleans persisted and terminal %s reactions through adapter APIs",
    (provider) =>
      Effect.gen(function* () {
        const externalThreadId = provider === "slack" ? "slack:C1:1" : "discord:guild-1:channel-1";
        const threadId = channelThreadId(BOT_ID, PROJECT_ID, provider, externalThreadId);
        const turnId = TurnId.make("reaction-turn");
        const requestMessageId = MessageId.make("reaction-request");

        const thread: OrchestrationThread = {
          ...makeThread(threadId, BOT_ID, [
            makeMessage(requestMessageId, "user", "Question", {
              provider,
              externalThreadId,
              externalMessageId: "external-request",
            }),
          ]),
          latestTurn: {
            turnId,
            state: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: null,
            requestMessageId,
            respondingBotId: BOT_ID,
          },
        };

        const harness = makeHarness({
          startTransport: null,
          threads: [thread],
          commandModelOmitsMessages: true,
        });

        yield* connectChannel(
          harness.dependencies,
          provider === "slack" ? slackConnect(BOT_ID) : discordConnect(BOT_ID),
        );
        const prefix = `${externalThreadId}:external-request`;
        expect(externalAdapters.reactions).toEqual([
          `remove:${prefix}:eyes`,
          `remove:${prefix}:check`,
          `remove:${prefix}:x`,
          `remove:${prefix}:hourglass`,
        ]);
        yield* finishChannelTurn(harness.dependencies, threadId, turnId, "completed");
        expect(externalAdapters.reactions.at(-1)).toBe(`add:${prefix}:check`);
        const count = externalAdapters.reactions.length;
        yield* finishChannelTurn(harness.dependencies, threadId, turnId, "completed");
        expect(externalAdapters.reactions).toHaveLength(count);
        yield* clearChannelThreadStatuses(threadId);
        expect(externalAdapters.reactions.slice(-4)).toEqual([
          `remove:${prefix}:eyes`,
          `remove:${prefix}:check`,
          `remove:${prefix}:x`,
          `remove:${prefix}:hourglass`,
        ]);
        yield* finishChannelTurn(harness.dependencies, threadId, turnId, "failed");
        expect(externalAdapters.reactions.at(-1)).toBe(`add:${prefix}:x`);
        yield* disconnectChannel(harness.dependencies, BOT_ID, provider);
        expect(externalAdapters.reactions.slice(-4)).toEqual([
          `remove:${prefix}:eyes`,
          `remove:${prefix}:check`,
          `remove:${prefix}:x`,
          `remove:${prefix}:hourglass`,
        ]);
        externalAdapters.reactions.length = 0;
        yield* reconnectChannel(harness.dependencies, BOT_ID, provider);
        expect(externalAdapters.reactions).toEqual([
          `remove:${prefix}:eyes`,
          `remove:${prefix}:check`,
          `remove:${prefix}:x`,
          `remove:${prefix}:hourglass`,
        ]);
      }),
  );

  it.effect("appends the Open in Akeru footer only from a server-advertised public origin", () =>
    Effect.gen(function* () {
      const url = `https://akeru.example.com/bots/${BOT_ID}`;

      const cases = [
        {
          provider: "whatsapp" as const,
          externalThreadId: "whatsapp:phone-number-id:15551234567",
          externalSenderId: "15551234567",
          connect: whatsappConnect(BOT_ID),
          withOrigin: `Approved answer\n\nOpen in Akeru: ${url}`,
        },
        {
          provider: "slack" as const,
          externalThreadId: "slack:C1:1.000",
          externalSenderId: "U1",
          connect: slackConnect(BOT_ID),
          withOrigin: `Approved answer\n\nOpen in Akeru: ${url}`,
        },
        {
          provider: "telegram" as const,
          externalThreadId: "telegram:42:7",
          externalSenderId: "42",
          connect: telegramConnect(BOT_ID),
          withOrigin: `Approved answer\n\nOpen in Akeru: ${url}`,
        },
        {
          provider: "imessage" as const,
          externalThreadId: "imessage:any;+15551234567",
          externalSenderId: "+15551234567",
          connect: imessageConnect(BOT_ID),
          withOrigin: `Approved answer\n\nOpen in Akeru: ${url}`,
        },
        {
          provider: "discord" as const,
          externalThreadId: "discord:guild-1:channel-1",
          externalSenderId: "user-1",
          connect: discordConnect(BOT_ID),
          withOrigin: `Approved answer\n\n[Open in Akeru](${url})`,
        },
      ];

      for (const entry of cases) {
        const build = (publicOrigin?: string | null) => {
          const messageId = MessageId.make(`${entry.provider}-reply-footer`);

          const threadId = channelThreadId(
            BOT_ID,
            PROJECT_ID,
            entry.provider,
            entry.externalThreadId,
          );

          const posts: Array<{ readonly externalThreadId: string; readonly text: string }> = [];

          const harness = makeHarness({
            threads: [
              makeThread(threadId, BOT_ID, [
                makeMessage(MessageId.make(`${entry.provider}-inbound`), "user", "Question", {
                  provider: entry.provider,
                  externalThreadId: entry.externalThreadId,
                  externalSenderId: entry.externalSenderId,
                }),
                makeMessage(messageId, "assistant", "Approved answer"),
              ]),
            ],
            post: async (target, text) => void posts.push({ externalThreadId: target, text }),
            ...(publicOrigin !== undefined ? { publicOrigin } : {}),
          });

          return { harness, posts, messageId, threadId };
        };

        const withoutOrigin = build(null);
        yield* connectChannel(withoutOrigin.harness.dependencies, entry.connect);
        yield* sendChannelMessage(withoutOrigin.harness.dependencies, {
          botId: BOT_ID,
          threadId: withoutOrigin.threadId,
          messageId: withoutOrigin.messageId,
        });
        expect(withoutOrigin.posts).toEqual([
          { externalThreadId: entry.externalThreadId, text: "Approved answer" },
        ]);

        const withOrigin = build("https://akeru.example.com/");
        yield* connectChannel(withOrigin.harness.dependencies, entry.connect);
        yield* sendChannelMessage(withOrigin.harness.dependencies, {
          botId: BOT_ID,
          threadId: withOrigin.threadId,
          messageId: withOrigin.messageId,
        });
        expect(withOrigin.posts).toEqual([
          { externalThreadId: entry.externalThreadId, text: entry.withOrigin },
        ]);
      }
    }),
  );

  it.effect("projects delivery transitions onto the assistant message", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("whatsapp-reply-delivery");
      const externalThreadId = "whatsapp:phone-number-id:15551234567";
      const threadId = channelThreadId(BOT_ID, PROJECT_ID, "whatsapp", externalThreadId);

      const harness = makeHarness({
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("whatsapp-inbound"), "user", "Question", {
              provider: "whatsapp",
              externalThreadId,
              externalSenderId: "15551234567",
            }),
            makeMessage(messageId, "assistant", "Approved answer"),
          ]),
        ],
        post: async () => undefined,
      });

      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));

      yield* sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });

      const deliveries = harness.commands
        .filter((command) => command.type === "thread.channel-delivery.set")
        .map((command) => (command.type === "thread.channel-delivery.set" ? command.delivery : ""));

      expect(deliveries).toEqual(["pending", "sent"]);
    }),
  );

  it.effect("dispatches delivery state when the command model omits messages after a restart", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-restart-delivery");
      const threadId = ThreadId.make("thread-restart-delivery");
      let posts = 0;

      const harness = makeHarness({
        threads: [
          makeThread(threadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-restart"), "user", "Question", {
              provider: "telegram",
              externalThreadId: "chat-restart",
            }),
            makeMessage(messageId, "assistant", "Restarted reply"),
          ]),
        ],
        post: async () => void (posts += 1),
        commandModelOmitsMessages: true,
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });
      expect(posts).toBe(1);

      const deliveries = harness.commands
        .filter((command) => command.type === "thread.channel-delivery.set")
        .map((command) => (command.type === "thread.channel-delivery.set" ? command.delivery : ""));

      expect(deliveries).toEqual(["pending", "sent"]);
    }),
  );

  it.effect("marks delivery failed for a rejected post and unknown for an ambiguous post", () =>
    Effect.gen(function* () {
      const rejectedMessageId = MessageId.make("message-delivery-rejected");
      const ambiguousMessageId = MessageId.make("message-delivery-unknown");
      const rejectedThreadId = ThreadId.make("thread-delivery-rejected");
      const ambiguousThreadId = ThreadId.make("thread-delivery-unknown");

      const rejectedHarness = makeHarness({
        threads: [
          makeThread(rejectedThreadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-delivery-rejected"), "user", "Question", {
              provider: "slack",
              externalThreadId: "slack:C9:9",
            }),
            makeMessage(rejectedMessageId, "assistant", "Rejected reply"),
          ]),
        ],
        post: async () => {
          throw new ChannelPostRejectedError({ message: "channel rejected" });
        },
      });

      yield* connectChannel(rejectedHarness.dependencies, slackConnect(BOT_ID));
      yield* expectFailureMessage(
        sendChannelMessage(rejectedHarness.dependencies, {
          botId: BOT_ID,
          threadId: rejectedThreadId,
          messageId: rejectedMessageId,
        }),
        "rejected",
      );

      const rejectedDeliveries = rejectedHarness.commands
        .filter((command) => command.type === "thread.channel-delivery.set")
        .map((command) => (command.type === "thread.channel-delivery.set" ? command.delivery : ""));

      expect(rejectedDeliveries).toEqual(["pending", "failed"]);

      const ambiguousHarness = makeHarness({
        threads: [
          makeThread(ambiguousThreadId, BOT_ID, [
            makeMessage(MessageId.make("inbound-delivery-unknown"), "user", "Question", {
              provider: "slack",
              externalThreadId: "slack:C9:9",
            }),
            makeMessage(ambiguousMessageId, "assistant", "Ambiguous reply"),
          ]),
        ],
        post: async () => {
          throw new Error("socket closed mid-post");
        },
      });

      yield* connectChannel(ambiguousHarness.dependencies, slackConnect(BOT_ID));

      const ambiguousFailure = yield* failureOf(
        sendChannelMessage(ambiguousHarness.dependencies, {
          botId: BOT_ID,
          threadId: ambiguousThreadId,
          messageId: ambiguousMessageId,
        }),
      );

      expect(ambiguousFailure).toMatchObject({ _tag: "ChannelTransportError" });

      const ambiguousDeliveries = ambiguousHarness.commands
        .filter((command) => command.type === "thread.channel-delivery.set")
        .map((command) => (command.type === "thread.channel-delivery.set" ? command.delivery : ""));

      expect(ambiguousDeliveries).toEqual(["pending", "unknown"]);
    }),
  );
});

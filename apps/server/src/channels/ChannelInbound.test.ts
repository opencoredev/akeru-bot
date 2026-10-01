import {
  expectFailureMessage,
  connectChannel,
  disconnectChannel,
  detachChannelConnection,
  dispatchInboundChannelMessage,
  sendChannelMessage,
  sendCompletedChannelReply,
  stopChannelsForBot,
  handleWhatsAppWebhook,
  NOW,
  BOT_ID,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  makeBot,
  makeMessage,
  makeChatSdkMessage,
  makeThread,
  makeHarness,
  telegramConnect,
  imessageConnect,
  whatsappConnect,
  slackConnect,
  discordConnect,
  signedWhatsAppRequest,
  externalAdapters,
} from "./testUtils/channelRuntime.ts";
import * as NodeCrypto from "node:crypto";
import { MessageId, ThreadId, TurnId, type OrchestrationThread } from "@akeru/contracts";
import { type Thread } from "chat";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import {
  channelThreadId,
  ignoredInbound,
  mentionWithContext,
  type ChannelRuntimeDependencies,
} from "./ChannelRuntime.ts";
describe("channel runtime", () => {
  it("gives each external conversation a stable isolated thread", () => {
    const first = channelThreadId(BOT_ID, PROJECT_ID, "telegram", "telegram:123");

    expect(channelThreadId(BOT_ID, PROJECT_ID, "telegram", "telegram:123")).toBe(first);
    expect(channelThreadId(BOT_ID, PROJECT_ID, "telegram", "telegram:456")).not.toBe(first);
    expect(channelThreadId(BOT_ID, PROJECT_ID, "imessage", "telegram:123")).not.toBe(first);
  });

  it.effect("routes an inbound message to the selected project instead of the first project", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});

      yield* dispatchInboundChannelMessage(harness.dependencies, {
        botId: BOT_ID,
        projectId: SECOND_PROJECT_ID,
        provider: "telegram",
        externalThreadId: "chat-project-2",
        externalMessageId: "message-project-2",
        text: "Work in project two",
      });

      expect(harness.commands.find((command) => command.type === "thread.create")).toMatchObject({
        projectId: SECOND_PROJECT_ID,
      });
    }),
  );

  it.effect("starts a new thread when the legacy conversation belongs to another project", () =>
    Effect.gen(function* () {
      const externalThreadId = "telegram:legacy-other-project";
      const legacyThreadId = ThreadId.make(
        `channel-${NodeCrypto.createHash("sha256")
          .update(`${BOT_ID}\0telegram\0${externalThreadId}`)
          .digest("hex")}`,
      );
      const harness = makeHarness({ threads: [makeThread(legacyThreadId, BOT_ID, [])] });

      yield* dispatchInboundChannelMessage(harness.dependencies, {
        botId: BOT_ID,
        projectId: SECOND_PROJECT_ID,
        provider: "telegram",
        externalThreadId,
        externalMessageId: "new-project-message",
        text: "Use the selected project",
      });

      const created = harness.commands.find((command) => command.type === "thread.create");
      expect(created).toMatchObject({ projectId: SECOND_PROJECT_ID });
      expect(created?.threadId).not.toBe(legacyThreadId);
      expect(
        harness.commands.find((command) => command.type === "thread.turn.start"),
      ).toMatchObject({
        threadId: created?.threadId,
      });
    }),
  );

  it.effect("continues a channel thread created before project-aware thread IDs", () =>
    Effect.gen(function* () {
      const externalThreadId = "telegram:legacy-chat";
      const legacyThreadId = ThreadId.make(
        `channel-${NodeCrypto.createHash("sha256")
          .update(`${BOT_ID}\0telegram\0${externalThreadId}`)
          .digest("hex")}`,
      );
      const harness = makeHarness({ threads: [makeThread(legacyThreadId, BOT_ID, [])] });

      yield* dispatchInboundChannelMessage(harness.dependencies, {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "telegram",
        externalThreadId,
        externalMessageId: "legacy-message",
        text: "Continue here",
      });

      expect(harness.commands.some((command) => command.type === "thread.create")).toBe(false);
      expect(
        harness.commands.find((command) => command.type === "thread.turn.start"),
      ).toMatchObject({
        threadId: legacyThreadId,
      });
    }),
  );

  it.effect("derives stable command and message identities from the provider message", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      const input = {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "telegram" as const,
        externalThreadId: "chat-dedupe",
        externalMessageId: "provider-message-1",
        text: "Only once",
      };

      yield* dispatchInboundChannelMessage(harness.dependencies, input);
      yield* dispatchInboundChannelMessage(harness.dependencies, input);

      const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
      expect(turns).toHaveLength(2);
      expect(turns[0]?.commandId).toBe(turns[1]?.commandId);
      expect(turns[0]?.message.messageId).toBe(turns[1]?.message.messageId);
    }),
  );

  it.effect("preserves the inbound provider, thread, and sender on the turn command", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});

      yield* dispatchInboundChannelMessage(harness.dependencies, {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "telegram",
        externalThreadId: "chat-a",
        externalSenderId: "sender-7",
        text: "Hello",
      });

      const turn = harness.commands.find((command) => command.type === "thread.turn.start");
      expect(turn?.type).toBe("thread.turn.start");
      if (turn?.type !== "thread.turn.start") throw new Error("Expected a turn command.");
      expect(turn.message.channelOrigin).toEqual({
        provider: "telegram",
        externalThreadId: "chat-a",
        externalSenderId: "sender-7",
      });
    }),
  );

  it.effect("validates and dispatches inbound WhatsApp DMs", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ startTransport: null });
      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
      // @effect-diagnostics-next-line preferSchemaOverJson:off - the webhook signs raw JSON text.
      const payload = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "business-id",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: {
                    display_phone_number: "+15550001111",
                    phone_number_id: "phone-number-id",
                  },
                  contacts: [{ profile: { name: "Alice" }, wa_id: "15551234567" }],
                  messages: [
                    {
                      from: "15551234567",
                      id: "wamid.1",
                      timestamp: "1788220000",
                      text: { body: "Hello from WhatsApp" },
                      type: "text",
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      const invalidSignature = yield* handleWhatsAppWebhook(
        BOT_ID,
        new Request(`https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook`, {
          method: "POST",
          body: payload,
        }),
      );
      const invalidPayload = yield* handleWhatsAppWebhook(BOT_ID, signedWhatsAppRequest("{}"));
      const accepted = yield* handleWhatsAppWebhook(BOT_ID, signedWhatsAppRequest(payload));

      expect(invalidSignature.status).toBe(401);
      expect(invalidPayload.status).toBe(400);
      expect(accepted.status).toBe(200);
      const turn = harness.commands.find((command) => command.type === "thread.turn.start");
      expect(turn?.type).toBe("thread.turn.start");
      if (turn?.type !== "thread.turn.start") throw new Error("Expected a turn command.");
      expect(turn.message.channelOrigin).toEqual({
        provider: "whatsapp",
        externalThreadId: "whatsapp:phone-number-id:15551234567",
        externalMessageId: "wamid.1",
        externalSenderId: "15551234567",
      });
    }),
  );

  it.effect("accepts iMessage direct messages and ignores group messages", () =>
    Effect.gen(function* () {
      let directMessage:
        | Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1]
        | undefined;
      const harness = makeHarness({
        startTransport: async (_input, onDirectMessage) => {
          directMessage = onDirectMessage;
          return {
            externalIdentity: "Photon hosted",
            runtime: { post: async () => undefined, shutdown: async () => undefined },
          };
        },
      });
      yield* connectChannel(harness.dependencies, imessageConnect(BOT_ID));

      yield* Effect.promise(async () =>
        directMessage?.({
          externalThreadId: "imessage:iMessage;-;+15551234567",
          externalMessageId: "direct-1",
          externalSenderId: "+15551234567",
          externalSenderName: "Alice",
          text: "DM without a mention",
        }),
      );

      const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
      expect(turns).toHaveLength(1);
      expect(turns[0]?.message.channelOrigin).toMatchObject({
        provider: "imessage",
        externalMessageId: "direct-1",
        externalThreadId: "imessage:iMessage;-;+15551234567",
      });
    }),
  );

  it.effect("bounds first-mention context and preserves sender attribution", () =>
    Effect.gen(function* () {
      const threadId = "slack:C123:1710000000.000001";
      const history = Array.from({ length: 12 }, (_, index) =>
        makeChatSdkMessage(threadId, `history-${index}`, `context ${index}`, `U${index}`),
      );
      const current = makeChatSdkMessage(
        threadId,
        "mention-current",
        "@Akeru investigate",
        "U-current",
        true,
      );
      const thread = {
        id: threadId,
        recentMessages: [...history, current],
        refresh: async () => undefined,
      } as unknown as Thread;

      const normalized = yield* Effect.promise(() => mentionWithContext(thread, current));

      expect(normalized.text).not.toContain("U0: context 0\n");
      expect(normalized.text).not.toContain("U1: context 1\n");
      expect(normalized.text.split("\n")).toHaveLength(11);
      expect(normalized.externalSenderName).toBe("U-current");
      expect(normalized.externalMessageId).toBe("mention-current");
    }),
  );

  it.effect("limits large prior context without truncating the current mention", () =>
    Effect.gen(function* () {
      const threadId = "slack:C123:large-context";
      const current = makeChatSdkMessage(
        threadId,
        "current",
        "@Akeru investigate",
        "U-current",
        true,
      );
      const thread = {
        id: threadId,
        recentMessages: [
          makeChatSdkMessage(threadId, "earlier", "x".repeat(20_000), "U1"),
          makeChatSdkMessage(threadId, "latest", "Latest detail", "U2"),
          current,
        ],
        refresh: async () => undefined,
      } as unknown as Thread;

      const normalized = yield* Effect.promise(() => mentionWithContext(thread, current));

      expect(normalized.text.length).toBe(8_000 + 1 + current.text.length);
      expect(normalized.text).toContain("U2: Latest detail");
      expect(normalized.text.endsWith(`\n${current.text}`)).toBe(true);
    }),
  );

  it.effect("routes Slack direct messages and subscribed mention threads", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ startTransport: null });
      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
      if (!externalAdapters.slackChat || !externalAdapters.slackAdapter) {
        throw new Error("Expected the Slack Chat runtime.");
      }

      const { slackChat, slackAdapter } = externalAdapters;

      const directThreadId = "slack:D123:";
      yield* Effect.promise(() =>
        slackChat.processMessage(
          slackAdapter,
          directThreadId,
          makeChatSdkMessage(directThreadId, "slack-dm-1", "Direct work", "U1"),
        ),
      );
      const channelThreadId = "slack:C123:1710000000.000001";
      yield* Effect.promise(() =>
        slackChat.processMessage(
          slackAdapter,
          channelThreadId,
          makeChatSdkMessage(channelThreadId, "slack-mention-1", "@Akeru investigate", "U2", true),
        ),
      );
      yield* Effect.promise(() =>
        slackChat.processMessage(
          slackAdapter,
          channelThreadId,
          makeChatSdkMessage(channelThreadId, "slack-followup-1", "One more detail", "U3"),
        ),
      );

      const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
      expect(turns.map((turn) => turn.message.channelOrigin?.externalMessageId)).toEqual([
        "slack-dm-1",
        "slack-mention-1",
        "slack-followup-1",
      ]);
      expect(turns[1]?.threadId).toBe(turns[2]?.threadId);

      yield* disconnectChannel(harness.dependencies, BOT_ID, "slack");
      expect(externalAdapters.slackDisconnects).toBeGreaterThan(0);
    }),
  );

  it.effect("restores Slack and Discord platform-thread subscriptions", () =>
    Effect.gen(function* () {
      const slackThreadId = ThreadId.make("thread-slack-restored");
      const discordThreadId = ThreadId.make("thread-discord-restored");
      const harness = makeHarness({
        startTransport: null,
        commandModelOmitsMessages: true,
        threads: [
          makeThread(slackThreadId, BOT_ID, [
            makeMessage(MessageId.make("slack-origin"), "user", "Mention", {
              provider: "slack",
              externalThreadId: "slack:C1:1",
            }),
          ]),
          makeThread(discordThreadId, BOT_ID, [
            makeMessage(MessageId.make("discord-origin"), "user", "Mention", {
              provider: "discord",
              externalThreadId: "discord:G1:C1:T1",
            }),
          ]),
        ],
      });

      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
      yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));

      expect(externalAdapters.slackRestoredBeforeInitialize).toBe(true);
      expect(externalAdapters.slackSubscriptions).toContain("slack:C1:1");
      expect(externalAdapters.discordSubscriptions).toContain("discord:G1:C1:T1");
    }),
  );

  it.effect("routes normalized Discord direct messages and mention-thread continuation", () =>
    Effect.gen(function* () {
      let directMessage:
        | Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1]
        | undefined;
      let context:
        | Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[2]
        | undefined;
      const harness = makeHarness({
        startTransport: async (_input, onDirectMessage, transportContext) => {
          directMessage = onDirectMessage;
          context = transportContext;
          return {
            externalIdentity: "akeru-discord",
            runtime: { post: async () => undefined, shutdown: async () => undefined },
          };
        },
      });
      yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));

      yield* Effect.promise(async () =>
        directMessage?.({
          externalThreadId: "discord:@me:dm-channel",
          externalMessageId: "discord-dm-1",
          externalSenderId: "D1",
          text: "Direct work",
        }),
      );
      yield* Effect.promise(async () =>
        context?.onMention({
          externalThreadId: "discord:guild-1:channel-1:thread-1",
          externalMessageId: "discord-mention-1",
          externalSenderId: "D2",
          text: "@Akeru investigate",
        }),
      );
      yield* Effect.promise(async () =>
        context?.onSubscribedMessage({
          externalThreadId: "discord:guild-1:channel-1:thread-1",
          externalMessageId: "discord-followup-1",
          externalSenderId: "D3",
          text: "One more detail",
        }),
      );

      const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
      expect(turns.map((turn) => turn.message.channelOrigin?.externalMessageId)).toEqual([
        "discord-dm-1",
        "discord-mention-1",
        "discord-followup-1",
      ]);
      expect(turns[1]?.threadId).toBe(turns[2]?.threadId);
    }),
  );

  it.effect("rejects inbound messages for archived bots", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ bots: [makeBot(BOT_ID, { archivedAt: NOW })] });

      yield* expectFailureMessage(
        dispatchInboundChannelMessage(harness.dependencies, {
          botId: BOT_ID,
          projectId: PROJECT_ID,
          provider: "telegram",
          externalThreadId: "chat-a",
          text: "Hello",
        }),
        "unavailable",
      );
      expect(harness.commands).toEqual([]);
    }),
  );

  for (const operation of [disconnectChannel, detachChannelConnection]) {
    it.effect(`ignores inbound messages when ${operation.name} shutdown fails`, () =>
      Effect.gen(function* () {
        const callbacks: Array<
          Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1]
        > = [];
        const shutdown = vi.fn(async () => {
          throw new Error("shutdown failed");
        });
        const harness = makeHarness({
          startTransport: async (_input, onInbound) => {
            callbacks.push(onInbound);
            return {
              externalIdentity: "@akeru",
              runtime: { post: async () => undefined, shutdown },
            };
          },
        });
        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
        expect(callbacks).toHaveLength(1);

        yield* expectFailureMessage(
          operation(harness.dependencies, BOT_ID, "telegram"),
          "Channel provider request failed.",
        );
        expect(harness.readModel().bots[0]?.channelBindings[0]?.status).toBe("disconnected");
        const commandsBefore = harness.commands.length;
        yield* Effect.promise(async () =>
          callbacks[0]!({
            externalThreadId: "telegram:failed-shutdown",
            externalMessageId: "still-active",
            text: "Do not start a turn",
          }),
        );
        expect(harness.commands).toHaveLength(commandsBefore);
        expect(
          harness.commands.filter((command) => command.type === "thread.turn.start"),
        ).toHaveLength(0);

        // The failed transport is no longer registered, so a later stop leaves it alone.
        yield* stopChannelsForBot(BOT_ID);
        expect(shutdown).toHaveBeenCalledTimes(1);
      }),
    );
  }

  it.effect("sends an approved WhatsApp reply to the inbound DM", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("whatsapp-reply");
      const externalThreadId = "whatsapp:phone-number-id:15551234567";
      const threadId = channelThreadId(BOT_ID, PROJECT_ID, "whatsapp", externalThreadId);
      const posts: Array<{ readonly externalThreadId: string; readonly text: string }> = [];
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
        post: async (target, text) => void posts.push({ externalThreadId: target, text }),
      });
      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));

      yield* sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });

      expect(posts).toEqual([
        {
          externalThreadId,
          text: `Approved answer\n\nOpen in Akeru: https://akeru.example/bots/${BOT_ID}`,
        },
      ]);
    }),
  );

  it.effect("automatically sends one completed reply for an inbound channel turn", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-auto-reply");
      const requestMessageId = MessageId.make("inbound-auto-reply");
      const messageId = MessageId.make("assistant-auto-reply");
      const threadId = ThreadId.make("thread-auto-reply");
      let posts = 0;
      const thread: OrchestrationThread = {
        ...makeThread(threadId, BOT_ID, [
          makeMessage(requestMessageId, "user", "Hello", {
            provider: "imessage",
            externalThreadId: "iMessage;-;sender",
          }),
          { ...makeMessage(messageId, "assistant", "Hello back"), turnId },
        ]),
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: messageId,
          requestMessageId,
          respondingBotId: BOT_ID,
        },
      };
      const harness = makeHarness({
        threads: [thread],
        post: async () => void (posts += 1),
      });
      yield* connectChannel(harness.dependencies, imessageConnect(BOT_ID));

      expect(
        yield* sendCompletedChannelReply(harness.dependencies, threadId, turnId),
      ).toBeGreaterThan(0);
      expect(
        yield* sendCompletedChannelReply(harness.dependencies, threadId, turnId),
      ).toBeGreaterThan(0);

      expect(posts).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toContain(messageId);

      expect(
        yield* sendCompletedChannelReply(
          harness.dependencies,
          threadId,
          TurnId.make("stale-auto-reply-turn"),
        ),
      ).toBeNull();
      expect(posts).toBe(1);
    }),
  );

  it("treats an unknown author as a bot except on Telegram", () => {
    const unknown = makeChatSdkMessage("thread", "unknown", "Hello", "sender", false, {
      isBot: "unknown",
    });
    const person = makeChatSdkMessage("thread", "person", "Hello", "sender");
    // Telegram marks messages sent on behalf of a chat (anonymous admins, channel posts) "unknown".
    expect(ignoredInbound("telegram", unknown)).toBe(false);
    for (const provider of ["discord", "slack", "whatsapp", "imessage"] as const) {
      expect(ignoredInbound(provider, unknown)).toBe(true);
    }
    for (const provider of ["telegram", "discord", "slack", "whatsapp", "imessage"] as const) {
      expect(ignoredInbound(provider, person)).toBe(false);
    }
  });

  it.effect("ignores bot-authored direct and subscribed-thread messages", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ startTransport: null });
      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
      if (!externalAdapters.slackChat || !externalAdapters.slackAdapter) {
        throw new Error("Expected the Slack Chat runtime.");
      }
      const { slackChat, slackAdapter } = externalAdapters;
      const process = (threadId: string, message: ReturnType<typeof makeChatSdkMessage>) =>
        Effect.promise(() => slackChat.processMessage(slackAdapter, threadId, message));

      const directThreadId = "slack:D123:";
      yield* process(
        directThreadId,
        makeChatSdkMessage(directThreadId, "slack-self-dm", "Echo", "U-AKERU", false, {
          isBot: true,
          isMe: true,
        }),
      );
      yield* process(
        directThreadId,
        makeChatSdkMessage(directThreadId, "slack-bot-dm", "Hi bot", "B2", false, {
          isBot: true,
        }),
      );
      const channelThreadId = "slack:C123:1710000000.000001";
      yield* process(
        channelThreadId,
        makeChatSdkMessage(channelThreadId, "slack-mention", "@Akeru investigate", "U2", true),
      );
      yield* process(
        channelThreadId,
        makeChatSdkMessage(channelThreadId, "slack-bot-followup", "Automated reply", "B2", false, {
          isBot: true,
        }),
      );
      yield* process(
        channelThreadId,
        makeChatSdkMessage(channelThreadId, "slack-self-followup", "My reply", "U-AKERU", false, {
          isBot: true,
          isMe: true,
        }),
      );
      yield* process(
        channelThreadId,
        makeChatSdkMessage(channelThreadId, "slack-unknown-followup", "Relayed", "B3", false, {
          isBot: "unknown",
        }),
      );
      yield* process(
        channelThreadId,
        makeChatSdkMessage(channelThreadId, "slack-human-followup", "Thanks", "U3"),
      );

      const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
      expect(turns.map((turn) => turn.message.channelOrigin?.externalMessageId)).toEqual([
        "slack-mention",
        "slack-human-followup",
      ]);
      yield* disconnectChannel(harness.dependencies, BOT_ID, "slack");
    }),
  );
});

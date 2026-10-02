import * as Schema from "effect/Schema";
import {
  adapters,
  NOW,
  BOT_ID,
  PROJECT_ID,
  chatMessage,
  slackProbeClient,
  slackOutageClient,
  slackOfflineClient,
  makeHarness,
  connect,
  slackConnect,
  discordConnect,
  whatsappSave,
} from "./testUtils/channelTransports.ts";
import * as NodeCrypto from "node:crypto";
import {
  ChannelConnectionId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import { channelFailureCategory, WHATSAPP_NOT_LIVE_MESSAGE } from "./ChannelRuntime.ts";

describe("channel transports", () => {
  describe("slack", () => {
    it.effect("never connects with an app-level token Slack rejects", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ httpClient: slackProbeClient(false) });
        const failure = yield* Effect.flip(harness.runtime.connect(slackConnect()));
        expect(failure.message).toBe("Slack app-level token is invalid.");
        expect(harness.binding()).toBeUndefined();
        expect(adapters.slack).toBeNull();
      }),
    );

    it.effect.each(["invalid_auth", "token_revoked", "not_allowed_token_type"])(
      "blames the app-level token only for a Slack auth error: %s",
      (error) =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ httpClient: slackProbeClient(false, [], error) });
          const failure = yield* Effect.flip(harness.runtime.connect(slackConnect()));
          expect(failure.message).toBe("Slack app-level token is invalid.");
          expect(channelFailureCategory(failure)).toBe("credentials");
          expect(adapters.slack).toBeNull();
        }),
    );

    it.effect.each([
      ["a network failure", slackOfflineClient],
      ["an HTTP error page", slackOutageClient],
      ["a Slack server error", slackProbeClient(false, [], "internal_error")],
    ] as const)("reports Slack as unreachable after %s", ([, httpClient]) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ httpClient });
        const failure = yield* Effect.flip(harness.runtime.connect(slackConnect()));
        expect(failure.message).toBe(
          "Slack could not be reached. Check the network and try again.",
        );
        expect(channelFailureCategory(failure)).toBe("network");
        expect(harness.binding()).toBeUndefined();
        expect(adapters.slack).toBeNull();
      }),
    );

    it.effect("rejects a token that is not an app-level token without calling Slack", () =>
      Effect.gen(function* () {
        const requests: string[] = [];
        const harness = yield* makeHarness({ httpClient: slackProbeClient(true, requests) });
        const failure = yield* Effect.flip(harness.runtime.connect(slackConnect("xoxb-token")));
        expect(failure.message).toBe("Slack app-level token is invalid.");
        expect(requests).toEqual([]);
        expect(harness.binding()).toBeUndefined();
      }),
    );

    it.effect("replies to a channel mention inside the mention's thread", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* harness.runtime.connect(slackConnect());
        expect(harness.binding()?.status).toBe("connected");
        const slack = adapters.slack;

        if (!slack) throw new Error("Expected the Slack Chat runtime.");

        const externalThreadId = "slack:C123:1710000000.000001";
        yield* Effect.promise(() =>
          slack.chat.processMessage(
            slack.adapter,
            externalThreadId,
            chatMessage(externalThreadId, "1710000000.000001", "<@U-AKERU> look", true),
          ),
        );
        const turn = yield* Queue.take(harness.turns);
        expect(turn.message.channelOrigin?.externalThreadId).toBe(externalThreadId);

        harness.addAssistantMessage(turn.threadId, "reply-1", "On it");
        yield* harness.runtime.sendChannelMessage({
          botId: BOT_ID,
          threadId: turn.threadId,
          messageId: MessageId.make("reply-1"),
        });
        expect(adapters.slackPosts).toHaveLength(1);
        expect(adapters.slackPosts[0]).toMatchObject({
          channel: "C123",
          thread_ts: "1710000000.000001",
        });
      }),
    );
  });

  describe("discord", () => {
    const gatewayEvent = (id: string, data: Schema.JsonObject) =>
      new Request("https://akeru.example/discord", {
        method: "POST",
        headers: { "x-discord-gateway-token": "discord-token" },
        body: JSON.stringify({
          type: "GATEWAY_MESSAGE_CREATE",
          timestamp: Date.parse(NOW),
          data: {
            id,
            guild_id: "G1",
            channel_id: "C1",
            content: "hello",
            author: { id: "U1", username: "u1", global_name: "U1", bot: false },
            mentions: [],
            attachments: [],
            timestamp: NOW,
            ...data,
          },
        }),
      });

    it.effect("ignores role and @everyone mentions even when the SDK env enables them", () =>
      Effect.gen(function* () {
        vi.stubEnv("DISCORD_MENTION_ROLE_IDS", "R1");
        vi.stubEnv("DISCORD_RESPOND_TO_CHANNEL_IDS", "C1");
        const harness = yield* makeHarness({});
        yield* harness.runtime.connect(discordConnect());
        const discord = adapters.discord;

        if (!discord) throw new Error("Expected the Discord Chat runtime.");

        for (const [id, data] of [
          ["m-role", { mention_roles: ["R1"] }],
          ["m-everyone", { mention_everyone: true }],
        ] as const) {
          const response = yield* Effect.promise(() =>
            discord.adapter.handleWebhook(gatewayEvent(id, data)),
          );

          expect(response.status).toBe(200);
        }

        expect(adapters.discordThreadsCreated).toEqual([]);

        // A direct mention still starts a thread and a turn, so the ignores above are real.
        yield* Effect.promise(() =>
          discord.adapter.handleWebhook(
            gatewayEvent("m-user", { mentions: [{ id: "discord-app", username: "akeru" }] }),
          ),
        );
        const turn = yield* Queue.take(harness.turns);
        expect(adapters.discordThreadsCreated).toEqual(["m-user"]);
        expect(turn.message.channelOrigin?.externalMessageId).toBe("m-user");
        expect(turn.message.channelOrigin?.externalThreadId).toBe("discord:G1:C1:T-m-user");
        expect(yield* Queue.size(harness.turns)).toBe(0);
      }),
    );
  });

  describe("telegram", () => {
    it.effect("ignores group messages, including mentions, and answers direct messages", () =>
      Effect.gen(function* () {
        const update = (updateId: number, chat: Schema.JsonObject, text: string) => ({
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1_758_800_000,
            chat,
            from: { id: 7, is_bot: false, first_name: "Leo" },
            text,
            ...(text.startsWith("@akeru")
              ? { entities: [{ type: "mention", offset: 0, length: 6 }] }
              : {}),
          },
        });

        let polled = false;
        vi.stubGlobal(
          "fetch",
          vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(
            async (url, init) => {
              const method = String(url).split("/").at(-1);

              if (method === "getMe")
                return Response.json({
                  ok: true,
                  result: { id: 1, is_bot: true, first_name: "Akeru", username: "akeru" },
                });

              if (method === "deleteWebhook" || method === "deleteMyCommands")
                return Response.json({ ok: true, result: true });

              if (method === "getUpdates" && !polled) {
                polled = true;

                return Response.json({
                  ok: true,
                  result: [
                    update(1, { id: -100, type: "supergroup", title: "Team" }, "@akeru help"),
                    update(2, { id: -100, type: "supergroup", title: "Team" }, "anyone?"),
                    update(3, { id: 7, type: "private", first_name: "Leo" }, "direct question"),
                  ],
                });
              }

              if (method === "getUpdates")
                return new Promise<Response>((_resolve, reject) => {
                  const abort = () => reject(new DOMException("Aborted", "AbortError"));

                  if (init?.signal?.aborted) abort();
                  else init?.signal?.addEventListener("abort", abort, { once: true });
                });
              throw new Error(`Unexpected Telegram method: ${method}`);
            },
          ),
        );
        const harness = yield* makeHarness({});
        yield* harness.runtime.connect(connect("telegram" as const, { token: "telegram-token" }));

        const turn = yield* Queue.take(harness.turns);
        expect(turn.message.text).toBe("direct question");
        expect(yield* Queue.size(harness.turns)).toBe(0);
        yield* harness.runtime.disconnect(BOT_ID, "telegram");
      }),
    );
  });

  describe("imessage", () => {
    it.effect("ignores group chats, including mentions, and answers direct messages", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* harness.runtime.connect({
          type: "channel.connect",
          commandId: CommandId.make("connect-imessage"),
          botId: BOT_ID,
          targetProjectId: PROJECT_ID,
          provider: "imessage",
          mode: "hosted",
          projectId: "photon-project",
          projectSecret: "photon-secret",
        });
        const imessage = adapters.imessage;

        if (!imessage) throw new Error("Expected the Photon Chat runtime.");

        const group = "imessage:iMessage;+;chat123";

        for (const [id, isMention] of [
          ["g-1", false],
          ["g-2", true],
        ] as const) {
          yield* Effect.promise(() =>
            imessage.chat.processMessage(
              imessage.adapter,
              group,
              chatMessage(group, id, "Akeru, help", isMention),
            ),
          );
        }

        const direct = "imessage:iMessage;-;+15551234567";
        yield* Effect.promise(() =>
          imessage.chat.processMessage(
            imessage.adapter,
            direct,
            chatMessage(direct, "d-1", "direct question", true),
          ),
        );

        const turn = yield* Queue.take(harness.turns);
        expect(turn.message.channelOrigin?.externalThreadId).toBe(direct);
        expect(yield* Queue.size(harness.turns)).toBe(0);
      }),
    );
  });

  describe("whatsapp", () => {
    const connectionId = ChannelConnectionId.make("connection-whatsapp");

    it.effect("attaches as not-live without a public https origin", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* harness.runtime.saveConnection(whatsappSave(connectionId));
        expect(harness.settings().channelConnections[0]?.webhookUrl).toBeUndefined();

        yield* harness.runtime.attach(BOT_ID, connectionId, PROJECT_ID, "whatsapp");
        expect(harness.binding()).toMatchObject({
          status: "not-live",
          lastError: WHATSAPP_NOT_LIVE_MESSAGE,
        });
      }),
    );

    it.effect("builds the webhook URL on the server and routes it to the attached bot", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ publicOrigin: "https://akeru.example" });
        yield* harness.runtime.saveConnection(whatsappSave(connectionId));
        const webhookUrl = harness.settings().channelConnections[0]?.webhookUrl;
        expect(webhookUrl).toBe(
          "https://akeru.example/api/channels/whatsapp/connections/connection-whatsapp/webhook",
        );

        yield* harness.runtime.attach(BOT_ID, connectionId, PROJECT_ID, "whatsapp");
        expect(harness.binding()?.status).toBe("connected");
        expect(harness.binding()?.lastError).toBeUndefined();

        const verify = yield* harness.runtime.handleWhatsAppConnectionWebhook(
          connectionId,
          new Request(
            `${webhookUrl}?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=abc`,
          ),
        );

        expect(verify.status).toBe(200);
        expect(yield* Effect.promise(() => verify.text())).toBe("abc");

        const unknown = yield* harness.runtime.handleWhatsAppConnectionWebhook(
          ChannelConnectionId.make("connection-missing"),
          new Request(webhookUrl ?? ""),
        );

        expect(unknown.status).toBe(404);
      }),
    );

    it.effect("rejects a signed message for another phone number on a connection URL", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ publicOrigin: "https://akeru.example" });
        yield* harness.runtime.saveConnection(whatsappSave(connectionId));
        yield* harness.runtime.attach(BOT_ID, connectionId, PROJECT_ID, "whatsapp");
        const url = harness.settings().channelConnections[0]?.webhookUrl ?? "";

        const signedRequest = (phoneNumberId: string) => {
          const body = JSON.stringify({
            object: "whatsapp_business_account",
            entry: [
              {
                id: "business-id",
                changes: [
                  {
                    field: "messages",
                    value: {
                      messaging_product: "whatsapp",
                      metadata: { phone_number_id: phoneNumberId },
                      contacts: [{ profile: { name: "Alice" }, wa_id: "15551234567" }],
                      messages: [
                        {
                          from: "15551234567",
                          id: "wamid.1",
                          timestamp: "1788220000",
                          text: { body: "Hello" },
                          type: "text",
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          });

          return new Request(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", "app-secret").update(body).digest("hex")}`,
            },
            body,
          });
        };

        const wrong = yield* harness.runtime.handleWhatsAppConnectionWebhook(
          connectionId,
          signedRequest("another-phone-number"),
        );

        expect(wrong.status).toBe(404);
        expect(yield* Queue.size(harness.turns)).toBe(0);

        const right = yield* harness.runtime.handleWhatsAppConnectionWebhook(
          connectionId,
          signedRequest("phone-number-id"),
        );

        expect(right.status).toBe(200);
        expect((yield* Queue.take(harness.turns)).type).toBe("thread.turn.start");
      }),
    );

    it.effect("refreshes saved webhook URLs when the public origin changes", () =>
      Effect.gen(function* () {
        const stale = {
          id: connectionId,
          name: "Support line",
          provider: "whatsapp" as const,
          adapter: "whatsapp" as const,
          externalIdentity: "phone-number-id",
          webhookUrl: "https://old.example/api/channels/whatsapp/connections/x/webhook",
        };

        const moved = yield* makeHarness({
          publicOrigin: "https://new.example",
          settings: { ...DEFAULT_SERVER_SETTINGS, channelConnections: [stale] },
        });

        yield* moved.runtime.restoreConnectedChannels;
        expect(moved.settings().channelConnections[0]?.webhookUrl).toBe(
          "https://new.example/api/channels/whatsapp/connections/connection-whatsapp/webhook",
        );

        const removed = yield* makeHarness({
          settings: { ...DEFAULT_SERVER_SETTINGS, channelConnections: [stale] },
        });

        yield* removed.runtime.restoreConnectedChannels;
        expect(removed.settings().channelConnections[0]).not.toHaveProperty("webhookUrl");
      }),
    );
  });
});

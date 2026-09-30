import * as NodeCrypto from "node:crypto";

import {
  BotId,
  ChannelConnectionId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@akeru/contracts";
import { Message as ChatMessage, parseMarkdown, type Adapter, type ChatInstance } from "chat";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";

const adapters = vi.hoisted(() => ({
  slack: null as { adapter: Adapter; chat: ChatInstance } | null,
  slackPosts: [] as Array<Record<string, string>>,
  discord: null as { adapter: Adapter; chat: ChatInstance } | null,
  discordThreadsCreated: [] as string[],
  imessage: null as { adapter: Adapter; chat: ChatInstance } | null,
}));

vi.mock("@chat-adapter/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chat-adapter/slack")>();
  return {
    ...actual,
    createSlackAdapter: (options: Parameters<typeof actual.createSlackAdapter>[0] = {}) => {
      const adapter = actual.createSlackAdapter({
        ...options,
        webClientOptions: {
          ...options.webClientOptions,
          adapter: async (config) => {
            if (config.url !== "https://slack.com/api/chat.postMessage") {
              throw new Error(`Unexpected Slack API request: ${config.url}`);
            }
            const data = String(config.data);
            adapters.slackPosts.push(
              data.startsWith("{")
                ? JSON.parse(data)
                : Object.fromEntries(new URLSearchParams(data).entries()),
            );
            return {
              status: 200,
              data: { ok: true, ts: "1710000000.000002" },
              headers: {},
              statusText: "",
              config,
              request: { path: "/api/chat.postMessage" },
            };
          },
        },
      }) as ReturnType<typeof actual.createSlackAdapter> & Adapter;
      adapter.initialize = async (chat) => {
        Object.assign(adapter, { _botUserId: "U-AKERU" });
        adapters.slack = { adapter, chat };
      };
      adapter.addReaction = async () => undefined;
      adapter.removeReaction = async () => undefined;
      adapter.onThreadSubscribe = async () => undefined;
      adapter.disconnect = async () => undefined;
      return adapter;
    },
  };
});

vi.mock("@chat-adapter/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chat-adapter/discord")>();
  return {
    ...actual,
    createDiscordAdapter: (options: Parameters<typeof actual.createDiscordAdapter>[0]) => {
      const adapter = actual.createDiscordAdapter(options) as ReturnType<
        typeof actual.createDiscordAdapter
      > &
        Adapter;
      const initialize = adapter.initialize.bind(adapter);
      adapter.initialize = async (chat) => {
        await initialize(chat);
        adapters.discord = { adapter, chat };
      };
      adapter.getUser = async (userId) => ({
        userId,
        userName: "akeru",
        fullName: "Akeru",
        isBot: true,
      });
      adapter.addReaction = async () => undefined;
      adapter.removeReaction = async () => undefined;
      adapter.onThreadSubscribe = async () => undefined;
      adapter.fetchMessages = async () => ({ messages: [] });
      adapter.disconnect = async () => undefined;
      adapter.startGatewayListener = async ({ waitUntil }, _durationMs, signal) => {
        waitUntil?.(
          new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        );
        return new Response(null, { status: 200 });
      };
      // The real call hits Discord's REST API; record it and hand back a new thread.
      Object.assign(adapter, {
        createDiscordThread: async (_channelId: string, messageId: string) => {
          adapters.discordThreadsCreated.push(messageId);
          return { id: `T-${messageId}`, name: "Thread" };
        },
      });
      return adapter;
    },
  };
});

vi.mock("@photon-ai/chat-adapter-imessage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@photon-ai/chat-adapter-imessage")>();
  return {
    ...actual,
    createiMessageAdapter: (options: Parameters<typeof actual.createiMessageAdapter>[0]) => {
      const adapter = actual.createiMessageAdapter(options) as ReturnType<
        typeof actual.createiMessageAdapter
      > &
        Adapter;
      adapter.initialize = async (chat) => {
        adapters.imessage = { adapter, chat };
      };
      adapter.startGatewayListener = async ({ waitUntil }, _durationMs, signal) => {
        waitUntil?.(
          new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        );
        return new Response(null, { status: 200 });
      };
      adapter.onThreadSubscribe = async () => undefined;
      adapter.disconnect = async () => undefined;
      return adapter;
    },
  };
});

import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { createEmptyReadModel } from "../orchestration/projector.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeMemoryChannelDeliveryStore } from "./ChannelDeliveryStore.ts";
import {
  ChannelRuntime,
  channelFailureCategory,
  WHATSAPP_NOT_LIVE_MESSAGE,
  type ChannelRuntimeDependencies,
} from "./ChannelRuntime.ts";

const NOW = "2026-09-25T12:00:00.000Z";
const BOT_ID = BotId.make("bot-1");
const PROJECT_ID = ProjectId.make("project-1");

const makeBot = (): OrchestrationBot => ({
  id: BOT_ID,
  name: "Akeru",
  title: "Agent",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither", seed: BOT_ID },
  engine: null,
  sandbox: "local",
  runtimeMode: "full-access",
  usageCap: null,
  imageProvider: null,
  voiceEnabled: false,
  channelBindings: [],
  groupId: null,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const makeThread = (
  id: ThreadId,
  messages: ReadonlyArray<OrchestrationMessage>,
): OrchestrationThread => ({
  id,
  projectId: PROJECT_ID,
  botId: BOT_ID,
  groupId: null,
  title: "Channel thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
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
  messages,
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const makeMessage = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  channelOrigin?: OrchestrationMessage["channelOrigin"],
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  ...(channelOrigin ? { channelOrigin } : {}),
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const chatMessage = (threadId: string, id: string, text: string, isMention: boolean) =>
  new ChatMessage({
    id,
    threadId,
    text,
    formatted: parseMarkdown(text),
    raw: {},
    author: { userId: "U1", userName: "u1", fullName: "U1", isBot: false, isMe: false },
    // @effect-diagnostics-next-line globalDate:off - Chat SDK Message requires a Date fixture.
    metadata: { dateSent: new Date(NOW), edited: false },
    attachments: [],
    isMention,
  });

/** Answers Slack's apps.connections.open probe with `ok` and records every request URL. */
const slackProbeClient = (ok: boolean, requests: string[] = [], error = "invalid_auth") =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      return HttpClientResponse.fromWeb(
        request,
        Response.json(ok ? { ok, url: "wss://wss.slack.test/link" } : { ok, error }),
      );
    }),
  );

/** Answers Slack's probe with a gateway error page, as an outage or proxy would. */
const slackOutageClient = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(request, new Response("<html>Bad gateway</html>", { status: 502 })),
  ),
);

/** Fails Slack's probe before any response, as a firewall or DNS failure would. */
const slackOfflineClient = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: "offline" }),
    }),
  ),
);

/**
 * A channel runtime over in-memory stores. Built-in transports run against the mocked SDK
 * adapters; every started turn is offered to `turns` so tests wait on it as a receipt.
 */
const makeHarness = (input: {
  readonly publicOrigin?: string;
  readonly httpClient?: HttpClient.HttpClient;
  readonly settings?: typeof DEFAULT_SERVER_SETTINGS;
}) =>
  Effect.gen(function* () {
    let model: OrchestrationReadModel = {
      ...createEmptyReadModel(NOW),
      bots: [makeBot()],
      projects: [
        {
          id: PROJECT_ID,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6",
          },
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
          deletedAt: null,
        },
      ],
    };
    let settings = input.settings ?? DEFAULT_SERVER_SETTINGS;
    let threads: OrchestrationThread[] = [];
    let sequence = 0;
    const turns =
      yield* Queue.unbounded<Extract<OrchestrationCommand, { type: "thread.turn.start" }>>();
    const values = new Map<string, Uint8Array>();
    const secretStore: ServerSecretStore["Service"] = {
      get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => values.get(name) ?? new Uint8Array(bytes)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
    };
    const engine = {
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("unused thread replay stats"),
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          sequence += 1;
          if (command.type === "bot.update" && command.channelBindings !== undefined) {
            const channelBindings = command.channelBindings;
            model = { ...model, bots: model.bots.map((bot) => ({ ...bot, channelBindings })) };
          }
          if (command.type === "thread.create") {
            threads = [...threads, makeThread(command.threadId, [])];
            model = { ...model, threads };
          }
          if (command.type === "thread.turn.start") {
            threads = threads.map((thread) =>
              thread.id === command.threadId
                ? {
                    ...thread,
                    messages: [
                      ...thread.messages,
                      makeMessage(
                        command.message.messageId,
                        "user",
                        command.message.text,
                        command.message.channelOrigin,
                      ),
                    ],
                  }
                : thread,
            );
            model = { ...model, threads };
            Queue.offerUnsafe(turns, command);
          }
          return { sequence };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.sync(() => sequence),
    } satisfies OrchestrationEngineShape;
    const dependencies: ChannelRuntimeDependencies = {
      engine,
      secretStore,
      settings: {
        getSettings: Effect.sync(() => settings),
        updateSettings: (patch) =>
          Effect.sync(() => {
            settings = { ...settings, ...patch } as typeof settings;
            return settings;
          }),
      },
      deliveryStore: makeMemoryChannelDeliveryStore(),
      readModel: Effect.sync(() => model),
      readThread: (threadId) =>
        Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
      nowIso: Effect.succeed(NOW),
      randomUuid: Effect.sync(() => `uuid-${sequence}`),
      httpClient: input.httpClient ?? slackProbeClient(true),
      ...(input.publicOrigin ? { publicOrigin: input.publicOrigin } : {}),
    };
    const scope = yield* Scope.Scope;
    const runtime = Context.get(
      yield* Layer.buildWithScope(ChannelRuntime.layerWith(dependencies), scope),
      ChannelRuntime,
    );
    return {
      runtime,
      turns,
      binding: () => model.bots[0]?.channelBindings?.[0],
      settings: () => settings,
      addAssistantMessage: (threadId: ThreadId, id: string, text: string) => {
        threads = threads.map((thread) =>
          thread.id === threadId
            ? { ...thread, messages: [...thread.messages, makeMessage(id, "assistant", text)] }
            : thread,
        );
      },
    };
  });

const connect = <P extends string, T extends Record<string, string>>(provider: P, fields: T) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-${provider}`),
  botId: BOT_ID,
  targetProjectId: PROJECT_ID,
  provider,
  ...fields,
});

const slackConnect = (appToken = "xapp-token") =>
  connect("slack" as const, { botToken: "xoxb-token", appToken });
const discordConnect = () =>
  connect("discord" as const, {
    botToken: "discord-token",
    applicationId: "discord-app",
    publicKey: "discord-public-key",
  });

const whatsappSave = (connectionId: ChannelConnectionId) => ({
  type: "channel.connection.save" as const,
  commandId: CommandId.make("save-whatsapp"),
  connectionId,
  name: "Support line",
  provider: "whatsapp" as const,
  accessToken: "access-token",
  appSecret: "app-secret",
  phoneNumberId: "phone-number-id",
  verifyToken: "verify-token",
});

afterEach(() => {
  adapters.slack = null;
  adapters.slackPosts.length = 0;
  adapters.discord = null;
  adapters.discordThreadsCreated.length = 0;
  adapters.imessage = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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
    const gatewayEvent = (id: string, data: Record<string, unknown>) =>
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
        const update = (updateId: number, chat: Record<string, unknown>, text: string) => ({
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

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
import { afterEach, vi } from "vite-plus/test";
import type { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { createEmptyReadModel } from "../../orchestration/projector.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { makeMemoryChannelDeliveryStore } from "../ChannelDeliveryStore.ts";
import { ChannelRuntime, type ChannelRuntimeDependencies } from "../ChannelRuntime.ts";

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

export {
  adapters,
  NOW,
  BOT_ID,
  PROJECT_ID,
  makeBot,
  makeThread,
  makeMessage,
  chatMessage,
  slackProbeClient,
  slackOutageClient,
  slackOfflineClient,
  makeHarness,
  connect,
  slackConnect,
  discordConnect,
  whatsappSave,
};

import * as NodeCrypto from "node:crypto";

import {
  BotId,
  ChannelConnectionId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ChannelBinding,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import type { iMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import {
  Message as ChatMessage,
  parseMarkdown,
  type Adapter,
  type ChatInstance,
  type Thread,
} from "chat";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";

const photon = vi.hoisted(() => ({
  adapter: null as iMessageAdapter | null,
  chat: null as ChatInstance | null,
  failedSubscription: null as string | null,
  subscriptionAttempts: [] as string[],
}));

const externalAdapters = vi.hoisted(() => ({
  slackAdapter: null as Adapter | null,
  slackChat: null as ChatInstance | null,
  slackDisconnects: 0,
  slackIdentityAvailable: true,
  slackInitializationFails: false,
  slackSubscriptions: [] as string[],
  slackRestoredBeforeInitialize: false,
  slackResponses: [] as Array<
    { status: number; data: unknown; headers?: Record<string, string> } | Error
  >,
  slackPostRequests: 0,
  slackRetryOptions: {} as {
    retries?: number | undefined;
    rejectRateLimitedCalls?: boolean | undefined;
  },
  discordAdapter: null as Adapter | null,
  discordChat: null as ChatInstance | null,
  discordGatewayStarts: 0,
  discordIdentityFails: false,
  discordDisconnects: 0,
  discordSubscriptions: [] as string[],
  reactions: [] as string[],
}));

vi.mock("@photon-ai/chat-adapter-imessage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@photon-ai/chat-adapter-imessage")>();
  return {
    ...actual,
    createiMessageAdapter: (
      options: Parameters<typeof actual.createiMessageAdapter>[0],
    ): iMessageAdapter => {
      const adapter = actual.createiMessageAdapter(options) as iMessageAdapter & Adapter;
      adapter.initialize = async (chat) => {
        photon.adapter = adapter;
        photon.chat = chat;
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
      adapter.onThreadSubscribe = async (threadId) => {
        photon.subscriptionAttempts.push(threadId);
        if (threadId === photon.failedSubscription) throw new Error("invalid group GUID");
      };
      adapter.disconnect = async () => undefined;
      return adapter;
    },
  };
});

vi.mock("@chat-adapter/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chat-adapter/slack")>();
  return {
    ...actual,
    createSlackAdapter: (options: Parameters<typeof actual.createSlackAdapter>[0] = {}) => {
      externalAdapters.slackRetryOptions = {
        retries: options.webClientOptions?.retryConfig?.retries,
        rejectRateLimitedCalls: options.webClientOptions?.rejectRateLimitedCalls,
      };
      const adapter = actual.createSlackAdapter({
        ...options,
        webClientOptions: {
          ...options.webClientOptions,
          adapter: async (config) => {
            if (config.url !== "https://slack.com/api/chat.postMessage") {
              throw new Error("Unexpected Slack API request");
            }
            externalAdapters.slackPostRequests += 1;
            const response = externalAdapters.slackResponses.shift();
            if (response instanceof Error) throw response;
            if (!response) throw new Error("Missing Slack API response");
            return {
              ...response,
              headers: response.headers ?? {},
              statusText: "",
              config,
              request: { path: "/api/chat.postMessage" },
            };
          },
        },
      }) as ReturnType<typeof actual.createSlackAdapter> & Adapter;
      adapter.initialize = async (chat) => {
        if (externalAdapters.slackIdentityAvailable) {
          Object.assign(adapter, { _botUserId: "U-AKERU" });
        }
        externalAdapters.slackAdapter = adapter;
        externalAdapters.slackChat = chat;
        externalAdapters.slackRestoredBeforeInitialize = await chat
          .getState()
          .isSubscribed("slack:C1:1");
        if (externalAdapters.slackInitializationFails) throw new Error("Socket startup failed");
      };
      adapter.addReaction = async (threadId, messageId, emoji) => {
        externalAdapters.reactions.push(`add:${threadId}:${messageId}:${String(emoji)}`);
      };
      adapter.removeReaction = async (threadId, messageId, emoji) => {
        externalAdapters.reactions.push(`remove:${threadId}:${messageId}:${String(emoji)}`);
      };
      adapter.onThreadSubscribe = async (threadId) => {
        externalAdapters.slackSubscriptions.push(threadId);
      };
      adapter.disconnect = async () => {
        externalAdapters.slackDisconnects += 1;
      };
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
      adapter.initialize = async (chat) => {
        externalAdapters.discordAdapter = adapter;
        externalAdapters.discordChat = chat;
      };
      adapter.getUser = async (userId) => {
        if (externalAdapters.discordIdentityFails) throw new Error("Discord identity failed");
        return { userId, userName: "akeru-discord", fullName: "Akeru Discord", isBot: true };
      };
      adapter.disconnect = async () => {
        externalAdapters.discordDisconnects += 1;
      };
      adapter.addReaction = async (threadId, messageId, emoji) => {
        externalAdapters.reactions.push(`add:${threadId}:${messageId}:${String(emoji)}`);
      };
      adapter.removeReaction = async (threadId, messageId, emoji) => {
        externalAdapters.reactions.push(`remove:${threadId}:${messageId}:${String(emoji)}`);
      };
      adapter.onThreadSubscribe = async (threadId) => {
        externalAdapters.discordSubscriptions.push(threadId);
      };
      adapter.startGatewayListener = async ({ waitUntil }, _durationMs, signal) => {
        externalAdapters.discordGatewayStarts += 1;
        waitUntil?.(
          new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        );
        return new Response(null, { status: 200 });
      };
      return adapter;
    },
  };
});

import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { createEmptyReadModel } from "../orchestration/projector.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeMemoryChannelDeliveryStore } from "./ChannelDeliveryStore.ts";
import {
  attachChannelConnection,
  defaultProjectIdForBot,
  CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT,
  ChannelPostRejectedError,
  channelBindingsForRuntime,
  channelThreadId,
  connectChannel,
  deleteChannelConnection,
  detachChannelConnection,
  disconnectChannel,
  dispatchInboundChannelMessage,
  finishChannelTurn,
  clearChannelThreadStatuses,
  handleWhatsAppWebhook,
  mentionWithContext,
  reconnectChannel,
  saveChannelConnection,
  restoreConnectedChannels,
  sendCompletedChannelReply,
  sendChannelMessage,
  shutdownAllChannels,
  startRenewingGateway,
  stopArchivedBotChannels,
  stopChannelsForBot,
  type ChannelRuntimeDependencies,
} from "./ChannelRuntime.ts";

const NOW = "2026-08-27T20:00:00.000Z";
const BOT_ID = BotId.make("bot-1");
const PROJECT_ID = ProjectId.make("project-1");
const SECOND_PROJECT_ID = ProjectId.make("project-2");
const MISSING_PROJECT_ID = ProjectId.make("project-missing");

function makeBot(
  id: BotId,
  input: {
    readonly name?: string;
    readonly archivedAt?: string | null;
    readonly channelBindings?: ReadonlyArray<ChannelBinding>;
  } = {},
): OrchestrationBot {
  return {
    id,
    name: input.name ?? id,
    title: "Agent",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "dither", seed: id },
    engine: null,
    sandbox: "local",
    runtimeMode: "full-access",
    usageCap: null,
    voiceEnabled: false,
    channelBindings: input.channelBindings ?? [],
    groupId: null,
    archivedAt: input.archivedAt ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeModel(bots: ReadonlyArray<OrchestrationBot>): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(NOW),
    snapshotSequence: 12,
    bots,
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
      {
        id: SECOND_PROJECT_ID,
        title: "Second project",
        workspaceRoot: "/tmp/project-2",
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
}

function makeMessage(
  id: MessageId,
  role: OrchestrationMessage["role"],
  text: string,
  channelOrigin?: OrchestrationMessage["channelOrigin"],
): OrchestrationMessage {
  return {
    id,
    role,
    text,
    turnId: null,
    ...(channelOrigin !== undefined ? { channelOrigin } : {}),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeChatSdkMessage(
  threadId: string,
  id: string,
  text: string,
  senderId: string,
  isMention = false,
) {
  return new ChatMessage({
    id,
    threadId,
    text,
    formatted: parseMarkdown(text),
    raw: {},
    author: {
      userId: senderId,
      userName: senderId,
      fullName: senderId,
      isBot: false,
      isMe: false,
    },
    // @effect-diagnostics-next-line globalDate:off - Chat SDK Message requires a Date fixture.
    metadata: { dateSent: new Date(NOW), edited: false },
    attachments: [],
    isMention,
  });
}

function makeThread(
  id: ThreadId,
  botId: BotId,
  messages: ReadonlyArray<OrchestrationMessage>,
): OrchestrationThread {
  return {
    id,
    projectId: PROJECT_ID,
    botId,
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
  };
}

function makeMemorySecretStore() {
  const values = new Map<string, Uint8Array>();
  const store: ServerSecretStore["Service"] = {
    get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = values.get(name) ?? new Uint8Array(bytes);
        values.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  };
  return { store, values };
}

function makeHarness(input: {
  readonly bots?: ReadonlyArray<OrchestrationBot>;
  readonly threads?: ReadonlyArray<OrchestrationThread>;
  readonly post?: (externalThreadId: string, text: string) => Promise<void>;
  readonly shutdown?: () => Promise<void>;
  readonly deliveryStore?: ChannelRuntimeDependencies["deliveryStore"];
  readonly secretStore?: ChannelRuntimeDependencies["secretStore"];
  readonly settings?: ChannelRuntimeDependencies["settings"];
  readonly startTransport?: ChannelRuntimeDependencies["startTransport"] | null;
  readonly failBotUpdate?: (updateIndex: number) => Error | undefined;
  readonly commandModelOmitsMessages?: boolean;
}) {
  let model = makeModel(input.bots ?? [makeBot(BOT_ID)]);
  let settings = DEFAULT_SERVER_SETTINGS;
  const threads = [...(input.threads ?? [])];
  const commands: OrchestrationCommand[] = [];
  const { store: memorySecretStore, values: secrets } = makeMemorySecretStore();
  const secretStore = input.secretStore ?? memorySecretStore;
  let sequence = model.snapshotSequence;
  let botUpdateIndex = 0;
  const dispatch = (command: OrchestrationCommand) =>
    Effect.sync(() => {
      if (command.type === "bot.update") {
        botUpdateIndex += 1;
        const failure = input.failBotUpdate?.(botUpdateIndex);
        if (failure) throw failure;
      }
      commands.push(command);
      sequence += 1;
      const channelBindings = command.type === "bot.update" ? command.channelBindings : undefined;
      if (channelBindings !== undefined) {
        const botId = command.type === "bot.update" ? command.botId : undefined;
        model = {
          ...model,
          snapshotSequence: sequence,
          bots: model.bots.map((bot) => (bot.id === botId ? { ...bot, channelBindings } : bot)),
        };
      }
      if (command.type === "thread.create") {
        threads.push(makeThread(command.threadId, command.botId!, []));
        model = { ...model, threads };
      }
      return { sequence };
    });
  const engine = {
    readEvents: () => Stream.empty,
    dispatch,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.sync(() => sequence),
  } satisfies OrchestrationEngineShape;
  const dependencies: ChannelRuntimeDependencies = {
    engine,
    secretStore,
    settings: input.settings ?? {
      getSettings: Effect.sync(() => settings),
      updateSettings: (patch) =>
        Effect.sync(() => {
          settings = { ...settings, ...patch } as typeof settings;
          return settings;
        }),
    },
    deliveryStore: input.deliveryStore ?? makeMemoryChannelDeliveryStore(),
    readModel: async () => ({
      ...model,
      threads: input.commandModelOmitsMessages
        ? threads.map((thread) => ({ ...thread, messages: [] }))
        : threads,
    }),
    readThread: async (threadId) => threads.find((thread) => thread.id === threadId) ?? null,
    nowIso: async () => NOW,
    randomUuid: async () => `uuid-${commands.length}`,
    ...(input.startTransport === null
      ? {}
      : {
          startTransport:
            input.startTransport ??
            (async () => ({
              externalIdentity: "@akeru",
              runtime: {
                post: input.post ?? (async () => undefined),
                shutdown: input.shutdown ?? (async () => undefined),
              },
            })),
        }),
  };
  return { commands, dependencies, secrets, readModel: () => model, readSettings: () => settings };
}

function makeAdapterDeliveryHarness(
  provider: ChannelBinding["provider"],
  externalThreadId: string,
  text = "Reply",
) {
  const messageId = MessageId.make(`adapter-reply-${provider}`);
  const threadId = ThreadId.make(`adapter-thread-${provider}`);
  const harness = makeHarness({
    startTransport: null,
    threads: [
      makeThread(threadId, BOT_ID, [
        makeMessage(MessageId.make(`adapter-inbound-${provider}`), "user", "Question", {
          provider,
          externalThreadId,
        }),
        makeMessage(messageId, "assistant", text),
      ]),
    ],
  });
  return { harness, input: { botId: BOT_ID, threadId, messageId } };
}

function mockTelegramDelivery(responses: Array<Response | Error>) {
  const sends = vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Missing Telegram response");
    return response;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(
      async (input, init) => {
        const method = String(input).split("/").at(-1);
        if (method === "sendMessage") return sends();
        if (method === "getMe")
          return Response.json({
            ok: true,
            result: { id: 1, is_bot: true, first_name: "Akeru", username: "akeru" },
          });
        if (method === "deleteWebhook" || method === "deleteMyCommands") {
          return Response.json({ ok: true, result: true });
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
  return sends;
}

const telegramConnect = (botId: BotId, token = "telegram-token") => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-${botId}`),
  botId,
  targetProjectId: PROJECT_ID,
  provider: "telegram" as const,
  token,
});

const imessageConnect = (botId: BotId) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-imessage-${botId}`),
  botId,
  targetProjectId: PROJECT_ID,
  provider: "imessage" as const,
  mode: "hosted" as const,
  projectId: "photon-project",
  projectSecret: "photon-secret",
});

const whatsappConnect = (botId: BotId) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-whatsapp-${botId}`),
  botId,
  targetProjectId: PROJECT_ID,
  provider: "whatsapp" as const,
  accessToken: "access-token",
  appSecret: "app-secret",
  phoneNumberId: "phone-number-id",
  verifyToken: "verify-token",
});

const slackConnect = (botId: BotId) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-slack-${botId}`),
  botId,
  targetProjectId: PROJECT_ID,
  provider: "slack" as const,
  botToken: "xoxb-token",
  appToken: "xapp-token",
});

const discordConnect = (botId: BotId) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-discord-${botId}`),
  botId,
  targetProjectId: PROJECT_ID,
  provider: "discord" as const,
  botToken: "discord-token",
  applicationId: "discord-app",
  publicKey: "discord-public-key",
});

const signedWhatsAppRequest = (body: string) =>
  new Request(`https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", "app-secret").update(body).digest("hex")}`,
    },
    body,
  });

afterEach(async () => {
  await shutdownAllChannels();
  photon.adapter = null;
  photon.chat = null;
  photon.failedSubscription = null;
  photon.subscriptionAttempts.length = 0;
  externalAdapters.slackAdapter = null;
  externalAdapters.slackChat = null;
  externalAdapters.slackDisconnects = 0;
  externalAdapters.slackIdentityAvailable = true;
  externalAdapters.slackInitializationFails = false;
  externalAdapters.slackSubscriptions.length = 0;
  externalAdapters.slackResponses.length = 0;
  externalAdapters.slackPostRequests = 0;
  externalAdapters.slackRetryOptions = {};
  vi.unstubAllGlobals();
  externalAdapters.discordAdapter = null;
  externalAdapters.discordChat = null;
  externalAdapters.discordGatewayStarts = 0;
  externalAdapters.discordIdentityFails = false;
  externalAdapters.discordDisconnects = 0;
  externalAdapters.discordSubscriptions.length = 0;
  externalAdapters.reactions.length = 0;
});

describe("channel runtime", () => {
  it.each(["slack", "discord"] as const)(
    "cleans persisted and terminal %s reactions through adapter APIs",
    async (provider) => {
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
      await connectChannel(
        harness.dependencies,
        provider === "slack" ? slackConnect(BOT_ID) : discordConnect(BOT_ID),
      );
      const prefix = `${externalThreadId}:external-request`;
      expect(externalAdapters.reactions).toEqual([
        `remove:${prefix}:eyes`,
        `remove:${prefix}:white_check_mark`,
        `remove:${prefix}:x`,
      ]);
      await finishChannelTurn(harness.dependencies, threadId, turnId, "completed");
      expect(externalAdapters.reactions.at(-1)).toBe(`add:${prefix}:white_check_mark`);
      const count = externalAdapters.reactions.length;
      await finishChannelTurn(harness.dependencies, threadId, turnId, "completed");
      expect(externalAdapters.reactions).toHaveLength(count);
      await clearChannelThreadStatuses(threadId);
      expect(externalAdapters.reactions.slice(-3)).toEqual([
        `remove:${prefix}:eyes`,
        `remove:${prefix}:white_check_mark`,
        `remove:${prefix}:x`,
      ]);
      await finishChannelTurn(harness.dependencies, threadId, turnId, "failed");
      expect(externalAdapters.reactions.at(-1)).toBe(`add:${prefix}:x`);
      await disconnectChannel(harness.dependencies, BOT_ID, provider);
      expect(externalAdapters.reactions.slice(-3)).toEqual([
        `remove:${prefix}:eyes`,
        `remove:${prefix}:white_check_mark`,
        `remove:${prefix}:x`,
      ]);
      externalAdapters.reactions.length = 0;
      await reconnectChannel(harness.dependencies, BOT_ID, provider);
      expect(externalAdapters.reactions).toEqual([
        `remove:${prefix}:eyes`,
        `remove:${prefix}:white_check_mark`,
        `remove:${prefix}:x`,
      ]);
    },
  );

  it("exposes gateway failure in runtime channel health", async () => {
    const failed = Promise.withResolvers<void>();
    const gateway = await startRenewingGateway(async (waitUntil) => {
      waitUntil(failed.promise);
      return new Response(null, { status: 200 });
    }, "Test gateway");
    const harness = makeHarness({
      startTransport: async () => ({
        externalIdentity: "test",
        runtime: { post: async () => {}, shutdown: gateway.shutdown, isHealthy: gateway.isHealthy },
      }),
    });
    await connectChannel(harness.dependencies, discordConnect(BOT_ID));
    const bindings = harness.readModel().bots[0]!.channelBindings;
    expect(channelBindingsForRuntime(bindings)[0]?.status).toBe("connected");
    failed.reject(new Error("Gateway disconnected"));
    await gateway.settled;
    expect(channelBindingsForRuntime(bindings)[0]?.status).toBe("needs-reconnect");
  });

  it("attaches to the bot's default project when the client names none", async () => {
    const connectionId = ChannelConnectionId.make("channel-default-project");
    const harness = makeHarness({
      startTransport: async () => ({
        externalIdentity: "@bot",
        runtime: { post: async () => {}, shutdown: async () => {} },
      }),
    });
    await saveChannelConnection(harness.dependencies, {
      type: "channel.connection.save",
      commandId: CommandId.make("save-default-project"),
      connectionId,
      name: "Default project line",
      provider: "telegram",
      token: "telegram-token",
    });

    await attachChannelConnection(
      harness.dependencies,
      BOT_ID,
      connectionId,
      undefined,
      "telegram",
    );

    expect(harness.readModel().bots[0]?.channelBindings?.[0]).toMatchObject({
      connectionId,
      status: "connected",
      projectId: defaultProjectIdForBot(harness.readModel(), BOT_ID),
    });
  });

  it("resolves a bot's default project from its own recent chats before global activity", () => {
    const model = makeHarness({}).readModel();
    const otherBot = BotId.make("other-bot");
    const base = makeThread(ThreadId.make("t"), BOT_ID, []);
    const withThreads = {
      ...model,
      threads: [
        {
          ...base,
          id: ThreadId.make("bot-old"),
          projectId: SECOND_PROJECT_ID,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          ...base,
          id: ThreadId.make("bot-new"),
          projectId: PROJECT_ID,
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        {
          ...base,
          id: ThreadId.make("other"),
          botId: otherBot,
          projectId: SECOND_PROJECT_ID,
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    };
    expect(defaultProjectIdForBot(withThreads, BOT_ID)).toBe(PROJECT_ID);
    expect(defaultProjectIdForBot(withThreads, otherBot)).toBe(SECOND_PROJECT_ID);
    expect(defaultProjectIdForBot(withThreads, BotId.make("fresh-bot"))).toBe(SECOND_PROJECT_ID);
    expect(defaultProjectIdForBot({ ...model, threads: [] }, BOT_ID)).toBe(PROJECT_ID);
    expect(defaultProjectIdForBot({ ...model, projects: [], threads: [] }, BOT_ID)).toBeNull();
  });

  it("gives each external conversation a stable isolated thread", () => {
    const first = channelThreadId(BOT_ID, PROJECT_ID, "telegram", "telegram:123");

    expect(channelThreadId(BOT_ID, PROJECT_ID, "telegram", "telegram:123")).toBe(first);
    expect(channelThreadId(BOT_ID, PROJECT_ID, "telegram", "telegram:456")).not.toBe(first);
    expect(channelThreadId(BOT_ID, PROJECT_ID, "imessage", "telegram:123")).not.toBe(first);
  });

  it("routes an inbound message to the selected project instead of the first project", async () => {
    const harness = makeHarness({});

    await dispatchInboundChannelMessage(harness.dependencies, {
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
  });

  it("marks the binding failed when its selected project is unavailable", async () => {
    const binding: ChannelBinding = {
      botId: BOT_ID,
      projectId: MISSING_PROJECT_ID,
      provider: "telegram",
      status: "connected",
      externalIdentity: "@akeru",
      connectedAt: NOW,
      sentMessageIds: [],
    };
    const harness = makeHarness({ bots: [makeBot(BOT_ID, { channelBindings: [binding] })] });

    await expect(
      dispatchInboundChannelMessage(harness.dependencies, {
        botId: BOT_ID,
        projectId: MISSING_PROJECT_ID,
        provider: "telegram",
        externalThreadId: "chat-missing-project",
        externalMessageId: "message-missing-project",
        text: "Work",
      }),
    ).rejects.toThrow("project is unavailable");
    expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
      status: "failed",
      lastError: "The selected project is unavailable. Choose another project.",
    });
  });

  it("starts a new thread when the legacy conversation belongs to another project", async () => {
    const externalThreadId = "telegram:legacy-other-project";
    const legacyThreadId = ThreadId.make(
      `channel-${NodeCrypto.createHash("sha256")
        .update(`${BOT_ID}\0telegram\0${externalThreadId}`)
        .digest("hex")}`,
    );
    const harness = makeHarness({ threads: [makeThread(legacyThreadId, BOT_ID, [])] });

    await dispatchInboundChannelMessage(harness.dependencies, {
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
    expect(harness.commands.find((command) => command.type === "thread.turn.start")).toMatchObject({
      threadId: created?.threadId,
    });
  });

  it("continues a channel thread created before project-aware thread IDs", async () => {
    const externalThreadId = "telegram:legacy-chat";
    const legacyThreadId = ThreadId.make(
      `channel-${NodeCrypto.createHash("sha256")
        .update(`${BOT_ID}\0telegram\0${externalThreadId}`)
        .digest("hex")}`,
    );
    const harness = makeHarness({ threads: [makeThread(legacyThreadId, BOT_ID, [])] });

    await dispatchInboundChannelMessage(harness.dependencies, {
      botId: BOT_ID,
      projectId: PROJECT_ID,
      provider: "telegram",
      externalThreadId,
      externalMessageId: "legacy-message",
      text: "Continue here",
    });

    expect(harness.commands.some((command) => command.type === "thread.create")).toBe(false);
    expect(harness.commands.find((command) => command.type === "thread.turn.start")).toMatchObject({
      threadId: legacyThreadId,
    });
  });

  it("derives stable command and message identities from the provider message", async () => {
    const harness = makeHarness({});
    const input = {
      botId: BOT_ID,
      projectId: PROJECT_ID,
      provider: "telegram" as const,
      externalThreadId: "chat-dedupe",
      externalMessageId: "provider-message-1",
      text: "Only once",
    };

    await dispatchInboundChannelMessage(harness.dependencies, input);
    await dispatchInboundChannelMessage(harness.dependencies, input);

    const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
    expect(turns).toHaveLength(2);
    expect(turns[0]?.commandId).toBe(turns[1]?.commandId);
    expect(turns[0]?.message.messageId).toBe(turns[1]?.message.messageId);
  });

  it("preserves the inbound provider, thread, and sender on the turn command", async () => {
    const harness = makeHarness({});

    await dispatchInboundChannelMessage(harness.dependencies, {
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
  });

  it("verifies WhatsApp webhook challenges", async () => {
    const harness = makeHarness({ startTransport: null });
    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));

    const accepted = await handleWhatsAppWebhook(
      BOT_ID,
      new Request(
        `https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123`,
      ),
    );
    const rejected = await handleWhatsAppWebhook(
      BOT_ID,
      new Request(
        `https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123`,
      ),
    );

    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("challenge-123");
    expect(rejected.status).toBe(403);
  });

  it("validates and dispatches inbound WhatsApp DMs", async () => {
    const harness = makeHarness({ startTransport: null });
    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
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

    const invalidSignature = await handleWhatsAppWebhook(
      BOT_ID,
      new Request(`https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook`, {
        method: "POST",
        body: payload,
      }),
    );
    const invalidPayload = await handleWhatsAppWebhook(BOT_ID, signedWhatsAppRequest("{}"));
    const accepted = await handleWhatsAppWebhook(BOT_ID, signedWhatsAppRequest(payload));

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
  });

  it("accepts iMessage direct messages and ignores group messages", async () => {
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
    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));

    await directMessage?.({
      externalThreadId: "imessage:iMessage;-;+15551234567",
      externalMessageId: "direct-1",
      externalSenderId: "+15551234567",
      externalSenderName: "Alice",
      text: "DM without a mention",
    });

    const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.message.channelOrigin).toMatchObject({
      provider: "imessage",
      externalMessageId: "direct-1",
      externalThreadId: "imessage:iMessage;-;+15551234567",
    });
  });

  it("bounds first-mention context and preserves sender attribution", async () => {
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

    const normalized = await mentionWithContext(thread, current);

    expect(normalized.text).not.toContain("U0: context 0\n");
    expect(normalized.text).not.toContain("U1: context 1\n");
    expect(normalized.text.split("\n")).toHaveLength(11);
    expect(normalized.externalSenderName).toBe("U-current");
    expect(normalized.externalMessageId).toBe("mention-current");
  });

  it("limits large prior context without truncating the current mention", async () => {
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

    const normalized = await mentionWithContext(thread, current);

    expect(normalized.text.length).toBe(8_000 + 1 + current.text.length);
    expect(normalized.text).toContain("U2: Latest detail");
    expect(normalized.text.endsWith(`\n${current.text}`)).toBe(true);
  });

  it("shuts down an adapter when chat initialization fails", async () => {
    externalAdapters.slackInitializationFails = true;
    const harness = makeHarness({ startTransport: null });

    await expect(connectChannel(harness.dependencies, slackConnect(BOT_ID))).rejects.toThrow(
      "Socket startup failed",
    );

    expect(externalAdapters.slackDisconnects).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
    expect(harness.secrets.size).toBe(0);
  });

  it("rejects Slack credentials that cannot resolve the bot identity", async () => {
    externalAdapters.slackIdentityAvailable = false;
    const harness = makeHarness({ startTransport: null });

    await expect(connectChannel(harness.dependencies, slackConnect(BOT_ID))).rejects.toThrow(
      "Slack bot credentials are invalid",
    );
    expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
  });

  it("routes Slack direct messages and subscribed mention threads", async () => {
    const harness = makeHarness({ startTransport: null });
    await connectChannel(harness.dependencies, slackConnect(BOT_ID));
    if (!externalAdapters.slackChat || !externalAdapters.slackAdapter) {
      throw new Error("Expected the Slack Chat runtime.");
    }

    const directThreadId = "slack:D123:";
    await externalAdapters.slackChat.processMessage(
      externalAdapters.slackAdapter,
      directThreadId,
      makeChatSdkMessage(directThreadId, "slack-dm-1", "Direct work", "U1"),
    );
    const channelThreadId = "slack:C123:1710000000.000001";
    await externalAdapters.slackChat.processMessage(
      externalAdapters.slackAdapter,
      channelThreadId,
      makeChatSdkMessage(channelThreadId, "slack-mention-1", "@Akeru investigate", "U2", true),
    );
    await externalAdapters.slackChat.processMessage(
      externalAdapters.slackAdapter,
      channelThreadId,
      makeChatSdkMessage(channelThreadId, "slack-followup-1", "One more detail", "U3"),
    );

    const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
    expect(turns.map((turn) => turn.message.channelOrigin?.externalMessageId)).toEqual([
      "slack-dm-1",
      "slack-mention-1",
      "slack-followup-1",
    ]);
    expect(turns[1]?.threadId).toBe(turns[2]?.threadId);

    await disconnectChannel(harness.dependencies, BOT_ID, "slack");
    expect(externalAdapters.slackDisconnects).toBeGreaterThan(0);
  });

  it("restores Slack and Discord platform-thread subscriptions", async () => {
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

    await connectChannel(harness.dependencies, slackConnect(BOT_ID));
    await connectChannel(harness.dependencies, discordConnect(BOT_ID));

    expect(externalAdapters.slackRestoredBeforeInitialize).toBe(true);
    expect(externalAdapters.slackSubscriptions).toContain("slack:C1:1");
    expect(externalAdapters.discordSubscriptions).toContain("discord:G1:C1:T1");
  });

  it("owns and aborts renewable Gateway listeners", async () => {
    let capturedSignal: AbortSignal | undefined;
    let capturedDuration = 0;
    const gateway = await startRenewingGateway(async (waitUntil, durationMs, signal) => {
      capturedSignal = signal;
      capturedDuration = durationMs;
      waitUntil(
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      );
      return new Response(null, { status: 200 });
    }, "Test gateway");

    expect(capturedDuration).toBeGreaterThan(3 * 60 * 1_000);
    expect(capturedSignal?.aborted).toBe(false);
    await gateway.shutdown();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("waits for gateway cleanup before shutdown completes", async () => {
    let finishCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const gateway = await startRenewingGateway(async (waitUntil, _duration, signal) => {
      waitUntil(
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              void cleanup.then(resolve);
            },
            { once: true },
          );
        }),
      );
      return new Response(null, { status: 200 });
    }, "Test gateway");
    let stopped = false;
    const shutdown = gateway.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(gateway.isHealthy()).toBe(false);
    finishCleanup?.();
    await shutdown;
    expect(stopped).toBe(true);
  });

  it("marks an early gateway exit unhealthy instead of restarting it", async () => {
    let starts = 0;
    const gateway = await startRenewingGateway(async (waitUntil) => {
      starts += 1;
      waitUntil(Promise.resolve());
      return new Response(null, { status: 200 });
    }, "Test gateway");
    await gateway.settled;
    expect(gateway.isHealthy()).toBe(false);
    expect(starts).toBe(1);
    await gateway.shutdown();
  });

  it("routes normalized Discord direct messages and mention-thread continuation", async () => {
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
    await connectChannel(harness.dependencies, discordConnect(BOT_ID));

    await directMessage?.({
      externalThreadId: "discord:@me:dm-channel",
      externalMessageId: "discord-dm-1",
      externalSenderId: "D1",
      text: "Direct work",
    });
    await context?.onMention({
      externalThreadId: "discord:guild-1:channel-1:thread-1",
      externalMessageId: "discord-mention-1",
      externalSenderId: "D2",
      text: "@Akeru investigate",
    });
    await context?.onSubscribedMessage({
      externalThreadId: "discord:guild-1:channel-1:thread-1",
      externalMessageId: "discord-followup-1",
      externalSenderId: "D3",
      text: "One more detail",
    });

    const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
    expect(turns.map((turn) => turn.message.channelOrigin?.externalMessageId)).toEqual([
      "discord-dm-1",
      "discord-mention-1",
      "discord-followup-1",
    ]);
    expect(turns[1]?.threadId).toBe(turns[2]?.threadId);
  });

  it("shuts down Discord when credential validation fails", async () => {
    externalAdapters.discordIdentityFails = true;
    const harness = makeHarness({ startTransport: null });

    await expect(connectChannel(harness.dependencies, discordConnect(BOT_ID))).rejects.toThrow(
      "Discord identity failed",
    );

    expect(externalAdapters.discordDisconnects).toBe(1);
    expect(externalAdapters.discordGatewayStarts).toBe(0);
    expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
    expect(harness.secrets.size).toBe(0);
  });

  it("starts and stops the supervised Discord Gateway", async () => {
    const harness = makeHarness({ startTransport: null });
    await connectChannel(harness.dependencies, discordConnect(BOT_ID));

    expect(externalAdapters.discordGatewayStarts).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
      projectId: PROJECT_ID,
      provider: "discord",
      status: "connected",
    });

    await disconnectChannel(harness.dependencies, BOT_ID, "discord");
    expect(harness.readModel().bots[0]?.channelBindings[0]?.status).toBe("disconnected");
  });

  it("ignores callbacks from a disconnected or replaced transport", async () => {
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
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    await disconnectChannel(harness.dependencies, BOT_ID, "telegram");
    const message = {
      externalThreadId: "telegram:retired",
      externalMessageId: "late",
      text: "Late event",
    };
    await callbacks[0]?.(message);
    expect(harness.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
      0,
    );

    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    await callbacks[0]?.(message);
    expect(harness.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
      0,
    );
    await callbacks[1]?.({ ...message, externalMessageId: "current" });
    expect(harness.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
      1,
    );
  });

  it("rejects inbound messages for archived bots", async () => {
    const harness = makeHarness({ bots: [makeBot(BOT_ID, { archivedAt: NOW })] });

    await expect(
      dispatchInboundChannelMessage(harness.dependencies, {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "telegram",
        externalThreadId: "chat-a",
        text: "Hello",
      }),
    ).rejects.toThrow("unavailable");
    expect(harness.commands).toEqual([]);
  });

  it("shows connected persisted bindings as needing reconnect until transport starts", () => {
    const binding: ChannelBinding = {
      botId: BOT_ID,
      provider: "telegram",
      status: "connected",
      externalIdentity: "@akeru",
      connectedAt: NOW,
      sentMessageIds: [],
    };

    expect(channelBindingsForRuntime([binding], () => false)).toEqual([
      { ...binding, status: "needs-reconnect" },
    ]);
    expect(channelBindingsForRuntime([binding], () => true)).toEqual([binding]);
  });

  it("rejects archived bot connections and skips them during restore", async () => {
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

    await expect(connectChannel(harness.dependencies, telegramConnect(BOT_ID))).rejects.toThrow(
      "unavailable",
    );
    await expect(restoreConnectedChannels(harness.dependencies)).resolves.toEqual([]);
    expect(starts).toBe(0);
  });

  it("records a truthful failed state when restore cannot start the transport", async () => {
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

    await expect(restoreConnectedChannels(harness.dependencies)).resolves.toHaveLength(1);
    expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
      status: "failed",
      lastError: "Connection restore failed. Reconnect with updated credentials.",
    });
  });

  it.effect("stops every live transport on bot archive events without stopping restored bots", () =>
    Effect.gen(function* () {
      let stops = 0;
      const harness = makeHarness({ shutdown: async () => void (stops += 1) });
      yield* Effect.promise(() => connectChannel(harness.dependencies, telegramConnect(BOT_ID)));
      yield* Effect.promise(() => connectChannel(harness.dependencies, imessageConnect(BOT_ID)));
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

  it("connects, disconnects, reconnects, restores, and stops a bot runtime", async () => {
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

    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    expect(harness.readModel().bots[0]?.channelBindings?.[0]?.status).toBe("connected");
    await stopChannelsForBot(BOT_ID);
    expect(stops).toBe(1);
    await reconnectChannel(harness.dependencies, BOT_ID, "telegram");
    await stopChannelsForBot(BOT_ID);
    await restoreConnectedChannels(harness.dependencies);
    await disconnectChannel(harness.dependencies, BOT_ID, "telegram");

    expect(starts).toBe(3);
    expect(stops).toBe(3);
    expect(harness.readModel().bots[0]?.channelBindings?.[0]?.status).toBe("disconnected");
    expect(harness.secrets.size).toBe(1);
    await detachChannelConnection(harness.dependencies, BOT_ID, "telegram");
    expect(harness.secrets.size).toBe(0);
  });

  it("saves, attaches, reconnects, detaches, and deletes a reusable connection", async () => {
    const connectionId = ChannelConnectionId.make("telegram-main");
    const harness = makeHarness({});

    await saveChannelConnection(harness.dependencies, {
      type: "channel.connection.save",
      commandId: CommandId.make("save-connection"),
      connectionId,
      name: "Main Telegram",
      provider: "telegram",
      token: "telegram-token",
    });
    await attachChannelConnection(
      harness.dependencies,
      BOT_ID,
      connectionId,
      PROJECT_ID,
      "telegram",
    );
    expect(harness.readSettings().channelConnections).toEqual([
      {
        id: connectionId,
        name: "Main Telegram",
        provider: "telegram",
        adapter: "telegram",
      },
    ]);
    expect(harness.readModel().bots[0]?.channelBindings?.[0]).toMatchObject({
      connectionId,
      provider: "telegram",
      status: "connected",
    });

    await expect(
      saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("edit-attached-connection"),
        connectionId,
        name: "Changed Telegram",
        provider: "telegram",
        token: "changed-token",
      }),
    ).rejects.toThrow("Unassign this channel before editing it");

    await expect(deleteChannelConnection(harness.dependencies, connectionId)).rejects.toThrow(
      "Unassign this channel",
    );
    await stopChannelsForBot(BOT_ID);
    await reconnectChannel(harness.dependencies, BOT_ID, "telegram");
    await disconnectChannel(harness.dependencies, BOT_ID, "telegram");
    await reconnectChannel(harness.dependencies, BOT_ID, "telegram");
    await disconnectChannel(harness.dependencies, BOT_ID, "telegram");
    await expect(deleteChannelConnection(harness.dependencies, connectionId)).rejects.toThrow(
      "Unassign this channel before deleting it",
    );
    await detachChannelConnection(harness.dependencies, BOT_ID, "telegram");
    expect(harness.secrets.size).toBe(1);
    await deleteChannelConnection(harness.dependencies, connectionId);
    expect(harness.secrets.size).toBe(0);
    expect(harness.readSettings().channelConnections).toEqual([]);
  });

  it("serializes multiple reusable connection profiles", async () => {
    const telegramId = ChannelConnectionId.make("telegram-work");
    const photonId = ChannelConnectionId.make("photon-personal");
    const harness = makeHarness({});

    await Promise.all([
      saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-telegram"),
        connectionId: telegramId,
        name: "Work Telegram",
        provider: "telegram",
        token: "telegram-token",
      }),
      saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-photon"),
        connectionId: photonId,
        name: "Personal iPhone",
        provider: "imessage",
        mode: "self-hosted",
        serverUrl: "photon.example:443",
        apiKey: "photon-key",
        phone: "+15551234567",
      }),
    ]);

    expect(harness.readSettings().channelConnections).toEqual([
      {
        id: telegramId,
        name: "Work Telegram",
        provider: "telegram",
        adapter: "telegram",
      },
      {
        id: photonId,
        name: "Personal iPhone",
        provider: "imessage",
        adapter: "photon",
        externalIdentity: "+15551234567",
      },
    ]);
  });

  it("stores a safe dashboard link for hosted Photon", async () => {
    const connectionId = ChannelConnectionId.make("photon-hosted");
    const harness = makeHarness({});

    await saveChannelConnection(harness.dependencies, {
      type: "channel.connection.save",
      commandId: CommandId.make("save-photon-hosted"),
      connectionId,
      name: "Launch iPhone",
      provider: "imessage",
      mode: "hosted",
      projectId: "project/launch",
      projectSecret: "never-in-settings",
    });

    expect(harness.readSettings().channelConnections).toEqual([
      {
        id: connectionId,
        name: "Launch iPhone",
        provider: "imessage",
        adapter: "photon",
        externalIdentity: "project/launch",
        managementUrl: "https://app.photon.codes/dashboard/project%2Flaunch",
      },
    ]);
    expect(JSON.stringify(harness.readSettings().channelConnections)).not.toContain(
      "never-in-settings",
    );
  });

  it("rolls back a saved secret when profile persistence fails", async () => {
    const connectionId = ChannelConnectionId.make("failed-profile");
    const harness = makeHarness({
      settings: {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () => Effect.die(new Error("settings write failed")),
      },
    });

    await expect(
      saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-failed-profile"),
        connectionId,
        name: "Failed profile",
        provider: "telegram",
        token: "telegram-token",
      }),
    ).rejects.toThrow("settings write failed");
    expect(harness.secrets.size).toBe(0);
  });

  it("restores saved WhatsApp credentials", async () => {
    let starts = 0;
    const harness = makeHarness({
      startTransport: async (input) => {
        starts += 1;
        expect(input).toMatchObject({
          provider: "whatsapp",
          accessToken: "access-token",
          appSecret: "app-secret",
          phoneNumberId: "phone-number-id",
          verifyToken: "verify-token",
        });
        return {
          externalIdentity: "phone-number-id",
          runtime: { post: async () => undefined, shutdown: async () => undefined },
        };
      },
    });

    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
    await stopChannelsForBot(BOT_ID);
    await restoreConnectedChannels(harness.dependencies);

    expect(starts).toBe(2);
  });

  it("sends an approved WhatsApp reply to the inbound DM", async () => {
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
    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));

    await sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });

    expect(posts).toEqual([{ externalThreadId, text: "Approved answer" }]);
  });

  it("automatically sends one completed reply for an inbound channel turn", async () => {
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
    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));

    await expect(
      sendCompletedChannelReply(harness.dependencies, threadId, turnId),
    ).resolves.toBeGreaterThan(0);
    await expect(
      sendCompletedChannelReply(harness.dependencies, threadId, turnId),
    ).resolves.toBeGreaterThan(0);

    expect(posts).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toContain(messageId);

    await expect(
      sendCompletedChannelReply(
        harness.dependencies,
        threadId,
        TurnId.make("stale-auto-reply-turn"),
      ),
    ).resolves.toBeNull();
    expect(posts).toBe(1);
  });

  it("rejects a reply after its channel moves to another project", async () => {
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
    await connectChannel(harness.dependencies, {
      ...telegramConnect(BOT_ID),
      targetProjectId: SECOND_PROJECT_ID,
    });

    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("previous channel project assignment");
    expect(posts).toBe(0);
  });

  it("does not send a local turn to an earlier channel conversation", async () => {
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
    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));

    await expect(
      sendCompletedChannelReply(harness.dependencies, threadId, turnId),
    ).resolves.toBeNull();

    expect(posts).toBe(0);
  });

  it("uses collision-free secret names for distinct bot IDs", async () => {
    const firstId = BotId.make("sales/east");
    const secondId = BotId.make("sales?east");
    const harness = makeHarness({ bots: [makeBot(firstId), makeBot(secondId)] });

    await connectChannel(harness.dependencies, telegramConnect(firstId, "token-1"));
    await connectChannel(harness.dependencies, telegramConnect(secondId, "token-2"));

    expect(harness.secrets.size).toBe(2);
    expect([...harness.secrets.keys()].every((name) => !name.includes("sales"))).toBe(true);
  });

  it("stops a new transport when reading the previous secret fails", async () => {
    const { store } = makeMemorySecretStore();
    let stops = 0;
    const harness = makeHarness({
      secretStore: { ...store, get: () => Effect.die(new Error("secret read failed")) },
      shutdown: async () => void (stops += 1),
    });

    await expect(connectChannel(harness.dependencies, telegramConnect(BOT_ID))).rejects.toThrow(
      "secret read failed",
    );

    expect(stops).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
  });

  it("keeps a connected runtime when removing its secret fails", async () => {
    const { store, values } = makeMemorySecretStore();
    let failRemove = false;
    let stops = 0;
    const harness = makeHarness({
      secretStore: {
        ...store,
        remove: (name) =>
          failRemove ? Effect.die(new Error("secret remove failed")) : store.remove(name),
      },
      shutdown: async () => void (stops += 1),
    });
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    failRemove = true;

    await expect(detachChannelConnection(harness.dependencies, BOT_ID, "telegram")).rejects.toThrow(
      "secret remove failed",
    );

    const binding = harness.readModel().bots[0]?.channelBindings?.[0];
    expect(binding?.status).toBe("connected");
    expect(binding && channelBindingsForRuntime([binding])).toEqual([binding]);
    expect(values.size).toBe(1);
    expect(stops).toBe(0);
  });

  it("restores the direct credential when unassign persistence fails", async () => {
    let stops = 0;
    const harness = makeHarness({
      failBotUpdate: (index) => (index === 2 ? new Error("binding write failed") : undefined),
      shutdown: async () => void (stops += 1),
    });
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    const credentials = [...harness.secrets.entries()];

    await expect(detachChannelConnection(harness.dependencies, BOT_ID, "telegram")).rejects.toThrow(
      "binding write failed",
    );

    expect([...harness.secrets.entries()]).toEqual(credentials);
    const binding = harness.readModel().bots[0]?.channelBindings[0];
    expect(binding?.status).toBe("connected");
    expect(binding && channelBindingsForRuntime([binding])).toEqual([binding]);
    expect(stops).toBe(0);
  });

  it("rejects one Telegram token bound to two active bots", async () => {
    const secondId = BotId.make("bot-2");
    const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    await expect(connectChannel(harness.dependencies, telegramConnect(secondId))).rejects.toThrow(
      "already connected",
    );
  });

  it("rejects one WhatsApp number bound to two active bots", async () => {
    const secondId = BotId.make("bot-2");
    const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
    await expect(connectChannel(harness.dependencies, whatsappConnect(secondId))).rejects.toThrow(
      "already connected",
    );
  });

  it("serializes concurrent WhatsApp identity claims", async () => {
    const secondId = BotId.make("bot-2");
    const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

    const results = await Promise.allSettled([
      connectChannel(harness.dependencies, whatsappConnect(BOT_ID)),
      connectChannel(harness.dependencies, whatsappConnect(secondId)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      harness
        .readModel()
        .bots.flatMap((bot) => bot.channelBindings ?? [])
        .filter((binding) => binding.provider === "whatsapp" && binding.status === "connected"),
    ).toHaveLength(1);
  });

  it.each([
    { status: 200, data: { ok: false, error: "missing_scope", detail: "secret-token" } },
    { status: 200, data: { ok: false, error: "channel_not_found" } },
    { status: 200, data: { ok: false, error: "invalid_auth" } },
    { status: 200, data: { ok: false, error: "ratelimited" } },
    { status: 429, data: {}, headers: { "retry-after": "1" } },
  ])(
    "retries a verified Slack API rejection through the shipped post wrapper: %j",
    async (response) => {
      const { harness, input } = makeAdapterDeliveryHarness("slack", "slack:C123:1");
      externalAdapters.slackResponses.push(response, { status: 200, data: { ok: true, ts: "2" } });
      await connectChannel(harness.dependencies, slackConnect(BOT_ID));
      expect(externalAdapters.slackRetryOptions).toEqual({
        retries: 0,
        rejectRateLimitedCalls: true,
      });
      const failedPost = sendChannelMessage(harness.dependencies, input);
      await expect(failedPost).rejects.toMatchObject({
        name: "ChannelPostRejectedError",
        message: "The channel rejected this reply. Correct the channel problem, then retry.",
      });
      await expect(failedPost).rejects.not.toHaveProperty("cause");
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).not.toContain(
        "secret-token",
      );
      await sendChannelMessage(harness.dependencies, input);
      await sendChannelMessage(harness.dependencies, input);
      expect(externalAdapters.slackPostRequests).toBe(2);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toBeUndefined();
    },
  );

  it.each([
    new Error("timeout with secret-token; channel_not_found"),
    { status: 200, data: { ok: false, error: "internal_error", detail: "secret-token" } },
    { status: 200, data: { ok: false, error: "request_timeout" } },
    { status: 503, data: "secret-token" },
  ])("retains an ambiguous Slack post without SDK retries: %j", async (response) => {
    const { harness, input } = makeAdapterDeliveryHarness("slack", "slack:C123:1");
    externalAdapters.slackResponses.push(response);
    await connectChannel(harness.dependencies, slackConnect(BOT_ID));
    const failedPost = sendChannelMessage(harness.dependencies, input);
    await expect(failedPost).rejects.toMatchObject({
      message:
        "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
    });
    await expect(failedPost).rejects.not.toHaveProperty("cause");
    await disconnectChannel(harness.dependencies, BOT_ID, "slack");
    expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toContain(
      "Check the channel",
    );
    await reconnectChannel(harness.dependencies, BOT_ID, "slack");
    expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toContain(
      "Check the channel",
    );
    await expect(sendChannelMessage(harness.dependencies, input)).rejects.toThrow(
      "unfinished delivery attempt",
    );
    expect(externalAdapters.slackPostRequests).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([]);
  });

  it.each([
    { status: 400, code: 50035 },
    { status: 401, code: 50014 },
    { status: 403, code: 50013 },
    { status: 404, code: 10003 },
    { status: 429, code: 20028 },
  ])(
    "retries a verified Discord API rejection through the shipped post wrapper: %j",
    async ({ status, code }) => {
      const { harness, input } = makeAdapterDeliveryHarness("discord", "discord:123:456");
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json({ code, message: "secret-token" }, { status }))
        .mockResolvedValueOnce(Response.json({ id: "discord-sent" }));
      vi.stubGlobal("fetch", fetch);
      await connectChannel(harness.dependencies, discordConnect(BOT_ID));
      await expect(sendChannelMessage(harness.dependencies, input)).rejects.toThrow(
        ChannelPostRejectedError,
      );
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).not.toContain(
        "secret-token",
      );
      await sendChannelMessage(harness.dependencies, input);
      await sendChannelMessage(harness.dependencies, input);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[0]).toBe("https://discord.com/api/v10/channels/456/messages");
    },
  );

  it.each([
    new Error("timeout secret-token; DiscordApiError 403"),
    { status: 503, body: { code: 50013, message: "secret-token" } },
    { status: 403, body: { message: "secret-token" } },
    { status: 400, body: { code: 99999, message: "secret-token" } },
    { status: 408, body: { code: 50035, message: "secret-token" } },
  ])(
    "retains an unverified Discord failure through the shipped post wrapper: %j",
    async (failure) => {
      const { harness, input } = makeAdapterDeliveryHarness("discord", "discord:123:456");
      const fetch = vi.fn<typeof globalThis.fetch>();
      if (failure instanceof Error) fetch.mockRejectedValue(failure);
      else fetch.mockResolvedValue(Response.json(failure.body, { status: failure.status }));
      vi.stubGlobal("fetch", fetch);
      await connectChannel(harness.dependencies, discordConnect(BOT_ID));
      await expect(sendChannelMessage(harness.dependencies, input)).rejects.toThrow(
        "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
      );
      await expect(sendChannelMessage(harness.dependencies, input)).rejects.toThrow(
        "unfinished delivery attempt",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([]);
    },
  );

  it.each([401, 403, 404, 429])(
    "retries a verified Telegram %i rejection through the shipped post wrapper",
    async (status) => {
      const { harness, input } = makeAdapterDeliveryHarness("telegram", "telegram:123");
      const sends = mockTelegramDelivery([
        Response.json({ ok: false, error_code: status, description: "secret-token" }, { status }),
        Response.json({
          ok: true,
          result: {
            message_id: 101,
            date: 1,
            chat: { id: 123, type: "private" },
            text: "Reply",
            from: { id: 1, is_bot: true, first_name: "Akeru" },
          },
        }),
      ]);
      await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      await expect(sendChannelMessage(harness.dependencies, input)).rejects.toThrow(
        ChannelPostRejectedError,
      );
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).not.toContain(
        "secret-token",
      );
      await sendChannelMessage(harness.dependencies, input);
      await sendChannelMessage(harness.dependencies, input);
      expect(sends).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    new Error("network timeout secret-token"),
    Response.json({ ok: false, error_code: 500, description: "secret-token" }, { status: 500 }),
    Response.json({ ok: false, error_code: 400, description: "secret-token" }, { status: 400 }),
  ])(
    "retains an unverified Telegram failure through the shipped post wrapper: %j",
    async (response) => {
      const { harness, input } = makeAdapterDeliveryHarness("telegram", "telegram:123");
      const sends = mockTelegramDelivery([response]);
      await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      await expect(sendChannelMessage(harness.dependencies, input)).rejects.toThrow(
        "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
      );
      await expect(sendChannelMessage(harness.dependencies, input)).rejects.toThrow(
        "unfinished delivery attempt",
      );
      expect(sends).toHaveBeenCalledTimes(1);
    },
  );

  it("retains a partial WhatsApp post when a later chunk is rejected", async () => {
    const { harness, input } = makeAdapterDeliveryHarness(
      "whatsapp",
      "whatsapp:phone-number-id:15551234567",
      "x".repeat(5000),
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ messages: [{ id: "first-chunk" }] }))
      .mockResolvedValueOnce(
        Response.json({ error: { code: 190, message: "secret-token" } }, { status: 401 }),
      );
    vi.stubGlobal("fetch", fetch);
    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
    await expect(sendChannelMessage(harness.dependencies, input)).rejects.toThrow(
      "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
    );
    await expect(sendChannelMessage(harness.dependencies, input)).rejects.toThrow(
      "unfinished delivery attempt",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([]);
  });

  it("retries a definite provider rejection and serializes concurrent approvals", async () => {
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
        if (posts === 1) throw new ChannelPostRejectedError("provider rejected secret-token");
      },
    });
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    const input = { botId: BOT_ID, threadId, messageId };
    await expect(sendChannelMessage(harness.dependencies, input)).rejects.toThrow(
      ChannelPostRejectedError,
    );
    expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toBe(
      "The channel rejected this reply. Correct the channel problem, then retry.",
    );
    await Promise.all(
      Array.from({ length: 8 }, () => sendChannelMessage(harness.dependencies, input)),
    );
    expect(posts).toBe(2);
    expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([messageId]);
  });

  it("serializes normal concurrent approvals with the delivery store as the authority", async () => {
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
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    const input = { botId: BOT_ID, threadId, messageId };
    await Promise.all(
      Array.from({ length: 8 }, () => sendChannelMessage(harness.dependencies, input)),
    );
    expect(posts).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([messageId]);
  });

  it("retains an ambiguous post after reconnect so explicit approval cannot repost", async () => {
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
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));

    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("timeout after remote acceptance");
    expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
      status: "connected",
      lastAttemptAt: NOW,
      lastError:
        "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
    });
    await shutdownAllChannels();
    await reconnectChannel(harness.dependencies, BOT_ID, "telegram");
    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("unfinished delivery attempt");
    expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toContain(
      "Check the channel",
    );
    expect(posts).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).not.toContain(
      messageId,
    );
  });

  it("releases a pre-transport failure so approval can retry after reconnect", async () => {
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
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    await shutdownAllChannels();

    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("needs reconnect");
    expect(posts).toBe(0);
    await reconnectChannel(harness.dependencies, BOT_ID, "telegram");
    await sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });
    expect(posts).toBe(1);
  });

  it("does not mark, release, or repost an unresolved failed delivery", async () => {
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
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));

    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("post failed");
    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("unfinished delivery attempt");

    expect(posts).toBe(1);
    expect(marks).toBe(0);
  });

  it("does not repost after transport succeeds and mark-sent fails", async () => {
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
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));

    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("database unavailable");
    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).resolves.toBeGreaterThan(0);
    expect(posts).toBe(1);
    expect(markAttempts).toBe(2);
  });

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
      yield* Effect.promise(() => connectChannel(harness.dependencies, telegramConnect(BOT_ID)));
      yield* Effect.promise(() =>
        sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
      );
      const deliveryStore = makeMemoryChannelDeliveryStore();
      const restored = { ...harness.dependencies, deliveryStore };
      yield* Effect.promise(() =>
        sendChannelMessage(restored, { botId: BOT_ID, threadId, messageId }),
      );
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

  it("fills the sent binding on retry after binding persistence fails", async () => {
    const messageId = MessageId.make("message-binding-retry");
    const threadId = ThreadId.make("thread-binding-retry");
    let posts = 0;
    const harness = makeHarness({
      failBotUpdate: (updateIndex) =>
        updateIndex === 2 ? new Error("binding persistence failed") : undefined,
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
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));

    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("binding persistence failed");
    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).resolves.toBeGreaterThan(0);

    expect(posts).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toContain(messageId);
  });

  it("bounds sent-message recovery metadata", async () => {
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
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));

    for (const messageId of assistantIds) {
      await sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });
    }

    const sent = harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds ?? [];
    expect(sent).toHaveLength(CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT);
    expect(sent).not.toContain(assistantIds[0]);
    expect(sent).toContain(assistantIds.at(-1));
    await sendChannelMessage(harness.dependencies, {
      botId: BOT_ID,
      threadId,
      messageId: assistantIds[0]!,
    });
    expect(posts).toBe(assistantIds.length);
    expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toHaveLength(
      CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT,
    );
  });
});

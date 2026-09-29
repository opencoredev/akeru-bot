import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

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
  type OrchestrationEvent,
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as FiberSet from "effect/FiberSet";
import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";

const photon = vi.hoisted(() => ({
  adapter: null as iMessageAdapter | null,
  chat: null as ChatInstance | null,
  failedSubscription: null as string | null,
  gatewayError: null as Error | null,
  gatewayStatus: 200,
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
        if (photon.gatewayError) throw photon.gatewayError;
        waitUntil?.(
          new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        );
        return new Response(null, { status: photon.gatewayStatus });
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
  CHANNEL_GATEWAY_RENEWAL_INTERVAL,
  CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT,
  ChannelPostRejectedError,
  ChannelRuntime,
  channelBindingsForRuntime as channelBindingsWith,
  channelFailureMessage,
  channelFailurePresentation,
  channelThreadId,
  ignoredInbound,
  makeKeyedLock,
  mentionWithContext,
  startRenewingGateway,
  type ChannelRuntimeDependencies,
  type ChannelRuntimeShape,
} from "./ChannelRuntime.ts";

/**
 * Each harness gets its own ChannelRuntime service, built into the current test's scope
 * on first use so the test owns cleanup. The helpers below return Effects; helpers without
 * a dependency argument use the most recently built service.
 */
const channelRuntimes = new Map<
  ChannelRuntimeDependencies,
  Deferred.Deferred<ChannelRuntimeShape>
>();
let latestChannelRuntime: ChannelRuntimeShape | undefined;

// Registers the build synchronously so concurrent operations on one harness share a service.
const channelRuntimeFor = (dependencies: ChannelRuntimeDependencies) =>
  Effect.gen(function* () {
    const existing = channelRuntimes.get(dependencies);
    if (existing) {
      const runtime = yield* Deferred.await(existing);
      latestChannelRuntime = runtime;
      return runtime;
    }
    const built = Deferred.makeUnsafe<ChannelRuntimeShape>();
    channelRuntimes.set(dependencies, built);
    const scope = yield* Scope.Scope;
    const context = yield* Layer.buildWithScope(ChannelRuntime.layerWith(dependencies), scope);
    const runtime = Context.get(context, ChannelRuntime);
    yield* Deferred.succeed(built, runtime);
    latestChannelRuntime = runtime;
    return runtime;
  });

const latestRuntime = () => {
  if (!latestChannelRuntime) throw new Error("No channel runtime was built in this test.");
  return latestChannelRuntime;
};

const runWith = <A, E>(
  dependencies: ChannelRuntimeDependencies,
  use: (runtime: ChannelRuntimeShape) => Effect.Effect<A, E>,
) => channelRuntimeFor(dependencies).pipe(Effect.flatMap(use));

/** The error a failed effect rejects with under a promise runner, or a defect on success. */
const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.flatMap((exit) =>
      Exit.isFailure(exit)
        ? Effect.succeed(Cause.squash(exit.cause))
        : Effect.die(new Error("Expected the effect to fail, but it succeeded.")),
    ),
  );

/** Asserts that an effect fails with an error whose message contains `message`. */
const expectFailureMessage = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  failureOf(effect).pipe(
    Effect.map((error) =>
      expect(error).toMatchObject({ message: expect.stringContaining(message) }),
    ),
  );

/**
 * Asserts that a provider SDK failure surfaces only as fixed text. The raw SDK message stays on
 * the server-side cause and never reaches the error message or the client presentation.
 */
const expectProviderFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  sdkText: string,
  category: "credentials" | "network" = "credentials",
) =>
  failureOf(effect).pipe(
    Effect.map((error) => {
      const presentation = channelFailurePresentation(error);
      expect(presentation).toEqual({
        message: channelFailureMessage(category),
        category,
      });
      expect(error).toMatchObject({ message: expect.not.stringContaining(sdkText) });
      expect(JSON.stringify(presentation)).not.toContain(sdkText);
    }),
  );

type ConnectInput = Parameters<ChannelRuntimeShape["connect"]>[0];
type SaveInput = Parameters<ChannelRuntimeShape["saveConnection"]>[0];
type Provider = Parameters<ChannelRuntimeShape["disconnect"]>[1];
type InboundInput = Parameters<ChannelRuntimeShape["dispatchInbound"]>[0];
type ReplyTarget = Parameters<ChannelRuntimeShape["sendChannelMessage"]>[0];

const connectChannel = (dependencies: ChannelRuntimeDependencies, input: ConnectInput) =>
  runWith(dependencies, (runtime) => runtime.connect(input));
const saveChannelConnection = (dependencies: ChannelRuntimeDependencies, input: SaveInput) =>
  runWith(dependencies, (runtime) => runtime.saveConnection(input));
const deleteChannelConnection = (
  dependencies: ChannelRuntimeDependencies,
  connectionId: ChannelConnectionId,
) => runWith(dependencies, (runtime) => runtime.deleteConnection(connectionId));
const attachChannelConnection = (
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  connectionId: ChannelConnectionId,
  projectId: ProjectId,
  provider: Provider,
) => runWith(dependencies, (runtime) => runtime.attach(botId, connectionId, projectId, provider));
const changeChannelProject = (
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  provider: Provider,
  projectId: ProjectId,
) => runWith(dependencies, (runtime) => runtime.changeProject(botId, provider, projectId));
const disconnectChannel = (
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  provider: Provider,
) => runWith(dependencies, (runtime) => runtime.disconnect(botId, provider));
const detachChannelConnection = (
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  provider: Provider,
) => runWith(dependencies, (runtime) => runtime.detach(botId, provider));
const reconnectChannel = (
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  provider: Provider,
) => runWith(dependencies, (runtime) => runtime.reconnect(botId, provider));
const restoreConnectedChannels = (dependencies: ChannelRuntimeDependencies) =>
  runWith(dependencies, (runtime) => runtime.restoreConnectedChannels);
const dispatchInboundChannelMessage = (
  dependencies: ChannelRuntimeDependencies,
  input: InboundInput,
) => runWith(dependencies, (runtime) => runtime.dispatchInbound(input));
const sendChannelMessage = (dependencies: ChannelRuntimeDependencies, input: ReplyTarget) =>
  runWith(dependencies, (runtime) => runtime.sendChannelMessage(input));
const sendCompletedChannelReply = (
  dependencies: ChannelRuntimeDependencies,
  threadId: ThreadId,
  turnId: TurnId,
) => runWith(dependencies, (runtime) => runtime.sendCompletedChannelReply(threadId, turnId));
const finishChannelTurn = (
  dependencies: ChannelRuntimeDependencies,
  threadId: ThreadId,
  turnId: TurnId | undefined,
  state: "completed" | "failed" | "cancelled",
  requestMessageId?: MessageId,
) =>
  runWith(dependencies, (runtime) =>
    runtime.finishChannelTurn(threadId, turnId, state, requestMessageId),
  );
const stopChannelsForBot = (botId: BotId) =>
  Effect.suspend(() => latestRuntime().stopChannelsForBot(botId));
const clearChannelThreadStatuses = (threadId: ThreadId) =>
  Effect.suspend(() => latestRuntime().clearChannelThreadStatuses(threadId));
const handleWhatsAppWebhook = (botId: BotId, request: Request) =>
  Effect.suspend(() => latestRuntime().handleWhatsAppWebhook(botId, request));
const shutdownAllChannels = () => Effect.suspend(() => latestRuntime().shutdown);
const stopArchivedBotChannels = (events: Stream.Stream<OrchestrationEvent>) =>
  Effect.suspend(() => latestRuntime().stopArchivedBotChannels(events));
const channelBindingsForRuntime = (bindings: ReadonlyArray<ChannelBinding>) =>
  latestRuntime().channelBindingsForRuntime(bindings);

/**
 * A gateway listener that runs until its abort signal fires, then waits for `cleanup`.
 * Each start is offered to `starts`, so tests wait on the receipt instead of polling.
 */
const makeGatewayListener = (cleanup: Promise<void> = Promise.resolve()) =>
  Effect.gen(function* () {
    const starts = yield* Queue.unbounded<{
      readonly signal: AbortSignal;
      readonly durationMs: number;
    }>();
    const start: Parameters<typeof startRenewingGateway>[0] = async (
      waitUntil,
      durationMs,
      signal,
    ) => {
      waitUntil(
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => void cleanup.then(resolve), { once: true });
        }),
      );
      Queue.offerUnsafe(starts, { signal, durationMs });
      return new Response(null, { status: 200 });
    };
    return { starts, start };
  });

/** Starts a renewing gateway in the test scope, with a promise-shaped shutdown for fake transports. */
const startTestGateway = (...args: Parameters<typeof startRenewingGateway>) =>
  Effect.gen(function* () {
    const gateway = yield* startRenewingGateway(...args);
    const runInTest = yield* FiberSet.makeRuntimePromise();
    return {
      isHealthy: gateway.isHealthy,
      settled: gateway.settled,
      shutdown: () => runInTest(gateway.shutdown),
    };
  });

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
    imageProvider: null,
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
  author: { readonly isBot?: boolean | "unknown"; readonly isMe?: boolean } = {},
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
      isBot: author.isBot ?? false,
      isMe: author.isMe ?? false,
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
  readonly onBindings?: (bindings: ReadonlyArray<ChannelBinding>) => void;
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
        input.onBindings?.(channelBindings);
      }
      if (command.type === "thread.create") {
        threads.push(makeThread(command.threadId, command.botId!, []));
        model = { ...model, threads };
      }
      return { sequence };
    });
  const engine = {
    readEvents: () => Stream.empty,
    readThreadEvents: () => Stream.empty,
    getThreadReplayStats: () => Effect.die("unused thread replay stats"),
    dispatch,
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
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
    readModel: Effect.sync(() => ({
      ...model,
      threads: input.commandModelOmitsMessages
        ? threads.map((thread) => ({ ...thread, messages: [] }))
        : threads,
    })),
    readThread: (threadId) =>
      Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
    nowIso: Effect.succeed(NOW),
    randomUuid: Effect.sync(() => `uuid-${commands.length}`),
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
  const archive = (botId: BotId) => {
    model = {
      ...model,
      bots: model.bots.map((bot) => (bot.id === botId ? { ...bot, archivedAt: NOW } : bot)),
    };
  };
  return {
    commands,
    dependencies,
    secrets,
    archive,
    readModel: () => model,
    readSettings: () => settings,
  };
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

afterEach(() => {
  channelRuntimes.clear();
  latestChannelRuntime = undefined;
  photon.adapter = null;
  photon.chat = null;
  photon.failedSubscription = null;
  photon.gatewayError = null;
  photon.gatewayStatus = 200;
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
  it.effect("serializes work per key in FIFO order while different keys overlap", () =>
    Effect.gen(function* () {
      const withLock = makeKeyedLock();
      const events: string[] = [];
      const releaseFirst = yield* Deferred.make<void>();
      const firstStarted = yield* Deferred.make<void>();
      const first = yield* withLock("same")(
        Effect.gen(function* () {
          events.push("same:start");
          yield* Deferred.succeed(firstStarted, undefined);
          yield* Deferred.await(releaseFirst);
          events.push("same:end");
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const second = yield* withLock("same")(
        Effect.sync(() => void events.push("same:second")),
      ).pipe(Effect.forkChild);
      const third = yield* withLock("same")(Effect.sync(() => void events.push("same:third"))).pipe(
        Effect.forkChild,
      );
      yield* withLock("other")(Effect.sync(() => void events.push("other")));
      expect(events).toEqual(["same:start", "other"]);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(third);
      expect(events).toEqual(["same:start", "other", "same:end", "same:second", "same:third"]);
    }),
  );

  it.effect("lets a queued caller be interrupted without blocking later callers", () =>
    Effect.gen(function* () {
      const withLock = makeKeyedLock();
      const events: string[] = [];
      const releaseFirst = yield* Deferred.make<void>();
      const firstStarted = yield* Deferred.make<void>();
      const first = yield* withLock("same")(
        Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.andThen(Effect.sync(() => void events.push("first"))),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const abandoned = yield* withLock("same")(
        Effect.sync(() => void events.push("abandoned")),
      ).pipe(Effect.forkChild);
      const last = yield* withLock("same")(Effect.sync(() => void events.push("last"))).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      expect(abandoned.pollUnsafe()).toBeUndefined();
      // Interrupting must not wait for the key the first caller still holds.
      yield* Fiber.interrupt(abandoned);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(last);
      expect(events).toEqual(["first", "last"]);
    }),
  );

  it("keeps ChannelPostRejectedError typed and message-safe", () => {
    const error = new ChannelPostRejectedError({ message: "rejected" });
    expect(error._tag).toBe("ChannelPostRejectedError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("rejected");
  });

  it.effect("shuts down active transports when the service scope closes", () =>
    Effect.gen(function* () {
      const shutdown = vi.fn(async () => undefined);
      const harness = makeHarness({ shutdown });
      yield* Effect.gen(function* () {
        const runtime = yield* ChannelRuntime;
        yield* runtime.connect(telegramConnect(BOT_ID));
        expect(shutdown).not.toHaveBeenCalled();
      }).pipe(Effect.provide(ChannelRuntime.layerWith(harness.dependencies)));
      expect(shutdown).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("keeps independent runtime scopes isolated", () =>
    Effect.gen(function* () {
      const firstShutdown = vi.fn(async () => undefined);
      const secondShutdown = vi.fn(async () => undefined);
      const first = makeHarness({ shutdown: firstShutdown });
      const second = makeHarness({ shutdown: secondShutdown });
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const build = (dependencies: ChannelRuntimeDependencies, scope: Scope.Scope) =>
        Layer.buildWithScope(ChannelRuntime.layerWith(dependencies), scope).pipe(
          Effect.map((context) => Context.get(context, ChannelRuntime)),
        );
      const firstRuntime = yield* build(first.dependencies, firstScope);
      const secondRuntime = yield* build(second.dependencies, secondScope);
      yield* firstRuntime.connect(telegramConnect(BOT_ID));
      yield* secondRuntime.connect(telegramConnect(BOT_ID));

      yield* Scope.close(firstScope, Exit.void);
      expect(firstShutdown).toHaveBeenCalledTimes(1);
      expect(secondShutdown).not.toHaveBeenCalled();
      expect(
        secondRuntime.channelBindingsForRuntime(second.readModel().bots[0]!.channelBindings),
      ).toMatchObject([{ status: "connected" }]);

      yield* Scope.close(secondScope, Exit.void);
      expect(secondShutdown).toHaveBeenCalledTimes(1);
    }),
  );

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
          `remove:${prefix}:white_check_mark`,
          `remove:${prefix}:x`,
        ]);
        yield* finishChannelTurn(harness.dependencies, threadId, turnId, "completed");
        expect(externalAdapters.reactions.at(-1)).toBe(`add:${prefix}:white_check_mark`);
        const count = externalAdapters.reactions.length;
        yield* finishChannelTurn(harness.dependencies, threadId, turnId, "completed");
        expect(externalAdapters.reactions).toHaveLength(count);
        yield* clearChannelThreadStatuses(threadId);
        expect(externalAdapters.reactions.slice(-3)).toEqual([
          `remove:${prefix}:eyes`,
          `remove:${prefix}:white_check_mark`,
          `remove:${prefix}:x`,
        ]);
        yield* finishChannelTurn(harness.dependencies, threadId, turnId, "failed");
        expect(externalAdapters.reactions.at(-1)).toBe(`add:${prefix}:x`);
        yield* disconnectChannel(harness.dependencies, BOT_ID, provider);
        expect(externalAdapters.reactions.slice(-3)).toEqual([
          `remove:${prefix}:eyes`,
          `remove:${prefix}:white_check_mark`,
          `remove:${prefix}:x`,
        ]);
        externalAdapters.reactions.length = 0;
        yield* reconnectChannel(harness.dependencies, BOT_ID, provider);
        expect(externalAdapters.reactions).toEqual([
          `remove:${prefix}:eyes`,
          `remove:${prefix}:white_check_mark`,
          `remove:${prefix}:x`,
        ]);
      }),
  );

  it.effect("exposes gateway failure in runtime channel health", () =>
    Effect.gen(function* () {
      const failed = Promise.withResolvers<void>();
      const gateway = yield* startTestGateway(async (waitUntil) => {
        waitUntil(failed.promise);
        return new Response(null, { status: 200 });
      }, "Test gateway");
      const harness = makeHarness({
        startTransport: async () => ({
          externalIdentity: "test",
          runtime: {
            post: async () => {},
            shutdown: gateway.shutdown,
            isHealthy: gateway.isHealthy,
          },
        }),
      });
      yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));
      const bindings = harness.readModel().bots[0]!.channelBindings;
      expect(channelBindingsForRuntime(bindings)[0]?.status).toBe("connected");
      failed.reject(new Error("Gateway disconnected"));
      yield* gateway.settled;
      expect(channelBindingsForRuntime(bindings)[0]?.status).toBe("needs-reconnect");
    }),
  );

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

  it.effect("attaches to the project the client names", () =>
    Effect.gen(function* () {
      const connectionId = ChannelConnectionId.make("channel-default-project");
      const harness = makeHarness({
        startTransport: async () => ({
          externalIdentity: "@bot",
          runtime: { post: async () => {}, shutdown: async () => {} },
        }),
      });
      yield* saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-default-project"),
        connectionId,
        name: "Default project line",
        provider: "telegram",
        token: "telegram-token",
      });

      yield* attachChannelConnection(
        harness.dependencies,
        BOT_ID,
        connectionId,
        PROJECT_ID,
        "telegram",
      );

      expect(harness.readModel().bots[0]?.channelBindings?.[0]).toMatchObject({
        connectionId,
        status: "connected",
        projectId: PROJECT_ID,
      });
    }),
  );

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

  it.effect("blocks the binding when its selected project is unavailable", () =>
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
      const harness = makeHarness({ bots: [makeBot(BOT_ID, { channelBindings: [binding] })] });

      yield* expectFailureMessage(
        dispatchInboundChannelMessage(harness.dependencies, {
          botId: BOT_ID,
          projectId: MISSING_PROJECT_ID,
          provider: "telegram",
          externalThreadId: "chat-missing-project",
          externalMessageId: "message-missing-project",
          text: "Work",
        }),
        "project is unavailable",
      );
      expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
        status: "blocked",
        lastError: "The selected project is unavailable. Choose another project.",
      });
    }),
  );

  describe("changeChannelProject", () => {
    const changeProjectConnectionId = ChannelConnectionId.make("telegram-change-project");
    const saveConnection = (harness: ReturnType<typeof makeHarness>) =>
      saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-change-project"),
        connectionId: changeProjectConnectionId,
        name: "Change project line",
        provider: "telegram",
        token: "telegram-token",
      });
    // Legacy per-bot credentials let a test seed a binding before any connection exists.
    const seedLegacySecret = (harness: ReturnType<typeof makeHarness>) =>
      harness.secrets.set(
        `channel-telegram-${NodeCrypto.createHash("sha256").update(BOT_ID).digest("hex")}`,
        new TextEncoder().encode(JSON.stringify({ provider: "telegram", token: "telegram-token" })),
      );
    const legacyBindingOn = (
      projectId: ProjectId,
      status: ChannelBinding["status"],
    ): ChannelBinding => ({
      botId: BOT_ID,
      projectId,
      provider: "telegram",
      status,
      externalIdentity: "@akeru",
      connectedAt: status === "connected" ? NOW : null,
      sentMessageIds: [],
    });

    it.effect("moves a blocked binding to a live project and reconnects it", () =>
      Effect.gen(function* () {
        const starts: Array<ProjectId> = [];
        const harness = makeHarness({
          bots: [
            makeBot(BOT_ID, {
              channelBindings: [
                {
                  ...legacyBindingOn(MISSING_PROJECT_ID, "blocked"),
                  lastError: "The selected project is unavailable. Choose another project.",
                },
              ],
            }),
          ],
          startTransport: async (input) => {
            starts.push(input.targetProjectId);
            return {
              externalIdentity: "@akeru",
              runtime: { post: async () => undefined, shutdown: async () => undefined },
            };
          },
        });
        seedLegacySecret(harness);

        yield* changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID);

        expect(starts).toEqual([SECOND_PROJECT_ID]);
        const binding = harness.readModel().bots[0]?.channelBindings[0];
        expect(binding).toMatchObject({
          projectId: SECOND_PROJECT_ID,
          status: "connected",
        });
        expect(binding?.lastError).toBeUndefined();
      }),
    );

    it.effect("rejects an unavailable target without touching the running channel", () =>
      Effect.gen(function* () {
        let stops = 0;
        const harness = makeHarness({ shutdown: async () => void (stops += 1) });
        yield* saveConnection(harness);
        yield* attachChannelConnection(
          harness.dependencies,
          BOT_ID,
          changeProjectConnectionId,
          PROJECT_ID,
          "telegram",
        );
        const before = harness.readModel().bots[0]?.channelBindings[0];

        yield* expectFailureMessage(
          changeChannelProject(harness.dependencies, BOT_ID, "telegram", MISSING_PROJECT_ID),
          "The selected project is unavailable. Choose another project.",
        );

        expect(stops).toBe(0);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toEqual(before);
        yield* stopChannelsForBot(BOT_ID);
      }),
    );

    it.effect("leaves a running channel alone when the target is its current project", () =>
      Effect.gen(function* () {
        let stops = 0;
        const harness = makeHarness({ shutdown: async () => void (stops += 1) });
        yield* saveConnection(harness);
        yield* attachChannelConnection(
          harness.dependencies,
          BOT_ID,
          changeProjectConnectionId,
          PROJECT_ID,
          "telegram",
        );
        const before = harness.readModel().bots[0]?.channelBindings[0];

        yield* changeChannelProject(harness.dependencies, BOT_ID, "telegram", PROJECT_ID);

        expect(stops).toBe(0);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toEqual(before);
        yield* stopChannelsForBot(BOT_ID);
      }),
    );

    it.effect("rejects missing credentials without stopping the running channel", () =>
      Effect.gen(function* () {
        let stops = 0;
        const harness = makeHarness({ shutdown: async () => void (stops += 1) });
        yield* saveConnection(harness);
        yield* attachChannelConnection(
          harness.dependencies,
          BOT_ID,
          changeProjectConnectionId,
          PROJECT_ID,
          "telegram",
        );
        harness.secrets.clear();

        yield* expectFailureMessage(
          changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID),
          "No saved telegram credentials.",
        );

        expect(stops).toBe(0);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          projectId: PROJECT_ID,
          status: "connected",
        });
        yield* stopChannelsForBot(BOT_ID);
      }),
    );

    it.effect("keeps the previous project when the new runtime fails after the old one stops", () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const harness = makeHarness({
          startTransport: async (input) => {
            if (input.targetProjectId === SECOND_PROJECT_ID) {
              events.push(`fail:${input.targetProjectId}`);
              throw new Error("transport refused");
            }
            events.push(`start:${input.targetProjectId}`);
            return {
              externalIdentity: "@akeru",
              runtime: {
                post: async () => undefined,
                shutdown: async () => void events.push(`stop:${input.targetProjectId}`),
              },
            };
          },
        });
        yield* saveConnection(harness);
        yield* attachChannelConnection(
          harness.dependencies,
          BOT_ID,
          changeProjectConnectionId,
          PROJECT_ID,
          "telegram",
        );

        yield* expectProviderFailure(
          changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID),
          "transport refused",
        );

        expect(events).toEqual([
          `start:${PROJECT_ID}`,
          `stop:${PROJECT_ID}`,
          `fail:${SECOND_PROJECT_ID}`,
          `start:${PROJECT_ID}`,
        ]);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          projectId: PROJECT_ID,
          status: "connected",
        });
        yield* stopChannelsForBot(BOT_ID);
      }),
    );

    it.effect("keeps the old listener reachable when shutdown prevents a project move", () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const callbacks: Array<
          Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1]
        > = [];
        let shutdownFails = true;
        const harness = makeHarness({
          startTransport: async (input, onDirectMessage) => {
            events.push(`start:${input.targetProjectId}`);
            callbacks.push(onDirectMessage);
            return {
              externalIdentity: "@akeru",
              runtime: {
                post: async () => undefined,
                shutdown: async () => {
                  events.push(`stop:${input.targetProjectId}`);
                  if (shutdownFails) throw new Error("shutdown failed");
                },
              },
            };
          },
        });
        yield* saveConnection(harness);
        yield* attachChannelConnection(
          harness.dependencies,
          BOT_ID,
          changeProjectConnectionId,
          PROJECT_ID,
          "telegram",
        );
        const before = harness.readModel().bots[0]?.channelBindings[0];
        const sequenceBefore = harness.readModel().snapshotSequence;

        yield* expectFailureMessage(
          changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID),
          "Channel provider request failed.",
        );

        expect(events).toEqual([`start:${PROJECT_ID}`, `stop:${PROJECT_ID}`]);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toEqual(before);
        expect(harness.readModel().snapshotSequence).toBe(sequenceBefore);
        const message = {
          externalThreadId: "telegram:failed-project-move",
          externalMessageId: "still-reachable",
          text: "Use the original project",
        };
        yield* Effect.promise(async () => callbacks[0]?.(message));
        expect(
          harness.commands.filter((command) => command.type === "thread.turn.start"),
        ).toHaveLength(1);
        expect(harness.readModel().threads[0]?.projectId).toBe(PROJECT_ID);

        shutdownFails = false;
        yield* shutdownAllChannels();
        expect(events).toEqual([`start:${PROJECT_ID}`, `stop:${PROJECT_ID}`, `stop:${PROJECT_ID}`]);
        yield* Effect.promise(async () =>
          callbacks[0]?.({ ...message, externalMessageId: "after-shutdown" }),
        );
        expect(
          harness.commands.filter((command) => command.type === "thread.turn.start"),
        ).toHaveLength(1);
        yield* shutdownAllChannels();
        expect(events).toHaveLength(3);
      }),
    );

    it.effect("records a failure on the previous project when neither runtime starts", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          bots: [
            makeBot(BOT_ID, {
              channelBindings: [legacyBindingOn(MISSING_PROJECT_ID, "blocked")],
            }),
          ],
          startTransport: async () => {
            throw new Error("transport refused");
          },
        });
        seedLegacySecret(harness);

        yield* expectProviderFailure(
          changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID),
          "transport refused",
        );

        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          projectId: MISSING_PROJECT_ID,
          status: "blocked",
          connectedAt: null,
          lastError: "Could not start the channel in the selected project. Try again.",
        });
      }),
    );
  });

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

  it.effect("verifies WhatsApp webhook challenges", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ startTransport: null });
      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));

      const accepted = yield* handleWhatsAppWebhook(
        BOT_ID,
        new Request(
          `https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123`,
        ),
      );
      const rejected = yield* handleWhatsAppWebhook(
        BOT_ID,
        new Request(
          `https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123`,
        ),
      );

      expect(accepted.status).toBe(200);
      expect(yield* Effect.promise(() => accepted.text())).toBe("challenge-123");
      expect(rejected.status).toBe(403);
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

  it.effect("shuts down an adapter when chat initialization fails", () =>
    Effect.gen(function* () {
      externalAdapters.slackInitializationFails = true;
      const harness = makeHarness({ startTransport: null });

      yield* expectProviderFailure(
        connectChannel(harness.dependencies, slackConnect(BOT_ID)),
        "Socket startup failed",
      );

      expect(externalAdapters.slackDisconnects).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
      expect(harness.secrets.size).toBe(0);
    }),
  );

  it.effect("rejects Slack credentials that cannot resolve the bot identity", () =>
    Effect.gen(function* () {
      externalAdapters.slackIdentityAvailable = false;
      const harness = makeHarness({ startTransport: null });

      yield* expectFailureMessage(
        connectChannel(harness.dependencies, slackConnect(BOT_ID)),
        "Slack bot credentials are invalid",
      );
      expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
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

  it.effect("owns and aborts renewable Gateway listeners", () =>
    Effect.gen(function* () {
      const listener = yield* makeGatewayListener();
      const gateway = yield* startRenewingGateway(listener.start, "Test gateway");
      const first = yield* Queue.take(listener.starts);

      expect(first.durationMs).toBe(Duration.toMillis(CHANNEL_GATEWAY_RENEWAL_INTERVAL));
      expect(first.signal.aborted).toBe(false);
      yield* gateway.shutdown;
      expect(first.signal.aborted).toBe(true);
      expect(gateway.isHealthy()).toBe(false);
    }),
  );

  it.effect("renews the gateway listener at each renewal deadline", () =>
    Effect.gen(function* () {
      const listener = yield* makeGatewayListener();
      const scope = yield* Scope.make();
      const gateway = yield* startRenewingGateway(listener.start, "Test gateway").pipe(
        Scope.provide(scope),
      );
      const first = yield* Queue.take(listener.starts);

      yield* TestClock.adjust(
        Duration.subtract(CHANNEL_GATEWAY_RENEWAL_INTERVAL, Duration.millis(1)),
      );
      expect(yield* Queue.size(listener.starts)).toBe(0);
      yield* TestClock.adjust(Duration.millis(1));
      const second = yield* Queue.take(listener.starts);
      // The listener that outlived its deadline stops before the next one starts.
      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(false);
      expect(gateway.isHealthy()).toBe(true);
      yield* TestClock.adjust(CHANNEL_GATEWAY_RENEWAL_INTERVAL);
      yield* Queue.take(listener.starts);
      expect(gateway.isHealthy()).toBe(true);

      // Closing the owning scope stops renewal.
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(Duration.times(CHANNEL_GATEWAY_RENEWAL_INTERVAL, 2));
      expect(yield* Queue.size(listener.starts)).toBe(0);
    }),
  );

  it.effect("waits for gateway cleanup before shutdown completes", () =>
    Effect.gen(function* () {
      const cleanup = Promise.withResolvers<void>();
      const listener = yield* makeGatewayListener(cleanup.promise);
      const gateway = yield* startRenewingGateway(listener.start, "Test gateway");
      const { signal } = yield* Queue.take(listener.starts);
      const aborted = yield* Deferred.make<void>();
      signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Effect.void), {
        once: true,
      });

      const shutdown = yield* gateway.shutdown.pipe(Effect.forkChild);
      yield* Deferred.await(aborted);
      expect(shutdown.pollUnsafe()).toBeUndefined();
      expect(gateway.isHealthy()).toBe(false);
      cleanup.resolve();
      yield* Fiber.join(shutdown);
    }),
  );

  it.effect("fails when the first gateway listener cannot launch", () =>
    Effect.gen(function* () {
      let starts = 0;
      const exit = yield* startRenewingGateway(async () => {
        starts += 1;
        return new Response(null, { status: 503 });
      }, "Test gateway").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      yield* TestClock.adjust(Duration.times(CHANNEL_GATEWAY_RENEWAL_INTERVAL, 2));
      expect(starts).toBe(1);
    }),
  );

  it.effect("marks an early gateway exit unhealthy instead of restarting it", () =>
    Effect.gen(function* () {
      let starts = 0;
      const gateway = yield* startRenewingGateway(async (waitUntil) => {
        starts += 1;
        waitUntil(Promise.resolve());
        return new Response(null, { status: 200 });
      }, "Test gateway");
      yield* gateway.settled;
      expect(gateway.isHealthy()).toBe(false);
      yield* TestClock.adjust(Duration.times(CHANNEL_GATEWAY_RENEWAL_INTERVAL, 2));
      expect(starts).toBe(1);
      yield* gateway.shutdown;
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

  it.effect("shuts down Discord when credential validation fails", () =>
    Effect.gen(function* () {
      externalAdapters.discordIdentityFails = true;
      const harness = makeHarness({ startTransport: null });

      yield* expectProviderFailure(
        connectChannel(harness.dependencies, discordConnect(BOT_ID)),
        "Discord identity failed",
      );

      expect(externalAdapters.discordDisconnects).toBe(1);
      expect(externalAdapters.discordGatewayStarts).toBe(0);
      expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
      expect(harness.secrets.size).toBe(0);
    }),
  );

  it.effect("starts and stops the supervised Discord Gateway", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ startTransport: null });
      yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));

      expect(externalAdapters.discordGatewayStarts).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
        projectId: PROJECT_ID,
        provider: "discord",
        status: "connected",
      });

      yield* disconnectChannel(harness.dependencies, BOT_ID, "discord");
      expect(harness.readModel().bots[0]?.channelBindings[0]?.status).toBe("disconnected");
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

  for (const operation of [disconnectChannel, detachChannelConnection]) {
    it.effect(`ignores inbound messages when ${operation.name} shutdown fails`, () =>
      Effect.gen(function* () {
        const callbacks: Array<
          Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1]
        > = [];
        let shutdownFails = true;
        const shutdown = vi.fn(async () => {
          if (shutdownFails) throw new Error("shutdown failed");
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
          "shutdown failed",
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

        shutdownFails = false;
        yield* stopChannelsForBot(BOT_ID);
        expect(shutdown).toHaveBeenCalledTimes(2);
        yield* stopChannelsForBot(BOT_ID);
        expect(shutdown).toHaveBeenCalledTimes(2);
      }),
    );
  }

  it.effect("saves, attaches, reconnects, detaches, and deletes a reusable connection", () =>
    Effect.gen(function* () {
      const connectionId = ChannelConnectionId.make("telegram-main");
      const harness = makeHarness({});

      yield* saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-connection"),
        connectionId,
        name: "Main Telegram",
        provider: "telegram",
        token: "telegram-token",
      });
      yield* attachChannelConnection(
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

      yield* expectFailureMessage(
        saveChannelConnection(harness.dependencies, {
          type: "channel.connection.save",
          commandId: CommandId.make("edit-attached-connection"),
          connectionId,
          name: "Changed Telegram",
          provider: "telegram",
          token: "changed-token",
        }),
        "Unassign this channel before editing it",
      );

      yield* expectFailureMessage(
        deleteChannelConnection(harness.dependencies, connectionId),
        "Unassign this channel",
      );
      yield* stopChannelsForBot(BOT_ID);
      yield* reconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* disconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* reconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* disconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* expectFailureMessage(
        deleteChannelConnection(harness.dependencies, connectionId),
        "Unassign this channel before deleting it",
      );
      yield* detachChannelConnection(harness.dependencies, BOT_ID, "telegram");
      expect(harness.secrets.size).toBe(1);
      yield* deleteChannelConnection(harness.dependencies, connectionId);
      expect(harness.secrets.size).toBe(0);
      expect(harness.readSettings().channelConnections).toEqual([]);
    }),
  );

  it.effect("serializes multiple reusable connection profiles", () =>
    Effect.gen(function* () {
      const telegramId = ChannelConnectionId.make("telegram-work");
      const photonId = ChannelConnectionId.make("photon-personal");
      const harness = makeHarness({});

      yield* Effect.all(
        [
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
        ],
        { concurrency: "unbounded" },
      );

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
    }),
  );

  it.effect("stores a safe dashboard link for hosted Photon", () =>
    Effect.gen(function* () {
      const connectionId = ChannelConnectionId.make("photon-hosted");
      const harness = makeHarness({});

      yield* saveChannelConnection(harness.dependencies, {
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
      // @effect-diagnostics-next-line preferSchemaOverJson:off - scans the persisted settings text.
      expect(JSON.stringify(harness.readSettings().channelConnections)).not.toContain(
        "never-in-settings",
      );
    }),
  );

  it.effect("rolls back a saved secret when profile persistence fails", () =>
    Effect.gen(function* () {
      const connectionId = ChannelConnectionId.make("failed-profile");
      const harness = makeHarness({
        settings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.die(new Error("settings write failed")),
        },
      });

      yield* expectFailureMessage(
        saveChannelConnection(harness.dependencies, {
          type: "channel.connection.save",
          commandId: CommandId.make("save-failed-profile"),
          connectionId,
          name: "Failed profile",
          provider: "telegram",
          token: "telegram-token",
        }),
        "settings write failed",
      );
      expect(harness.secrets.size).toBe(0);
    }),
  );

  it.effect("restores saved WhatsApp credentials", () =>
    Effect.gen(function* () {
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

      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
      yield* stopChannelsForBot(BOT_ID);
      yield* restoreConnectedChannels(harness.dependencies);

      expect(starts).toBe(2);
    }),
  );

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

      expect(posts).toEqual([{ externalThreadId, text: "Approved answer" }]);
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

  it.effect("uses collision-free secret names for distinct bot IDs", () =>
    Effect.gen(function* () {
      const firstId = BotId.make("sales/east");
      const secondId = BotId.make("sales?east");
      const harness = makeHarness({ bots: [makeBot(firstId), makeBot(secondId)] });

      yield* connectChannel(harness.dependencies, telegramConnect(firstId, "token-1"));
      yield* connectChannel(harness.dependencies, telegramConnect(secondId, "token-2"));

      expect(harness.secrets.size).toBe(2);
      expect([...harness.secrets.keys()].every((name) => !name.includes("sales"))).toBe(true);
    }),
  );

  it.effect("stops a new transport when reading the previous secret fails", () =>
    Effect.gen(function* () {
      const { store } = makeMemorySecretStore();
      let stops = 0;
      const harness = makeHarness({
        secretStore: { ...store, get: () => Effect.die(new Error("secret read failed")) },
        shutdown: async () => void (stops += 1),
      });

      yield* expectFailureMessage(
        connectChannel(harness.dependencies, telegramConnect(BOT_ID)),
        "secret read failed",
      );

      expect(stops).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
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

  it.effect("keeps a connected runtime when removing its secret fails", () =>
    Effect.gen(function* () {
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
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      failRemove = true;

      yield* expectFailureMessage(
        detachChannelConnection(harness.dependencies, BOT_ID, "telegram"),
        "secret remove failed",
      );

      const binding = harness.readModel().bots[0]?.channelBindings?.[0];
      expect(binding?.status).toBe("connected");
      expect(binding && channelBindingsForRuntime([binding])).toEqual([binding]);
      expect(values.size).toBe(1);
      expect(stops).toBe(0);
    }),
  );

  it.effect("restores the direct credential when unassign persistence fails", () =>
    Effect.gen(function* () {
      let stops = 0;
      const harness = makeHarness({
        failBotUpdate: (index) => (index === 3 ? new Error("binding write failed") : undefined),
        shutdown: async () => void (stops += 1),
      });
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      const credentials = [...harness.secrets.entries()];

      yield* expectFailureMessage(
        detachChannelConnection(harness.dependencies, BOT_ID, "telegram"),
        "binding write failed",
      );

      expect([...harness.secrets.entries()]).toEqual(credentials);
      const binding = harness.readModel().bots[0]?.channelBindings[0];
      expect(binding?.status).toBe("connected");
      expect(binding && channelBindingsForRuntime([binding])).toEqual([binding]);
      expect(stops).toBe(0);
    }),
  );

  it.effect("rejects one Telegram token bound to two active bots", () =>
    Effect.gen(function* () {
      const secondId = BotId.make("bot-2");
      const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* expectFailureMessage(
        connectChannel(harness.dependencies, telegramConnect(secondId)),
        "already connected",
      );
    }),
  );

  it.effect("rejects one WhatsApp number bound to two active bots", () =>
    Effect.gen(function* () {
      const secondId = BotId.make("bot-2");
      const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
      yield* expectFailureMessage(
        connectChannel(harness.dependencies, whatsappConnect(secondId)),
        "already connected",
      );
    }),
  );

  it.effect("serializes concurrent WhatsApp identity claims", () =>
    Effect.gen(function* () {
      const secondId = BotId.make("bot-2");
      const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

      const results = yield* Effect.all(
        [
          Effect.exit(connectChannel(harness.dependencies, whatsappConnect(BOT_ID))),
          Effect.exit(connectChannel(harness.dependencies, whatsappConnect(secondId))),
        ],
        { concurrency: "unbounded" },
      );

      expect(results.filter(Exit.isSuccess)).toHaveLength(1);
      expect(results.filter(Exit.isFailure)).toHaveLength(1);
      expect(
        harness
          .readModel()
          .bots.flatMap((bot) => bot.channelBindings ?? [])
          .filter((binding) => binding.provider === "whatsapp" && binding.status === "connected"),
      ).toHaveLength(1);
    }),
  );

  it.effect.each([
    { status: 200, data: { ok: false, error: "missing_scope", detail: "secret-token" } },
    { status: 200, data: { ok: false, error: "channel_not_found" } },
    { status: 200, data: { ok: false, error: "invalid_auth" } },
    { status: 200, data: { ok: false, error: "ratelimited" } },
    { status: 429, data: {}, headers: { "retry-after": "1" } },
  ])("retries a verified Slack API rejection through the shipped post wrapper: %j", (response) =>
    Effect.gen(function* () {
      const { harness, input } = makeAdapterDeliveryHarness("slack", "slack:C123:1");
      externalAdapters.slackResponses.push(response, { status: 200, data: { ok: true, ts: "2" } });
      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
      expect(externalAdapters.slackRetryOptions).toEqual({
        retries: 0,
        rejectRateLimitedCalls: true,
      });
      const failure = yield* failureOf(sendChannelMessage(harness.dependencies, input));
      expect(failure).toMatchObject({
        name: "ChannelPostRejectedError",
        message: "The channel rejected this reply. Correct the channel problem, then retry.",
      });
      expect(failure).not.toHaveProperty("cause");
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).not.toContain(
        "secret-token",
      );
      yield* sendChannelMessage(harness.dependencies, input);
      yield* sendChannelMessage(harness.dependencies, input);
      expect(externalAdapters.slackPostRequests).toBe(2);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toBeUndefined();
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

  it.effect.each([
    { status: 400, code: 50035 },
    { status: 401, code: 50014 },
    { status: 403, code: 50013 },
    { status: 404, code: 10003 },
    { status: 429, code: 20028 },
  ])(
    "retries a verified Discord API rejection through the shipped post wrapper: %j",
    ({ status, code }) =>
      Effect.gen(function* () {
        const { harness, input } = makeAdapterDeliveryHarness("discord", "discord:123:456");
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(Response.json({ code, message: "secret-token" }, { status }))
          .mockResolvedValueOnce(Response.json({ id: "discord-sent" }));
        vi.stubGlobal("fetch", fetch);
        yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));
        expect(yield* failureOf(sendChannelMessage(harness.dependencies, input))).toMatchObject({
          _tag: "ChannelPostRejectedError",
        });
        expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).not.toContain(
          "secret-token",
        );
        yield* sendChannelMessage(harness.dependencies, input);
        yield* sendChannelMessage(harness.dependencies, input);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0]?.[0]).toBe("https://discord.com/api/v10/channels/456/messages");
      }),
  );

  it.effect.each([
    new Error("timeout secret-token; DiscordApiError 403"),
    { status: 503, body: { code: 50013, message: "secret-token" } },
    { status: 403, body: { message: "secret-token" } },
    { status: 400, body: { code: 99999, message: "secret-token" } },
    { status: 408, body: { code: 50035, message: "secret-token" } },
  ])("retains an unverified Discord failure through the shipped post wrapper: %j", (failure) =>
    Effect.gen(function* () {
      const { harness, input } = makeAdapterDeliveryHarness("discord", "discord:123:456");
      const fetch = vi.fn<typeof globalThis.fetch>();
      if (failure instanceof Error) fetch.mockRejectedValue(failure);
      else fetch.mockResolvedValue(Response.json(failure.body, { status: failure.status }));
      vi.stubGlobal("fetch", fetch);
      yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
      );
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "unfinished delivery attempt",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([]);
    }),
  );

  it.effect.each([401, 403, 404, 429])(
    "retries a verified Telegram %i rejection through the shipped post wrapper",
    (status) =>
      Effect.gen(function* () {
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
        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
        expect(yield* failureOf(sendChannelMessage(harness.dependencies, input))).toMatchObject({
          _tag: "ChannelPostRejectedError",
        });
        expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).not.toContain(
          "secret-token",
        );
        yield* sendChannelMessage(harness.dependencies, input);
        yield* sendChannelMessage(harness.dependencies, input);
        expect(sends).toHaveBeenCalledTimes(2);
      }),
  );

  it.effect.each([
    new Error("network timeout secret-token"),
    Response.json({ ok: false, error_code: 500, description: "secret-token" }, { status: 500 }),
    Response.json({ ok: false, error_code: 400, description: "secret-token" }, { status: 400 }),
  ])("retains an unverified Telegram failure through the shipped post wrapper: %j", (response) =>
    Effect.gen(function* () {
      const { harness, input } = makeAdapterDeliveryHarness("telegram", "telegram:123");
      const sends = mockTelegramDelivery([response]);
      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
      );
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "unfinished delivery attempt",
      );
      expect(sends).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("retains a partial WhatsApp post when a later chunk is rejected", () =>
    Effect.gen(function* () {
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
      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
      );
      yield* expectFailureMessage(
        sendChannelMessage(harness.dependencies, input),
        "unfinished delivery attempt",
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toEqual([]);
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

  describe("health", () => {
    it.effect("never marks a binding connected when its listener stopped before commit", () =>
      Effect.gen(function* () {
        let stops = 0;
        const statuses: string[] = [];
        const harness = makeHarness({
          onBindings: (bindings) => statuses.push(bindings[0]?.status ?? "none"),
          startTransport: async () => ({
            externalIdentity: "@akeru",
            runtime: {
              post: async () => undefined,
              shutdown: async () => void (stops += 1),
              isHealthy: () => false,
            },
          }),
        });

        yield* expectProviderFailure(
          connectChannel(harness.dependencies, telegramConnect(BOT_ID)),
          "telegram-token",
          "network",
        );

        expect(statuses).toEqual(["connecting", "none"]);
        expect(stops).toBe(1);
        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
        expect(harness.secrets.size).toBe(0);
      }),
    );

    it.effect("rejects an iMessage gateway that refuses its first listener", () =>
      Effect.gen(function* () {
        photon.gatewayStatus = 401;
        const harness = makeHarness({ startTransport: null });

        yield* expectProviderFailure(
          connectChannel(harness.dependencies, imessageConnect(BOT_ID)),
          "status 401",
        );

        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
        expect(harness.secrets.size).toBe(0);
      }),
    );

    it.effect("classifies an iMessage gateway that cannot be reached on first launch", () =>
      Effect.gen(function* () {
        photon.gatewayError = new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
            code: "ECONNREFUSED",
          }),
        });
        const harness = makeHarness({ startTransport: null });

        yield* expectProviderFailure(
          connectChannel(harness.dependencies, imessageConnect(BOT_ID)),
          "ECONNREFUSED",
          "network",
        );
        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);

        photon.gatewayError = null;
        photon.gatewayStatus = 503;
        yield* expectProviderFailure(
          connectChannel(harness.dependencies, imessageConnect(BOT_ID)),
          "503",
          "network",
        );
        expect(harness.secrets.size).toBe(0);
      }),
    );

    it.effect("shows connecting while the transport starts and records the success time", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = Promise.withResolvers<void>();
        const harness = makeHarness({
          startTransport: async () => {
            Deferred.doneUnsafe(started, Exit.void);
            await release.promise;
            return {
              externalIdentity: "@akeru",
              runtime: { post: async () => undefined, shutdown: async () => undefined },
            };
          },
        });

        const connecting = yield* connectChannel(
          harness.dependencies,
          telegramConnect(BOT_ID),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        const pending = harness.readModel().bots[0]!.channelBindings;
        expect(pending[0]).toMatchObject({ status: "connecting", lastAttemptAt: NOW });
        expect(pending[0]?.lastError).toBeUndefined();
        expect(channelBindingsForRuntime(pending)[0]?.status).toBe("connecting");

        release.resolve();
        yield* Fiber.join(connecting);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          status: "connected",
          lastSucceededAt: NOW,
        });
        expect(harness.readModel().bots[0]?.channelBindings[0]?.failureCategory).toBeUndefined();
      }),
    );

    it.effect("keeps an unconfirmed delivery warning after reconnecting", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          bots: [
            makeBot(BOT_ID, {
              channelBindings: [
                {
                  botId: BOT_ID,
                  provider: "telegram",
                  projectId: PROJECT_ID,
                  status: "failed",
                  externalIdentity: null,
                  connectedAt: null,
                  sentMessageIds: [],
                  lastError: channelFailureMessage("delivery-unknown"),
                  failureCategory: "delivery-unknown",
                },
              ],
            }),
          ],
        });

        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          status: "connected",
          lastError: channelFailureMessage("delivery-unknown"),
          failureCategory: "delivery-unknown",
        });
      }),
    );

    it.effect("keeps a running channel connected when a new token is rejected", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-bad-token");
        const messageId = MessageId.make("message-bad-token");
        let stops = 0;
        let posts = 0;
        const harness = makeHarness({
          threads: [
            makeThread(threadId, BOT_ID, [
              makeMessage(MessageId.make("inbound-bad-token"), "user", "Question", {
                provider: "telegram",
                externalThreadId: "chat-bad-token",
              }),
              makeMessage(messageId, "assistant", "Answer"),
            ]),
          ],
          startTransport: async (input) => {
            if (input.provider === "telegram" && input.token === "invalid-token") {
              throw new Error("401 Unauthorized: invalid-token");
            }
            return {
              externalIdentity: "@akeru",
              runtime: {
                post: async () => void (posts += 1),
                shutdown: async () => void (stops += 1),
              },
            };
          },
        });
        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

        yield* expectProviderFailure(
          connectChannel(harness.dependencies, telegramConnect(BOT_ID, "invalid-token")),
          "invalid-token",
        );
        const annotated = harness.readModel().bots[0]?.channelBindings[0];
        expect(annotated).toMatchObject({
          status: "connected",
          lastError: channelFailureMessage("credentials"),
          failureCategory: "credentials",
        });
        expect(NodeUtil.inspect(annotated)).not.toContain("invalid-token");
        expect(channelBindingsForRuntime([annotated!])[0]?.status).toBe("connected");
        expect(stops).toBe(0);

        yield* sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });
        expect(posts).toBe(1);
        const cleared = harness.readModel().bots[0]?.channelBindings[0];
        expect(cleared).toMatchObject({ status: "connected", sentMessageIds: [messageId] });
        expect(cleared).not.toHaveProperty("lastError");
        expect(cleared).not.toHaveProperty("failureCategory");

        yield* expectProviderFailure(
          connectChannel(harness.dependencies, telegramConnect(BOT_ID, "invalid-token")),
          "invalid-token",
        );
        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
        const reconnected = harness.readModel().bots[0]?.channelBindings[0];
        expect(reconnected).toMatchObject({ status: "connected" });
        expect(reconnected).not.toHaveProperty("lastError");
        expect(reconnected).not.toHaveProperty("failureCategory");
      }),
    );

    it.effect("leaves no connecting binding when the bot is archived mid-connect", () =>
      Effect.gen(function* () {
        let stops = 0;
        let archiveDuringStart = (): void => undefined;
        const harness = makeHarness({
          startTransport: async () => {
            archiveDuringStart();
            return {
              externalIdentity: "@akeru",
              runtime: { post: async () => undefined, shutdown: async () => void (stops += 1) },
            };
          },
        });
        archiveDuringStart = () => harness.archive(BOT_ID);

        // A first connect that succeeds after the archive is refused and removed.
        yield* expectFailureMessage(
          connectChannel(harness.dependencies, telegramConnect(BOT_ID)),
          "Channel bot is unavailable.",
        );
        expect(stops).toBe(1);
        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
        expect(harness.secrets.size).toBe(0);

        // A reconnect that fails after the archive puts the earlier binding back.
        const earlier: ChannelBinding = {
          botId: BOT_ID,
          projectId: PROJECT_ID,
          provider: "telegram",
          status: "connecting",
          externalIdentity: "@akeru",
          connectedAt: null,
          sentMessageIds: [],
        };
        let archiveRestarted = (): void => undefined;
        const restarted = makeHarness({
          bots: [makeBot(BOT_ID, { channelBindings: [earlier] })],
          startTransport: async () => {
            archiveRestarted();
            throw new Error("Unauthorized telegram-token");
          },
        });
        archiveRestarted = () => restarted.archive(BOT_ID);
        yield* failureOf(connectChannel(restarted.dependencies, telegramConnect(BOT_ID)));
        expect(restarted.readModel().bots[0]?.channelBindings).toEqual([
          { ...earlier, status: "needs-reconnect" },
        ]);
        expect(yield* restoreConnectedChannels(restarted.dependencies)).toEqual([]);
      }),
    );

    it.effect("reports a connecting binding with no start in flight as needing reconnect", () =>
      Effect.gen(function* () {
        const binding: ChannelBinding = {
          botId: BOT_ID,
          projectId: PROJECT_ID,
          provider: "telegram",
          status: "connecting",
          externalIdentity: null,
          connectedAt: null,
          sentMessageIds: [],
        };
        const harness = makeHarness({ bots: [makeBot(BOT_ID, { channelBindings: [binding] })] });
        yield* runWith(harness.dependencies, () => Effect.void);

        expect(channelBindingsForRuntime([binding])[0]?.status).toBe("needs-reconnect");
      }),
    );

    it.effect("pushes needs-reconnect when a live gateway exits", () =>
      Effect.gen(function* () {
        const failed = Promise.withResolvers<void>();
        const gateway = yield* startTestGateway(async (waitUntil) => {
          waitUntil(failed.promise);
          return new Response(null, { status: 200 });
        }, "Test gateway");
        const runInTest = yield* FiberSet.makeRuntimePromise();
        const stopped = yield* Deferred.make<ChannelBinding>();
        let starts = 0;
        const harness = makeHarness({
          onBindings: (bindings) => {
            if (bindings[0]?.status === "needs-reconnect") {
              Deferred.doneUnsafe(stopped, Exit.succeed(bindings[0]));
            }
          },
          // The first start runs the gateway; the reconnect gets a fresh, healthy transport.
          startTransport: async () => {
            starts += 1;
            return {
              externalIdentity: "test",
              runtime:
                starts === 1
                  ? {
                      post: async () => {},
                      shutdown: gateway.shutdown,
                      isHealthy: gateway.isHealthy,
                      settled: runInTest(gateway.settled),
                    }
                  : { post: async () => {}, shutdown: async () => {} },
            };
          },
        });
        yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));

        failed.reject(new Error("Gateway disconnected with token discord-token"));
        const binding = yield* Deferred.await(stopped);

        expect(binding).toMatchObject({
          status: "needs-reconnect",
          connectedAt: null,
          lastError: "The channel connection stopped. Reconnect to resume.",
          failureCategory: "network",
        });
        expect(NodeUtil.inspect(binding)).not.toContain("discord-token");
        yield* reconnectChannel(harness.dependencies, BOT_ID, "discord");
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          status: "connected",
        });
        expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toBeUndefined();
        expect(harness.readModel().bots[0]?.channelBindings[0]?.failureCategory).toBeUndefined();
      }),
    );

    it.effect("rolls back the credential when connect cannot persist the binding", () =>
      Effect.gen(function* () {
        let stops = 0;
        const harness = makeHarness({
          failBotUpdate: (index) => (index === 2 ? new Error("binding write failed") : undefined),
          shutdown: async () => void (stops += 1),
        });

        yield* expectFailureMessage(
          connectChannel(harness.dependencies, telegramConnect(BOT_ID)),
          "binding write failed",
        );

        expect(stops).toBe(1);
        expect(harness.secrets.size).toBe(0);
        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
      }),
    );

    it.effect("rolls back an attach when the binding write fails", () =>
      Effect.gen(function* () {
        const connectionId = ChannelConnectionId.make("telegram-rollback");
        let stops = 0;
        const harness = makeHarness({
          failBotUpdate: (index) => (index === 2 ? new Error("binding write failed") : undefined),
          shutdown: async () => void (stops += 1),
        });
        yield* saveChannelConnection(harness.dependencies, {
          type: "channel.connection.save",
          commandId: CommandId.make("save-rollback"),
          connectionId,
          name: "Rollback Telegram",
          provider: "telegram",
          token: "telegram-token",
        });
        const saved = [...harness.secrets.entries()];

        yield* expectFailureMessage(
          attachChannelConnection(
            harness.dependencies,
            BOT_ID,
            connectionId,
            PROJECT_ID,
            "telegram",
          ),
          "binding write failed",
        );

        expect(stops).toBe(1);
        expect([...harness.secrets.entries()]).toEqual(saved);
        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
        yield* deleteChannelConnection(harness.dependencies, connectionId);
        expect(harness.secrets.size).toBe(0);
      }),
    );

    it.effect("keeps the live transport when a second bot claims its identity", () =>
      Effect.gen(function* () {
        const secondId = BotId.make("bot-2");
        const stops: string[] = [];
        const harness = makeHarness({
          bots: [makeBot(BOT_ID), makeBot(secondId)],
          startTransport: async (input) => ({
            externalIdentity: "@akeru",
            runtime: {
              post: async () => undefined,
              shutdown: async () => void stops.push(input.botId),
            },
          }),
        });
        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

        yield* expectFailureMessage(
          connectChannel(harness.dependencies, telegramConnect(secondId)),
          "already connected",
        );

        expect(stops).not.toContain(BOT_ID);
        const [first, second] = harness.readModel().bots;
        expect(first?.channelBindings[0]).toMatchObject({ status: "connected" });
        expect(channelBindingsForRuntime(first!.channelBindings)[0]?.status).toBe("connected");
        expect(second?.channelBindings).toEqual([]);
        expect(harness.secrets.size).toBe(1);
      }),
    );

    it.effect("records the restore category when a restored transport cannot start", () =>
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
            throw new Error("401 Unauthorized for token telegram-token");
          },
        });

        const failures = yield* restoreConnectedChannels(harness.dependencies);

        expect(failures).toEqual([{ botId: BOT_ID, provider: "telegram", category: "restore" }]);
        const restored = harness.readModel().bots[0]?.channelBindings[0];
        expect(restored).toMatchObject({
          status: "failed",
          connectedAt: null,
          failureCategory: "restore",
        });
        expect(NodeUtil.inspect(restored)).not.toContain("telegram-token");
        expect(NodeUtil.inspect(restored)).not.toContain("Unauthorized");
      }),
    );
  });

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

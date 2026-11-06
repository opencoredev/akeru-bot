import { photon, externalAdapters } from "./channelAdapters.ts";

export { photon, externalAdapters } from "./channelAdapters.ts";

import { BOT_ID, NOW, PROJECT_ID, SECOND_PROJECT_ID } from "./channelFixtures.ts";

export {
  NOW,
  BOT_ID,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  MISSING_PROJECT_ID,
  telegramConnect,
  imessageConnect,
  whatsappConnect,
  slackConnect,
  discordConnect,
  signedWhatsAppRequest,
} from "./channelFixtures.ts";

import {
  BotId,
  ChannelConnectionId,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
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
} from "@akeru/contracts";
import { Message as ChatMessage, parseMarkdown } from "chat";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as FiberSet from "effect/FiberSet";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach, expect, vi } from "vite-plus/test";
import type { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { createEmptyReadModel } from "../../orchestration/projector.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { memoryChannelDeliveryStore } from "../ChannelDeliveryStore.ts";
import { type ChannelFollowStoreShape, memoryChannelFollowStore } from "../ChannelFollowStore.ts";
import {
  ChannelRuntime,
  channelFailureMessage,
  channelFailurePresentation,
  startRenewingGateway,
  type ChannelRuntimeDependencies,
  type ChannelRuntimeShape,
} from "../ChannelRuntime.ts";

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
  author: {
    readonly isBot?: boolean | "unknown";
    readonly isMe?: boolean;
    readonly raw?: Record<string, string>;
    readonly edited?: boolean;
  } = {},
) {
  return new ChatMessage({
    id,
    threadId,
    text,
    formatted: parseMarkdown(text),
    raw: author.raw ?? {},
    author: {
      userId: senderId,
      userName: senderId,
      fullName: senderId,
      isBot: author.isBot ?? false,
      isMe: author.isMe ?? false,
    },
    metadata: { dateSent: new Date(NOW), edited: author.edited ?? false },
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

/** Answers Slack's apps.connections.open app-token probe with `ok`. */
const slackProbeClient = (ok: boolean) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.url === "https://slack.com/api/apps.connections.open"
          ? Response.json(
              ok ? { ok, url: "wss://wss.slack.test/link" } : { ok, error: "invalid_auth" },
            )
          : Response.json({ ok: false, error: "unexpected_request" }, { status: 404 }),
      ),
    ),
  );

function makeHarness(input: {
  readonly bots?: ReadonlyArray<OrchestrationBot>;
  readonly threads?: ReadonlyArray<OrchestrationThread>;
  readonly post?: (externalThreadId: string, text: string) => Promise<void>;
  readonly shutdown?: () => Promise<void>;
  readonly deliveryStore?: ChannelRuntimeDependencies["deliveryStore"];
  readonly publicOrigin?: string | null | undefined;
  readonly secretStore?: ChannelRuntimeDependencies["secretStore"];
  readonly settings?: ChannelRuntimeDependencies["settings"];
  readonly startTransport?: ChannelRuntimeDependencies["startTransport"] | null;
  readonly failBotUpdate?: (updateIndex: number) => Error | undefined;
  readonly onBindings?: (bindings: ReadonlyArray<ChannelBinding>) => void;
  readonly commandModelOmitsMessages?: boolean;
  /** Linked owner identities and per-bot access the settings start with. */
  readonly channelOwners?: ServerSettings["channelOwners"];
  readonly channelBotAccess?: ServerSettings["channelBotAccess"];
  /** The clock the runtime reads. Defaults to the fixed `NOW`. */
  readonly now?: () => string;
  /** Wraps the in-memory follow store, for example to fail one call. */
  readonly wrapFollowStore?: (store: ChannelFollowStoreShape) => ChannelFollowStoreShape;
  /** Makes each read-model query yield first, as a real database query does. */
  readonly readModelYields?: boolean;
  /** Runs before each read-model query, for example to hold one until a test releases it. */
  readonly beforeReadModel?: () => Effect.Effect<void>;
}) {
  let model = makeModel(input.bots ?? [makeBot(BOT_ID)]);

  let settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    channelOwners: input.channelOwners ?? [],
    channelBotAccess: input.channelBotAccess ?? [],
  };

  const threads = [...(input.threads ?? [])];
  const commands: OrchestrationCommand[] = [];
  const memoryFollowStore = memoryChannelFollowStore();
  const followStore = input.wrapFollowStore?.(memoryFollowStore) ?? memoryFollowStore;
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
          settings = { ...settings, ...patch } as ServerSettings;

          return settings;
        }),
    },
    deliveryStore: input.deliveryStore ?? memoryChannelDeliveryStore(),
    followStore,
    readModel: (input.readModelYields ? Effect.yieldNow : Effect.void).pipe(
      Effect.andThen(Effect.suspend(() => input.beforeReadModel?.() ?? Effect.void)),
      Effect.andThen(
        Effect.sync(() => ({
          ...model,
          threads: input.commandModelOmitsMessages
            ? threads.map((thread) => ({ ...thread, messages: [] }))
            : threads,
        })),
      ),
    ),
    readThread: (threadId) =>
      Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
    nowIso: input.now ? Effect.sync(input.now) : Effect.succeed(NOW),
    randomUuid: Effect.sync(() => `uuid-${commands.length}`),
    // Accepts the Slack app-token probe, the only request the built-in transports send here.
    httpClient: slackProbeClient(true),
    ...(input.publicOrigin === null
      ? {}
      : { publicOrigin: input.publicOrigin ?? "https://akeru.example" }),
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
    followStore,
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
  externalAdapters.slackOnInitialize = null;
  externalAdapters.slackSubscriptions.length = 0;
  externalAdapters.slackResponses.length = 0;
  externalAdapters.slackPostRequests = 0;
  externalAdapters.slackRetryOptions = {};
  externalAdapters.slackTeamId = "T-HOME";
  externalAdapters.slackUserNames = {};
  externalAdapters.slackUserLookups = 0;
  externalAdapters.slackUserTeams = {};
  externalAdapters.slackMissingUsers = [];
  externalAdapters.slackScopes = undefined;
  externalAdapters.slackUserFlags = {};
  externalAdapters.slackThreadMessages = [];
  externalAdapters.slackSubscribeFailures = 0;
  externalAdapters.slackApiCalls.length = 0;
  vi.unstubAllGlobals();
  externalAdapters.discordAdapter = null;
  externalAdapters.discordChat = null;
  externalAdapters.discordGatewayStarts = 0;
  externalAdapters.discordIdentityFails = false;
  externalAdapters.discordDisconnects = 0;
  externalAdapters.discordSubscriptions.length = 0;
  externalAdapters.reactions.length = 0;
});

export {
  channelRuntimes,
  latestChannelRuntime,
  channelRuntimeFor,
  latestRuntime,
  runWith,
  failureOf,
  expectFailureMessage,
  expectProviderFailure,
  type ConnectInput,
  type SaveInput,
  type Provider,
  type InboundInput,
  type ReplyTarget,
  connectChannel,
  saveChannelConnection,
  deleteChannelConnection,
  attachChannelConnection,
  changeChannelProject,
  disconnectChannel,
  detachChannelConnection,
  reconnectChannel,
  restoreConnectedChannels,
  dispatchInboundChannelMessage,
  sendChannelMessage,
  sendCompletedChannelReply,
  finishChannelTurn,
  stopChannelsForBot,
  clearChannelThreadStatuses,
  handleWhatsAppWebhook,
  shutdownAllChannels,
  stopArchivedBotChannels,
  channelBindingsForRuntime,
  makeGatewayListener,
  startTestGateway,
  makeBot,
  makeModel,
  makeMessage,
  makeChatSdkMessage,
  makeThread,
  makeMemorySecretStore,
  slackProbeClient,
  makeHarness,
  makeAdapterDeliveryHarness,
  mockTelegramDelivery,
};

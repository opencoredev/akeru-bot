import { createHash } from "node:crypto";

import { createMemoryState } from "@chat-adapter/state-memory";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { TelegramProvider } from "@mastra/telegram";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import {
  BotId,
  ChannelConnectionId,
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ChannelBinding,
  type ChannelConnectionProfile,
  type ChannelProvider,
  type ClientOrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { type Adapter, Chat } from "chat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import type { ChannelDeliveryStoreShape } from "./ChannelDeliveryStore.ts";

interface ChannelRuntimeEntry {
  readonly post: (externalThreadId: string, text: string) => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly webhook?: (request: Request) => Promise<Response>;
}

interface StartedChannel {
  readonly binding: ChannelBinding;
  readonly runtime: ChannelRuntimeEntry;
}

interface InboundChannelMessage {
  readonly externalThreadId: string;
  readonly externalSenderId?: string;
  readonly text: string;
}

interface ChannelTransportContext {
  readonly botName: string;
  readonly subscribedIMessageGroupIds: ReadonlyArray<string>;
  readonly onIMessageGroupMessage: (input: InboundChannelMessage) => Promise<void>;
}

type LiveProvider = ChannelProvider;
type ChannelConnectInput = Extract<
  ClientOrchestrationCommand,
  { readonly type: "channel.connect" }
>;
type ChannelConnectionSaveInput = Extract<
  ClientOrchestrationCommand,
  { readonly type: "channel.connection.save" }
>;

export interface ChannelRuntimeDependencies {
  readonly engine: OrchestrationEngine.OrchestrationEngineShape;
  readonly secretStore: ServerSecretStore["Service"];
  readonly settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettings">;
  readonly deliveryStore: ChannelDeliveryStoreShape;
  readonly readModel: () => Promise<OrchestrationReadModel>;
  readonly readThread: (threadId: ThreadId) => Promise<OrchestrationThread | null>;
  readonly nowIso: () => Promise<string>;
  readonly randomUuid: () => Promise<string>;
  readonly startTransport?: (
    input: ChannelConnectInput,
    onDirectMessage: (input: InboundChannelMessage) => Promise<void>,
    context: ChannelTransportContext,
  ) => Promise<{ readonly externalIdentity: string; readonly runtime: ChannelRuntimeEntry }>;
}

const runtimes = new Map<string, ChannelRuntimeEntry>();
const inboundQueues = new Map<string, Promise<void>>();
const bindingQueues = new Map<string, Promise<void>>();
const operationQueues = new Map<string, Promise<void>>();
const iMessageGroupContextLimit = 20;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const StoredChannelSecret = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("telegram"), token: Schema.String }),
  Schema.Struct({
    provider: Schema.Literal("imessage"),
    mode: Schema.Literals(["hosted", "self-hosted"]),
    projectId: Schema.optional(Schema.String),
    projectSecret: Schema.optional(Schema.String),
    serverUrl: Schema.optional(Schema.String),
    apiKey: Schema.optional(Schema.String),
    phone: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    provider: Schema.Literal("whatsapp"),
    accessToken: Schema.String,
    appSecret: Schema.String,
    phoneNumberId: Schema.String,
    verifyToken: Schema.String,
  }),
]);
type StoredChannelSecret = typeof StoredChannelSecret.Type;
const decodeStoredChannelSecret = Schema.decodeUnknownEffect(StoredChannelSecret);

const runtimeKey = (botId: string, provider: ChannelProvider) => `${botId}:${provider}`;
const operationKey = (provider: ChannelProvider) => provider;
const secretName = (botId: BotId, provider: ChannelProvider) =>
  `channel-${provider}-${createHash("sha256").update(botId).digest("hex")}`;
const connectionSecretName = (connectionId: ChannelConnectionId) =>
  `channel-connection-${createHash("sha256").update(connectionId).digest("hex")}`;

export const channelThreadId = (
  botId: BotId,
  provider: LiveProvider,
  externalThreadId: string,
): ThreadId =>
  ThreadId.make(
    `channel-${createHash("sha256").update(`${botId}\0${provider}\0${externalThreadId}`).digest("hex")}`,
  );

export const WHATSAPP_WEBHOOK_PATH = "/api/channels/whatsapp/:botId/webhook";

export async function handleWhatsAppWebhook(botId: BotId, request: Request): Promise<Response> {
  const webhook = runtimes.get(runtimeKey(botId, "whatsapp"))?.webhook;
  return webhook ? webhook(request) : new Response("Not Found", { status: 404 });
}

const whatsAppWebhookHttpHandler = Effect.gen(function* () {
  const params = yield* HttpRouter.schemaPathParams(Schema.Struct({ botId: BotId })).pipe(
    Effect.option,
  );
  if (params._tag === "None") return HttpServerResponse.text("Not Found", { status: 404 });
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* HttpServerRequest.toWeb(request).pipe(Effect.option);
  if (webRequest._tag === "None") return HttpServerResponse.text("Bad Request", { status: 400 });
  const response = yield* Effect.promise(() =>
    handleWhatsAppWebhook(params.value.botId, webRequest.value),
  );
  return HttpServerResponse.fromWeb(response);
});

export const whatsAppWebhookRouteLayer = Layer.merge(
  HttpRouter.add("GET", WHATSAPP_WEBHOOK_PATH, whatsAppWebhookHttpHandler),
  HttpRouter.add("POST", WHATSAPP_WEBHOOK_PATH, whatsAppWebhookHttpHandler),
);

const isIMessageDirectThread = (externalThreadId: string) => externalThreadId.includes(";-;");

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const iMessageGroupTrigger = (botName: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}_])@${escapeRegExp(botName)}(?=$|[^\\p{L}\\p{N}_-])`, "iu");

function subscribedIMessageGroupIds(
  model: OrchestrationReadModel,
  botId: BotId,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const thread of model.threads) {
    if (thread.botId !== botId || thread.groupId !== null || thread.deletedAt !== null) continue;
    for (const message of thread.messages) {
      const origin = message.channelOrigin;
      if (
        origin?.provider === "imessage" &&
        !isIMessageDirectThread(origin.externalThreadId) &&
        thread.id === channelThreadId(botId, "imessage", origin.externalThreadId)
      ) {
        ids.add(origin.externalThreadId);
      }
    }
  }
  return [...ids];
}

export function channelBindingsForRuntime(
  bindings: ReadonlyArray<ChannelBinding>,
  isRunning: (botId: BotId, provider: ChannelProvider) => boolean = (botId, provider) =>
    runtimes.has(runtimeKey(botId, provider)),
): ReadonlyArray<ChannelBinding> {
  return bindings.map((binding) =>
    binding.status === "connected" && !isRunning(binding.botId, binding.provider)
      ? { ...binding, status: "needs-reconnect" }
      : binding,
  );
}

const randomId = async (dependencies: ChannelRuntimeDependencies, prefix: string) =>
  `${prefix}-${await dependencies.randomUuid()}`;

async function loadSecret(
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  provider: LiveProvider,
): Promise<StoredChannelSecret | null> {
  const stored = await Effect.runPromise(dependencies.secretStore.get(secretName(botId, provider)));
  if (stored._tag === "None") return null;
  const raw: unknown = JSON.parse(decoder.decode(stored.value));
  return Effect.runPromise(decodeStoredChannelSecret(raw));
}

async function loadConnectionSecret(
  dependencies: ChannelRuntimeDependencies,
  connectionId: ChannelConnectionId,
): Promise<StoredChannelSecret | null> {
  const stored = await Effect.runPromise(
    dependencies.secretStore.get(connectionSecretName(connectionId)),
  );
  if (stored._tag === "None") return null;
  const raw: unknown = JSON.parse(decoder.decode(stored.value));
  return Effect.runPromise(decodeStoredChannelSecret(raw));
}

const storedSecretFromInput = (
  input: ChannelConnectInput | ChannelConnectionSaveInput,
): StoredChannelSecret =>
  input.provider === "telegram"
    ? { provider: "telegram", token: input.token }
    : input.provider === "whatsapp"
      ? {
          provider: "whatsapp",
          accessToken: input.accessToken,
          appSecret: input.appSecret,
          phoneNumberId: input.phoneNumberId,
          verifyToken: input.verifyToken,
        }
      : input.mode === "hosted"
        ? {
            provider: "imessage",
            mode: "hosted",
            projectId: input.projectId,
            projectSecret: input.projectSecret,
          }
        : {
            provider: "imessage",
            mode: "self-hosted",
            serverUrl: input.serverUrl,
            apiKey: input.apiKey,
            ...(input.phone ? { phone: input.phone } : {}),
          };

const connectInputFromSecret = (
  botId: BotId,
  commandId: CommandId,
  secret: StoredChannelSecret,
): ChannelConnectInput =>
  secret.provider === "telegram"
    ? { type: "channel.connect", commandId, botId, provider: "telegram", token: secret.token }
    : secret.provider === "whatsapp"
      ? {
          type: "channel.connect",
          commandId,
          botId,
          provider: "whatsapp",
          accessToken: secret.accessToken,
          appSecret: secret.appSecret,
          phoneNumberId: secret.phoneNumberId,
          verifyToken: secret.verifyToken,
        }
      : secret.mode === "hosted" && secret.projectId && secret.projectSecret
        ? {
            type: "channel.connect",
            commandId,
            botId,
            provider: "imessage",
            mode: "hosted",
            projectId: secret.projectId,
            projectSecret: secret.projectSecret,
          }
        : secret.mode === "self-hosted" && secret.serverUrl && secret.apiKey
          ? {
              type: "channel.connect",
              commandId,
              botId,
              provider: "imessage",
              mode: "self-hosted",
              serverUrl: secret.serverUrl,
              apiKey: secret.apiKey,
              ...(secret.phone ? { phone: secret.phone } : {}),
            }
          : (() => {
              throw new Error("Saved channel credentials are incomplete.");
            })();

const channelSecretIdentity = (secret: StoredChannelSecret): string =>
  secret.provider === "telegram"
    ? `telegram:${secret.token}`
    : secret.provider === "whatsapp"
      ? `whatsapp:${secret.phoneNumberId}`
      : secret.mode === "hosted"
        ? `imessage:hosted:${secret.projectId ?? ""}`
        : `imessage:self-hosted:${secret.serverUrl ?? ""}:${secret.phone ?? ""}`;

async function assertChannelIdentityAvailable(
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  candidateSecret: StoredChannelSecret,
): Promise<void> {
  const model = await dependencies.readModel();
  for (const bot of model.bots) {
    if (bot.id === botId || bot.archivedAt !== null) continue;
    for (const binding of bot.channelBindings ?? []) {
      if (binding.provider !== candidateSecret.provider || binding.status === "disconnected") {
        continue;
      }
      const secret = binding.connectionId
        ? await loadConnectionSecret(dependencies, binding.connectionId).catch(() => null)
        : await loadSecret(dependencies, bot.id, binding.provider).catch(() => null);
      if (secret && channelSecretIdentity(secret) === channelSecretIdentity(candidateSecret)) {
        throw new Error("This channel connection is already connected to another bot.");
      }
    }
  }
}

export async function dispatchInboundChannelMessage(
  dependencies: ChannelRuntimeDependencies,
  input: {
    readonly botId: BotId;
    readonly provider: LiveProvider;
    readonly externalThreadId: string;
    readonly externalSenderId?: string;
    readonly text: string;
  },
): Promise<void> {
  const threadId = channelThreadId(input.botId, input.provider, input.externalThreadId);
  const previous = inboundQueues.get(threadId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const model = await dependencies.readModel();
      const bot = model.bots.find(
        (candidate) => candidate.id === input.botId && candidate.archivedAt === null,
      );
      if (!bot) throw new Error(`Bot '${input.botId}' is unavailable.`);
      const project = model.projects.find((candidate) => candidate.deletedAt === null);
      if (!project) throw new Error("A project is required before a channel can start a turn.");
      const modelSelection = bot.engine
        ? { instanceId: ProviderInstanceId.make(bot.engine.provider), model: bot.engine.model }
        : project.defaultModelSelection;
      if (!modelSelection)
        throw new Error(`Bot '${bot.name}' needs a model before channel messages.`);

      const existing = model.threads.find(
        (thread) => thread.id === threadId && thread.deletedAt === null,
      );
      const createdAt = await dependencies.nowIso();
      if (!existing) {
        await Effect.runPromise(
          dependencies.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(await randomId(dependencies, "channel-create")),
            threadId,
            projectId: project.id,
            botId: bot.id,
            groupId: null,
            title: bot.name,
            modelSelection,
            runtimeMode: bot.runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
      } else if (existing.botId !== bot.id || existing.groupId != null) {
        throw new Error(`Channel thread '${threadId}' belongs to another owner.`);
      }

      await Effect.runPromise(
        dependencies.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(await randomId(dependencies, "channel-turn")),
          threadId,
          message: {
            messageId: MessageId.make(await randomId(dependencies, "channel-message")),
            role: "user",
            text: input.text,
            attachments: [],
            channelOrigin: {
              provider: input.provider,
              externalThreadId: input.externalThreadId,
              ...(input.externalSenderId ? { externalSenderId: input.externalSenderId } : {}),
            },
          },
          modelSelection,
          runtimeMode: bot.runtimeMode,
          interactionMode: "default",
          createdAt,
        }),
      );
    });
  inboundQueues.set(threadId, next);
  try {
    await next;
  } finally {
    if (inboundQueues.get(threadId) === next) inboundQueues.delete(threadId);
  }
}

async function replaceBinding(
  dependencies: ChannelRuntimeDependencies,
  binding: ChannelBinding,
): Promise<number> {
  const previous = bindingQueues.get(binding.botId) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const model = await dependencies.readModel();
      const bot = model.bots.find((candidate) => candidate.id === binding.botId);
      if (!bot) throw new Error(`Bot '${binding.botId}' does not exist.`);
      const previousBinding = (bot.channelBindings ?? []).find(
        (candidate) => candidate.provider === binding.provider,
      );
      const nextBinding = {
        ...binding,
        sentMessageIds:
          binding.sentMessageIds.length > 0
            ? binding.sentMessageIds
            : (previousBinding?.sentMessageIds ?? []),
      };
      const receipt = await Effect.runPromise(
        dependencies.engine.dispatch({
          type: "bot.update",
          commandId: CommandId.make(await randomId(dependencies, "channel-binding")),
          botId: bot.id,
          channelBindings: [
            ...(bot.channelBindings ?? []).filter(
              (candidate) => candidate.provider !== binding.provider,
            ),
            nextBinding,
          ],
        }),
      );
      return receipt.sequence;
    });
  const queued = operation.then(
    () => undefined,
    () => undefined,
  );
  bindingQueues.set(binding.botId, queued);
  try {
    return await operation;
  } finally {
    if (bindingQueues.get(binding.botId) === queued) bindingQueues.delete(binding.botId);
  }
}

async function withChannelOperation<A>(
  botId: BotId,
  provider: ChannelProvider,
  operation: () => Promise<A>,
): Promise<A> {
  const key = operationKey(provider);
  const previous = operationQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const queued = result.then(
    () => undefined,
    () => undefined,
  );
  operationQueues.set(key, queued);
  try {
    return await result;
  } finally {
    if (operationQueues.get(key) === queued) operationQueues.delete(key);
  }
}

async function withConnectionOperation<A>(
  connectionId: ChannelConnectionId,
  operation: () => Promise<A>,
): Promise<A> {
  const key = `connection:${connectionId}`;
  const previous = operationQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const queued = result.then(
    () => undefined,
    () => undefined,
  );
  operationQueues.set(key, queued);
  try {
    return await result;
  } finally {
    if (operationQueues.get(key) === queued) operationQueues.delete(key);
  }
}

async function withConnectionSettingsOperation<A>(operation: () => Promise<A>): Promise<A> {
  const key = "connection-settings";
  const previous = operationQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const queued = result.then(
    () => undefined,
    () => undefined,
  );
  operationQueues.set(key, queued);
  try {
    return await result;
  } finally {
    if (operationQueues.get(key) === queued) operationQueues.delete(key);
  }
}

async function stopRuntime(botId: BotId, provider: ChannelProvider): Promise<void> {
  const key = runtimeKey(botId, provider);
  const runtime = runtimes.get(key);
  if (!runtime) return;
  runtimes.delete(key);
  await runtime.shutdown();
}

export async function stopChannelsForBot(botId: BotId): Promise<void> {
  await Promise.allSettled(
    (["telegram", "imessage", "whatsapp"] as const).map((provider) =>
      withChannelOperation(botId, provider, () => stopRuntime(botId, provider)),
    ),
  );
}

export const stopArchivedBotChannels = (events: Stream.Stream<OrchestrationEvent>) =>
  Stream.runForEach(events, (event) =>
    event.type === "bot.archived"
      ? Effect.promise(() => stopChannelsForBot(event.payload.botId))
      : Effect.void,
  );

export async function shutdownAllChannels(): Promise<void> {
  const entries = [...runtimes.values()];
  runtimes.clear();
  inboundQueues.clear();
  bindingQueues.clear();
  operationQueues.clear();
  await Promise.allSettled(entries.map((entry) => entry.shutdown()));
}

async function startTelegram(
  botId: BotId,
  token: string,
  onDirectMessage: Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1],
): Promise<{ readonly externalIdentity: string; readonly runtime: ChannelRuntimeEntry }> {
  const provider = new TelegramProvider({ mode: "polling", commands: [] });
  const connected = await provider.connect(botId, { botToken: token, commands: [] });
  if (connected.type !== "immediate") throw new Error("Telegram did not connect immediately.");
  const installation = await provider.getInstallation(botId);
  const adapter = provider.getAdapter(connected.installationId);
  if (!installation || !adapter) throw new Error("Telegram did not create an active adapter.");
  if (!adapter.botUserId) throw new Error("Telegram did not identify the connected bot.");
  const activeAdapter = Object.assign(adapter, { botUserId: adapter.botUserId });
  const chat = new Chat({
    userName: installation.username ?? "Akeru Bot",
    adapters: { telegram: activeAdapter },
    state: createMemoryState(),
  });
  chat.onDirectMessage(async (thread, message) => {
    if (!message.text.trim()) return;
    await onDirectMessage({
      externalThreadId: thread.id,
      externalSenderId: message.author.userId,
      text: message.text,
    });
  });
  try {
    await chat.initialize();
  } catch (cause) {
    await provider.disconnect(botId).catch(() => undefined);
    throw cause;
  }
  return {
    externalIdentity: installation.username ? `@${installation.username}` : botId,
    runtime: {
      post: async (externalThreadId, text) => void (await chat.thread(externalThreadId).post(text)),
      shutdown: async () => {
        await chat.shutdown();
        await provider.disconnect(botId).catch(() => undefined);
      },
    },
  };
}

async function startIMessage(
  input: Extract<ChannelConnectInput, { readonly provider: "imessage" }>,
  context: ChannelTransportContext,
  onDirectMessage: Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1],
): Promise<{ readonly externalIdentity: string; readonly runtime: ChannelRuntimeEntry }> {
  const adapter = createiMessageAdapter(
    input.mode === "hosted"
      ? { projectId: input.projectId, projectSecret: input.projectSecret }
      : {
          serverUrl: input.serverUrl,
          apiKey: input.apiKey,
          ...(input.phone ? { phone: input.phone } : {}),
        },
  );
  const chat = new Chat({
    userName: context.botName,
    adapters: { imessage: adapter },
    state: createMemoryState(),
  });
  chat.onDirectMessage(async (thread, message) => {
    if (!message.text.trim()) return;
    await onDirectMessage({
      externalThreadId: thread.id,
      externalSenderId: message.author.userId,
      text: message.text,
    });
  });
  const onGroupMessage = async (
    thread: Parameters<Parameters<typeof chat.onSubscribedMessage>[0]>[0],
    message: Parameters<Parameters<typeof chat.onSubscribedMessage>[0]>[1],
  ) => {
    if (adapter.isDM(thread.id) || !message.text.trim()) return;
    await context.onIMessageGroupMessage({
      externalThreadId: thread.id,
      externalSenderId: message.author.userId,
      text: message.text,
    });
  };
  chat.onNewMention(async (thread, message) => {
    if (adapter.isDM(thread.id)) return;
    await thread.subscribe();
    await onGroupMessage(thread, message);
  });
  chat.onSubscribedMessage(onGroupMessage);
  await chat.initialize();
  await Promise.allSettled(
    context.subscribedIMessageGroupIds.map((externalThreadId) =>
      chat.thread(externalThreadId).subscribe(),
    ),
  );
  const abort = new AbortController();
  const response = await adapter.startGatewayListener(
    { waitUntil: (task) => void task },
    undefined,
    abort.signal,
  );
  if (!response.ok) {
    abort.abort();
    await chat.shutdown();
    throw new Error(`Photon gateway failed with status ${response.status}.`);
  }
  return {
    externalIdentity:
      input.mode === "self-hosted" && input.phone
        ? input.phone
        : input.mode === "hosted"
          ? "Photon hosted"
          : "Photon self-hosted",
    runtime: {
      post: async (externalThreadId, text) => void (await chat.thread(externalThreadId).post(text)),
      shutdown: async () => {
        abort.abort();
        await chat.shutdown();
      },
    },
  };
}

async function startWhatsApp(
  input: Extract<ChannelConnectInput, { readonly provider: "whatsapp" }>,
  context: ChannelTransportContext,
  onDirectMessage: Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1],
): Promise<{ readonly externalIdentity: string; readonly runtime: ChannelRuntimeEntry }> {
  const adapter = createWhatsAppAdapter({
    accessToken: input.accessToken,
    appSecret: input.appSecret,
    phoneNumberId: input.phoneNumberId,
    verifyToken: input.verifyToken,
    userName: context.botName,
  });
  const chat = new Chat({
    userName: context.botName,
    adapters: { whatsapp: adapter as Adapter },
    state: createMemoryState(),
  });
  chat.onDirectMessage(async (thread, message) => {
    if (!message.text.trim()) return;
    await onDirectMessage({
      externalThreadId: thread.id,
      externalSenderId: message.author.userId,
      text: message.text,
    });
  });
  await chat.initialize();
  return {
    externalIdentity: input.phoneNumberId,
    runtime: {
      post: async (externalThreadId, text) => void (await chat.thread(externalThreadId).post(text)),
      shutdown: () => chat.shutdown(),
      webhook: async (request) => {
        const tasks: Promise<unknown>[] = [];
        let response: Response;
        try {
          response = await adapter.handleWebhook(request, {
            waitUntil: (task) => void tasks.push(task),
          });
        } catch {
          return new Response("Invalid webhook payload", { status: 400 });
        }
        const results = await Promise.allSettled(tasks);
        return results.some((result) => result.status === "rejected")
          ? new Response("Webhook processing failed", { status: 500 })
          : response;
      },
    },
  };
}

async function startChannel(
  dependencies: ChannelRuntimeDependencies,
  input: ChannelConnectInput,
  connectionId?: ChannelConnectionId,
): Promise<StartedChannel> {
  const model = await dependencies.readModel();
  const bot = model.bots.find((candidate) => candidate.id === input.botId);
  if (!bot || bot.archivedAt !== null) throw new Error(`Bot '${input.botId}' is unavailable.`);
  const onDirectMessage = (message: InboundChannelMessage) =>
    dispatchInboundChannelMessage(dependencies, {
      ...message,
      botId: bot.id,
      provider: input.provider,
    });
  let iMessageGroupContext: ReadonlyArray<InboundChannelMessage> = [];
  const context: ChannelTransportContext = {
    botName: bot.name,
    subscribedIMessageGroupIds:
      input.provider === "imessage" ? subscribedIMessageGroupIds(model, bot.id) : [],
    onIMessageGroupMessage: async (message) => {
      if (input.provider !== "imessage" || isIMessageDirectThread(message.externalThreadId)) {
        return;
      }
      if (!iMessageGroupTrigger(bot.name).test(message.text)) {
        iMessageGroupContext = [...iMessageGroupContext, message].slice(-iMessageGroupContextLimit);
        return;
      }
      const recentMessages = iMessageGroupContext.filter(
        (candidate) => candidate.externalThreadId === message.externalThreadId,
      );
      await dispatchInboundChannelMessage(dependencies, {
        ...message,
        botId: bot.id,
        provider: "imessage",
        text:
          recentMessages.length === 0
            ? message.text
            : [...recentMessages, message]
                .map(
                  (candidate) =>
                    `${candidate.externalSenderId ?? "Unknown sender"}: ${candidate.text}`,
                )
                .join("\n"),
      });
      const consumedMessages = new Set(recentMessages);
      iMessageGroupContext = iMessageGroupContext.filter(
        (candidate) => !consumedMessages.has(candidate),
      );
    },
  };
  const started = dependencies.startTransport
    ? await dependencies.startTransport(input, onDirectMessage, context)
    : input.provider === "telegram"
      ? await startTelegram(bot.id, input.token, onDirectMessage)
      : input.provider === "imessage"
        ? await startIMessage(input, context, onDirectMessage)
        : await startWhatsApp(input, context, onDirectMessage);
  return {
    runtime: started.runtime,
    binding: {
      botId: bot.id,
      ...(connectionId ? { connectionId } : {}),
      provider: input.provider,
      status: "connected",
      externalIdentity: started.externalIdentity,
      connectedAt: await dependencies.nowIso(),
      sentMessageIds: [],
    },
  };
}

async function commitStartedChannel(
  dependencies: ChannelRuntimeDependencies,
  started: StartedChannel,
  secret?: StoredChannelSecret,
): Promise<number> {
  const key = runtimeKey(started.binding.botId, started.binding.provider);
  const previousRuntime = runtimes.get(key);
  const name = secretName(started.binding.botId, started.binding.provider);
  let previousSecret: Option.Option<Uint8Array> | undefined;
  try {
    previousSecret = await Effect.runPromise(dependencies.secretStore.get(name));
    runtimes.set(key, started.runtime);
    if (secret) {
      await Effect.runPromise(
        dependencies.secretStore.set(name, encoder.encode(JSON.stringify(secret))),
      );
    }
    const sequence = await replaceBinding(dependencies, started.binding);
    if (previousRuntime && previousRuntime !== started.runtime) {
      await previousRuntime.shutdown().catch(() => undefined);
    }
    return sequence;
  } catch (cause) {
    if (previousRuntime) runtimes.set(key, previousRuntime);
    else runtimes.delete(key);
    await started.runtime.shutdown().catch(() => undefined);
    if (previousSecret?._tag === "Some") {
      await Effect.runPromise(dependencies.secretStore.set(name, previousSecret.value)).catch(
        () => undefined,
      );
    } else if (previousSecret?._tag === "None") {
      await Effect.runPromise(dependencies.secretStore.remove(name)).catch(() => undefined);
    }
    throw cause;
  }
}

export async function connectChannel(
  dependencies: ChannelRuntimeDependencies,
  input: ChannelConnectInput,
): Promise<number> {
  return withChannelOperation(input.botId, input.provider, async () => {
    await assertChannelIdentityAvailable(dependencies, input.botId, storedSecretFromInput(input));
    const started = await startChannel(dependencies, input);
    return commitStartedChannel(dependencies, started, storedSecretFromInput(input));
  });
}

export async function saveChannelConnection(
  dependencies: ChannelRuntimeDependencies,
  input: ChannelConnectionSaveInput,
): Promise<number> {
  return withConnectionSettingsOperation(() =>
    withConnectionOperation(input.connectionId, async () => {
      const model = await dependencies.readModel();
      const attached = model.bots.some((bot) =>
        (bot.channelBindings ?? []).some(
          (binding) =>
            binding.connectionId === input.connectionId && binding.status !== "disconnected",
        ),
      );
      if (attached) throw new Error("Disconnect this channel before editing it.");
      const secretKey = connectionSecretName(input.connectionId);
      const previousSecret = await Effect.runPromise(dependencies.secretStore.get(secretKey));
      const settings = await Effect.runPromise(dependencies.settings.getSettings);
      const profile: ChannelConnectionProfile = {
        id: input.connectionId,
        name: input.name,
        provider: input.provider,
        adapter: input.provider === "imessage" ? "photon" : input.provider,
        ...(input.provider === "whatsapp"
          ? { externalIdentity: input.phoneNumberId }
          : input.provider === "imessage"
            ? {
                externalIdentity:
                  input.mode === "hosted" ? input.projectId : (input.phone ?? input.serverUrl),
                ...(input.mode === "hosted"
                  ? {
                      managementUrl: `https://app.photon.codes/dashboard/${encodeURIComponent(input.projectId)}`,
                    }
                  : {}),
              }
            : {}),
      };
      await Effect.runPromise(
        dependencies.secretStore.set(
          secretKey,
          encoder.encode(JSON.stringify(storedSecretFromInput(input))),
        ),
      );
      try {
        await Effect.runPromise(
          dependencies.settings.updateSettings({
            channelConnections: [
              ...settings.channelConnections.filter(
                (connection) => connection.id !== input.connectionId,
              ),
              profile,
            ],
          }),
        );
      } catch (cause) {
        if (previousSecret._tag === "Some") {
          await Effect.runPromise(
            dependencies.secretStore.set(secretKey, previousSecret.value),
          ).catch(() => undefined);
        } else {
          await Effect.runPromise(dependencies.secretStore.remove(secretKey)).catch(
            () => undefined,
          );
        }
        throw cause;
      }
      return 0;
    }),
  );
}

export async function deleteChannelConnection(
  dependencies: ChannelRuntimeDependencies,
  connectionId: ChannelConnectionId,
): Promise<number> {
  return withConnectionSettingsOperation(() =>
    withConnectionOperation(connectionId, async () => {
      const model = await dependencies.readModel();
      if (
        model.bots.some((bot) =>
          (bot.channelBindings ?? []).some(
            (binding) => binding.connectionId === connectionId && binding.status !== "disconnected",
          ),
        )
      ) {
        throw new Error("Disconnect this channel before deleting it.");
      }
      const secretKey = connectionSecretName(connectionId);
      const previousSecret = await Effect.runPromise(dependencies.secretStore.get(secretKey));
      const settings = await Effect.runPromise(dependencies.settings.getSettings);
      await Effect.runPromise(dependencies.secretStore.remove(secretKey));
      try {
        await Effect.runPromise(
          dependencies.settings.updateSettings({
            channelConnections: settings.channelConnections.filter(
              (connection) => connection.id !== connectionId,
            ),
          }),
        );
      } catch (cause) {
        if (previousSecret._tag === "Some") {
          await Effect.runPromise(
            dependencies.secretStore.set(secretKey, previousSecret.value),
          ).catch(() => undefined);
        }
        throw cause;
      }
      return 0;
    }),
  );
}

export async function attachChannelConnection(
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  connectionId: ChannelConnectionId,
  provider: ChannelProvider,
): Promise<number> {
  return withConnectionOperation(connectionId, () =>
    withChannelOperation(botId, provider, async () => {
      const model = await dependencies.readModel();
      const inUse = model.bots.some(
        (bot) =>
          bot.id !== botId &&
          bot.archivedAt === null &&
          (bot.channelBindings ?? []).some(
            (binding) => binding.connectionId === connectionId && binding.status !== "disconnected",
          ),
      );
      if (inUse) throw new Error("This channel connection is attached to another bot.");
      const secret = await loadConnectionSecret(dependencies, connectionId);
      if (!secret || secret.provider !== provider)
        throw new Error("Saved channel connection is unavailable.");
      await assertChannelIdentityAvailable(dependencies, botId, secret);
      const commandId = CommandId.make(await randomId(dependencies, "channel-attach"));
      const started = await startChannel(
        dependencies,
        connectInputFromSecret(botId, commandId, secret),
        connectionId,
      );
      return commitStartedChannel(dependencies, started);
    }),
  );
}

export async function disconnectChannel(
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  provider: ChannelProvider,
): Promise<number> {
  return withChannelOperation(botId, provider, async () => {
    const model = await dependencies.readModel();
    const currentBinding = model.bots
      .find((bot) => bot.id === botId)
      ?.channelBindings?.find((binding) => binding.provider === provider);
    const name = secretName(botId, provider);
    const previousSecret = await Effect.runPromise(dependencies.secretStore.get(name));
    if (!currentBinding?.connectionId) {
      await Effect.runPromise(dependencies.secretStore.remove(name));
    }
    let sequence: number;
    try {
      sequence = await replaceBinding(dependencies, {
        botId,
        provider,
        status: "disconnected",
        externalIdentity: null,
        connectedAt: null,
        sentMessageIds: [],
      });
    } catch (cause) {
      if (previousSecret._tag === "Some") {
        await Effect.runPromise(dependencies.secretStore.set(name, previousSecret.value)).catch(
          () => undefined,
        );
      }
      throw cause;
    }
    await stopRuntime(botId, provider);
    return sequence;
  });
}

export async function reconnectChannel(
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  provider: LiveProvider,
): Promise<number> {
  return withChannelOperation(botId, provider, async () => {
    const model = await dependencies.readModel();
    const binding = model.bots
      .find((bot) => bot.id === botId)
      ?.channelBindings?.find((candidate) => candidate.provider === provider);
    if (!binding || binding.status === "disconnected") {
      throw new Error(`No active ${provider} channel to reconnect.`);
    }
    const secret = binding?.connectionId
      ? await loadConnectionSecret(dependencies, binding.connectionId)
      : await loadSecret(dependencies, botId, provider);
    if (!secret || secret.provider !== provider)
      throw new Error(`No saved ${provider} credentials.`);
    await assertChannelIdentityAvailable(dependencies, botId, secret);
    const commandId = CommandId.make(await randomId(dependencies, "channel-reconnect"));
    const input = connectInputFromSecret(botId, commandId, secret);
    const started = await startChannel(dependencies, input, binding?.connectionId);
    return commitStartedChannel(dependencies, started);
  });
}

export async function restoreConnectedChannels(
  dependencies: ChannelRuntimeDependencies,
): Promise<
  ReadonlyArray<{ readonly botId: BotId; readonly provider: LiveProvider; readonly cause: unknown }>
> {
  const model = await dependencies.readModel();
  const candidates = model.bots.flatMap((bot) =>
    bot.archivedAt === null
      ? (bot.channelBindings ?? []).flatMap((binding) =>
          binding.status === "connected" || binding.status === "needs-reconnect"
            ? [{ botId: bot.id, provider: binding.provider }]
            : [],
        )
      : [],
  );
  const results = await Promise.allSettled(
    candidates.map(async (candidate) => {
      await reconnectChannel(dependencies, candidate.botId, candidate.provider);
    }),
  );
  return results.flatMap((result, index) =>
    result.status === "rejected" ? [{ ...candidates[index]!, cause: result.reason }] : [],
  );
}

export async function sendChannelMessage(
  dependencies: ChannelRuntimeDependencies,
  input: { readonly botId: BotId; readonly threadId: ThreadId; readonly messageId: MessageId },
): Promise<number> {
  const thread = await dependencies.readThread(input.threadId);
  const messageIndex = thread?.messages.findIndex(
    (message) => message.id === input.messageId && message.role === "assistant",
  );
  if (!thread || thread.botId !== input.botId || messageIndex === undefined || messageIndex < 0) {
    throw new Error("Channel reply approval does not match this bot thread.");
  }
  const origin = thread.messages
    .slice(0, messageIndex)
    .toReversed()
    .find((message) => message.role === "user")?.channelOrigin;
  if (!origin) throw new Error("Channel reply approval does not match an inbound channel message.");
  const approvedMessage = thread.messages[messageIndex];
  if (!approvedMessage?.text.trim()) throw new Error("Channel reply is empty.");

  return withChannelOperation(input.botId, origin.provider, async () => {
    const model = await dependencies.readModel();
    const bot = model.bots.find((candidate) => candidate.id === input.botId);
    const binding = bot?.channelBindings?.find(
      (candidate) => candidate.provider === origin.provider,
    );
    if (!bot || bot.archivedAt !== null || !binding)
      throw new Error("Channel binding is unavailable.");
    const claim = await Effect.runPromise(
      dependencies.deliveryStore.claim({
        messageId: input.messageId,
        botId: input.botId,
        threadId: input.threadId,
        provider: origin.provider,
        externalThreadId: origin.externalThreadId,
        requestedAt: await dependencies.nowIso(),
      }),
    );
    if (claim === "requested" && !binding.sentMessageIds.includes(input.messageId)) {
      throw new Error("This channel reply has an unfinished delivery attempt.");
    }
    if (claim === "claimed") {
      const runtime = runtimes.get(runtimeKey(input.botId, origin.provider));
      if (!runtime) {
        await Effect.runPromise(dependencies.deliveryStore.releaseRequested(input.messageId));
        throw new Error(
          `${origin.provider === "imessage" ? "iMessage" : origin.provider === "whatsapp" ? "WhatsApp" : "Telegram"} needs reconnect before this reply can send.`,
        );
      }
      try {
        await runtime.post(origin.externalThreadId, approvedMessage.text);
      } catch (cause) {
        await Effect.runPromise(dependencies.deliveryStore.releaseRequested(input.messageId));
        throw cause;
      }
      try {
        await Effect.runPromise(
          dependencies.deliveryStore.markSent({
            messageId: input.messageId,
            sentAt: await dependencies.nowIso(),
          }),
        );
      } catch (cause) {
        if (!binding.sentMessageIds.includes(input.messageId)) {
          await replaceBinding(dependencies, {
            ...binding,
            sentMessageIds: [...binding.sentMessageIds, input.messageId],
          });
        }
        throw cause;
      }
    } else if (claim === "requested") {
      await Effect.runPromise(
        dependencies.deliveryStore.markSent({
          messageId: input.messageId,
          sentAt: await dependencies.nowIso(),
        }),
      );
    }
    const sequence = binding.sentMessageIds.includes(input.messageId)
      ? model.snapshotSequence
      : await replaceBinding(dependencies, {
          ...binding,
          sentMessageIds: [...binding.sentMessageIds, input.messageId],
        });
    return sequence;
  });
}

export async function resolveCompletedChannelReply(
  dependencies: ChannelRuntimeDependencies,
  threadId: ThreadId,
  turnId: TurnId,
): Promise<{
  readonly botId: BotId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
} | null> {
  const thread = await dependencies.readThread(threadId);
  const latestTurn = thread?.latestTurn;
  if (
    !thread?.botId ||
    latestTurn?.state !== "completed" ||
    latestTurn.turnId !== turnId ||
    !latestTurn.requestMessageId ||
    !latestTurn.assistantMessageId
  ) {
    return null;
  }

  const inboundIndex = thread.messages.findIndex(
    (message) =>
      message.id === latestTurn.requestMessageId &&
      message.role === "user" &&
      message.channelOrigin !== undefined,
  );
  const assistantIndex = thread.messages.findIndex(
    (message) =>
      message.id === latestTurn.assistantMessageId &&
      message.role === "assistant" &&
      message.turnId === turnId &&
      !message.streaming &&
      Boolean(message.text.trim()),
  );
  if (inboundIndex < 0 || assistantIndex <= inboundIndex) return null;

  return {
    botId: thread.botId,
    threadId,
    messageId: latestTurn.assistantMessageId,
  };
}

export async function sendCompletedChannelReply(
  dependencies: ChannelRuntimeDependencies,
  threadId: ThreadId,
  turnId: TurnId,
): Promise<number | null> {
  const target = await resolveCompletedChannelReply(dependencies, threadId, turnId);
  return target ? sendChannelMessage(dependencies, target) : null;
}

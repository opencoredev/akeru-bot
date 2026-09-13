import * as NodeCrypto from "node:crypto";

import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { TelegramProvider } from "@mastra/telegram";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import {
  BotId,
  CHANNEL_PROVIDERS,
  ChannelConnectionId,
  CommandId,
  MessageId,
  ProjectId,
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
import { type Adapter, Chat, type Message, type Thread } from "chat";
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

/** Transport adapters must confirm that no part of the reply was accepted before using this error. */
export class ChannelPostRejectedError extends Error {
  override readonly name = "ChannelPostRejectedError";
}

const channelDeliveryUnknownError =
  "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.";
const channelDeliveryRejectedError =
  "The channel rejected this reply. Correct the channel problem, then retry.";

const isSlackPostRejection = Schema.is(
  Schema.Union([
    Schema.Struct({
      code: Schema.Literal("slack_webapi_platform_error"),
      data: Schema.Struct({
        ok: Schema.Literal(false),
        error: Schema.Literals([
          "channel_not_found",
          "not_in_channel",
          "is_archived",
          "missing_scope",
          "no_permission",
          "invalid_auth",
          "not_authed",
          "token_revoked",
          "account_inactive",
          "msg_too_long",
          "no_text",
          "restricted_action",
        ]),
      }),
    }),
    Schema.Struct({ code: Schema.Literal("slack_webapi_rate_limited_error") }),
    Schema.Struct({
      name: Schema.Literal("AdapterRateLimitError"),
      adapter: Schema.Literal("slack"),
      code: Schema.Literal("RATE_LIMITED"),
    }),
  ]),
);

const isDiscordPostRejection = Schema.is(
  Schema.Struct({
    name: Schema.Literal("NetworkError"),
    adapter: Schema.Literal("discord"),
    code: Schema.Literal("NETWORK_ERROR"),
    originalError: Schema.Struct({
      name: Schema.Literal("DiscordApiError"),
      status: Schema.Literals([400, 401, 403, 404, 429]),
      code: Schema.Literals([10003, 10008, 50001, 50013, 50014, 50035, 20028, 20029]),
    }),
  }),
);

const isTelegramPostRejection = Schema.is(
  Schema.Union([
    Schema.Struct({
      name: Schema.Literal("AuthenticationError"),
      adapter: Schema.Literal("telegram"),
      code: Schema.Literal("AUTH_FAILED"),
    }),
    Schema.Struct({
      name: Schema.Literal("PermissionError"),
      adapter: Schema.Literal("telegram"),
      code: Schema.Literal("PERMISSION_DENIED"),
      action: Schema.Literal("sendMessage"),
    }),
    Schema.Struct({
      name: Schema.Literal("ResourceNotFoundError"),
      adapter: Schema.Literal("telegram"),
      code: Schema.Literal("NOT_FOUND"),
      resourceType: Schema.Literal("sendMessage"),
    }),
    Schema.Struct({
      name: Schema.Literal("AdapterRateLimitError"),
      adapter: Schema.Literal("telegram"),
      code: Schema.Literal("RATE_LIMITED"),
    }),
  ]),
);

async function postChannelText(
  chat: Chat,
  provider: ChannelProvider,
  threadId: string,
  text: string,
) {
  const outcome = await chat
    .thread(threadId)
    .post(text)
    .then(
      () => "sent" as const,
      (cause: unknown) => {
        // These classifiers cover text-only posts, not partial attachment batches.
        const rejected =
          cause instanceof Error &&
          (provider === "slack"
            ? isSlackPostRejection(cause)
            : provider === "discord"
              ? isDiscordPostRejection(cause)
              : provider === "telegram"
                ? isTelegramPostRejection(cause)
                : false);
        return rejected ? ("rejected" as const) : ("unknown" as const);
      },
    );
  // Provider errors can contain credentials. Do not retain their messages or causes.
  if (outcome === "rejected") throw new ChannelPostRejectedError(channelDeliveryRejectedError);
  if (outcome === "unknown") throw new Error(channelDeliveryUnknownError);
}

interface ChannelRuntimeEntry {
  readonly post: (externalThreadId: string, text: string) => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly webhook?: (request: Request) => Promise<Response>;
  readonly react?: (
    externalThreadId: string,
    externalMessageId: string,
    emoji: string,
  ) => Promise<void>;
  readonly removeReaction?: (
    externalThreadId: string,
    externalMessageId: string,
    emoji: string,
  ) => Promise<void>;
  readonly clearThreadStatus?: (threadId: ThreadId) => Promise<void>;
  readonly isHealthy?: () => boolean;
}

interface StartedChannel {
  readonly binding: ChannelBinding;
  readonly runtime: ChannelRuntimeEntry;
}

interface InboundChannelMessage {
  readonly externalThreadId: string;
  readonly externalMessageId?: string;
  readonly externalSenderId?: string;
  readonly externalSenderName?: string;
  readonly text: string;
}

interface ChannelTransportContext {
  readonly botName: string;
  readonly subscribedThreadIds: ReadonlyArray<string>;
  readonly onMention: (input: InboundChannelMessage) => Promise<void>;
  readonly onSubscribedMessage: (input: InboundChannelMessage) => Promise<void>;
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
export const CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT = 128;
export const CHANNEL_MENTION_CONTEXT_LIMIT = 10;
export const CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT = 8_000;
const gatewayRenewalDurationMs = 60 * 60 * 1_000;
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
  Schema.Struct({
    provider: Schema.Literal("slack"),
    botToken: Schema.String,
    appToken: Schema.String,
  }),
  Schema.Struct({
    provider: Schema.Literal("discord"),
    botToken: Schema.String,
    applicationId: Schema.String,
    publicKey: Schema.String,
  }),
]);
type StoredChannelSecret = typeof StoredChannelSecret.Type;
const decodeStoredChannelSecret = Schema.decodeUnknownEffect(StoredChannelSecret);

const runtimeKey = (botId: string, provider: ChannelProvider) => `${botId}:${provider}`;
const operationKey = (provider: ChannelProvider) => provider;
const secretName = (botId: BotId, provider: ChannelProvider) =>
  `channel-${provider}-${NodeCrypto.createHash("sha256").update(botId).digest("hex")}`;
const connectionSecretName = (connectionId: ChannelConnectionId) =>
  `channel-connection-${NodeCrypto.createHash("sha256").update(connectionId).digest("hex")}`;

export const channelThreadId = (
  botId: BotId,
  projectId: ProjectId,
  provider: LiveProvider,
  externalThreadId: string,
): ThreadId =>
  ThreadId.make(
    `channel-${NodeCrypto.createHash("sha256")
      .update(`${botId}\0${projectId}\0${provider}\0${externalThreadId}`)
      .digest("hex")}`,
  );

const legacyChannelThreadId = (
  botId: BotId,
  provider: LiveProvider,
  externalThreadId: string,
): ThreadId =>
  ThreadId.make(
    `channel-${NodeCrypto.createHash("sha256")
      .update(`${botId}\0${provider}\0${externalThreadId}`)
      .digest("hex")}`,
  );

const deterministicChannelId = (
  prefix: string,
  input: {
    readonly botId: BotId;
    readonly projectId: ProjectId;
    readonly provider: ChannelProvider;
    readonly externalThreadId: string;
    readonly externalMessageId: string;
  },
) =>
  `${prefix}-${NodeCrypto.createHash("sha256")
    .update(
      `${input.botId}\0${input.projectId}\0${input.provider}\0${input.externalThreadId}\0${input.externalMessageId}`,
    )
    .digest("hex")}`;

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

const normalizedInboundMessage = (
  thread: Thread,
  message: Message,
  text = message.text,
): InboundChannelMessage => ({
  externalThreadId: thread.id,
  externalMessageId: message.id,
  externalSenderId: message.author.userId,
  externalSenderName: message.author.fullName || message.author.userName,
  text,
});

export async function mentionWithContext(
  thread: Thread,
  message: Message,
): Promise<InboundChannelMessage> {
  await thread.refresh().catch(() => undefined);
  const context = thread.recentMessages
    .filter(
      (candidate) =>
        candidate.id !== message.id &&
        candidate.author.isBot !== true &&
        candidate.author.isMe !== true &&
        candidate.text.trim(),
    )
    .slice(-CHANNEL_MENTION_CONTEXT_LIMIT)
    .map(
      (candidate) =>
        `${candidate.author.fullName || candidate.author.userName || candidate.author.userId}: ${candidate.text}`,
    );
  const boundedContext = context.join("\n").slice(-CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT);
  return normalizedInboundMessage(
    thread,
    message,
    boundedContext.length === 0 ? message.text : `${boundedContext}\n${message.text}`,
  );
}

async function subscribedExternalThreadIds(
  dependencies: ChannelRuntimeDependencies,
  model: OrchestrationReadModel,
  botId: BotId,
  projectId: ProjectId,
  provider: ChannelProvider,
): Promise<ReadonlyArray<string>> {
  const candidateIds = model.threads.flatMap((thread) =>
    thread.botId === botId &&
    thread.projectId === projectId &&
    thread.groupId === null &&
    thread.deletedAt === null
      ? [thread.id]
      : [],
  );
  const threads = await Promise.all(
    candidateIds.map((threadId) => dependencies.readThread(threadId)),
  );
  const ids = new Set<string>();
  for (const thread of threads) {
    if (!thread) continue;
    for (const message of thread.messages) {
      if (message.channelOrigin?.provider === provider) {
        ids.add(message.channelOrigin.externalThreadId);
      }
    }
  }
  return [...ids];
}

export function channelBindingsForRuntime(
  bindings: ReadonlyArray<ChannelBinding>,
  isRunning: (botId: BotId, provider: ChannelProvider) => boolean = (botId, provider) => {
    const runtime = runtimes.get(runtimeKey(botId, provider));
    return runtime !== undefined && (runtime.isHealthy?.() ?? true);
  },
): ReadonlyArray<ChannelBinding> {
  return bindings.map((binding) =>
    binding.status === "connected" && !isRunning(binding.botId, binding.provider)
      ? { ...binding, status: "needs-reconnect" }
      : binding,
  );
}

const randomId = async (dependencies: ChannelRuntimeDependencies, prefix: string) =>
  `${prefix}-${await dependencies.randomUuid()}`;

const channelProviderName = (provider: ChannelProvider) =>
  provider === "imessage"
    ? "iMessage"
    : provider === "whatsapp"
      ? "WhatsApp"
      : provider === "telegram"
        ? "Telegram"
        : provider === "slack"
          ? "Slack"
          : "Discord";

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
): StoredChannelSecret => {
  if (input.provider === "telegram") return { provider: "telegram", token: input.token };
  if (input.provider === "whatsapp") {
    return {
      provider: "whatsapp",
      accessToken: input.accessToken,
      appSecret: input.appSecret,
      phoneNumberId: input.phoneNumberId,
      verifyToken: input.verifyToken,
    };
  }
  if (input.provider === "slack") {
    return { provider: "slack", botToken: input.botToken, appToken: input.appToken };
  }
  if (input.provider === "discord") {
    return {
      provider: "discord",
      botToken: input.botToken,
      applicationId: input.applicationId,
      publicKey: input.publicKey,
    };
  }
  return input.mode === "hosted"
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
};

const connectInputFromSecret = (
  botId: BotId,
  targetProjectId: ProjectId,
  commandId: CommandId,
  secret: StoredChannelSecret,
): ChannelConnectInput => {
  if (secret.provider === "telegram") {
    return {
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "telegram",
      token: secret.token,
    };
  }
  if (secret.provider === "whatsapp") {
    return {
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "whatsapp",
      accessToken: secret.accessToken,
      appSecret: secret.appSecret,
      phoneNumberId: secret.phoneNumberId,
      verifyToken: secret.verifyToken,
    };
  }
  if (secret.provider === "slack") {
    return {
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "slack",
      botToken: secret.botToken,
      appToken: secret.appToken,
    };
  }
  if (secret.provider === "discord") {
    return {
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "discord",
      botToken: secret.botToken,
      applicationId: secret.applicationId,
      publicKey: secret.publicKey,
    };
  }
  if (secret.mode === "hosted" && secret.projectId && secret.projectSecret) {
    return {
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "imessage",
      mode: "hosted",
      projectId: secret.projectId,
      projectSecret: secret.projectSecret,
    };
  }
  if (secret.mode === "self-hosted" && secret.serverUrl && secret.apiKey) {
    return {
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "imessage",
      mode: "self-hosted",
      serverUrl: secret.serverUrl,
      apiKey: secret.apiKey,
      ...(secret.phone ? { phone: secret.phone } : {}),
    };
  }
  throw new Error("Saved channel credentials are incomplete.");
};

const channelSecretIdentity = (secret: StoredChannelSecret): string => {
  if (secret.provider === "telegram") return `telegram:${secret.token}`;
  if (secret.provider === "whatsapp") return `whatsapp:${secret.phoneNumberId}`;
  if (secret.provider === "slack") return `slack:${secret.botToken}`;
  if (secret.provider === "discord") return `discord:${secret.applicationId}`;
  return secret.mode === "hosted"
    ? `imessage:hosted:${secret.projectId ?? ""}`
    : `imessage:self-hosted:${secret.serverUrl ?? ""}:${secret.phone ?? ""}`;
};

async function assertChannelIdentityAvailable(
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  candidateSecret: StoredChannelSecret,
): Promise<void> {
  const model = await dependencies.readModel();
  for (const bot of model.bots) {
    if (bot.id === botId || bot.archivedAt !== null) continue;
    for (const binding of bot.channelBindings ?? []) {
      if (
        binding.provider !== candidateSecret.provider ||
        (binding.status === "disconnected" && !binding.connectionId)
      ) {
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
    readonly projectId: ProjectId;
    readonly provider: LiveProvider;
    readonly externalThreadId: string;
    readonly externalMessageId?: string;
    readonly externalSenderId?: string;
    readonly externalSenderName?: string;
    readonly text: string;
  },
): Promise<void> {
  const preferredThreadId = channelThreadId(
    input.botId,
    input.projectId,
    input.provider,
    input.externalThreadId,
  );
  const previous = inboundQueues.get(preferredThreadId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const model = await dependencies.readModel();
      const bot = model.bots.find(
        (candidate) => candidate.id === input.botId && candidate.archivedAt === null,
      );
      if (!bot) throw new Error(`Bot '${input.botId}' is unavailable.`);
      const project = model.projects.find(
        (candidate) => candidate.id === input.projectId && candidate.deletedAt === null,
      );
      if (!project) {
        const binding = bot.channelBindings.find(
          (entry) => entry.provider === input.provider && entry.projectId === input.projectId,
        );
        if (binding) {
          await replaceBinding(dependencies, {
            ...binding,
            status: "failed",
            lastAttemptAt: await dependencies.nowIso(),
            lastError: "The selected project is unavailable. Choose another project.",
          }).catch(() => undefined);
        }
        throw new Error("The channel project is unavailable.");
      }
      const modelSelection = bot.engine
        ? {
            instanceId: ProviderInstanceId.make(bot.engine.provider),
            model: bot.engine.model,
            ...(bot.engine.options ? { options: bot.engine.options } : {}),
          }
        : project.defaultModelSelection;
      if (!modelSelection)
        throw new Error(`Bot '${bot.name}' needs a model before channel messages.`);

      const legacyThreadId = legacyChannelThreadId(
        input.botId,
        input.provider,
        input.externalThreadId,
      );
      const existing = model.threads.find(
        (thread) =>
          (thread.id === preferredThreadId || thread.id === legacyThreadId) &&
          thread.projectId === input.projectId &&
          thread.deletedAt === null,
      );
      const threadId = existing?.id ?? preferredThreadId;
      const createdAt = await dependencies.nowIso();
      if (!existing) {
        await Effect.runPromise(
          dependencies.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`channel-create-${threadId}`),
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
      } else if (
        existing.botId !== bot.id ||
        existing.groupId != null ||
        existing.projectId !== project.id
      ) {
        throw new Error(`Channel thread '${threadId}' belongs to another owner.`);
      }

      const deterministicInput = input.externalMessageId
        ? {
            botId: input.botId,
            projectId: input.projectId,
            provider: input.provider,
            externalThreadId: input.externalThreadId,
            externalMessageId: input.externalMessageId,
          }
        : null;
      const commandId = CommandId.make(
        deterministicInput
          ? deterministicChannelId("channel-turn", deterministicInput)
          : await randomId(dependencies, "channel-turn"),
      );
      const messageId = MessageId.make(
        deterministicInput
          ? deterministicChannelId("channel-message", deterministicInput)
          : await randomId(dependencies, "channel-message"),
      );
      await Effect.runPromise(
        dependencies.engine.dispatch({
          type: "thread.turn.start",
          commandId,
          threadId,
          message: {
            messageId,
            role: "user",
            text: input.text,
            attachments: [],
            channelOrigin: {
              provider: input.provider,
              externalThreadId: input.externalThreadId,
              ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
              ...(input.externalSenderId ? { externalSenderId: input.externalSenderId } : {}),
            },
          },
          ...(input.externalSenderName ? { senderDisplayName: input.externalSenderName } : {}),
          modelSelection,
          runtimeMode: bot.runtimeMode,
          interactionMode: "default",
          createdAt,
        }),
      );
    });
  inboundQueues.set(preferredThreadId, next);
  try {
    await next;
  } finally {
    if (inboundQueues.get(preferredThreadId) === next) inboundQueues.delete(preferredThreadId);
  }
}

const boundedSentMessageIds = (messageIds: ReadonlyArray<MessageId>) =>
  messageIds.slice(-CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT);

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
        ...(binding.projectId &&
        binding.projectId === previousBinding?.projectId &&
        previousBinding.lastError === channelDeliveryUnknownError
          ? { lastError: channelDeliveryUnknownError }
          : {}),
        sentMessageIds: boundedSentMessageIds(
          binding.status === "disconnected" && !binding.connectionId
            ? binding.sentMessageIds
            : binding.sentMessageIds.length > 0
              ? binding.sentMessageIds
              : (previousBinding?.sentMessageIds ?? []),
        ),
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
    CHANNEL_PROVIDERS.map((provider) =>
      withChannelOperation(botId, provider, () => stopRuntime(botId, provider)),
    ),
  );
}

export async function clearChannelThreadStatuses(threadId: ThreadId): Promise<void> {
  await Promise.allSettled(
    [...runtimes.entries()].map(([key, runtime]) => {
      const separator = key.lastIndexOf(":");
      const botId = BotId.make(key.slice(0, separator));
      const provider = CHANNEL_PROVIDERS.find((value) => value === key.slice(separator + 1));
      return provider
        ? withChannelOperation(botId, provider, async () => {
            if (runtimes.get(key) === runtime) await runtime.clearThreadStatus?.(threadId);
          })
        : Promise.resolve();
    }),
  );
}

export const stopArchivedBotChannels = (events: Stream.Stream<OrchestrationEvent>) =>
  Stream.runForEach(events, (event) =>
    event.type === "bot.archived"
      ? Effect.promise(() => stopChannelsForBot(event.payload.botId))
      : event.type === "thread.deleted" || event.type === "thread.archived"
        ? Effect.promise(() => clearChannelThreadStatuses(event.payload.threadId))
        : Effect.void,
  );

export async function shutdownAllChannels(): Promise<void> {
  await Promise.allSettled(
    [...runtimes.entries()].map(([key, entry]) => {
      const separator = key.lastIndexOf(":");
      const botId = BotId.make(key.slice(0, separator));
      const provider = CHANNEL_PROVIDERS.find((value) => value === key.slice(separator + 1));
      return provider
        ? withChannelOperation(botId, provider, async () => {
            if (runtimes.get(key) !== entry) return;
            runtimes.delete(key);
            await entry.shutdown();
          })
        : Promise.resolve();
    }),
  );
}

async function initializeChannelChat(chat: Chat): Promise<void> {
  try {
    await chat.initialize();
  } catch (cause) {
    await chat.shutdown().catch(() => undefined);
    throw cause;
  }
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
  const chat = new Chat({
    userName: installation.username ?? "Akeru Bot",
    adapters: { telegram: adapter as Adapter },
    state: createMemoryState(),
  });
  chat.onDirectMessage(async (thread, message) => {
    if (!message.text.trim()) return;
    await onDirectMessage(normalizedInboundMessage(thread, message));
  });
  try {
    await initializeChannelChat(chat);
    if (!adapter.botUserId) {
      await chat.shutdown();
      throw new Error("Telegram did not identify the connected bot.");
    }
  } catch (cause) {
    await provider.disconnect(botId).catch(() => undefined);
    throw cause;
  }
  return {
    externalIdentity: installation.username ? `@${installation.username}` : botId,
    runtime: {
      post: (externalThreadId, text) => postChannelText(chat, "telegram", externalThreadId, text),
      shutdown: async () => {
        await chat.shutdown();
        await provider.disconnect(botId).catch(() => undefined);
      },
    },
  };
}

export async function startRenewingGateway(
  start: (
    waitUntil: (task: Promise<unknown>) => void,
    durationMs: number,
    signal: AbortSignal,
  ) => Promise<Response>,
  label: string,
): Promise<{
  readonly shutdown: () => Promise<void>;
  readonly isHealthy: () => boolean;
  readonly settled: Promise<void>;
}> {
  const abort = new AbortController();
  let healthy = true;
  let activeTask: Promise<unknown> | undefined;
  let startedAt = 0;
  const launch = async () => {
    activeTask = undefined;
    startedAt = performance.now();
    const response = await start(
      (task) => {
        activeTask = task;
      },
      gatewayRenewalDurationMs,
      abort.signal,
    );
    if (!response.ok || !activeTask) {
      throw new Error(`${label} failed with status ${response.status}.`);
    }
    return { task: activeTask };
  };
  const firstTask = (await launch()).task;
  const supervisor = (async () => {
    let task = firstTask;
    while (!abort.signal.aborted) {
      await task;
      if (!abort.signal.aborted) {
        if (performance.now() - startedAt < gatewayRenewalDurationMs) {
          throw new Error(`${label} stopped before its renewal deadline.`);
        }
        task = (await launch()).task;
      }
    }
  })().catch(() => {
    healthy = false;
  });
  return {
    isHealthy: () => healthy,
    settled: supervisor,
    shutdown: async () => {
      healthy = false;
      abort.abort();
      await supervisor;
    },
  };
}

function registerThreadedHandlers(chat: Chat, context: ChannelTransportContext) {
  chat.onNewMention(async (thread, message) => {
    if (!message.text.trim()) return;
    await thread.subscribe();
    await context.onMention(await mentionWithContext(thread, message));
  });
  chat.onSubscribedMessage(async (thread, message) => {
    if (!message.text.trim()) return;
    await context.onSubscribedMessage(normalizedInboundMessage(thread, message));
  });
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
    await onDirectMessage(normalizedInboundMessage(thread, message));
  });
  await initializeChannelChat(chat);
  const gateway = await startRenewingGateway(
    (waitUntil, durationMs, signal) =>
      adapter.startGatewayListener({ waitUntil }, durationMs, signal),
    "Photon gateway",
  ).catch(async (cause) => {
    await chat.shutdown();
    throw cause;
  });
  return {
    externalIdentity:
      input.mode === "self-hosted" && input.phone
        ? input.phone
        : input.mode === "hosted"
          ? "Photon hosted"
          : "Photon self-hosted",
    runtime: {
      post: (externalThreadId, text) => postChannelText(chat, "imessage", externalThreadId, text),
      isHealthy: gateway.isHealthy,
      shutdown: async () => {
        await gateway.shutdown();
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
    await onDirectMessage(normalizedInboundMessage(thread, message));
  });
  await initializeChannelChat(chat);
  return {
    externalIdentity: input.phoneNumberId,
    runtime: {
      post: (externalThreadId, text) => postChannelText(chat, "whatsapp", externalThreadId, text),
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

async function startSlack(
  input: Extract<ChannelConnectInput, { readonly provider: "slack" }>,
  context: ChannelTransportContext,
  onDirectMessage: Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1],
): Promise<{ readonly externalIdentity: string; readonly runtime: ChannelRuntimeEntry }> {
  const adapter = createSlackAdapter({
    mode: "socket",
    botToken: input.botToken,
    appToken: input.appToken,
    // An internal retry could hide an accepted request behind a later rejection.
    webClientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
  });
  const state = createMemoryState();
  await state.connect();
  await Promise.all(context.subscribedThreadIds.map((threadId) => state.subscribe(threadId)));
  const chat = new Chat({
    userName: context.botName,
    adapters: { slack: adapter as Adapter },
    state,
  });
  chat.onDirectMessage(async (thread, message) => {
    if (!message.text.trim()) return;
    await onDirectMessage(normalizedInboundMessage(thread, message));
  });
  registerThreadedHandlers(chat, context);
  await initializeChannelChat(chat);
  if (!adapter.botUserId) {
    await chat.shutdown();
    throw new Error("Slack bot credentials are invalid.");
  }
  await Promise.allSettled(
    context.subscribedThreadIds.map((externalThreadId) =>
      chat.thread(externalThreadId).subscribe(),
    ),
  );
  return {
    externalIdentity: adapter.botUserId,
    runtime: {
      react: (externalThreadId, externalMessageId, emoji) =>
        adapter.addReaction(externalThreadId, externalMessageId, emoji),
      removeReaction: (externalThreadId, externalMessageId, emoji) =>
        adapter.removeReaction(externalThreadId, externalMessageId, emoji),
      post: (externalThreadId, text) => postChannelText(chat, "slack", externalThreadId, text),
      shutdown: () => chat.shutdown(),
    },
  };
}

async function startDiscord(
  input: Extract<ChannelConnectInput, { readonly provider: "discord" }>,
  context: ChannelTransportContext,
  onDirectMessage: Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1],
): Promise<{ readonly externalIdentity: string; readonly runtime: ChannelRuntimeEntry }> {
  const adapter = createDiscordAdapter({
    applicationId: input.applicationId,
    botToken: input.botToken,
    publicKey: input.publicKey,
  });
  const chat = new Chat({
    userName: context.botName,
    adapters: { discord: adapter as Adapter },
    state: createMemoryState(),
  });
  chat.onDirectMessage(async (thread, message) => {
    if (!message.text.trim()) return;
    await onDirectMessage(normalizedInboundMessage(thread, message));
  });
  registerThreadedHandlers(chat, context);
  await initializeChannelChat(chat);
  const identity = await adapter.getUser(input.applicationId).catch(async (cause) => {
    await chat.shutdown().catch(() => undefined);
    throw cause;
  });
  if (!identity) {
    await chat.shutdown();
    throw new Error("Discord credentials are invalid.");
  }
  await Promise.allSettled(
    context.subscribedThreadIds.map((externalThreadId) =>
      chat.thread(externalThreadId).subscribe(),
    ),
  );
  const gateway = await startRenewingGateway(
    (waitUntil, durationMs, signal) =>
      adapter.startGatewayListener({ waitUntil }, durationMs, signal),
    "Discord gateway",
  ).catch(async (cause) => {
    await chat.shutdown();
    throw cause;
  });
  return {
    externalIdentity: `${identity.userName} (${identity.userId})`,
    runtime: {
      post: (externalThreadId, text) => postChannelText(chat, "discord", externalThreadId, text),
      react: (externalThreadId, externalMessageId, emoji) =>
        adapter.addReaction(externalThreadId, externalMessageId, emoji),
      removeReaction: (externalThreadId, externalMessageId, emoji) =>
        adapter.removeReaction(externalThreadId, externalMessageId, emoji),
      isHealthy: gateway.isHealthy,
      shutdown: async () => {
        await gateway.shutdown();
        await chat.shutdown();
      },
    },
  };
}

const channelStatusReactions = ["eyes", "white_check_mark", "x"] as const;
type ChannelOrigin = NonNullable<OrchestrationThread["messages"][number]["channelOrigin"]>;
type ChannelStatus = {
  origin: ChannelOrigin;
  status: (typeof channelStatusReactions)[number];
  threadId?: ThreadId;
};
const channelStatuses = new WeakMap<ChannelRuntimeEntry, Map<string, ChannelStatus>>();

async function updateChannelStatus(
  runtime: ChannelRuntimeEntry,
  origin: ChannelOrigin,
  status?: (typeof channelStatusReactions)[number],
  threadId?: ThreadId,
): Promise<void> {
  if (
    (origin.provider !== "slack" && origin.provider !== "discord") ||
    !origin.externalMessageId ||
    !runtime.removeReaction ||
    !runtime.react
  )
    return;
  const statuses = channelStatuses.get(runtime) ?? new Map<string, ChannelStatus>();
  channelStatuses.set(runtime, statuses);
  const key = JSON.stringify([origin.externalThreadId, origin.externalMessageId]);
  if (status && statuses.get(key)?.status === status) return;
  statuses.delete(key);
  for (const emoji of channelStatusReactions) {
    await runtime
      .removeReaction(origin.externalThreadId, origin.externalMessageId, emoji)
      .catch(() => undefined);
  }
  if (status) {
    if (statuses.size >= CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT) {
      const oldest = statuses.values().next().value;
      if (oldest) await updateChannelStatus(runtime, oldest.origin);
    }
    await runtime
      .react(origin.externalThreadId, origin.externalMessageId, status)
      .catch(() => undefined);
    statuses.set(key, { origin, status, ...(threadId ? { threadId } : {}) });
  }
}

async function clearPersistedChannelStatuses(
  dependencies: ChannelRuntimeDependencies,
  runtime: ChannelRuntimeEntry,
  botId: BotId,
  provider: ChannelProvider,
): Promise<void> {
  if (provider !== "slack" && provider !== "discord") return;
  const model = await dependencies.readModel();
  for (const summary of model.threads) {
    if (summary.botId !== botId) continue;
    const thread = await dependencies.readThread(summary.id);
    for (const message of thread?.messages ?? []) {
      const origin = message.channelOrigin;
      if (origin?.provider === provider) {
        await updateChannelStatus(runtime, origin);
      }
    }
  }
}

export async function finishChannelTurn(
  dependencies: ChannelRuntimeDependencies,
  threadId: ThreadId,
  turnId: TurnId | undefined,
  state: "completed" | "failed" | "cancelled",
  requestMessageId?: MessageId,
): Promise<void> {
  const thread = await dependencies.readThread(threadId);
  if (!thread?.botId) return;
  const botId = thread.botId;
  const request = requestMessageId
    ? thread.messages.find((message) => message.id === requestMessageId)
    : !turnId
      ? thread.messages.findLast((message) => message.role === "user")
      : thread.messages.find(
          (message) =>
            message.id === thread.latestTurn?.requestMessageId &&
            thread.latestTurn?.turnId === turnId,
        );
  const origin = request?.channelOrigin;
  if (!origin) return;
  await withChannelOperation(botId, origin.provider, async () => {
    const runtime = runtimes.get(runtimeKey(botId, origin.provider));
    if (!runtime) return;
    const current = await dependencies.readThread(threadId);
    if (current?.messages.findLast((message) => message.role === "user")?.id !== request.id) return;
    await updateChannelStatus(
      runtime,
      origin,
      state === "completed" ? "white_check_mark" : "x",
      threadId,
    );
  });
}

async function startChannel(
  dependencies: ChannelRuntimeDependencies,
  input: ChannelConnectInput,
  connectionId?: ChannelConnectionId,
): Promise<StartedChannel> {
  const model = await dependencies.readModel();
  const bot = model.bots.find((candidate) => candidate.id === input.botId);
  if (!bot || bot.archivedAt !== null) throw new Error(`Bot '${input.botId}' is unavailable.`);
  const project = model.projects.find(
    (candidate) => candidate.id === input.targetProjectId && candidate.deletedAt === null,
  );
  if (!project) throw new Error("The selected channel project is unavailable.");
  let runtime: ChannelRuntimeEntry | undefined;
  const dispatch = (message: InboundChannelMessage) =>
    withChannelOperation(bot.id, input.provider, async () => {
      if (!runtime || runtimes.get(runtimeKey(bot.id, input.provider)) !== runtime) return;
      const currentModel = await dependencies.readModel();
      let duplicate = false;
      if (message.externalMessageId) {
        for (const summary of currentModel.threads) {
          if (summary.botId !== bot.id || summary.projectId !== project.id) continue;
          const thread = await dependencies.readThread(summary.id);
          duplicate ||=
            thread?.messages.some(
              (entry) =>
                entry.channelOrigin?.provider === input.provider &&
                entry.channelOrigin.externalThreadId === message.externalThreadId &&
                entry.channelOrigin.externalMessageId === message.externalMessageId,
            ) ?? false;
        }
      }
      await dispatchInboundChannelMessage(dependencies, {
        ...message,
        botId: bot.id,
        projectId: project.id,
        provider: input.provider,
      });
      if (!duplicate) {
        for (const { origin } of channelStatuses.get(runtime)?.values() ?? []) {
          if (origin.externalThreadId === message.externalThreadId)
            await updateChannelStatus(runtime, origin);
        }
        await updateChannelStatus(runtime, { provider: input.provider, ...message }, "eyes");
      }
    });
  const context: ChannelTransportContext = {
    botName: bot.name,
    subscribedThreadIds: await subscribedExternalThreadIds(
      dependencies,
      model,
      bot.id,
      project.id,
      input.provider,
    ),
    onMention: dispatch,
    onSubscribedMessage: dispatch,
  };
  const started = dependencies.startTransport
    ? await dependencies.startTransport(input, dispatch, context)
    : input.provider === "telegram"
      ? await startTelegram(bot.id, input.token, dispatch)
      : input.provider === "imessage"
        ? await startIMessage(input, context, dispatch)
        : input.provider === "whatsapp"
          ? await startWhatsApp(input, context, dispatch)
          : input.provider === "slack"
            ? await startSlack(input, context, dispatch)
            : await startDiscord(input, context, dispatch);
  await clearPersistedChannelStatuses(dependencies, started.runtime, bot.id, input.provider);
  const clearTrackedStatuses = async (threadId?: ThreadId) => {
    if (!runtime) return;
    for (const { origin, threadId: statusThreadId } of channelStatuses.get(runtime)?.values() ??
      []) {
      if (
        !threadId ||
        threadId === statusThreadId ||
        channelThreadId(bot.id, project.id, input.provider, origin.externalThreadId) === threadId ||
        legacyChannelThreadId(bot.id, input.provider, origin.externalThreadId) === threadId
      ) {
        await updateChannelStatus(runtime, origin);
      }
    }
  };
  runtime = {
    ...started.runtime,
    clearThreadStatus: clearTrackedStatuses,
    shutdown: async () => {
      try {
        await clearTrackedStatuses();
      } finally {
        await started.runtime.shutdown();
      }
    },
  };
  return {
    runtime,
    binding: {
      botId: bot.id,
      ...(connectionId ? { connectionId } : {}),
      projectId: project.id,
      provider: input.provider,
      status: "connected",
      externalIdentity: started.externalIdentity,
      connectedAt: await dependencies.nowIso(),
      lastAttemptAt: await dependencies.nowIso(),
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
        (bot.channelBindings ?? []).some((binding) => binding.connectionId === input.connectionId),
      );
      if (attached) throw new Error("Unassign this channel before editing it.");
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
            : input.provider === "slack"
              ? { managementUrl: "https://api.slack.com/apps" }
              : input.provider === "discord"
                ? {
                    externalIdentity: input.applicationId,
                    managementUrl: `https://discord.com/developers/applications/${encodeURIComponent(input.applicationId)}`,
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
          (bot.channelBindings ?? []).some((binding) => binding.connectionId === connectionId),
        )
      ) {
        throw new Error("Unassign this channel before deleting it.");
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

/**
 * The project a bot works in when a channel does not name one. Matches the in-app chat
 * default: the project with the most recent live activity, then the most recently updated.
 */
export function defaultProjectIdForBot(
  model: Pick<OrchestrationReadModel, "projects" | "threads">,
  botId: BotId,
): ProjectId | null {
  const live = model.projects.filter((project) => project.deletedAt === null);
  if (live.length === 0) return null;
  const latestActivity = new Map<ProjectId, string>();
  for (const thread of model.threads) {
    if (thread.archivedAt !== null) continue;
    const previous = latestActivity.get(thread.projectId);
    if (!previous || thread.updatedAt > previous)
      latestActivity.set(thread.projectId, thread.updatedAt);
  }
  const botThreads = model.threads.filter(
    (thread) => thread.botId === botId && thread.archivedAt === null,
  );
  const botProject = botThreads
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => live.find((project) => project.id === thread.projectId))
    .find((project) => project !== undefined);
  if (botProject) return botProject.id;
  return live.toSorted(
    (left, right) =>
      (latestActivity.get(right.id) ?? right.updatedAt).localeCompare(
        latestActivity.get(left.id) ?? left.updatedAt,
      ) || left.title.localeCompare(right.title),
  )[0]!.id;
}

export async function attachChannelConnection(
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  connectionId: ChannelConnectionId,
  requestedProjectId: ProjectId | undefined,
  provider: ChannelProvider,
): Promise<number> {
  return withConnectionOperation(connectionId, () =>
    withChannelOperation(botId, provider, async () => {
      const model = await dependencies.readModel();
      const projectId = requestedProjectId ?? defaultProjectIdForBot(model, botId);
      if (!projectId) throw new Error("Add a project before connecting a channel.");
      const inUse = model.bots.some(
        (bot) =>
          bot.id !== botId &&
          bot.archivedAt === null &&
          (bot.channelBindings ?? []).some((binding) => binding.connectionId === connectionId),
      );
      if (inUse) throw new Error("This channel connection is attached to another bot.");
      const secret = await loadConnectionSecret(dependencies, connectionId);
      if (!secret || secret.provider !== provider)
        throw new Error("Saved channel connection is unavailable.");
      await assertChannelIdentityAvailable(dependencies, botId, secret);
      const commandId = CommandId.make(await randomId(dependencies, "channel-attach"));
      const started = await startChannel(
        dependencies,
        connectInputFromSecret(botId, projectId, commandId, secret),
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
    if (!currentBinding) throw new Error(`No ${provider} channel is assigned to this bot.`);
    const sequence = await replaceBinding(dependencies, {
      ...currentBinding,
      status: "disconnected",
      connectedAt: null,
      lastAttemptAt: await dependencies.nowIso(),
    });
    await stopRuntime(botId, provider);
    return sequence;
  });
}

export async function detachChannelConnection(
  dependencies: ChannelRuntimeDependencies,
  botId: BotId,
  provider: ChannelProvider,
): Promise<number> {
  return withChannelOperation(botId, provider, async () => {
    const model = await dependencies.readModel();
    const currentBinding = model.bots
      .find((bot) => bot.id === botId)
      ?.channelBindings?.find((binding) => binding.provider === provider);
    if (!currentBinding) throw new Error(`No ${provider} channel is assigned to this bot.`);
    const name = secretName(botId, provider);
    const previousSecret = currentBinding.connectionId
      ? undefined
      : await Effect.runPromise(dependencies.secretStore.get(name));
    if (!currentBinding.connectionId) {
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
      if (previousSecret?._tag === "Some") {
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
    if (!binding) {
      throw new Error(`No ${provider} channel is assigned to this bot.`);
    }
    const secret = binding?.connectionId
      ? await loadConnectionSecret(dependencies, binding.connectionId)
      : await loadSecret(dependencies, botId, provider);
    if (!secret || secret.provider !== provider)
      throw new Error(`No saved ${provider} credentials.`);
    if (!binding.projectId) throw new Error("Select a project before reconnecting this channel.");
    await assertChannelIdentityAvailable(dependencies, botId, secret);
    const commandId = CommandId.make(await randomId(dependencies, "channel-reconnect"));
    const input = connectInputFromSecret(botId, binding.projectId, commandId, secret);
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
      try {
        await reconnectChannel(dependencies, candidate.botId, candidate.provider);
      } catch {
        const latest = await dependencies.readModel();
        const binding = latest.bots
          .find((bot) => bot.id === candidate.botId)
          ?.channelBindings?.find((entry) => entry.provider === candidate.provider);
        if (binding) {
          await replaceBinding(dependencies, {
            ...binding,
            status: "failed",
            lastAttemptAt: await dependencies.nowIso(),
            lastError: "Connection restore failed. Reconnect with updated credentials.",
          }).catch(() => undefined);
        }
        throw new Error("Channel restore failed.");
      }
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
    if (binding.projectId !== thread.projectId) {
      throw new Error("This reply belongs to a previous channel project assignment.");
    }
    if (binding.status !== "connected") {
      throw new Error("Reconnect this channel before sending a reply.");
    }
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
    const unfinishedDeliveryError = channelDeliveryUnknownError;
    if (claim === "requested" && !binding.sentMessageIds.includes(input.messageId)) {
      await replaceBinding(dependencies, {
        ...binding,
        lastAttemptAt: await dependencies.nowIso(),
        lastError: unfinishedDeliveryError,
      });
      throw new Error(unfinishedDeliveryError);
    }
    if (claim === "claimed" && !binding.sentMessageIds.includes(input.messageId)) {
      const runtime = runtimes.get(runtimeKey(input.botId, origin.provider));
      if (!runtime) {
        await Effect.runPromise(dependencies.deliveryStore.releaseRequested(input.messageId));
        throw new Error(
          `${channelProviderName(origin.provider)} needs reconnect before this reply can send.`,
        );
      }
      try {
        await runtime.post(origin.externalThreadId, approvedMessage.text);
      } catch (cause) {
        const rejected = cause instanceof ChannelPostRejectedError;
        if (rejected) {
          await Effect.runPromise(dependencies.deliveryStore.releaseRequested(input.messageId));
        }
        await replaceBinding(dependencies, {
          ...binding,
          lastAttemptAt: await dependencies.nowIso(),
          lastError: rejected ? channelDeliveryRejectedError : unfinishedDeliveryError,
        });
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
            sentMessageIds: boundedSentMessageIds([...binding.sentMessageIds, input.messageId]),
          });
        }
        throw cause;
      }
    } else if (claim !== "sent") {
      await Effect.runPromise(
        dependencies.deliveryStore.markSent({
          messageId: input.messageId,
          sentAt: await dependencies.nowIso(),
        }),
      );
    }
    const { lastError, ...sentBinding } = binding;
    const sequence = binding.sentMessageIds.includes(input.messageId)
      ? model.snapshotSequence
      : await replaceBinding(dependencies, {
          ...sentBinding,
          ...(lastError && lastError !== channelDeliveryRejectedError ? { lastError } : {}),
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

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
  type ChannelConnectionId,
  CommandId,
  MessageId,
  type ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TurnId,
  type ChannelBinding,
  type ChannelConnectionProfile,
  type ChannelProvider,
  type ClientOrchestrationCommand,
  type OrchestrationEvent,
  type ServerSettingsError,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { type Adapter, Chat, type Message, type Thread } from "chat";
import { Context } from "effect";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerSecretStore, type SecretStoreError } from "../auth/ServerSecretStore.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ChannelDeliveryStore, type ChannelDeliveryStoreShape } from "./ChannelDeliveryStore.ts";

/** Transport adapters must confirm that no part of the reply was accepted before using this error. */
export class ChannelPostRejectedError extends Schema.TaggedErrorClass<ChannelPostRejectedError>()(
  "ChannelPostRejectedError",
  { message: Schema.String },
) {}

/** A channel operation failed. The message is safe to show and never carries provider errors. */
export class ChannelRuntimeError extends Schema.TaggedErrorClass<ChannelRuntimeError>()(
  "ChannelRuntimeError",
  { message: Schema.String },
) {}

const failWith = (message: string) => Effect.fail(new ChannelRuntimeError({ message }));

/** A transport SDK promise rejected. The message is the SDK's own; the cause keeps the original. */
export class ChannelTransportError extends Schema.TaggedErrorClass<ChannelTransportError>()(
  "ChannelTransportError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** Runs an SDK promise and keeps its original rejection as the cause. */
const fromPromise = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, ChannelTransportError> =>
  Effect.tryPromise({
    try: () => evaluate(),
    catch: (cause) =>
      new ChannelTransportError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const isChannelPostRejected = Schema.is(ChannelPostRejectedError);

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

const postChannelText = (chat: Chat, provider: ChannelProvider, threadId: string, text: string) =>
  Effect.tryPromise({
    try: () => chat.thread(threadId).post(text),
    // These classifiers cover text-only posts, not partial attachment batches.
    // Provider errors can contain credentials. Do not retain their messages or causes.
    catch: (cause) =>
      cause instanceof Error &&
      (provider === "slack"
        ? isSlackPostRejection(cause)
        : provider === "discord"
          ? isDiscordPostRejection(cause)
          : provider === "telegram"
            ? isTelegramPostRejection(cause)
            : false)
        ? new ChannelPostRejectedError({ message: channelDeliveryRejectedError })
        : new ChannelRuntimeError({ message: channelDeliveryUnknownError }),
  }).pipe(Effect.asVoid);

/** Promise-shaped transport handle. Injected transports return this; the runtime adapts it. */
export interface ChannelTransportRuntime {
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
  readonly isHealthy?: () => boolean;
}

/** Ways a running transport can fail. */
type ChannelTransportFailure =
  | ChannelTransportError
  | ChannelPostRejectedError
  | ChannelRuntimeError;

/** Everything a channel operation can fail with. */
export type ChannelOperationError =
  | ChannelTransportFailure
  | OrchestrationDispatchError
  | SecretStoreError
  | ServerSettingsError
  | Schema.SchemaError
  | PlatformError.PlatformError;

interface ChannelRuntimeEntry {
  readonly post: (
    externalThreadId: string,
    text: string,
  ) => Effect.Effect<void, ChannelTransportFailure>;
  readonly shutdown: Effect.Effect<void, ChannelTransportFailure>;
  readonly webhook?: (request: Request) => Effect.Effect<Response, ChannelTransportFailure>;
  readonly react?: (
    externalThreadId: string,
    externalMessageId: string,
    emoji: string,
  ) => Effect.Effect<void, ChannelTransportFailure>;
  readonly removeReaction?: (
    externalThreadId: string,
    externalMessageId: string,
    emoji: string,
  ) => Effect.Effect<void, ChannelTransportFailure>;
  readonly clearThreadStatus?: (threadId: ThreadId) => Effect.Effect<void>;
  readonly isHealthy?: () => boolean;
}

const fromTransportRuntime = (runtime: ChannelTransportRuntime): ChannelRuntimeEntry => {
  const { webhook, react, removeReaction, isHealthy } = runtime;
  return {
    // Injected transports signal a definite provider rejection by throwing ChannelPostRejectedError.
    post: (externalThreadId, text) =>
      Effect.tryPromise({
        try: () => runtime.post(externalThreadId, text),
        catch: (cause) =>
          isChannelPostRejected(cause)
            ? cause
            : new ChannelTransportError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }),
    shutdown: fromPromise(() => runtime.shutdown()),
    ...(webhook ? { webhook: (request: Request) => fromPromise(() => webhook(request)) } : {}),
    ...(react
      ? {
          react: (externalThreadId: string, externalMessageId: string, emoji: string) =>
            fromPromise(() => react(externalThreadId, externalMessageId, emoji)),
        }
      : {}),
    ...(removeReaction
      ? {
          removeReaction: (externalThreadId: string, externalMessageId: string, emoji: string) =>
            fromPromise(() => removeReaction(externalThreadId, externalMessageId, emoji)),
        }
      : {}),
    ...(isHealthy ? { isHealthy } : {}),
  };
};

interface StartedTransport {
  readonly externalIdentity: string;
  readonly runtime: ChannelRuntimeEntry;
}

interface StartedChannel {
  readonly binding: ChannelBinding;
  readonly runtime: ChannelRuntimeEntry;
}

export interface InboundChannelMessage {
  readonly externalThreadId: string;
  readonly externalMessageId?: string;
  readonly externalSenderId?: string;
  readonly externalSenderName?: string;
  readonly text: string;
}

/** SDK callback that hands an inbound message to the runtime that owns the transport. */
type InboundCallback = (input: InboundChannelMessage) => Promise<void>;

export interface ChannelTransportContext {
  readonly botName: string;
  readonly subscribedThreadIds: ReadonlyArray<string>;
  readonly onMention: InboundCallback;
  readonly onSubscribedMessage: InboundCallback;
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
  readonly engine: OrchestrationEngineShape;
  readonly secretStore: ServerSecretStore["Service"];
  readonly settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettings">;
  readonly deliveryStore: ChannelDeliveryStoreShape;
  readonly readModel: Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThread | null, ProjectionRepositoryError>;
  readonly nowIso: Effect.Effect<string>;
  readonly randomUuid: Effect.Effect<string, PlatformError.PlatformError>;
  /** Replaces the built-in adapters. Tests use it to drive transports directly. */
  readonly startTransport?: (
    input: ChannelConnectInput,
    onDirectMessage: InboundCallback,
    context: ChannelTransportContext,
  ) => Promise<{ readonly externalIdentity: string; readonly runtime: ChannelTransportRuntime }>;
}

export interface ChannelReplyTarget {
  readonly botId: BotId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

export interface ChannelRestoreFailure {
  readonly botId: BotId;
  readonly provider: LiveProvider;
  readonly cause: unknown;
}

const channelStatusReactions = ["eyes", "white_check_mark", "x"] as const;
type ChannelOrigin = NonNullable<OrchestrationThread["messages"][number]["channelOrigin"]>;
type ChannelStatus = {
  origin: ChannelOrigin;
  status: (typeof channelStatusReactions)[number];
  threadId?: ThreadId;
};

type KeyedLock = (
  key: string,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/** Everything one runtime owns. Created by the layer and closed with its scope. */
interface ChannelRuntimeContext {
  readonly deps: ChannelRuntimeDependencies;
  readonly runtimes: Map<string, ChannelRuntimeEntry>;
  readonly statuses: WeakMap<ChannelRuntimeEntry, Map<string, ChannelStatus>>;
  readonly withLock: KeyedLock;
  /** Runs SDK callback work as a fiber of the runtime scope. */
  readonly runSdkCallback: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** Parent of every transport's own scope, such as a renewing gateway. */
  readonly transportScope: Scope.Scope;
  closed: boolean;
}

/**
 * FIFO mutual exclusion per key. A queued caller keeps its place until it runs, so
 * operations on one key happen in the order they were requested. An interrupted caller
 * leaves the queue without blocking the callers behind it.
 */
export const makeKeyedLock = (): KeyedLock => {
  const queues = new Map<string, Array<() => void>>();
  const releaseKey = (key: string) => {
    const next = queues.get(key)?.shift();
    if (next) next();
    else queues.delete(key);
  };
  const acquire = (key: string) =>
    Effect.callback<void>((resume) => {
      const waiters = queues.get(key);
      if (!waiters) {
        queues.set(key, []);
        resume(Effect.void);
        return;
      }
      let granted = false;
      const waiter = () => {
        granted = true;
        resume(Effect.void);
      };
      waiters.push(waiter);
      // An interrupted waiter leaves the queue, or passes the key on if it was just granted.
      return Effect.sync(() => {
        if (granted) releaseKey(key);
        else waiters.splice(waiters.indexOf(waiter), 1);
      });
    });
  return (key) => (effect) =>
    Effect.uninterruptibleMask((restore) =>
      restore(acquire(key)).pipe(
        Effect.andThen(restore(effect).pipe(Effect.ensuring(Effect.sync(() => releaseKey(key))))),
      ),
    );
};

export const CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT = 128;
export const CHANNEL_MENTION_CONTEXT_LIMIT = 10;
export const CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT = 8_000;
export const CHANNEL_GATEWAY_RENEWAL_INTERVAL = Duration.hours(1);
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
const StoredChannelSecretJson = Schema.fromJsonString(StoredChannelSecret);
const decodeStoredChannelSecret = Schema.decodeUnknownEffect(StoredChannelSecretJson);
const encodeStoredChannelSecretJson = Schema.encodeEffect(StoredChannelSecretJson);
const encodeStoredChannelSecret = (secret: StoredChannelSecret) =>
  encodeStoredChannelSecretJson(secret).pipe(Effect.map((json) => encoder.encode(json)));

const runtimeKey = (botId: string, provider: ChannelProvider) => `${botId}:${provider}`;
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

const subscribedExternalThreadIds = (
  ctx: ChannelRuntimeContext,
  model: OrchestrationReadModel,
  botId: BotId,
  projectId: ProjectId,
  provider: ChannelProvider,
) =>
  Effect.gen(function* () {
    const candidateIds = model.threads.flatMap((thread) =>
      thread.botId === botId &&
      thread.projectId === projectId &&
      thread.groupId === null &&
      thread.deletedAt === null
        ? [thread.id]
        : [],
    );
    const threads = yield* Effect.forEach(candidateIds, ctx.deps.readThread, {
      concurrency: "unbounded",
    });
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
  });

/** Marks connected bindings whose transport is not running as needing a reconnect. */
export function channelBindingsForRuntime(
  bindings: ReadonlyArray<ChannelBinding>,
  isRunning: (botId: BotId, provider: ChannelProvider) => boolean,
): ReadonlyArray<ChannelBinding> {
  return bindings.map((binding) =>
    binding.status === "connected" && !isRunning(binding.botId, binding.provider)
      ? { ...binding, status: "needs-reconnect" }
      : binding,
  );
}

const randomId = (ctx: ChannelRuntimeContext, prefix: string) =>
  ctx.deps.randomUuid.pipe(Effect.map((uuid) => `${prefix}-${uuid}`));

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

const decodeSecret = (stored: Option.Option<Uint8Array>) =>
  Option.isNone(stored)
    ? Effect.succeed(null)
    : decodeStoredChannelSecret(decoder.decode(stored.value));

const loadSecret = (ctx: ChannelRuntimeContext, botId: BotId, provider: LiveProvider) =>
  ctx.deps.secretStore.get(secretName(botId, provider)).pipe(Effect.flatMap(decodeSecret));

const loadConnectionSecret = (ctx: ChannelRuntimeContext, connectionId: ChannelConnectionId) =>
  ctx.deps.secretStore.get(connectionSecretName(connectionId)).pipe(Effect.flatMap(decodeSecret));

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
): Effect.Effect<ChannelConnectInput, ChannelRuntimeError> => {
  if (secret.provider === "telegram") {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "telegram",
      token: secret.token,
    });
  }
  if (secret.provider === "whatsapp") {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "whatsapp",
      accessToken: secret.accessToken,
      appSecret: secret.appSecret,
      phoneNumberId: secret.phoneNumberId,
      verifyToken: secret.verifyToken,
    });
  }
  if (secret.provider === "slack") {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "slack",
      botToken: secret.botToken,
      appToken: secret.appToken,
    });
  }
  if (secret.provider === "discord") {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "discord",
      botToken: secret.botToken,
      applicationId: secret.applicationId,
      publicKey: secret.publicKey,
    });
  }
  if (secret.mode === "hosted" && secret.projectId && secret.projectSecret) {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "imessage",
      mode: "hosted",
      projectId: secret.projectId,
      projectSecret: secret.projectSecret,
    });
  }
  if (secret.mode === "self-hosted" && secret.serverUrl && secret.apiKey) {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "imessage",
      mode: "self-hosted",
      serverUrl: secret.serverUrl,
      apiKey: secret.apiKey,
      ...(secret.phone ? { phone: secret.phone } : {}),
    });
  }
  return failWith("Saved channel credentials are incomplete.");
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

const assertChannelIdentityAvailable = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  candidateSecret: StoredChannelSecret,
) =>
  Effect.gen(function* () {
    const model = yield* ctx.deps.readModel;
    for (const bot of model.bots) {
      if (bot.id === botId || bot.archivedAt !== null) continue;
      for (const binding of bot.channelBindings ?? []) {
        if (
          binding.provider !== candidateSecret.provider ||
          (binding.status === "disconnected" && !binding.connectionId)
        ) {
          continue;
        }
        const secret = yield* (
          binding.connectionId
            ? loadConnectionSecret(ctx, binding.connectionId)
            : loadSecret(ctx, bot.id, binding.provider)
        ).pipe(Effect.orElseSucceed(() => null));
        if (secret && channelSecretIdentity(secret) === channelSecretIdentity(candidateSecret)) {
          return yield* failWith("This channel connection is already connected to another bot.");
        }
      }
    }
  });

interface InboundDispatchInput extends InboundChannelMessage {
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly provider: LiveProvider;
}

const dispatchInboundChannelMessage = (ctx: ChannelRuntimeContext, input: InboundDispatchInput) => {
  const deps = ctx.deps;
  const preferredThreadId = channelThreadId(
    input.botId,
    input.projectId,
    input.provider,
    input.externalThreadId,
  );
  return ctx.withLock(`inbound:${preferredThreadId}`)(
    Effect.gen(function* () {
      const model = yield* deps.readModel;
      const bot = model.bots.find(
        (candidate) => candidate.id === input.botId && candidate.archivedAt === null,
      );
      if (!bot) return yield* failWith(`Bot '${input.botId}' is unavailable.`);
      const project = model.projects.find(
        (candidate) => candidate.id === input.projectId && candidate.deletedAt === null,
      );
      if (!project) {
        const binding = bot.channelBindings.find(
          (entry) => entry.provider === input.provider && entry.projectId === input.projectId,
        );
        if (binding) {
          yield* Effect.gen(function* () {
            yield* replaceBinding(ctx, {
              ...binding,
              status: "failed",
              lastAttemptAt: yield* deps.nowIso,
              lastError: "The selected project is unavailable. Choose another project.",
            });
          }).pipe(Effect.ignoreCause);
        }
        return yield* failWith("The channel project is unavailable.");
      }
      const modelSelection = bot.engine
        ? {
            instanceId: ProviderInstanceId.make(bot.engine.provider),
            model: bot.engine.model,
            ...(bot.engine.options ? { options: bot.engine.options } : {}),
          }
        : project.defaultModelSelection;
      if (!modelSelection)
        return yield* failWith(`Bot '${bot.name}' needs a model before channel messages.`);

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
      const createdAt = yield* deps.nowIso;
      if (!existing) {
        yield* deps.engine.dispatch({
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
        });
      } else if (
        existing.botId !== bot.id ||
        existing.groupId != null ||
        existing.projectId !== project.id
      ) {
        return yield* failWith(`Channel thread '${threadId}' belongs to another owner.`);
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
          : yield* randomId(ctx, "channel-turn"),
      );
      const messageId = MessageId.make(
        deterministicInput
          ? deterministicChannelId("channel-message", deterministicInput)
          : yield* randomId(ctx, "channel-message"),
      );
      yield* deps.engine.dispatch({
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
      });
    }),
  );
};

const boundedSentMessageIds = (messageIds: ReadonlyArray<MessageId>) =>
  messageIds.slice(-CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT);

const replaceBinding = (ctx: ChannelRuntimeContext, binding: ChannelBinding) =>
  ctx.withLock(`binding:${binding.botId}`)(
    Effect.gen(function* () {
      const model = yield* ctx.deps.readModel;
      const bot = model.bots.find((candidate) => candidate.id === binding.botId);
      if (!bot) return yield* failWith(`Bot '${binding.botId}' does not exist.`);
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
      const receipt = yield* ctx.deps.engine.dispatch({
        type: "bot.update",
        commandId: CommandId.make(yield* randomId(ctx, "channel-binding")),
        botId: bot.id,
        channelBindings: [
          ...(bot.channelBindings ?? []).filter(
            (candidate) => candidate.provider !== binding.provider,
          ),
          nextBinding,
        ],
      });
      return receipt.sequence;
    }),
  );

const withChannelOperation = (ctx: ChannelRuntimeContext, provider: ChannelProvider) =>
  ctx.withLock(`channel:${provider}`);

const withConnectionOperation = (ctx: ChannelRuntimeContext, connectionId: ChannelConnectionId) =>
  ctx.withLock(`connection:${connectionId}`);

const withConnectionSettingsOperation = (ctx: ChannelRuntimeContext) =>
  ctx.withLock("connection-settings");

const stopRuntime = (ctx: ChannelRuntimeContext, botId: BotId, provider: ChannelProvider) =>
  Effect.suspend(() => {
    const key = runtimeKey(botId, provider);
    const runtime = ctx.runtimes.get(key);
    if (!runtime) return Effect.void;
    ctx.runtimes.delete(key);
    return runtime.shutdown;
  });

/** Runs `operation` for each running transport under its channel lock, ignoring failures. */
const forEachRuntime = (
  ctx: ChannelRuntimeContext,
  operation: (
    key: string,
    runtime: ChannelRuntimeEntry,
  ) => Effect.Effect<void, ChannelTransportFailure>,
) =>
  // Suspended so each run sees the transports running at that moment.
  Effect.suspend(() =>
    Effect.forEach(
      [...ctx.runtimes.entries()],
      ([key, runtime]) => {
        const provider = CHANNEL_PROVIDERS.find(
          (value) => value === key.slice(key.lastIndexOf(":") + 1),
        );
        return provider
          ? withChannelOperation(ctx, provider)(operation(key, runtime)).pipe(Effect.ignoreCause)
          : Effect.void;
      },
      { concurrency: "unbounded", discard: true },
    ),
  );

const stopChannelsForBot = (ctx: ChannelRuntimeContext, botId: BotId) =>
  Effect.forEach(
    CHANNEL_PROVIDERS,
    (provider) =>
      withChannelOperation(
        ctx,
        provider,
      )(stopRuntime(ctx, botId, provider)).pipe(Effect.ignoreCause),
    { concurrency: "unbounded", discard: true },
  );

const clearChannelThreadStatuses = (ctx: ChannelRuntimeContext, threadId: ThreadId) =>
  forEachRuntime(ctx, (key, runtime) =>
    ctx.runtimes.get(key) === runtime && runtime.clearThreadStatus
      ? runtime.clearThreadStatus(threadId)
      : Effect.void,
  );

const shutdownAllChannels = (ctx: ChannelRuntimeContext) =>
  forEachRuntime(ctx, (key, runtime) =>
    Effect.suspend(() => {
      if (ctx.runtimes.get(key) !== runtime) return Effect.void;
      ctx.runtimes.delete(key);
      return runtime.shutdown;
    }),
  );

const stopArchivedBotChannels = <E, R>(
  ctx: ChannelRuntimeContext,
  events: Stream.Stream<OrchestrationEvent, E, R>,
) =>
  Stream.runForEach(events, (event) =>
    event.type === "bot.archived"
      ? stopChannelsForBot(ctx, event.payload.botId)
      : event.type === "thread.deleted" || event.type === "thread.archived"
        ? clearChannelThreadStatuses(ctx, event.payload.threadId)
        : Effect.void,
  );

const shutdownChat = (chat: Chat) => fromPromise(() => chat.shutdown());

const initializeChannelChat = (chat: Chat) =>
  fromPromise(() => chat.initialize()).pipe(
    Effect.onError(() => shutdownChat(chat).pipe(Effect.ignoreCause)),
  );

const startTelegram = (botId: BotId, token: string, onDirectMessage: InboundCallback) =>
  Effect.gen(function* () {
    const provider = new TelegramProvider({ mode: "polling", commands: [] });
    const connected = yield* fromPromise(() =>
      provider.connect(botId, { botToken: token, commands: [] }),
    );
    if (connected.type !== "immediate")
      return yield* failWith("Telegram did not connect immediately.");
    const installation = yield* fromPromise(() => provider.getInstallation(botId));
    const adapter = provider.getAdapter(connected.installationId);
    if (!installation || !adapter)
      return yield* failWith("Telegram did not create an active adapter.");
    const chat = new Chat({
      userName: installation.username ?? "Akeru Bot",
      adapters: { telegram: adapter as Adapter },
      state: createMemoryState(),
    });
    chat.onDirectMessage(async (thread, message) => {
      if (!message.text.trim()) return;
      await onDirectMessage(normalizedInboundMessage(thread, message));
    });
    const disconnect = fromPromise(() => provider.disconnect(botId)).pipe(Effect.ignoreCause);
    yield* Effect.gen(function* () {
      yield* initializeChannelChat(chat);
      if (!adapter.botUserId) {
        yield* shutdownChat(chat);
        return yield* failWith("Telegram did not identify the connected bot.");
      }
    }).pipe(Effect.onError(() => disconnect));
    return {
      externalIdentity: installation.username ? `@${installation.username}` : botId,
      runtime: {
        post: (externalThreadId, text) => postChannelText(chat, "telegram", externalThreadId, text),
        shutdown: shutdownChat(chat).pipe(Effect.andThen(disconnect)),
      },
    } satisfies StartedTransport;
  });

export interface RenewingGateway {
  readonly isHealthy: () => boolean;
  /** Completes when the supervisor stops, after a failure or shutdown. */
  readonly settled: Effect.Effect<void>;
  /** Aborts the listener, stops renewal, and waits for the listener task to finish. */
  readonly shutdown: Effect.Effect<void>;
}

/**
 * Keeps a time-limited gateway listener alive. Each cycle launches a listener that ends
 * itself at the renewal deadline and watches it until then; a schedule repeats the cycle.
 * Each cycle aborts and awaits the previous listener before launching the next one.
 * The first launch completes before this returns, and a failed first launch fails it.
 * A listener that stops early or fails to renew leaves the gateway unhealthy. Renewal
 * runs in its own child of the caller's scope, so closing that scope stops it.
 */
export const startRenewingGateway = (
  start: (
    waitUntil: (task: Promise<unknown>) => void,
    durationMs: number,
    signal: AbortSignal,
  ) => Promise<Response>,
  label: string,
): Effect.Effect<RenewingGateway, ChannelRuntimeError | ChannelTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Scope.Scope);
    let abort = new AbortController();
    const durationMs = Duration.toMillis(CHANNEL_GATEWAY_RENEWAL_INTERVAL);
    let healthy = true;
    let activeTask: Promise<unknown> | undefined;
    const currentTask = () => activeTask;
    const settle = (task: Promise<unknown>) => Effect.promise(() => task);
    const launch = Effect.gen(function* () {
      // A listener still running at its deadline must stop before the next one starts.
      const previous = currentTask();
      abort.abort();
      if (previous) yield* settle(previous);
      abort = new AbortController();
      activeTask = undefined;
      const response = yield* fromPromise(() =>
        start(
          (task) => {
            // Observe the task at once so an early rejection is never unhandled.
            activeTask = task.then(
              () => undefined,
              () => undefined,
            );
          },
          durationMs,
          abort.signal,
        ),
      );
      const task = currentTask();
      if (!response.ok || !task)
        return yield* failWith(`${label} failed with status ${response.status}.`);
      return task;
    });
    const watch = (task: Promise<unknown>) =>
      settle(task).pipe(
        Effect.andThen(failWith(`${label} stopped before its renewal deadline.`)),
        Effect.timeoutOption(CHANNEL_GATEWAY_RENEWAL_INTERVAL),
      );
    // The first listener launches before this returns, so callers see it running.
    const first = yield* launch.pipe(
      Effect.onError(() =>
        Scope.close(scope, Exit.void).pipe(Effect.andThen(Effect.sync(() => abort.abort()))),
      ),
    );
    const renew = launch.pipe(Effect.flatMap(watch), Effect.repeat(Schedule.forever));
    const supervisor = yield* watch(first).pipe(
      Effect.andThen(renew),
      Effect.onError(() =>
        Effect.sync(() => {
          healthy = false;
        }),
      ),
      Effect.ignoreCause,
      Effect.forkIn(scope),
    );
    return {
      isHealthy: () => healthy,
      settled: Fiber.await(supervisor).pipe(Effect.asVoid),
      shutdown: Effect.gen(function* () {
        healthy = false;
        yield* Scope.close(scope, Exit.void);
        abort.abort();
        const task = currentTask();
        if (task) yield* settle(task);
      }),
    } satisfies RenewingGateway;
  });

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

const onDirectText = (chat: Chat, onDirectMessage: InboundCallback) =>
  chat.onDirectMessage(async (thread, message) => {
    if (!message.text.trim()) return;
    await onDirectMessage(normalizedInboundMessage(thread, message));
  });

const subscribeThreads = (chat: Chat, context: ChannelTransportContext) =>
  Effect.promise(() =>
    Promise.allSettled(
      context.subscribedThreadIds.map((externalThreadId) =>
        chat.thread(externalThreadId).subscribe(),
      ),
    ),
  );

const startIMessage = (
  input: Extract<ChannelConnectInput, { readonly provider: "imessage" }>,
  context: ChannelTransportContext,
  onDirectMessage: InboundCallback,
) =>
  Effect.gen(function* () {
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
    onDirectText(chat, onDirectMessage);
    yield* initializeChannelChat(chat);
    const gateway = yield* startRenewingGateway(
      (waitUntil, durationMs, signal) =>
        adapter.startGatewayListener({ waitUntil }, durationMs, signal),
      "Photon gateway",
    ).pipe(Effect.onError(() => shutdownChat(chat).pipe(Effect.ignoreCause)));
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
        shutdown: gateway.shutdown.pipe(Effect.andThen(shutdownChat(chat))),
      },
    } satisfies StartedTransport;
  });

const startWhatsApp = (
  input: Extract<ChannelConnectInput, { readonly provider: "whatsapp" }>,
  context: ChannelTransportContext,
  onDirectMessage: InboundCallback,
) =>
  Effect.gen(function* () {
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
    onDirectText(chat, onDirectMessage);
    yield* initializeChannelChat(chat);
    return {
      externalIdentity: input.phoneNumberId,
      runtime: {
        post: (externalThreadId, text) => postChannelText(chat, "whatsapp", externalThreadId, text),
        shutdown: shutdownChat(chat),
        webhook: (request) =>
          Effect.gen(function* () {
            const tasks: Promise<unknown>[] = [];
            const response = yield* fromPromise(() =>
              adapter.handleWebhook(request, { waitUntil: (task) => void tasks.push(task) }),
            ).pipe(Effect.option);
            if (Option.isNone(response))
              return new Response("Invalid webhook payload", { status: 400 });
            const results = yield* Effect.promise(() => Promise.allSettled(tasks));
            return results.some((result) => result.status === "rejected")
              ? new Response("Webhook processing failed", { status: 500 })
              : response.value;
          }),
      },
    } satisfies StartedTransport;
  });

const startSlack = (
  input: Extract<ChannelConnectInput, { readonly provider: "slack" }>,
  context: ChannelTransportContext,
  onDirectMessage: InboundCallback,
) =>
  Effect.gen(function* () {
    const adapter = createSlackAdapter({
      mode: "socket",
      botToken: input.botToken,
      appToken: input.appToken,
      // An internal retry could hide an accepted request behind a later rejection.
      webClientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
    });
    const state = createMemoryState();
    yield* fromPromise(() => state.connect());
    yield* fromPromise(() =>
      Promise.all(context.subscribedThreadIds.map((threadId) => state.subscribe(threadId))),
    );
    const chat = new Chat({
      userName: context.botName,
      adapters: { slack: adapter as Adapter },
      state,
    });
    onDirectText(chat, onDirectMessage);
    registerThreadedHandlers(chat, context);
    yield* initializeChannelChat(chat);
    if (!adapter.botUserId) {
      yield* shutdownChat(chat);
      return yield* failWith("Slack bot credentials are invalid.");
    }
    yield* subscribeThreads(chat, context);
    return {
      externalIdentity: adapter.botUserId,
      runtime: {
        react: (externalThreadId, externalMessageId, emoji) =>
          fromPromise(() => adapter.addReaction(externalThreadId, externalMessageId, emoji)),
        removeReaction: (externalThreadId, externalMessageId, emoji) =>
          fromPromise(() => adapter.removeReaction(externalThreadId, externalMessageId, emoji)),
        post: (externalThreadId, text) => postChannelText(chat, "slack", externalThreadId, text),
        shutdown: shutdownChat(chat),
      },
    } satisfies StartedTransport;
  });

const startDiscord = (
  input: Extract<ChannelConnectInput, { readonly provider: "discord" }>,
  context: ChannelTransportContext,
  onDirectMessage: InboundCallback,
) =>
  Effect.gen(function* () {
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
    onDirectText(chat, onDirectMessage);
    registerThreadedHandlers(chat, context);
    yield* initializeChannelChat(chat);
    const identity = yield* fromPromise(() => adapter.getUser(input.applicationId)).pipe(
      Effect.onError(() => shutdownChat(chat).pipe(Effect.ignoreCause)),
    );
    if (!identity) {
      yield* shutdownChat(chat);
      return yield* failWith("Discord credentials are invalid.");
    }
    yield* subscribeThreads(chat, context);
    const gateway = yield* startRenewingGateway(
      (waitUntil, durationMs, signal) =>
        adapter.startGatewayListener({ waitUntil }, durationMs, signal),
      "Discord gateway",
    ).pipe(Effect.onError(() => shutdownChat(chat).pipe(Effect.ignoreCause)));
    return {
      externalIdentity: `${identity.userName} (${identity.userId})`,
      runtime: {
        post: (externalThreadId, text) => postChannelText(chat, "discord", externalThreadId, text),
        react: (externalThreadId, externalMessageId, emoji) =>
          fromPromise(() => adapter.addReaction(externalThreadId, externalMessageId, emoji)),
        removeReaction: (externalThreadId, externalMessageId, emoji) =>
          fromPromise(() => adapter.removeReaction(externalThreadId, externalMessageId, emoji)),
        isHealthy: gateway.isHealthy,
        shutdown: gateway.shutdown.pipe(Effect.andThen(shutdownChat(chat))),
      },
    } satisfies StartedTransport;
  });

const startBuiltInTransport = (
  botId: BotId,
  input: ChannelConnectInput,
  context: ChannelTransportContext,
  onDirectMessage: InboundCallback,
): Effect.Effect<StartedTransport, ChannelRuntimeError | ChannelTransportError, Scope.Scope> =>
  input.provider === "telegram"
    ? startTelegram(botId, input.token, onDirectMessage)
    : input.provider === "imessage"
      ? startIMessage(input, context, onDirectMessage)
      : input.provider === "whatsapp"
        ? startWhatsApp(input, context, onDirectMessage)
        : input.provider === "slack"
          ? startSlack(input, context, onDirectMessage)
          : startDiscord(input, context, onDirectMessage);

const updateChannelStatus = (
  ctx: ChannelRuntimeContext,
  runtime: ChannelRuntimeEntry,
  origin: ChannelOrigin,
  status?: (typeof channelStatusReactions)[number],
  threadId?: ThreadId,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { react, removeReaction } = runtime;
    const externalMessageId = origin.externalMessageId;
    if (
      (origin.provider !== "slack" && origin.provider !== "discord") ||
      !externalMessageId ||
      !removeReaction ||
      !react
    )
      return;
    const statuses = ctx.statuses.get(runtime) ?? new Map<string, ChannelStatus>();
    ctx.statuses.set(runtime, statuses);
    const key = `${origin.externalThreadId}\u0000${externalMessageId}`;
    if (status && statuses.get(key)?.status === status) return;
    statuses.delete(key);
    for (const emoji of channelStatusReactions) {
      yield* removeReaction(origin.externalThreadId, externalMessageId, emoji).pipe(
        Effect.ignoreCause,
      );
    }
    if (status) {
      if (statuses.size >= CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT) {
        const oldest = statuses.values().next().value;
        if (oldest) yield* updateChannelStatus(ctx, runtime, oldest.origin);
      }
      yield* react(origin.externalThreadId, externalMessageId, status).pipe(Effect.ignoreCause);
      statuses.set(key, { origin, status, ...(threadId ? { threadId } : {}) });
    }
  });

const clearPersistedChannelStatuses = (
  ctx: ChannelRuntimeContext,
  runtime: ChannelRuntimeEntry,
  botId: BotId,
  provider: ChannelProvider,
) =>
  Effect.gen(function* () {
    if (provider !== "slack" && provider !== "discord") return;
    const model = yield* ctx.deps.readModel;
    for (const summary of model.threads) {
      if (summary.botId !== botId) continue;
      const thread = yield* ctx.deps.readThread(summary.id);
      for (const message of thread?.messages ?? []) {
        const origin = message.channelOrigin;
        if (origin?.provider === provider) {
          yield* updateChannelStatus(ctx, runtime, origin);
        }
      }
    }
  });

const finishChannelTurn = (
  ctx: ChannelRuntimeContext,
  threadId: ThreadId,
  turnId: TurnId | undefined,
  state: "completed" | "failed" | "cancelled",
  requestMessageId?: MessageId,
) =>
  Effect.gen(function* () {
    const thread = yield* ctx.deps.readThread(threadId);
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
    if (!request || !origin) return;
    yield* withChannelOperation(
      ctx,
      origin.provider,
    )(
      Effect.gen(function* () {
        const runtime = ctx.runtimes.get(runtimeKey(botId, origin.provider));
        if (!runtime) return;
        const current = yield* ctx.deps.readThread(threadId);
        if (current?.messages.findLast((message) => message.role === "user")?.id !== request.id)
          return;
        yield* updateChannelStatus(
          ctx,
          runtime,
          origin,
          state === "completed" ? "white_check_mark" : "x",
          threadId,
        );
      }),
    );
  });

const startChannel = (
  ctx: ChannelRuntimeContext,
  input: ChannelConnectInput,
  connectionId?: ChannelConnectionId,
) =>
  Effect.gen(function* () {
    const deps = ctx.deps;
    if (ctx.closed) return yield* failWith("Channels are shutting down.");
    const model = yield* deps.readModel;
    const bot = model.bots.find((candidate) => candidate.id === input.botId);
    if (!bot || bot.archivedAt !== null)
      return yield* failWith(`Bot '${input.botId}' is unavailable.`);
    const project = model.projects.find(
      (candidate) => candidate.id === input.targetProjectId && candidate.deletedAt === null,
    );
    if (!project) return yield* failWith("The selected channel project is unavailable.");
    let runtime: ChannelRuntimeEntry | undefined;
    const dispatch = (message: InboundChannelMessage) =>
      withChannelOperation(
        ctx,
        input.provider,
      )(
        Effect.gen(function* () {
          const current = runtime;
          if (!current || ctx.runtimes.get(runtimeKey(bot.id, input.provider)) !== current) return;
          const currentModel = yield* deps.readModel;
          let duplicate = false;
          if (message.externalMessageId) {
            for (const summary of currentModel.threads) {
              if (summary.botId !== bot.id || summary.projectId !== project.id) continue;
              const thread = yield* deps.readThread(summary.id);
              duplicate ||=
                thread?.messages.some(
                  (entry) =>
                    entry.channelOrigin?.provider === input.provider &&
                    entry.channelOrigin.externalThreadId === message.externalThreadId &&
                    entry.channelOrigin.externalMessageId === message.externalMessageId,
                ) ?? false;
            }
          }
          yield* dispatchInboundChannelMessage(ctx, {
            ...message,
            botId: bot.id,
            projectId: project.id,
            provider: input.provider,
          });
          if (!duplicate) {
            for (const { origin } of ctx.statuses.get(current)?.values() ?? []) {
              if (origin.externalThreadId === message.externalThreadId)
                yield* updateChannelStatus(ctx, current, origin);
            }
            yield* updateChannelStatus(
              ctx,
              current,
              { provider: input.provider, ...message },
              "eyes",
            );
          }
        }),
      );
    // SDK callbacks are the only place work crosses into Effect; each runs in the runtime scope.
    const onInbound: InboundCallback = (message) => ctx.runSdkCallback(dispatch(message));
    const context: ChannelTransportContext = {
      botName: bot.name,
      subscribedThreadIds: yield* subscribedExternalThreadIds(
        ctx,
        model,
        bot.id,
        project.id,
        input.provider,
      ),
      onMention: onInbound,
      onSubscribedMessage: onInbound,
    };
    const startTransport = deps.startTransport;
    const started: StartedTransport = startTransport
      ? yield* fromPromise(() => startTransport(input, onInbound, context)).pipe(
          Effect.map((transport) => ({
            externalIdentity: transport.externalIdentity,
            runtime: fromTransportRuntime(transport.runtime),
          })),
        )
      : yield* startBuiltInTransport(bot.id, input, context, onInbound).pipe(
          Scope.provide(ctx.transportScope),
        );
    yield* clearPersistedChannelStatuses(ctx, started.runtime, bot.id, input.provider).pipe(
      Effect.onError(() => started.runtime.shutdown.pipe(Effect.ignoreCause)),
    );
    const clearTrackedStatuses = (threadId?: ThreadId) =>
      Effect.gen(function* () {
        const current = runtime;
        if (!current) return;
        for (const { origin, threadId: statusThreadId } of ctx.statuses.get(current)?.values() ??
          []) {
          if (
            !threadId ||
            threadId === statusThreadId ||
            channelThreadId(bot.id, project.id, input.provider, origin.externalThreadId) ===
              threadId ||
            legacyChannelThreadId(bot.id, input.provider, origin.externalThreadId) === threadId
          ) {
            yield* updateChannelStatus(ctx, current, origin);
          }
        }
      });
    const wrapped: ChannelRuntimeEntry = {
      ...started.runtime,
      clearThreadStatus: clearTrackedStatuses,
      shutdown: clearTrackedStatuses().pipe(Effect.andThen(started.runtime.shutdown)),
    };
    runtime = wrapped;
    return {
      runtime: wrapped,
      binding: {
        botId: bot.id,
        ...(connectionId ? { connectionId } : {}),
        projectId: project.id,
        provider: input.provider,
        status: "connected",
        externalIdentity: started.externalIdentity,
        connectedAt: yield* deps.nowIso,
        lastAttemptAt: yield* deps.nowIso,
        sentMessageIds: [],
      },
    } satisfies StartedChannel;
  });

const commitStartedChannel = (
  ctx: ChannelRuntimeContext,
  started: StartedChannel,
  secret?: StoredChannelSecret,
) =>
  Effect.gen(function* () {
    const deps = ctx.deps;
    if (ctx.closed) {
      yield* started.runtime.shutdown.pipe(Effect.ignoreCause);
      return yield* failWith("Channels are shutting down.");
    }
    const key = runtimeKey(started.binding.botId, started.binding.provider);
    const previousRuntime = ctx.runtimes.get(key);
    const name = secretName(started.binding.botId, started.binding.provider);
    let previousSecret: Option.Option<Uint8Array> | undefined;
    const rollback = Effect.gen(function* () {
      if (previousRuntime) ctx.runtimes.set(key, previousRuntime);
      else ctx.runtimes.delete(key);
      yield* started.runtime.shutdown.pipe(Effect.ignoreCause);
      const prior = previousSecret;
      if (prior?._tag === "Some") {
        yield* deps.secretStore.set(name, prior.value).pipe(Effect.ignoreCause);
      } else if (prior?._tag === "None") {
        yield* deps.secretStore.remove(name).pipe(Effect.ignoreCause);
      }
    });
    return yield* Effect.gen(function* () {
      previousSecret = yield* deps.secretStore.get(name);
      ctx.runtimes.set(key, started.runtime);
      if (secret) {
        yield* deps.secretStore.set(name, yield* encodeStoredChannelSecret(secret));
      }
      const sequence = yield* replaceBinding(ctx, started.binding);
      if (previousRuntime && previousRuntime !== started.runtime) {
        yield* previousRuntime.shutdown.pipe(Effect.ignoreCause);
      }
      return sequence;
    }).pipe(Effect.onError(() => rollback));
  });

const connectChannel = (ctx: ChannelRuntimeContext, input: ChannelConnectInput) =>
  withChannelOperation(
    ctx,
    input.provider,
  )(
    Effect.gen(function* () {
      yield* assertChannelIdentityAvailable(ctx, input.botId, storedSecretFromInput(input));
      const started = yield* startChannel(ctx, input);
      return yield* commitStartedChannel(ctx, started, storedSecretFromInput(input));
    }),
  );

const saveChannelConnection = (ctx: ChannelRuntimeContext, input: ChannelConnectionSaveInput) =>
  withConnectionSettingsOperation(ctx)(
    withConnectionOperation(
      ctx,
      input.connectionId,
    )(
      Effect.gen(function* () {
        const deps = ctx.deps;
        const model = yield* deps.readModel;
        const attached = model.bots.some((bot) =>
          (bot.channelBindings ?? []).some(
            (binding) => binding.connectionId === input.connectionId,
          ),
        );
        if (attached) return yield* failWith("Unassign this channel before editing it.");
        const secretKey = connectionSecretName(input.connectionId);
        const previousSecret = yield* deps.secretStore.get(secretKey);
        const settings = yield* deps.settings.getSettings;
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
        yield* deps.secretStore.set(
          secretKey,
          yield* encodeStoredChannelSecret(storedSecretFromInput(input)),
        );
        yield* deps.settings
          .updateSettings({
            channelConnections: [
              ...settings.channelConnections.filter(
                (connection) => connection.id !== input.connectionId,
              ),
              profile,
            ],
          })
          .pipe(
            Effect.onError(() =>
              (previousSecret._tag === "Some"
                ? deps.secretStore.set(secretKey, previousSecret.value)
                : deps.secretStore.remove(secretKey)
              ).pipe(Effect.ignoreCause),
            ),
          );
        return 0;
      }),
    ),
  );

const deleteChannelConnection = (ctx: ChannelRuntimeContext, connectionId: ChannelConnectionId) =>
  withConnectionSettingsOperation(ctx)(
    withConnectionOperation(
      ctx,
      connectionId,
    )(
      Effect.gen(function* () {
        const deps = ctx.deps;
        const model = yield* deps.readModel;
        if (
          model.bots.some((bot) =>
            (bot.channelBindings ?? []).some((binding) => binding.connectionId === connectionId),
          )
        ) {
          return yield* failWith("Unassign this channel before deleting it.");
        }
        const secretKey = connectionSecretName(connectionId);
        const previousSecret = yield* deps.secretStore.get(secretKey);
        const settings = yield* deps.settings.getSettings;
        yield* deps.secretStore.remove(secretKey);
        yield* deps.settings
          .updateSettings({
            channelConnections: settings.channelConnections.filter(
              (connection) => connection.id !== connectionId,
            ),
          })
          .pipe(
            Effect.onError(() =>
              previousSecret._tag === "Some"
                ? deps.secretStore.set(secretKey, previousSecret.value).pipe(Effect.ignoreCause)
                : Effect.void,
            ),
          );
        return 0;
      }),
    ),
  );

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

const attachChannelConnection = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  connectionId: ChannelConnectionId,
  requestedProjectId: ProjectId | undefined,
  provider: ChannelProvider,
) =>
  withConnectionOperation(
    ctx,
    connectionId,
  )(
    withChannelOperation(
      ctx,
      provider,
    )(
      Effect.gen(function* () {
        const model = yield* ctx.deps.readModel;
        const projectId = requestedProjectId ?? defaultProjectIdForBot(model, botId);
        if (!projectId) return yield* failWith("Add a project before connecting a channel.");
        const inUse = model.bots.some(
          (bot) =>
            bot.id !== botId &&
            bot.archivedAt === null &&
            (bot.channelBindings ?? []).some((binding) => binding.connectionId === connectionId),
        );
        if (inUse) return yield* failWith("This channel connection is attached to another bot.");
        const secret = yield* loadConnectionSecret(ctx, connectionId);
        if (!secret || secret.provider !== provider)
          return yield* failWith("Saved channel connection is unavailable.");
        yield* assertChannelIdentityAvailable(ctx, botId, secret);
        const commandId = CommandId.make(yield* randomId(ctx, "channel-attach"));
        const input = yield* connectInputFromSecret(botId, projectId, commandId, secret);
        const started = yield* startChannel(ctx, input, connectionId);
        return yield* commitStartedChannel(ctx, started);
      }),
    ),
  );

const currentBindingFor = (ctx: ChannelRuntimeContext, botId: BotId, provider: ChannelProvider) =>
  Effect.gen(function* () {
    const model = yield* ctx.deps.readModel;
    const binding = model.bots
      .find((bot) => bot.id === botId)
      ?.channelBindings?.find((candidate) => candidate.provider === provider);
    if (!binding) return yield* failWith(`No ${provider} channel is assigned to this bot.`);
    return binding;
  });

const disconnectChannel = (ctx: ChannelRuntimeContext, botId: BotId, provider: ChannelProvider) =>
  withChannelOperation(
    ctx,
    provider,
  )(
    Effect.gen(function* () {
      const currentBinding = yield* currentBindingFor(ctx, botId, provider);
      const sequence = yield* replaceBinding(ctx, {
        ...currentBinding,
        status: "disconnected",
        connectedAt: null,
        lastAttemptAt: yield* ctx.deps.nowIso,
      });
      yield* stopRuntime(ctx, botId, provider);
      return sequence;
    }),
  );

const detachChannelConnection = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
) =>
  withChannelOperation(
    ctx,
    provider,
  )(
    Effect.gen(function* () {
      const deps = ctx.deps;
      const currentBinding = yield* currentBindingFor(ctx, botId, provider);
      const name = secretName(botId, provider);
      const previousSecret = currentBinding.connectionId
        ? undefined
        : yield* deps.secretStore.get(name);
      if (!currentBinding.connectionId) {
        yield* deps.secretStore.remove(name);
      }
      const sequence = yield* replaceBinding(ctx, {
        botId,
        provider,
        status: "disconnected",
        externalIdentity: null,
        connectedAt: null,
        sentMessageIds: [],
      }).pipe(
        Effect.onError(() =>
          previousSecret?._tag === "Some"
            ? deps.secretStore.set(name, previousSecret.value).pipe(Effect.ignoreCause)
            : Effect.void,
        ),
      );
      yield* stopRuntime(ctx, botId, provider);
      return sequence;
    }),
  );

const reconnectChannel = (ctx: ChannelRuntimeContext, botId: BotId, provider: LiveProvider) =>
  withChannelOperation(
    ctx,
    provider,
  )(
    Effect.gen(function* () {
      const binding = yield* currentBindingFor(ctx, botId, provider);
      const secret = binding.connectionId
        ? yield* loadConnectionSecret(ctx, binding.connectionId)
        : yield* loadSecret(ctx, botId, provider);
      if (!secret || secret.provider !== provider)
        return yield* failWith(`No saved ${provider} credentials.`);
      if (!binding.projectId)
        return yield* failWith("Select a project before reconnecting this channel.");
      yield* assertChannelIdentityAvailable(ctx, botId, secret);
      const commandId = CommandId.make(yield* randomId(ctx, "channel-reconnect"));
      const input = yield* connectInputFromSecret(botId, binding.projectId, commandId, secret);
      const started = yield* startChannel(ctx, input, binding.connectionId);
      return yield* commitStartedChannel(ctx, started);
    }),
  );

const restoreConnectedChannels = (
  ctx: ChannelRuntimeContext,
): Effect.Effect<ReadonlyArray<ChannelRestoreFailure>, ChannelOperationError> =>
  Effect.gen(function* () {
    const deps = ctx.deps;
    const model = yield* deps.readModel;
    const candidates = model.bots.flatMap((bot) =>
      bot.archivedAt === null
        ? (bot.channelBindings ?? []).flatMap((binding) =>
            binding.status === "connected" || binding.status === "needs-reconnect"
              ? [{ botId: bot.id, provider: binding.provider }]
              : [],
          )
        : [],
    );
    const results = yield* Effect.forEach(
      candidates,
      (candidate) =>
        reconnectChannel(ctx, candidate.botId, candidate.provider).pipe(
          Effect.catchCause(() =>
            Effect.gen(function* () {
              const latest = yield* deps.readModel;
              const binding = latest.bots
                .find((bot) => bot.id === candidate.botId)
                ?.channelBindings?.find((entry) => entry.provider === candidate.provider);
              if (binding) {
                yield* Effect.gen(function* () {
                  yield* replaceBinding(ctx, {
                    ...binding,
                    status: "failed",
                    lastAttemptAt: yield* deps.nowIso,
                    lastError: "Connection restore failed. Reconnect with updated credentials.",
                  });
                }).pipe(Effect.ignoreCause);
              }
              return yield* failWith("Channel restore failed.");
            }),
          ),
          Effect.exit,
        ),
      { concurrency: "unbounded" },
    );
    return results.flatMap((exit, index) =>
      Exit.isFailure(exit) ? [{ ...candidates[index]!, cause: Cause.squash(exit.cause) }] : [],
    );
  });

const sendChannelMessage = (
  ctx: ChannelRuntimeContext,
  input: { readonly botId: BotId; readonly threadId: ThreadId; readonly messageId: MessageId },
) =>
  Effect.gen(function* () {
    const deps = ctx.deps;
    const thread = yield* deps.readThread(input.threadId);
    const messageIndex = thread?.messages.findIndex(
      (message) => message.id === input.messageId && message.role === "assistant",
    );
    if (!thread || thread.botId !== input.botId || messageIndex === undefined || messageIndex < 0) {
      return yield* failWith("Channel reply approval does not match this bot thread.");
    }
    const origin = thread.messages
      .slice(0, messageIndex)
      .toReversed()
      .find((message) => message.role === "user")?.channelOrigin;
    if (!origin)
      return yield* failWith("Channel reply approval does not match an inbound channel message.");
    const text = thread.messages[messageIndex]?.text;
    if (!text?.trim()) return yield* failWith("Channel reply is empty.");

    return yield* withChannelOperation(
      ctx,
      origin.provider,
    )(
      Effect.gen(function* () {
        const model = yield* deps.readModel;
        const bot = model.bots.find((candidate) => candidate.id === input.botId);
        const binding = bot?.channelBindings?.find(
          (candidate) => candidate.provider === origin.provider,
        );
        if (!bot || bot.archivedAt !== null || !binding)
          return yield* failWith("Channel binding is unavailable.");
        if (binding.projectId !== thread.projectId) {
          return yield* failWith("This reply belongs to a previous channel project assignment.");
        }
        if (binding.status !== "connected") {
          return yield* failWith("Reconnect this channel before sending a reply.");
        }
        const claim = yield* deps.deliveryStore.claim({
          messageId: input.messageId,
          botId: input.botId,
          threadId: input.threadId,
          provider: origin.provider,
          externalThreadId: origin.externalThreadId,
          requestedAt: yield* deps.nowIso,
        });
        const alreadySent = binding.sentMessageIds.includes(input.messageId);
        if (claim === "requested" && !alreadySent) {
          yield* replaceBinding(ctx, {
            ...binding,
            lastAttemptAt: yield* deps.nowIso,
            lastError: channelDeliveryUnknownError,
          });
          return yield* failWith(channelDeliveryUnknownError);
        }
        if (claim === "claimed" && !alreadySent) {
          const runtime = ctx.runtimes.get(runtimeKey(input.botId, origin.provider));
          if (!runtime) {
            yield* deps.deliveryStore.releaseRequested(input.messageId);
            return yield* failWith(
              `${channelProviderName(origin.provider)} needs reconnect before this reply can send.`,
            );
          }
          const posted = yield* Effect.exit(runtime.post(origin.externalThreadId, text));
          if (Exit.isFailure(posted)) {
            const rejected = isChannelPostRejected(Cause.squash(posted.cause));
            if (rejected) {
              yield* deps.deliveryStore.releaseRequested(input.messageId);
            }
            yield* replaceBinding(ctx, {
              ...binding,
              lastAttemptAt: yield* deps.nowIso,
              lastError: rejected ? channelDeliveryRejectedError : channelDeliveryUnknownError,
            });
            return yield* Effect.failCause(posted.cause);
          }
          const marked = yield* Effect.exit(
            Effect.gen(function* () {
              yield* deps.deliveryStore.markSent({
                messageId: input.messageId,
                sentAt: yield* deps.nowIso,
              });
            }),
          );
          if (Exit.isFailure(marked)) {
            yield* replaceBinding(ctx, {
              ...binding,
              sentMessageIds: boundedSentMessageIds([...binding.sentMessageIds, input.messageId]),
            });
            return yield* Effect.failCause(marked.cause);
          }
        } else if (claim !== "sent") {
          yield* deps.deliveryStore.markSent({
            messageId: input.messageId,
            sentAt: yield* deps.nowIso,
          });
        }
        const { lastError, ...sentBinding } = binding;
        return alreadySent
          ? model.snapshotSequence
          : yield* replaceBinding(ctx, {
              ...sentBinding,
              ...(lastError && lastError !== channelDeliveryRejectedError ? { lastError } : {}),
              sentMessageIds: [...binding.sentMessageIds, input.messageId],
            });
      }),
    );
  });

const resolveCompletedChannelReply = (
  ctx: ChannelRuntimeContext,
  threadId: ThreadId,
  turnId: TurnId,
): Effect.Effect<ChannelReplyTarget | null, ChannelOperationError> =>
  Effect.gen(function* () {
    const thread = yield* ctx.deps.readThread(threadId);
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
  });

export interface ChannelRuntimeShape {
  readonly connect: (input: ChannelConnectInput) => Effect.Effect<number, ChannelOperationError>;
  readonly saveConnection: (
    input: ChannelConnectionSaveInput,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly deleteConnection: (
    connectionId: ChannelConnectionId,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly attach: (
    botId: BotId,
    connectionId: ChannelConnectionId,
    projectId: ProjectId | undefined,
    provider: ChannelProvider,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly disconnect: (
    botId: BotId,
    provider: ChannelProvider,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly detach: (
    botId: BotId,
    provider: ChannelProvider,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly reconnect: (
    botId: BotId,
    provider: ChannelProvider,
  ) => Effect.Effect<number, ChannelOperationError>;
  /** Reconnects every saved binding and reports the ones that failed. */
  readonly restoreConnectedChannels: Effect.Effect<
    ReadonlyArray<ChannelRestoreFailure>,
    ChannelOperationError
  >;
  readonly dispatchInbound: (
    input: InboundDispatchInput,
  ) => Effect.Effect<void, ChannelOperationError>;
  readonly sendChannelMessage: (
    input: ChannelReplyTarget,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly finishChannelTurn: (
    threadId: ThreadId,
    turnId: TurnId | undefined,
    state: "completed" | "failed" | "cancelled",
    requestMessageId?: MessageId,
  ) => Effect.Effect<void, ChannelOperationError>;
  readonly resolveCompletedChannelReply: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<ChannelReplyTarget | null, ChannelOperationError>;
  readonly sendCompletedChannelReply: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<number | null, ChannelOperationError>;
  readonly stopChannelsForBot: (botId: BotId) => Effect.Effect<void>;
  readonly clearChannelThreadStatuses: (threadId: ThreadId) => Effect.Effect<void>;
  /** Stops transports for archived bots and clears statuses for removed threads. */
  readonly stopArchivedBotChannels: <E, R>(
    events: Stream.Stream<OrchestrationEvent, E, R>,
  ) => Effect.Effect<void, E, R>;
  readonly handleWhatsAppWebhook: (botId: BotId, request: Request) => Effect.Effect<Response>;
  readonly channelBindingsForRuntime: (
    bindings: ReadonlyArray<ChannelBinding>,
  ) => ReadonlyArray<ChannelBinding>;
  /** Stops every running transport. The runtime stays usable; its scope finalizer also runs this. */
  readonly shutdown: Effect.Effect<void>;
}

const makeChannelRuntime = (deps: ChannelRuntimeDependencies) =>
  Effect.gen(function* () {
    const serviceScope = yield* Scope.Scope;
    // Created before the callback set and the shutdown finalizer, so it closes last.
    const transportScope = yield* Scope.fork(serviceScope);
    const runSdkCallback = yield* FiberSet.makeRuntimePromise();
    const ctx: ChannelRuntimeContext = {
      deps,
      runtimes: new Map(),
      statuses: new WeakMap(),
      withLock: makeKeyedLock(),
      runSdkCallback,
      transportScope,
      closed: false,
    };
    const shutdown = shutdownAllChannels(ctx);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ctx.closed = true;
      }).pipe(Effect.andThen(shutdown)),
    );
    return {
      connect: (input) => connectChannel(ctx, input),
      saveConnection: (input) => saveChannelConnection(ctx, input),
      deleteConnection: (connectionId) => deleteChannelConnection(ctx, connectionId),
      attach: (botId, connectionId, projectId, provider) =>
        attachChannelConnection(ctx, botId, connectionId, projectId, provider),
      disconnect: (botId, provider) => disconnectChannel(ctx, botId, provider),
      detach: (botId, provider) => detachChannelConnection(ctx, botId, provider),
      reconnect: (botId, provider) => reconnectChannel(ctx, botId, provider),
      restoreConnectedChannels: restoreConnectedChannels(ctx),
      dispatchInbound: (input) => dispatchInboundChannelMessage(ctx, input),
      sendChannelMessage: (input) => sendChannelMessage(ctx, input),
      finishChannelTurn: (threadId, turnId, state, requestMessageId) =>
        finishChannelTurn(ctx, threadId, turnId, state, requestMessageId),
      resolveCompletedChannelReply: (threadId, turnId) =>
        resolveCompletedChannelReply(ctx, threadId, turnId),
      sendCompletedChannelReply: (threadId, turnId) =>
        resolveCompletedChannelReply(ctx, threadId, turnId).pipe(
          Effect.flatMap((target) =>
            target ? sendChannelMessage(ctx, target) : Effect.succeed(null),
          ),
        ),
      stopChannelsForBot: (botId) => stopChannelsForBot(ctx, botId),
      clearChannelThreadStatuses: (threadId) => clearChannelThreadStatuses(ctx, threadId),
      stopArchivedBotChannels: (events) => stopArchivedBotChannels(ctx, events),
      handleWhatsAppWebhook: (botId, request) =>
        Effect.suspend(() => {
          const webhook = ctx.runtimes.get(runtimeKey(botId, "whatsapp"))?.webhook;
          return webhook
            ? webhook(request)
            : Effect.succeed(new Response("Not Found", { status: 404 }));
        }).pipe(
          Effect.catchCause(() =>
            Effect.succeed(new Response("Webhook processing failed", { status: 500 })),
          ),
        ),
      channelBindingsForRuntime: (bindings) =>
        channelBindingsForRuntime(bindings, (botId, provider) => {
          const runtime = ctx.runtimes.get(runtimeKey(botId, provider));
          return runtime !== undefined && (runtime.isHealthy?.() ?? true);
        }),
      shutdown,
    } satisfies ChannelRuntimeShape;
  });

/**
 * Owns every external channel transport for one server. Transports, locks, and status
 * reactions live in the service; closing its scope stops them.
 */
export class ChannelRuntime extends Context.Service<ChannelRuntime, ChannelRuntimeShape>()(
  "akeru-bot/channels/ChannelRuntime",
) {
  /** Builds the runtime from explicit dependencies. */
  static readonly layerWith = (dependencies: ChannelRuntimeDependencies) =>
    Layer.effect(ChannelRuntime, makeChannelRuntime(dependencies));

  /**
   * Builds the runtime from server services. Channels need secret and delivery storage;
   * without them the layer provides nothing and consumers treat channels as unavailable.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const secretStore = yield* Effect.serviceOption(ServerSecretStore);
      const deliveryStore = yield* Effect.serviceOption(ChannelDeliveryStore);
      if (Option.isNone(secretStore) || Option.isNone(deliveryStore)) return Layer.empty;
      const engine = yield* OrchestrationEngineService;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const settings = yield* ServerSettingsService;
      const crypto = yield* Crypto.Crypto;
      return ChannelRuntime.layerWith({
        engine,
        secretStore: secretStore.value,
        settings,
        deliveryStore: deliveryStore.value,
        readModel: projectionSnapshotQuery.getCommandReadModel(),
        readThread: (threadId) =>
          projectionSnapshotQuery
            .getThreadDetailById(threadId, { activityKinds: [] })
            .pipe(Effect.map(Option.getOrNull)),
        nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        randomUuid: crypto.randomUUIDv4,
      });
    }),
  );
}

/** Serves WhatsApp webhooks for the runtime in the router's context. */
export const whatsAppWebhookRouteLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const channelRuntime = yield* Effect.serviceOption(ChannelRuntime);
    const handler = Effect.gen(function* () {
      if (Option.isNone(channelRuntime))
        return HttpServerResponse.text("Not Found", { status: 404 });
      const params = yield* HttpRouter.schemaPathParams(Schema.Struct({ botId: BotId })).pipe(
        Effect.option,
      );
      if (Option.isNone(params)) return HttpServerResponse.text("Not Found", { status: 404 });
      const request = yield* HttpServerRequest.HttpServerRequest;
      const webRequest = yield* HttpServerRequest.toWeb(request).pipe(Effect.option);
      if (Option.isNone(webRequest)) return HttpServerResponse.text("Bad Request", { status: 400 });
      const response = yield* channelRuntime.value.handleWhatsAppWebhook(
        params.value.botId,
        webRequest.value,
      );
      return HttpServerResponse.fromWeb(response);
    });
    yield* router.add("GET", WHATSAPP_WEBHOOK_PATH, handler);
    yield* router.add("POST", WHATSAPP_WEBHOOK_PATH, handler);
  }),
);

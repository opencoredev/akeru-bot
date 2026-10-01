import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { TelegramProvider } from "@mastra/telegram";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { BotId, type ChannelProvider } from "@akeru/contracts";
import { type Adapter, Chat, ConsoleLogger, type Message } from "chat";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  ChannelRuntimeError,
  failWith,
  ChannelTransportError,
  transportError,
  fromPromise,
  isChannelPostRejected,
  channelFailureMessage,
  postChannelText,
} from "./ChannelErrors.ts";
import {
  type ChannelTransportRuntime,
  type ChannelRuntimeEntry,
  type StartedTransport,
  type InboundCallback,
  type ChannelTransportContext,
  type ChannelConnectInput,
} from "./ChannelRuntimeTypes.ts";
import { normalizedInboundMessage, mentionWithContext } from "./ChannelInbound.ts";
export const fromTransportRuntime = (runtime: ChannelTransportRuntime): ChannelRuntimeEntry => {
  const { webhook, react, removeReaction, isHealthy, settled } = runtime;
  return {
    // Injected transports signal a definite provider rejection by throwing ChannelPostRejectedError.
    post: (externalThreadId, text) =>
      Effect.tryPromise({
        try: () => runtime.post(externalThreadId, text),
        catch: (cause) => (isChannelPostRejected(cause) ? cause : transportError(cause)),
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
    ...(settled
      ? {
          settled: Effect.promise(() =>
            settled.then(
              () => undefined,
              () => undefined,
            ),
          ),
        }
      : {}),
  };
};

export const CHANNEL_GATEWAY_RENEWAL_INTERVAL = Duration.hours(1);

export const shutdownChat = (chat: Chat) => fromPromise(() => chat.shutdown());

export const initializeChannelChat = (chat: Chat) =>
  fromPromise(() => chat.initialize()).pipe(
    Effect.onError(() => shutdownChat(chat).pipe(Effect.ignoreCause)),
  );

/**
 * Blank messages and anything a bot wrote, including this bot, never start a turn.
 *
 * Discord, Slack, WhatsApp and iMessage always give a person's message a real boolean, so an
 * `"unknown"` author there is treated as a bot. Telegram reports `"unknown"` for messages sent on
 * behalf of a chat (`sender_chat`: anonymous group admins and linked channel posts), which people
 * write, so only an explicit `true` counts as a bot on Telegram.
 */
export const ignoredInbound = (provider: ChannelProvider, message: Message) =>
  !message.text.trim() ||
  message.author.isMe === true ||
  (provider === "telegram" ? message.author.isBot === true : message.author.isBot !== false);

export const startTelegram = (botId: BotId, token: string, onDirectMessage: InboundCallback) =>
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
      if (ignoredInbound("telegram", message)) return;
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
 * The first launch completes before this returns, and a failed first launch fails with its
 * cause so the connect can classify it. A later listener that stops early or fails to launch
 * leaves the gateway unhealthy. Renewal runs in its own child of the caller's scope, so
 * closing that scope stops it.
 */
export const startRenewingGateway = (
  start: (
    waitUntil: (task: Promise<unknown>) => void,
    durationMs: number,
    signal: AbortSignal,
  ) => Promise<Response>,
  label: string,
): Effect.Effect<RenewingGateway, ChannelTransportError | ChannelRuntimeError, Scope.Scope> =>
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
      // Server-side and rate-limit statuses are worth retrying; anything else is a rejection.
      if (!response.ok) {
        const category =
          response.status >= 500 || response.status === 429 ? "network" : "credentials";
        return yield* failWith(channelFailureMessage(category), category);
      }
      const task = currentTask();
      if (!task) return yield* failWith(`${label} did not start a listener.`);
      return task;
    });
    const watch = (task: Promise<unknown>) =>
      settle(task).pipe(
        Effect.andThen(failWith(`${label} stopped before its renewal deadline.`)),
        Effect.timeoutOption(CHANNEL_GATEWAY_RENEWAL_INTERVAL),
      );
    // The first listener launches before this returns, so callers see it running.
    const first = yield* Effect.exit(launch);
    if (Exit.isFailure(first)) {
      abort.abort();
      yield* Scope.close(scope, Exit.void);
      const task = currentTask();
      if (task) yield* settle(task);
      return yield* Effect.failCause(first.cause);
    }
    const renew = launch.pipe(Effect.flatMap(watch), Effect.repeat(Schedule.forever));
    const supervisor = yield* watch(first.value).pipe(
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

export function registerThreadedHandlers(
  chat: Chat,
  provider: ChannelProvider,
  context: ChannelTransportContext,
) {
  chat.onNewMention(async (thread, message) => {
    if (ignoredInbound(provider, message)) return;
    await thread.subscribe();
    await context.onMention(await mentionWithContext(thread, message));
  });
  chat.onSubscribedMessage(async (thread, message) => {
    if (ignoredInbound(provider, message)) return;
    await context.onSubscribedMessage(normalizedInboundMessage(thread, message));
  });
}

export const onDirectText = (
  chat: Chat,
  provider: ChannelProvider,
  onDirectMessage: InboundCallback,
) =>
  chat.onDirectMessage(async (thread, message) => {
    if (ignoredInbound(provider, message)) return;
    await onDirectMessage(normalizedInboundMessage(thread, message));
  });

export const subscribeThreads = (chat: Chat, context: ChannelTransportContext) =>
  Effect.promise(() =>
    Promise.allSettled(
      context.subscribedThreadIds.map((externalThreadId) =>
        chat.thread(externalThreadId).subscribe(),
      ),
    ),
  );

export const startIMessage = (
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
    onDirectText(chat, "imessage", onDirectMessage);
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
        settled: gateway.settled,
        shutdown: gateway.shutdown.pipe(Effect.andThen(shutdownChat(chat))),
      },
    } satisfies StartedTransport;
  });

export const startWhatsApp = (
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
    onDirectText(chat, "whatsapp", onDirectMessage);
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

export const SLACK_APP_TOKEN_INVALID = "Slack app-level token is invalid.";

export const SLACK_UNREACHABLE = "Slack could not be reached. Check the network and try again.";

export // Slack `error` codes that mean the app-level token itself is unusable.
const SLACK_TOKEN_ERRORS: ReadonlySet<unknown> = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "not_allowed_token_type",
  "missing_scope",
]);

export // Socket Mode retries a rejected app token in the background instead of failing `initialize`,
// so the token is checked up front. Only a Slack auth error blames the token; network, HTTP,
// and other Slack failures report that Slack could not be reached. Slack's own error text is
// dropped to keep it out of logs.
const validateSlackAppToken = (appToken: string, httpClient: HttpClient.HttpClient | undefined) =>
  Effect.gen(function* () {
    if (!appToken.startsWith("xapp-"))
      return yield* failWith(SLACK_APP_TOKEN_INVALID, "credentials");
    const probe = HttpClient.execute(
      HttpClientRequest.post("https://slack.com/api/apps.connections.open").pipe(
        HttpClientRequest.bearerToken(appToken),
      ),
    ).pipe(Effect.flatMap((response) => response.json));
    const body = yield* (
      httpClient
        ? probe.pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
        : probe.pipe(Effect.provide(FetchHttpClient.layer))
    ).pipe(
      Effect.mapError(
        () => new ChannelRuntimeError({ message: SLACK_UNREACHABLE, category: "network" }),
      ),
    );
    if (typeof body === "object" && body !== null && "ok" in body && body.ok === true) return;
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      SLACK_TOKEN_ERRORS.has(body.error)
    )
      return yield* failWith(SLACK_APP_TOKEN_INVALID, "credentials");
    return yield* failWith(SLACK_UNREACHABLE, "network");
  });

export const startSlack = (
  input: Extract<ChannelConnectInput, { readonly provider: "slack" }>,
  context: ChannelTransportContext,
  onDirectMessage: InboundCallback,
) =>
  Effect.gen(function* () {
    yield* validateSlackAppToken(input.appToken, context.httpClient);
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
    onDirectText(chat, "slack", onDirectMessage);
    registerThreadedHandlers(chat, "slack", context);
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

export const startDiscord = (
  input: Extract<ChannelConnectInput, { readonly provider: "discord" }>,
  context: ChannelTransportContext,
  onDirectMessage: InboundCallback,
) =>
  Effect.gen(function* () {
    const adapter = createDiscordAdapter({
      applicationId: input.applicationId,
      botToken: input.botToken,
      // The SDK requires a key to verify interaction webhooks. Akeru only uses the gateway,
      // but a placeholder verifier would silently reject interactions if they are ever routed.
      publicKey: input.publicKey,
      // The SDK falls back to DISCORD_* environment variables for these. Only a direct mention
      // of the bot starts a chat, whatever the server's environment says.
      mentionRoleIds: [],
      respondToChannelIds: [],
      respondToGlobalMentions: false,
      // Info-level gateway logs include message content.
      logger: new ConsoleLogger("warn", "discord"),
    });
    const chat = new Chat({
      userName: context.botName,
      adapters: { discord: adapter as Adapter },
      state: createMemoryState(),
    });
    onDirectText(chat, "discord", onDirectMessage);
    registerThreadedHandlers(chat, "discord", context);
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
        settled: gateway.settled,
        shutdown: gateway.shutdown.pipe(Effect.andThen(shutdownChat(chat))),
      },
    } satisfies StartedTransport;
  });

export const startBuiltInTransport = (
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

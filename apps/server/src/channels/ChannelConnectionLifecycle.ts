import {
  BotId,
  ChannelConnectionId,
  CommandId,
  ThreadId,
  type ChannelBinding,
  type ChannelProvider,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import {
  failWith,
  fromPromise,
  channelFailureMessage,
  channelFailurePresentation,
  channelDeliveryUnknownError,
} from "./ChannelErrors.ts";
import {
  type ChannelRuntimeEntry,
  type StartedTransport,
  type StartedChannel,
  type InboundChannelMessage,
  type InboundCallback,
  type ChannelTransportContext,
  type ChannelConnectInput,
  type ChannelRuntimeContext,
} from "./ChannelRuntimeTypes.ts";
import { fromTransportRuntime, startBuiltInTransport } from "./ChannelTransportFactory.ts";
import {
  StoredChannelSecret,
  encodeStoredChannelSecret,
  runtimeKey,
  secretName,
  randomId,
} from "./ChannelSecrets.ts";
import {
  channelThreadId,
  legacyChannelThreadId,
  subscribedExternalThreadIds,
  dispatchInboundChannelMessage,
} from "./ChannelInbound.ts";
import {
  WHATSAPP_NOT_LIVE_MESSAGE,
  updateChannelStatus,
  clearPersistedChannelStatuses,
} from "./ChannelDelivery.ts";
import { replaceBinding, withChannelOperation } from "./ChannelOperations.ts";

export const startChannel = (
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

    if (!project) return yield* failWith("The selected channel project is unavailable.", "project");
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

          const binding = currentModel.bots
            .find((candidate) => candidate.id === bot.id)
            ?.channelBindings.find((candidate) => candidate.provider === input.provider);

          if (binding?.status !== "connected") return;
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
      ...(ctx.deps.httpClient ? { httpClient: ctx.deps.httpClient } : {}),
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
    // Meta only delivers WhatsApp webhooks to a public https URL; without one the bot never hears messages.
    const notLive = input.provider === "whatsapp" && !deps.publicOrigin?.startsWith("https://");

    return {
      runtime: wrapped,
      binding: {
        botId: bot.id,
        ...(connectionId ? { connectionId } : {}),
        projectId: project.id,
        provider: input.provider,
        ...(notLive
          ? { status: "not-live" as const, lastError: WHATSAPP_NOT_LIVE_MESSAGE }
          : { status: "connected" as const }),
        externalIdentity: started.externalIdentity,
        connectedAt: yield* deps.nowIso,
        lastAttemptAt: yield* deps.nowIso,
        lastSucceededAt: yield* deps.nowIso,
        sentMessageIds: [],
      },
    } satisfies StartedChannel;
  });

export const commitStartedChannel = (
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

    const liveBot = (yield* deps.readModel.pipe(
      Effect.onError(() => started.runtime.shutdown.pipe(Effect.ignoreCause)),
    )).bots.some((bot) => bot.id === started.binding.botId && bot.archivedAt === null);

    if (!liveBot) {
      yield* started.runtime.shutdown.pipe(Effect.ignoreCause);

      return yield* failWith("Channel bot is unavailable.");
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

export const bindingFor = (
  model: OrchestrationReadModel,
  botId: BotId,
  provider: ChannelProvider,
): ChannelBinding | undefined =>
  model.bots
    .find((bot) => bot.id === botId)
    ?.channelBindings?.find((binding) => binding.provider === provider);

/**
 * Undoes the `connecting` write of a failed attempt, unless something replaced it since: puts
 * back the binding from before the attempt, or removes the one the attempt created.
 */
export const revertConnectingBinding = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
  previous: ChannelBinding | undefined,
) =>
  ctx.withLock(`binding:${botId}`)(
    Effect.gen(function* () {
      const model = yield* ctx.deps.readModel;
      const bot = model.bots.find((candidate) => candidate.id === botId);

      if (bindingFor(model, botId, provider)?.status !== "connecting" || !bot) return;
      yield* ctx.deps.engine.dispatch({
        type: "bot.update",
        commandId: CommandId.make(yield* randomId(ctx, "channel-binding")),
        botId,
        channelBindings: (bot.channelBindings ?? []).flatMap((candidate) =>
          candidate.provider !== provider
            ? [candidate]
            : !previous
              ? []
              : previous.status === "connecting"
                ? // A stale attempt from before a restart; nothing is starting it any more.
                  [{ ...previous, status: "needs-reconnect" as const, connectedAt: null }]
                : [previous],
        ),
      });
    }),
  );

/**
 * Records why a start failed. A binding whose earlier transport still runs keeps its status and
 * gains the failure; one with nothing running becomes `failed` (or stays `blocked`). An attempt
 * on a saved connection keeps the bot assigned to that connection, so the user can retry without
 * choosing the bot again. A first connect with inline credentials leaves nothing behind. When the
 * bot was archived or deleted during the attempt, the binding goes back to how it was before, so
 * no `connecting` binding outlives the attempt or returns when the bot is restored.
 */
export const recordStartFailure = (
  ctx: ChannelRuntimeContext,
  previous: ChannelBinding | undefined,
  input: ChannelConnectInput,
  error: unknown,
  connectionId: ChannelConnectionId | undefined,
) =>
  Effect.gen(function* () {
    const liveBot = (yield* ctx.deps.readModel).bots.some(
      (bot) => bot.id === input.botId && bot.archivedAt === null,
    );

    if (!liveBot || (!previous && !connectionId))
      return yield* revertConnectingBinding(ctx, input.botId, input.provider, previous);
    const running = ctx.runtimes.has(runtimeKey(input.botId, input.provider));

    const target: ChannelBinding =
      previous && (running || !connectionId || previous.connectionId === connectionId)
        ? previous
        : {
            botId: input.botId,
            provider: input.provider,
            status: "failed",
            ...(connectionId ? { connectionId } : {}),
            projectId: input.targetProjectId,
            externalIdentity: null,
            connectedAt: null,
            sentMessageIds: [],
          };

    const failure = channelFailurePresentation(error);
    const { failureCategory: _previousCategory, ...base } = target;

    const annotated: ChannelBinding = {
      ...base,
      lastAttemptAt: yield* ctx.deps.nowIso,
      lastError: failure.message,
      ...(failure.category ? { failureCategory: failure.category } : {}),
    };

    yield* replaceBinding(
      ctx,
      running
        ? annotated
        : {
            ...annotated,
            status: target.status === "blocked" ? "blocked" : "failed",
            connectedAt: null,
          },
    );
  }).pipe(Effect.ignoreCause);

export const channelStoppedMessage = "The channel connection stopped. Reconnect to resume.";

/**
 * Marks the binding for reconnect when a long-lived listener stops on its own, so clients
 * learn about it without waiting for the next snapshot. A stop caused by replacing or
 * removing the transport is ignored because the runtime is no longer current.
 */
export const watchTransportExit = (ctx: ChannelRuntimeContext, started: StartedChannel) => {
  const { settled } = started.runtime;

  if (!settled) return Effect.void;
  const { botId, provider } = started.binding;
  const key = runtimeKey(botId, provider);

  return settled.pipe(
    Effect.andThen(
      withChannelOperation(
        ctx,
        provider,
      )(
        Effect.gen(function* () {
          if (ctx.closed || ctx.runtimes.get(key) !== started.runtime) return;
          const current = bindingFor(yield* ctx.deps.readModel, botId, provider);

          if (current?.status !== "connected" && current?.status !== "not-live") return;
          yield* replaceBinding(ctx, {
            ...current,
            status: "needs-reconnect",
            connectedAt: null,
            lastError: channelStoppedMessage,
            failureCategory: "network",
          });
        }),
      ),
    ),
    Effect.ignoreCause,
    Effect.forkIn(ctx.transportScope),
    Effect.asVoid,
  );
};

/**
 * Starts a transport and commits it, persisting `connecting` first so every client sees the
 * attempt. A transport that is already unhealthy when it returns, such as a gateway whose
 * first launch was refused, fails instead of committing. With `recordFailure` false the caller
 * records the outcome itself.
 */
export const startAndCommitChannel = (
  ctx: ChannelRuntimeContext,
  input: ChannelConnectInput,
  options: {
    readonly connectionId?: ChannelConnectionId | undefined;
    readonly secret?: StoredChannelSecret;
    readonly recordFailure?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const key = runtimeKey(input.botId, input.provider);
    const model = yield* ctx.deps.readModel;
    const previous = bindingFor(model, input.botId, input.provider);
    const liveBot = model.bots.some((bot) => bot.id === input.botId && bot.archivedAt === null);
    ctx.connecting.add(key);

    return yield* Effect.gen(function* () {
      if (liveBot && !ctx.closed) {
        const initial: ChannelBinding = {
          status: "disconnected",
          botId: input.botId,
          provider: input.provider,
          ...(options.connectionId ? { connectionId: options.connectionId } : {}),
          projectId: input.targetProjectId,
          externalIdentity: null,
          connectedAt: null,
          sentMessageIds: [],
        };

        const {
          lastError: _lastError,
          failureCategory: _failureCategory,
          ...base
        } = previous ?? initial;

        yield* replaceBinding(ctx, {
          ...base,
          status: "connecting",
          lastAttemptAt: yield* ctx.deps.nowIso,
          ...(previous?.failureCategory === "delivery-unknown"
            ? {
                lastError: channelDeliveryUnknownError,
                failureCategory: "delivery-unknown" as const,
              }
            : {}),
        });
      }

      const started = yield* startChannel(ctx, input, options.connectionId);

      // A failed first gateway launch already failed the start with its own category. A listener
      // the provider accepted and then dropped before commit is a connection problem.
      if (started.runtime.isHealthy?.() === false) {
        yield* started.runtime.shutdown.pipe(Effect.ignoreCause);

        return yield* failWith(channelFailureMessage("network"), "network");
      }

      const sequence = yield* commitStartedChannel(ctx, started, options.secret);
      yield* watchTransportExit(ctx, started);

      return sequence;
    }).pipe(
      Effect.onError((cause) =>
        options.recordFailure === false
          ? Effect.void
          : Cause.hasInterruptsOnly(cause)
            ? // An interrupted attempt must not leave its `connecting` binding behind.
              ctx.closed
              ? Effect.void
              : revertConnectingBinding(ctx, input.botId, input.provider, previous).pipe(
                  Effect.ignoreCause,
                )
            : recordStartFailure(ctx, previous, input, Cause.squash(cause), options.connectionId),
      ),
      Effect.ensuring(Effect.sync(() => ctx.connecting.delete(key))),
    );
  });

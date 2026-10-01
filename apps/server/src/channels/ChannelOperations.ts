import {
  BotId,
  CHANNEL_PROVIDERS,
  ChannelConnectionId,
  CommandId,
  ThreadId,
  type ChannelBinding,
  type ChannelProvider,
  type OrchestrationEvent,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { failWith, channelDeliveryUnknownError } from "./ChannelErrors.ts";
import {
  type ChannelTransportFailure,
  type ChannelRuntimeEntry,
  type KeyedLock,
  type ChannelRuntimeContext,
} from "./ChannelRuntimeTypes.ts";
import { runtimeKey, randomId } from "./ChannelSecrets.ts";
import { boundedSentMessageIds } from "./ChannelDelivery.ts";
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

export const replaceBinding = (ctx: ChannelRuntimeContext, binding: ChannelBinding) =>
  ctx.withLock(`binding:${binding.botId}`)(
    Effect.gen(function* () {
      const model = yield* ctx.deps.readModel;
      const bot = model.bots.find((candidate) => candidate.id === binding.botId);
      if (!bot) return yield* failWith(`Bot '${binding.botId}' does not exist.`);
      const previousBinding = (bot.channelBindings ?? []).find(
        (candidate) => candidate.provider === binding.provider,
      );
      const { failureCategory, ...merged } = {
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
      const previousSent = new Set(previousBinding?.sentMessageIds ?? []);
      const delivered = merged.sentMessageIds.some((id) => !previousSent.has(id));
      // The category follows the error: dropped with it, and fixed for an unresolved delivery.
      const category =
        merged.lastError === channelDeliveryUnknownError
          ? "delivery-unknown"
          : merged.lastError
            ? failureCategory
            : undefined;
      const nextBinding: ChannelBinding = {
        ...merged,
        ...(category ? { failureCategory: category } : {}),
        ...(delivered ? { lastSucceededAt: yield* ctx.deps.nowIso } : {}),
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

export const withChannelOperation = (ctx: ChannelRuntimeContext, provider: ChannelProvider) =>
  ctx.withLock(`channel:${provider}`);

export const withConnectionOperation = (
  ctx: ChannelRuntimeContext,
  connectionId: ChannelConnectionId,
) => ctx.withLock(`connection:${connectionId}`);

export const withConnectionSettingsOperation = (ctx: ChannelRuntimeContext) =>
  ctx.withLock("connection-settings");

export /**
 * Unregisters and stops a bot's transport. Pass `keepOnFailure` when the caller still owns the
 * channel (a project move), so a transport that fails to stop stays registered and blocks a
 * competing listener. Otherwise it stays unregistered and its inbound callbacks are ignored.
 */
const stopRuntime = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
  options?: { readonly keepOnFailure?: boolean },
) =>
  Effect.suspend(() => {
    const key = runtimeKey(botId, provider);
    const runtime = ctx.runtimes.get(key);
    if (!runtime) return Effect.void;
    ctx.runtimes.delete(key);
    if (!options?.keepOnFailure) return runtime.shutdown;
    return runtime.shutdown.pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          if (!ctx.runtimes.has(key)) ctx.runtimes.set(key, runtime);
        }),
      ),
    );
  });

export /** Runs `operation` for each running transport under its channel lock, ignoring failures. */
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

export const stopChannelsForBot = (ctx: ChannelRuntimeContext, botId: BotId) =>
  Effect.forEach(
    CHANNEL_PROVIDERS,
    (provider) =>
      withChannelOperation(
        ctx,
        provider,
      )(stopRuntime(ctx, botId, provider)).pipe(Effect.ignoreCause),
    { concurrency: "unbounded", discard: true },
  );

export const clearChannelThreadStatuses = (ctx: ChannelRuntimeContext, threadId: ThreadId) =>
  forEachRuntime(ctx, (key, runtime) =>
    ctx.runtimes.get(key) === runtime && runtime.clearThreadStatus
      ? runtime.clearThreadStatus(threadId)
      : Effect.void,
  );

export const shutdownAllChannels = (ctx: ChannelRuntimeContext) =>
  forEachRuntime(ctx, (key, runtime) =>
    Effect.suspend(() => {
      if (ctx.runtimes.get(key) !== runtime) return Effect.void;
      ctx.runtimes.delete(key);
      return runtime.shutdown;
    }),
  );

export const stopArchivedBotChannels = <E, R>(
  ctx: ChannelRuntimeContext,
  events: Stream.Stream<OrchestrationEvent, E, R>,
) =>
  Stream.runForEach(events, (event) =>
    event.type === "bot.archived" || event.type === "bot.deleted"
      ? stopChannelsForBot(ctx, event.payload.botId)
      : event.type === "thread.deleted" || event.type === "thread.archived"
        ? clearChannelThreadStatuses(ctx, event.payload.threadId)
        : Effect.void,
  );

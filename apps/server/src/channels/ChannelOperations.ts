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
  type PendingChannelLinkCode,
} from "./ChannelRuntimeTypes.ts";
import { runtimeKey, randomId } from "./ChannelSecrets.ts";
import { boundedSentMessageIds } from "./ChannelDelivery.ts";

/**
 * FIFO mutual exclusion per key. A queued caller keeps its place until it runs, so
 * operations on one key happen in the order they were requested. An interrupted caller
 * leaves the queue without blocking the callers behind it.
 */
export const keyedLock = (): KeyedLock => {
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

/**
 * The one serial lane for a bot's channel on a provider. Access checks that read or write claims,
 * follows, link codes, or owners, and every change to which transport is attached, run here one
 * at a time, so a check never decides against an attachment that changed under it. The key is
 * the runtime key, which also names a saved connection for as long as it is attached. Nothing in
 * the lane waits on the network or on another lane.
 */
export const withAccessLane = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
) => ctx.withLock(`access:${runtimeKey(botId, provider)}`);

/** Removes and returns a bot channel's pending link codes. Call it only inside the access lane. */
const dropLinkCodes = (ctx: ChannelRuntimeContext, botId: BotId, provider: ChannelProvider) => {
  const removed: Array<readonly [string, PendingChannelLinkCode]> = [];

  for (const [code, pending] of ctx.linkCodes) {
    if (pending.botId !== botId || pending.provider !== provider) continue;
    ctx.linkCodes.delete(code);
    removed.push([code, pending]);
  }

  return removed;
};

/**
 * Attaches a running transport to a bot's channel. Replacing a different transport drops the
 * channel's pending link codes: a code belongs to the account it was made for, and a connection
 * without a saved connection ID gives a code nothing else to tell the accounts apart by.
 */
export const attachRuntime = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
  runtime: ChannelRuntimeEntry,
) =>
  withAccessLane(
    ctx,
    botId,
    provider,
  )(
    Effect.sync(() => {
      const key = runtimeKey(botId, provider);

      if (ctx.runtimes.get(key) === runtime) return [];
      ctx.runtimes.set(key, runtime);

      return dropLinkCodes(ctx, botId, provider);
    }),
  );

/**
 * Puts back link codes a transport change removed, when that change is undone and the earlier
 * transport listens again. A code already present is left as it is.
 */
export const restoreLinkCodes = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
  codes: ReadonlyArray<readonly [string, PendingChannelLinkCode]>,
) =>
  withAccessLane(
    ctx,
    botId,
    provider,
  )(
    Effect.sync(() => {
      for (const [code, pending] of codes) {
        if (!ctx.linkCodes.has(code)) ctx.linkCodes.set(code, pending);
      }
    }),
  );

/**
 * Detaches the bot's transport when it is still `expected`, and drops the channel's pending link
 * codes, so a link attempt that resumes after an unassign or disconnect finds no code.
 */
export const detachRuntime = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
  expected: ChannelRuntimeEntry,
) =>
  withAccessLane(
    ctx,
    botId,
    provider,
  )(
    Effect.sync(() => {
      const key = runtimeKey(botId, provider);

      if (ctx.runtimes.get(key) === expected) ctx.runtimes.delete(key);

      return dropLinkCodes(ctx, botId, provider);
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

/**
 * Unregisters and stops a bot's transport. Pass `keepOnFailure` when the caller still owns the
 * channel (a project move), so a transport that fails to stop stays registered and blocks a
 * competing listener. Otherwise it stays unregistered and its inbound callbacks are ignored.
 */
export const stopRuntime = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  provider: ChannelProvider,
  options?: { readonly keepOnFailure?: boolean },
) =>
  Effect.suspend(() => {
    const key = runtimeKey(botId, provider);
    const runtime = ctx.runtimes.get(key);

    if (!runtime) return Effect.void;
    const detach = detachRuntime(ctx, botId, provider, runtime);

    if (!options?.keepOnFailure) return detach.pipe(Effect.andThen(runtime.shutdown));

    // A transport that fails to stop keeps listening, so its pending link codes stay valid too.
    return detach.pipe(
      Effect.flatMap((removedCodes) =>
        runtime.shutdown.pipe(
          Effect.onError(() =>
            withAccessLane(
              ctx,
              botId,
              provider,
            )(
              Effect.sync(() => {
                if (ctx.runtimes.has(key)) return;
                ctx.runtimes.set(key, runtime);

                for (const [code, pending] of removedCodes) {
                  if (!ctx.linkCodes.has(code)) ctx.linkCodes.set(code, pending);
                }
              }),
            ),
          ),
        ),
      ),
    );
  });

/** The bot and provider a runtime key names. */
const parseRuntimeKey = (key: string) => {
  const separator = key.lastIndexOf(":");
  const provider = CHANNEL_PROVIDERS.find((value) => value === key.slice(separator + 1));

  return [provider ? BotId.make(key.slice(0, separator)) : undefined, provider] as const;
};

/** Runs `operation` for each running transport under its channel lock, ignoring failures. */
export const forEachRuntime = (
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
      const [botId, provider] = parseRuntimeKey(key);

      return (
        botId && provider
          ? detachRuntime(ctx, botId, provider, runtime)
          : Effect.sync(() => void ctx.runtimes.delete(key))
      ).pipe(Effect.andThen(runtime.shutdown));
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

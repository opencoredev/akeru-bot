import {
  BotId,
  CommandId,
  MessageId,
  ThreadId,
  type TurnId,
  type ChannelProvider,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  failWith,
  isChannelPostRejected,
  channelFailureCategory,
  channelDeliveryUnknownError,
  channelDeliveryRejectedError,
} from "./ChannelErrors.ts";
import {
  type ChannelOperationError,
  type ChannelRuntimeEntry,
  type ChannelReplyTarget,
  channelStatusReactions,
  type ChannelOrigin,
  type ChannelStatus,
  type ChannelRuntimeContext,
} from "./ChannelRuntimeTypes.ts";
import { runtimeKey, randomId, channelProviderName } from "./ChannelSecrets.ts";
import { replaceBinding, withChannelOperation } from "./ChannelOperations.ts";

/**
 * Appends the server-advertised "Open in Akeru" link to an external reply.
 * Only the server-resolved public origin is used; the browser origin is never
 * substituted, so remote clients see the link only when the server can be
 * reached at it.
 */
export const channelReplyTextWithFooter = (
  text: string,
  botId: BotId,
  provider: ChannelProvider,
  publicOrigin: string | undefined,
): string => {
  if (publicOrigin === undefined) return text;
  const url = `${publicOrigin.replace(/\/$/, "")}/bots/${botId}`;

  // Posts go out as plain strings; only Discord renders Markdown link syntax.
  return provider === "discord"
    ? `${text}\n\n[Open in Akeru](${url})`
    : `${text}\n\nOpen in Akeru: ${url}`;
};

export const CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT = 128;

export const WHATSAPP_NOT_LIVE_MESSAGE =
  "WhatsApp cannot reach this server. Start it with a public https origin (--public-origin), then reconnect.";

export const boundedSentMessageIds = (messageIds: ReadonlyArray<MessageId>) =>
  messageIds.slice(-CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT);

export const channelStatusKey = (origin: ChannelOrigin) =>
  `${origin.externalThreadId}\u0000${origin.externalMessageId ?? ""}`;

export const updateChannelStatus = (
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
    const key = channelStatusKey(origin);

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

export const clearPersistedChannelStatuses = (
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

// Runs `update` against the channel runtime for the user message that started `turnId`,
// but only while that message is still the thread's latest user message.
export const withChannelTurnOrigin = (
  ctx: ChannelRuntimeContext,
  threadId: ThreadId,
  turnId: TurnId | undefined,
  requestMessageId: MessageId | undefined,
  update: (
    runtime: ChannelRuntimeEntry,
    origin: ChannelOrigin,
    statuses: Map<string, ChannelStatus> | undefined,
  ) => Effect.Effect<void>,
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
        yield* update(runtime, origin, ctx.statuses.get(runtime));
      }),
    );
  });

export const finishChannelTurn = (
  ctx: ChannelRuntimeContext,
  threadId: ThreadId,
  turnId: TurnId | undefined,
  state: "completed" | "failed" | "cancelled",
  requestMessageId?: MessageId,
) =>
  withChannelTurnOrigin(ctx, threadId, turnId, requestMessageId, (runtime, origin) =>
    updateChannelStatus(ctx, runtime, origin, state === "completed" ? "check" : "x", threadId),
  );

// Swaps the in-progress reaction for "hourglass" while the turn waits on an approval or
// user-input answer, and back once it resumes. Terminal reactions are never overwritten.
export const markChannelTurnWaiting = (
  ctx: ChannelRuntimeContext,
  threadId: ThreadId,
  turnId: TurnId | undefined,
  waiting: boolean,
) =>
  withChannelTurnOrigin(ctx, threadId, turnId, undefined, (runtime, origin, statuses) => {
    const current = statuses?.get(channelStatusKey(origin))?.status;

    if (waiting && current !== undefined && current !== "eyes") return Effect.void;

    if (!waiting && current !== "hourglass") return Effect.void;

    return updateChannelStatus(ctx, runtime, origin, waiting ? "hourglass" : "eyes", threadId);
  });

/** Persists a projected delivery state on the assistant message via the internal command. */
export const setChannelDelivery = (
  ctx: ChannelRuntimeContext,
  threadId: ThreadId,
  messageId: MessageId,
  delivery: "pending" | "sent" | "failed" | "unknown",
) =>
  Effect.gen(function* () {
    const thread = yield* ctx.deps.readThread(threadId);

    if (
      thread?.messages.find((message) => message.id === messageId)?.channelDelivery === delivery
    ) {
      return;
    }

    yield* ctx.deps.engine.dispatch({
      type: "thread.channel-delivery.set",
      commandId: CommandId.make(yield* randomId(ctx, "channel-delivery")),
      threadId,
      messageId,
      delivery,
      createdAt: yield* ctx.deps.nowIso,
    });
    // The label is best effort: a failed read or write never blocks the delivery itself.
  }).pipe(Effect.catchCause(() => Effect.void));

export const sendChannelMessage = (
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

        // A not-live WhatsApp binding can still hear messages through an unconfigured tunnel.
        if (
          binding.status !== "connected" &&
          !(binding.status === "not-live" && origin.provider === "whatsapp")
        ) {
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

        // A retry of a reply that already landed keeps its sent label.
        if (!alreadySent) {
          yield* setChannelDelivery(ctx, input.threadId, input.messageId, "pending");
        }

        if (claim === "requested" && !alreadySent) {
          yield* replaceBinding(ctx, {
            ...binding,
            lastAttemptAt: yield* deps.nowIso,
            lastError: channelDeliveryUnknownError,
          });
          yield* setChannelDelivery(ctx, input.threadId, input.messageId, "unknown");

          return yield* failWith(channelDeliveryUnknownError);
        }

        if (claim === "claimed" && !alreadySent) {
          const runtime = ctx.runtimes.get(runtimeKey(input.botId, origin.provider));

          if (!runtime) {
            yield* deps.deliveryStore.releaseRequested(input.messageId);
            yield* setChannelDelivery(ctx, input.threadId, input.messageId, "failed");

            return yield* failWith(
              `${channelProviderName(origin.provider)} needs reconnect before this reply can send.`,
            );
          }

          const posted = yield* Effect.exit(
            runtime.post(
              origin.externalThreadId,
              channelReplyTextWithFooter(text, input.botId, origin.provider, deps.publicOrigin),
            ),
          );

          if (Exit.isFailure(posted)) {
            const failure = Cause.squash(posted.cause);
            const rejected = isChannelPostRejected(failure);

            if (rejected) {
              yield* deps.deliveryStore.releaseRequested(input.messageId);
            }

            yield* replaceBinding(ctx, {
              ...binding,
              lastAttemptAt: yield* deps.nowIso,
              ...(rejected
                ? {
                    lastError: channelDeliveryRejectedError,
                    failureCategory: channelFailureCategory(failure),
                  }
                : { lastError: channelDeliveryUnknownError }),
            });
            yield* setChannelDelivery(
              ctx,
              input.threadId,
              input.messageId,
              rejected ? "failed" : "unknown",
            );

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
            // The post landed even though the durable mark failed, so the
            // delivery is known sent rather than ambiguous.
            yield* setChannelDelivery(ctx, input.threadId, input.messageId, "sent");

            return yield* Effect.failCause(marked.cause);
          }
        } else if (claim !== "sent") {
          yield* deps.deliveryStore.markSent({
            messageId: input.messageId,
            sentAt: yield* deps.nowIso,
          });
        }

        yield* setChannelDelivery(ctx, input.threadId, input.messageId, "sent");
        const { lastError, ...sentBinding } = binding;

        return alreadySent
          ? model.snapshotSequence
          : yield* replaceBinding(ctx, {
              ...sentBinding,
              // A delivered reply clears every failure except another reply's unresolved delivery.
              ...(lastError === channelDeliveryUnknownError ? { lastError } : {}),
              sentMessageIds: [...binding.sentMessageIds, input.messageId],
            });
      }),
    );
  });

export const resolveCompletedChannelReply = (
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

    if (inboundIndex < 0) return null;

    // Only the owning bot answers the channel, from the thread the channel message landed on.
    // The decider never gives a delegated child thread a channel origin, so the parent turn is
    // the only delivery point and this branch should not see child threads. Turns answered by
    // another bot stay inside Akeru.
    if (
      thread.parentThreadId ||
      (latestTurn.respondingBotId && latestTurn.respondingBotId !== thread.botId)
    ) {
      yield* Effect.logTrace("channel reply dropped", {
        threadId,
        turnId,
        reason: thread.parentThreadId ? "delegated-child-thread" : "other-responding-bot",
      });

      return null;
    }

    const assistantIndex = thread.messages.findIndex(
      (message) =>
        message.id === latestTurn.assistantMessageId &&
        message.role === "assistant" &&
        message.turnId === turnId &&
        !message.streaming &&
        Boolean(message.text.trim()),
    );

    if (assistantIndex <= inboundIndex) return null;

    return {
      botId: thread.botId,
      threadId,
      messageId: latestTurn.assistantMessageId,
    };
  });

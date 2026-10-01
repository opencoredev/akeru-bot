import { type ProviderRuntimeEvent } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { resolveControllerBotId } from "../ProviderCommandReactor.ts";
import {
  toTurnId,
  providerTurnKey,
  sameId,
  STRICT_PROVIDER_LIFECYCLE_GUARD,
  orchestrationSessionStatusFromRuntimeState,
  normalizeRuntimeTurnState,
  sessionStatusAllowsActiveTurn,
} from "./EventFields.ts";
import type { createContext } from "./Context.ts";
import type { createWatchdogs } from "./Watchdogs.ts";
import type { createDependencies } from "./Dependencies.ts";
import type { createChannels } from "./Channels.ts";
import type { createPlans } from "./Plans.ts";
export function createAdmission({
  resolveThreadRuntimeContextForEvent,
  silenceWatchdogs,
  syncApprovalInbox,
  stopAllSilenceWatchdogs,
  resolveSilenceIncidents,
  stopSilenceWatchdog,
  silenceWaitingRequests,
  channelRuntime,
  channelWaitingRequests,
  channelStatusWorker,
  clearChannelWaitingRequests,
  projectionTurnRepository,
  getExpectedProviderTurnIdForThread,
  botUsageLedger,
  startTurnSilenceWatchdog,
  getSourceProposedPlanReferenceForAcceptedTurnStart,
  markSourceProposedPlanImplemented,
  orchestrationEngine,
  providerCommandId,
}: Pick<
  ReturnType<typeof createContext> &
    Effect.Success<ReturnType<typeof createWatchdogs>> &
    Effect.Success<ReturnType<typeof createDependencies>> &
    Effect.Success<ReturnType<typeof createChannels>> &
    Effect.Success<ReturnType<typeof createPlans>>,
  | "resolveThreadRuntimeContextForEvent"
  | "silenceWatchdogs"
  | "syncApprovalInbox"
  | "stopAllSilenceWatchdogs"
  | "resolveSilenceIncidents"
  | "stopSilenceWatchdog"
  | "silenceWaitingRequests"
  | "channelRuntime"
  | "channelWaitingRequests"
  | "channelStatusWorker"
  | "clearChannelWaitingRequests"
  | "projectionTurnRepository"
  | "getExpectedProviderTurnIdForThread"
  | "botUsageLedger"
  | "startTurnSilenceWatchdog"
  | "getSourceProposedPlanReferenceForAcceptedTurnStart"
  | "markSourceProposedPlanImplemented"
  | "orchestrationEngine"
  | "providerCommandId"
>) {
  const prepareRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadRuntimeContextForEvent(event);
      if (!thread) return;
      const eventTurnId = toTurnId(event.turnId);
      // turn.started starts its watchdog only once the lifecycle accepts it, below.
      if (
        eventTurnId &&
        event.type !== "turn.started" &&
        event.type !== "turn.completed" &&
        event.type !== "turn.aborted"
      ) {
        // A turn ending disposes its watchdog below; it is not output resuming.
        const handle = silenceWatchdogs.get(providerTurnKey(thread.id, eventTurnId));
        if (handle) yield* handle.touch;
      }
      if (event.type === "content.delta" && event.payload.streamKind !== "assistant_text") return;
      if (event.type === "request.opened" || event.type === "request.resolved") {
        yield* syncApprovalInbox(event, thread);
      }
      const now = event.createdAt;
      if (
        event.type === "session.exited" ||
        (event.type === "session.state.changed" &&
          (event.payload.state === "stopped" || event.payload.state === "error"))
      ) {
        // A session that stopped runs no turn, so it cannot go silent.
        yield* stopAllSilenceWatchdogs(thread.id);
        yield* resolveSilenceIncidents(thread.id);
      } else if (
        (event.type === "turn.completed" || event.type === "turn.aborted") &&
        eventTurnId
      ) {
        // The ending turn's own watchdog always stops. Its inbox item closes below,
        // once the lifecycle accepts the ending, so a stale ending cannot hide
        // another turn's silent run.
        yield* stopSilenceWatchdog(thread.id, eventTurnId);
      }
      const watchedTurnKey = eventTurnId ? providerTurnKey(thread.id, eventTurnId) : undefined;
      const activeWatchdog = watchedTurnKey ? silenceWatchdogs.get(watchedTurnKey) : undefined;
      if (
        watchedTurnKey &&
        activeWatchdog &&
        (event.type === "request.opened" || event.type === "user-input.requested")
      ) {
        const waiting = silenceWaitingRequests.get(watchedTurnKey) ?? new Set<string>();
        silenceWaitingRequests.set(watchedTurnKey, waiting);
        const requestId = event.requestId === undefined ? undefined : String(event.requestId);
        if (requestId === undefined || !waiting.has(requestId)) {
          if (requestId !== undefined) waiting.add(requestId);
          yield* activeWatchdog.suspend;
        }
      } else if (
        watchedTurnKey &&
        activeWatchdog &&
        (event.type === "request.resolved" || event.type === "user-input.resolved")
      ) {
        const requestId = event.requestId === undefined ? undefined : String(event.requestId);
        if (
          requestId === undefined ||
          silenceWaitingRequests.get(watchedTurnKey)?.delete(requestId) === true
        ) {
          yield* activeWatchdog.resume;
        }
      }
      const respondingBotId = resolveControllerBotId(thread);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      // Requests do not always carry a turn id; they then belong to the active turn.
      const waitingTurnId = eventTurnId ?? activeTurnId ?? undefined;
      if (
        channelRuntime &&
        waitingTurnId &&
        !conflictsWithActiveTurn &&
        (event.type === "request.opened" || event.type === "user-input.requested")
      ) {
        const waitingKey = providerTurnKey(thread.id, waitingTurnId);
        const open = channelWaitingRequests.get(waitingKey) ?? {
          turnId: waitingTurnId,
          requestIds: new Set<string>(),
        };
        open.requestIds.add(event.requestId ?? event.eventId);
        channelWaitingRequests.set(waitingKey, open);
        if (open.requestIds.size === 1) {
          yield* channelStatusWorker.enqueue({
            threadId: thread.id,
            turnId: waitingTurnId,
            state: "waiting",
          });
        }
      } else if (
        channelRuntime &&
        (event.type === "request.resolved" || event.type === "user-input.resolved")
      ) {
        // Resolutions do not always carry a turn id, so match the pending request instead.
        const requestId = event.requestId;
        for (const [waitingKey, open] of channelWaitingRequests) {
          if (!waitingKey.startsWith(`${thread.id}:`)) continue;
          if (eventTurnId && !sameId(open.turnId, eventTurnId)) continue;
          if (requestId && !open.requestIds.has(requestId)) continue;
          // Without a request id, one resolution answers one request, never all of them.
          const resolved = requestId ?? open.requestIds.values().next().value;
          if (resolved !== undefined) open.requestIds.delete(resolved);
          if (open.requestIds.size > 0) continue;
          channelWaitingRequests.delete(waitingKey);
          yield* channelStatusWorker.enqueue({
            threadId: thread.id,
            turnId: open.turnId,
            state: "resumed",
          });
        }
      } else if (
        (event.type === "turn.completed" || event.type === "turn.aborted") &&
        eventTurnId
      ) {
        channelWaitingRequests.delete(providerTurnKey(thread.id, eventTurnId));
      }
      if (
        event.type === "session.exited" ||
        (event.type === "session.state.changed" &&
          (event.payload.state === "error" || event.payload.state === "stopped"))
      ) {
        clearChannelWaitingRequests(thread.id);
      }
      const needsPendingTurnStart =
        event.type === "session.exited" ||
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "thread.started" ||
        event.type === "thread.token-usage.updated" ||
        event.type === "turn.started" ||
        event.type === "turn.aborted" ||
        event.type === "turn.completed";
      const pendingTurnStart = needsPendingTurnStart
        ? yield* projectionTurnRepository.getPendingTurnStartByThreadId({ threadId: thread.id })
        : Option.none();
      const expectedPendingTurnId = Option.isSome(pendingTurnStart)
        ? yield* getExpectedProviderTurnIdForThread(thread.id)
        : undefined;
      const eventMatchesPendingTurn =
        Option.isSome(pendingTurnStart) && sameId(expectedPendingTurnId, eventTurnId);
      const canReconcileUsage = Option.isSome(pendingTurnStart)
        ? eventMatchesPendingTurn
        : !conflictsWithActiveTurn;
      if (
        respondingBotId !== null &&
        eventTurnId !== undefined &&
        canReconcileUsage &&
        event.type === "thread.token-usage.updated"
      ) {
        const usage = event.payload.usage;
        const outputTokens = usage.lastOutputTokens ?? usage.outputTokens ?? 0;
        yield* botUsageLedger
          .settleForTurn({
            botId: respondingBotId,
            threadId: thread.id,
            turnId: eventTurnId,
            state: "reported",
            inputTokens:
              usage.lastInputTokens ??
              usage.inputTokens ??
              Math.max(0, (usage.lastUsedTokens ?? usage.usedTokens) - outputTokens),
            outputTokens,
            cachedInputTokens: usage.lastCachedInputTokens ?? usage.cachedInputTokens ?? 0,
            cacheCreationTokens: usage.lastCacheCreationTokens ?? usage.cacheCreationTokens ?? 0,
            reasoningTokens: usage.lastReasoningOutputTokens ?? usage.reasoningOutputTokens ?? null,
            settledAt: now,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider runtime ingestion failed to record bot usage", {
                eventId: event.eventId,
                threadId: thread.id,
                turnId: eventTurnId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
      if (
        respondingBotId !== null &&
        eventTurnId !== undefined &&
        canReconcileUsage &&
        (event.type === "turn.completed" || event.type === "turn.aborted")
      ) {
        const cancelled =
          event.type === "turn.aborted" ||
          (event.type === "turn.completed" &&
            (event.payload.state === "cancelled" ||
              event.payload.state === "interrupted" ||
              (event.payload.stopReason !== null &&
                event.payload.stopReason !== undefined &&
                /cancel|abort|interrupt|killed|stopped/i.test(event.payload.stopReason))));
        yield* botUsageLedger
          .finalizeForTurn({
            botId: respondingBotId,
            threadId: thread.id,
            turnId: eventTurnId,
            settledAt: now,
            cancelled,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider runtime ingestion failed to finalize bot usage", {
                eventId: event.eventId,
                threadId: thread.id,
                turnId: eventTurnId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
      const hasPendingTurnStart =
        Option.isSome(pendingTurnStart) && thread.session?.status === "starting";
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;
      // A turn.started that conflicts with the active turn is legitimate when
      // the server itself has a turn start pending for this thread AND the
      // provider session already tracks the event's turn as its active turn:
      // steering a running turn makes some providers (e.g. opencode) open a
      // new turn without ever completing the superseded one. A stale
      // turn.started for some other turn id still gets rejected.
      const conflictingTurnStartIsPendingTurnStart =
        event.type === "turn.started" && conflictsWithActiveTurn ? eventMatchesPendingTurn : false;
      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn || conflictingTurnStartIsPendingTurnStart;
          case "turn.completed":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            if (Option.isSome(pendingTurnStart)) {
              return eventMatchesPendingTurn;
            }
            // No active turn tracked: accept only completions that name their
            // turn (covers a real completion whose turn.started was lost). An
            // untargeted completion cannot prove it belongs to any turn this
            // thread ran — the known emitter was the Claude resume handshake
            // (system/init + result(num_turns: 0)), which is not a turn at
            // all — and applying it here stomps the "starting" lifecycle
            // state while a turn start is pending.
            return eventTurnId !== undefined;
          default:
            return true;
        }
      })();
      // Stale turn events must not start watchdogs or close another turn's silent run.
      if (event.type === "turn.started" && eventTurnId && shouldApplyThreadLifecycle) {
        yield* startTurnSilenceWatchdog(thread, eventTurnId, event.provider);
      } else if (
        (event.type === "turn.completed" || event.type === "turn.aborted") &&
        eventTurnId &&
        shouldApplyThreadLifecycle &&
        !conflictsWithActiveTurn
      ) {
        yield* resolveSilenceIncidents(thread.id);
      }
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;
      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const status = (() => {
          switch (event.type) {
            case "session.state.changed": {
              const runtimeStatus = orchestrationSessionStatusFromRuntimeState(event.payload.state);
              return hasPendingTurnStart && runtimeStatus === "ready" ? "starting" : runtimeStatus;
            }
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active or pending turn; preserve that lifecycle state.
              return activeTurnId !== null ? "running" : hasPendingTurnStart ? "starting" : "ready";
          }
        })();
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : event.type === "session.state.changed" &&
                  !sessionStatusAllowsActiveTurn(
                    orchestrationSessionStatusFromRuntimeState(event.payload.state),
                  )
                ? null
                : activeTurnId;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              mcpServerIds: thread.session?.mcpServerIds ?? [],
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }
      return {
        thread,
        eventTurnId,
        now,
        activeTurnId,
        conflictsWithActiveTurn,
        pendingTurnStart,
        shouldApplyThreadLifecycle,
      };
    });
  return { prepareRuntimeEvent };
}

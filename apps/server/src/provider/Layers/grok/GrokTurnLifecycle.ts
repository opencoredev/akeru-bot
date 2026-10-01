// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
import { EventId, type ProviderRuntimeEvent, type ThreadId, TurnId } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import type * as EffectAcpSchema from "effect-acp/schema";

import { ProviderAdapterRequestError } from "../../Errors.ts";

import { PROVIDER, type GrokSessionContext, type GrokTurnTerminal } from "./GrokAdapterState.ts";
import {
  grokPromptSettlementBelongsToContext,
  grokTurnCompletionForPromptEpoch,
} from "./GrokProtocol.ts";

export function createGrokTurnLifecycle(deps: {
  readonly sessions: Map<ThreadId, GrokSessionContext>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, never, never>;
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError,
    never
  >;
  readonly nowIso: Effect.Effect<string, never, never>;
}) {
  const settlePromptInFlight = (
    threadId: ThreadId,
    turnId: TurnId,
    expectedAcpSessionId: string,
    options?: {
      readonly errorMessage?: string;
      readonly completedStopReason?: EffectAcpSchema.StopReason | null;
      readonly emitTurnCompletion?: boolean;
      /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
      readonly settleAllPrompts?: boolean;
      /** sendTurn epoch that produced this settlement. */
      readonly promptEpoch?: number;
    },
  ) =>
    Effect.gen(function* () {
      const liveCtx = deps.sessions.get(threadId);

      if (!liveCtx) {
        return;
      }

      const promptEpoch = options?.promptEpoch;
      const superseded = promptEpoch !== undefined && promptEpoch < liveCtx.discardBeforeEpoch;

      const settlementBelongsToLiveContext = grokPromptSettlementBelongsToContext({
        liveAcpSessionId: liveCtx.acpSessionId,
        expectedAcpSessionId,
        liveActiveTurnId: liveCtx.activeTurnId,
        liveSessionActiveTurnId: liveCtx.session.activeTurnId,
        turnId,
      });

      if (!settlementBelongsToLiveContext) {
        // interruptTurn already consumed every prompt slot for this turn. A
        // late prompt result must neither emit a second terminal event nor
        // consume a slot belonging to a newer turn on the same ACP session.
        // A superseded steer prompt also never publishes its own cancellation
        // as the merged turn's outcome.
        if (
          superseded ||
          liveCtx.acpSessionId !== expectedAcpSessionId ||
          liveCtx.interruptedTurnIds.has(turnId)
        ) {
          return;
        }

        if (options?.emitTurnCompletion !== false) {
          if (options?.errorMessage !== undefined) {
            yield* deps.offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* deps.makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId,
              payload: {
                state: "failed",
                errorMessage: options.errorMessage,
              },
            });
          } else if (options?.completedStopReason !== undefined) {
            yield* deps.offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* deps.makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId,
              payload: {
                state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: options.completedStopReason ?? null,
              },
            });
          }
        }

        return;
      }

      let settleTurnId = turnId;

      if (options?.settleAllPrompts) {
        liveCtx.promptsInFlight = 0;
        liveCtx.pendingTurnCompletion = undefined;

        if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
          const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;

          if (!fallbackTurnId) {
            if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
              const updatedAt = yield* deps.nowIso;
              const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
              liveCtx.activeTurnId = undefined;
              liveCtx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }

            return;
          }

          settleTurnId = fallbackTurnId;
        }
      } else {
        const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
        liveCtx.promptsInFlight = remainingPrompts;

        const incoming: GrokTurnTerminal | undefined =
          options?.errorMessage !== undefined
            ? { errorMessage: options.errorMessage }
            : options?.completedStopReason !== undefined
              ? { completedStopReason: options.completedStopReason }
              : undefined;

        const decision = grokTurnCompletionForPromptEpoch({
          promptEpoch: promptEpoch ?? liveCtx.promptEpoch,
          discardBeforeEpoch: liveCtx.discardBeforeEpoch,
          remainingPrompts,
          stored: liveCtx.pendingTurnCompletion,
          incoming,
          emitTurnCompletion: options?.emitTurnCompletion !== false,
        });

        liveCtx.pendingTurnCompletion = decision.stored;

        if (
          remainingPrompts > 0 ||
          liveCtx.activeTurnId !== settleTurnId ||
          liveCtx.session.activeTurnId !== settleTurnId
        ) {
          return;
        }

        const updatedAt = yield* deps.nowIso;

        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";

        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.pendingTurnCompletion = undefined;
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };

        if (!canEmitTurnCompletion || decision.emit === undefined) {
          return;
        }

        if (decision.emit.errorMessage !== undefined) {
          yield* deps.offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* deps.makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: decision.emit.errorMessage,
            },
          });

          return;
        }

        if (decision.emit.completedStopReason !== undefined) {
          yield* deps.offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* deps.makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: decision.emit.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: decision.emit.completedStopReason,
            },
          });
        }

        return;
      }

      const updatedAt = yield* deps.nowIso;

      const canEmitTurnCompletion =
        liveCtx.session.status === "running" || liveCtx.session.status === "connecting";

      const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;

      const shouldEmitCompletedTurn =
        options?.completedStopReason !== undefined && canEmitTurnCompletion;

      const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
      liveCtx.activeTurnId = undefined;
      liveCtx.session = {
        ...readySession,
        status: "ready",
        updatedAt,
      };

      if (options?.emitTurnCompletion === false) {
        return;
      }

      if (shouldEmitFailedTurn) {
        yield* deps.offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* deps.makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: settleTurnId,
          payload: {
            state: "failed",
            errorMessage: options.errorMessage,
          },
        });
      } else if (shouldEmitCompletedTurn) {
        yield* deps.offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* deps.makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: settleTurnId,
          payload: {
            state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: options.completedStopReason ?? null,
          },
        });
      }
    });

  return { settlePromptInFlight };
}

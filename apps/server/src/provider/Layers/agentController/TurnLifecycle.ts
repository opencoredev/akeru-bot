import { ProviderDriverKind } from "@akeru/contracts";
import { ProviderInstanceId } from "@akeru/contracts";
import type { AkeruToolRuntime } from "../../AkeruToolRuntime.ts";
import type { ProviderServiceError } from "../../Errors.ts";
import type { AkeruRuntimeSeam } from "../../AkeruRuntimeSeam.ts";
import type { AgentControllerLiveOptions } from "./Options.ts";

import {
  EventId,
  RuntimeRequestId,
  TurnId,
  type BotId,
  type AkeruCreateRoutineInput,
  type ProviderRuntimeEvent,
  ThreadId,
  type AkeruMemoryThreadAccess,
} from "@akeru/contracts";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import { type AkeruChannelRuntime } from "../../AkeruChannelRuntime.ts";
import { type AkeruBotStateRuntime } from "../../AkeruBotStateRuntime.ts";
import { AkeruMemoryTurnHarness, type AkeruMemoryTurn } from "../../AkeruMemoryTurnHarness.ts";
import { type AkeruDelegationChildOutcome } from "../../AkeruDelegationRuntime.ts";
import type { AkeruWorkerRuntime } from "../../AkeruWorkerRuntime.ts";

import type { PendingWaiters } from "../../PendingWaiters.ts";
import {
  createAkeruPluginRuntime,
  type AkeruPluginRuntimeOptions,
} from "../../AkeruCatalogToolHandlers.ts";

import { type AkeruToolSession } from "../../AkeruToolRuntime.ts";

import { AgentControllerRuntimeError } from "../../Errors.ts";

import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";

import {
  type ActiveTurn,
  type PendingTurn,
  type ActiveSession,
  type PendingApproval,
  type WorkerOrchestration,
} from "./State.ts";

export function createTurnLifecycle(deps: {
  readonly runPromise: AkeruRuntimeSeam["runPromise"];
  readonly forkPromise: AkeruRuntimeSeam["forkPromise"];
  readonly fork: AkeruRuntimeSeam["fork"];
  readonly pendingRoutineRequests: PendingWaiters<
    {
      readonly threadId: string;
      readonly input: AkeruCreateRoutineInput;
      readonly timezone: string;
    },
    unknown,
    Error
  >;
  readonly creatingRoutineReviews: Map<string, string>;
  readonly publish: (event: ProviderRuntimeEvent) => void;
  readonly baseEvent: (
    threadId: ThreadId,
    active: Pick<ActiveSession, "provider" | "providerInstanceId">,
    turnId?: TurnId,
  ) => {
    turnId?: TurnId;
    eventId: EventId;
    provider: ProviderDriverKind;
    providerInstanceId: ProviderInstanceId;
    threadId: ThreadId;
    createdAt: string;
  };
  readonly toolRuntime: AkeruToolRuntime;
  readonly memoryUsageByThread: Map<string, { readonly botId: BotId; turnId: TurnId }>;
  readonly publishSessionState: (
    threadId: ThreadId,
    active: ActiveSession,
    state: "ready" | "running" | "waiting" | "stopped" | "error",
    reason?: string,
  ) => void;
  readonly sessionFailureDetail: (
    active: Pick<ActiveSession, "mcpServerIds">,
    cause: unknown,
  ) => string;
  readonly stopSessionWithResources: (
    input: { readonly threadId: ThreadId },
    destroyResources: boolean,
  ) => Effect.Effect<void, ProviderServiceError | AgentControllerRuntimeError, never>;
  readonly memorySettings: () =>
    | Effect.Effect<
        | { enabled: boolean; privateBotMemory: boolean; sharedProjectMemory: "auto" | "ask" }
        | { enabled: boolean; privateBotMemory: boolean; sharedProjectMemory: "ask" },
        never,
        never
      >
    | Effect.Effect<
        {
          readonly enabled: true;
          readonly privateBotMemory: true;
          readonly sharedProjectMemory: "ask";
        },
        never,
        never
      >;
  readonly refreshEntityMemoryAccess: (
    access: AkeruMemoryThreadAccess | undefined,
  ) => Promise<AkeruMemoryThreadAccess | undefined>;
  readonly memoryTurnHarness: AkeruMemoryTurnHarness;
  readonly mastraReservationKey: (threadId: ThreadId, turnId: TurnId) => string;
  readonly mastraMemoryTurns: Map<string, AkeruMemoryTurn>;
  readonly entityMemoryContext: (access: AkeruMemoryThreadAccess | undefined) => Promise<string>;
  readonly legacyProviderBridge: LegacyProviderBridge["Service"];
  readonly startPendingTurn: (active: ActiveSession, pending: PendingTurn) => void;
  readonly queueTurnMemory: (threadId: ThreadId, active: ActiveSession, turn: ActiveTurn) => void;
  readonly completeAssistantMessages: (
    threadId: ThreadId,
    active: ActiveSession,
    turn: ActiveTurn,
  ) => void;
  readonly resolveChildWaiter: (threadId: ThreadId, outcome: AkeruDelegationChildOutcome) => void;
  readonly workerRuntime: AkeruWorkerRuntime;
  readonly wired: () => {
    readonly channelRuntime?: AkeruChannelRuntime;
    readonly pluginRuntime?: ReturnType<typeof createAkeruPluginRuntime>;
    readonly pluginRuntimeOptions?: AkeruPluginRuntimeOptions;
    readonly botStateRuntime?: AkeruBotStateRuntime;
    readonly delegationRuntime?: AgentControllerLiveOptions["delegationRuntime"];
    readonly workerOrchestration?: WorkerOrchestration;
  };
  readonly failureDetail: (cause: unknown) => string;
}) {
  const turnStillWaiting = (threadId: string, active: ActiveSession) =>
    active.pendingApprovals.size > 0 ||
    (active.activeTurn?.suspendedToolCalls.size ?? 0) > 0 ||
    deps.pendingRoutineRequests.entries().some(([, request]) => request.threadId === threadId) ||
    [...deps.creatingRoutineReviews.values()].includes(threadId);

  const cancelPendingApproval = (
    threadId: ThreadId,
    active: ActiveSession,
    requestId: string,
    pending: PendingApproval,
  ) => {
    deps.publish({
      ...deps.baseEvent(threadId, active, active.activeTurn?.turnId),
      requestId: RuntimeRequestId.make(requestId),
      type: "request.resolved",
      payload: {
        requestType: "dynamic_tool_call",
        decision: "cancel",
        actor: "system",
        target: pending.toolName,
        action: pending.action,
        outcome: "cancelled",
      },
    });
  };

  const cancelAllPendingApprovals = (threadId: ThreadId, active: ActiveSession) => {
    for (const [requestId, pending] of active.pendingApprovals) {
      cancelPendingApproval(threadId, active, requestId, pending);
    }

    active.pendingApprovals.clear();
    active.approvalRequests.clear();
    deps.toolRuntime.clearApprovals(String(threadId));
  };

  const beginPendingTurn = (
    active: ActiveSession,
    { threadId, turnId, botUsage, hiddenWake }: PendingTurn,
  ) => {
    const key = String(threadId);

    if (botUsage) {
      deps.memoryUsageByThread.set(key, { ...botUsage, turnId });
    } else {
      deps.memoryUsageByThread.delete(key);
    }

    active.activeTurn = {
      turnId,
      assistantMessages: new Map(),
      waiting: false,
      suspendedToolCalls: new Set(),
      finished: false,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      memoryQueued: false,
      assistantText: "",
    };
    active.status = "running";
    deps.publish({
      ...deps.baseEvent(threadId, active, turnId),
      type: "turn.started",
      payload: { model: active.model, ...(hiddenWake ? { hiddenWake: true } : {}) },
    });
    deps.publishSessionState(threadId, active, "running");
  };

  const failActiveTurn = async (
    active: ActiveSession,
    threadId: ThreadId,
    turnId: TurnId,
    cause: unknown,
  ) => {
    if (active.activeTurn?.turnId !== turnId) return;
    const detail = deps.sessionFailureDetail(active, cause);
    deps.publish({
      ...deps.baseEvent(threadId, active, turnId),
      type: "runtime.error",
      payload: { message: detail, class: "provider_error" },
    });
    finishTurn(threadId, active, "failed", detail);
    await deps.runPromise(
      deps.stopSessionWithResources({ threadId }, false).pipe(
        Effect.catchCause((resetCause) =>
          Effect.logWarning("provider session reset failed", {
            threadId,
            cause: resetCause,
          }),
        ),
      ),
    );
  };

  const handlePendingTurnFailure = (
    active: ActiveSession,
    pending: PendingTurn,
    cause: unknown,
  ) => {
    const ownsAdmission = active.admittingTurn?.turnId === pending.turnId;
    const ownsActiveTurn = active.activeTurn?.turnId === pending.turnId;

    if (!ownsAdmission && !ownsActiveTurn) return Promise.resolve();

    if (ownsAdmission) {
      active.admittingTurn = null;
    }

    if (!active.activeTurn) beginPendingTurn(active, pending);

    return failActiveTurn(active, pending.threadId, pending.turnId, cause);
  };

  const startAdmittedPendingTurn = (active: ActiveSession, pending: PendingTurn) => {
    const { threadId, turnId, message } = pending;

    if (active.admittingTurn?.turnId !== turnId) return;

    const dispatch: Promise<void> = (async () => {
      const settings = pending.memoryAccess
        ? await deps.runPromise(deps.memorySettings())
        : undefined;

      // The settings read is asynchronous; the turn may have been interrupted
      // while it was pending. Only mutate session state if this admission
      // still owns the turn.
      if (active.admittingTurn?.turnId !== turnId) return;

      const memoryAccess =
        pending.memoryAccess && settings?.enabled ? pending.memoryAccess : undefined;

      // Entity memory rides on durable memory access. With Memory off (or a
      // delegated turn without memory) the turn runs without memory, so group
      // membership is only checked when memory is actually in play.
      const entityMemoryAccess = memoryAccess
        ? await deps.refreshEntityMemoryAccess(pending.entityMemoryAccess)
        : undefined;

      if (memoryAccess && pending.entityMemoryAccess && !entityMemoryAccess) {
        active.admittingTurn = null;
        beginPendingTurn(active, pending);
        await failActiveTurn(
          active,
          pending.threadId,
          pending.turnId,
          new Error("The bot is no longer a member of this group."),
        );

        return;
      }

      if (settings) active.privateBotMemory = settings.privateBotMemory;
      active.memoryAccess = memoryAccess;

      if (!memoryAccess) {
        // Memory was turned off after the turn was queued: drop the memory
        // tool handler so the bot cannot read or change facts. A delegated
        // turn never has durable access, so it keeps the handler its grant
        // built; that handler checks the Memory setting on every call.
        const toolSession = { ...pending.toolSession };

        if (pending.memoryAccess) delete toolSession.memoryHandlers;
        active.toolSession = toolSession;
        deps.toolRuntime.registerSession(String(threadId), active.toolSession);
        const { persistentMemoryContext, ...stateWithoutMemory } = active.session.state.get();

        if (pending.delegationResults) {
          await active.session.state.set({
            ...stateWithoutMemory,
            persistentMemoryContext: pending.delegationResults,
          });
        } else if (persistentMemoryContext) {
          await active.session.state.set(stateWithoutMemory);
        }

        if (active.admittingTurn?.turnId !== turnId) return;
        active.admittingTurn = null;
        beginPendingTurn(active, pending);
        await active.session.sendMessage(message);

        return;
      }

      {
        active.toolSession = pending.toolSession;

        const memoryTurn = await deps.memoryTurnHarness.admit({
          access: memoryAccess,
          input: {
            threadId: String(threadId),
            groupId: memoryAccess.groupId === null ? null : String(memoryAccess.groupId),
            text: pending.reviewInput.slice(0, 4_000),
          },
          privateBotMemory: active.privateBotMemory,
        });

        const reservationKey = deps.mastraReservationKey(threadId, turnId);
        deps.mastraMemoryTurns.set(reservationKey, memoryTurn);
        let accepted = false;
        let reviewToolSession: AkeruToolSession | undefined;

        try {
          const memoryHandler = pending.toolSession.memoryHandlers?.memory;

          if (memoryTurn.reviewIncluded && memoryHandler) {
            reviewToolSession = {
              ...pending.toolSession,
              memoryHandlers: {
                memory: memoryTurn.wrapMemoryHandler(memoryHandler),
              },
            };
            active.toolSession = reviewToolSession;
          }

          deps.toolRuntime.registerSession(String(threadId), active.toolSession);
          const currentState = active.session.state.get();

          const { persistentMemoryContext: _priorMemoryContext, ...stateWithoutMemory } =
            currentState;

          const entityPacket = await deps.entityMemoryContext(entityMemoryAccess);

          const persistentMemoryContext = [
            memoryTurn.context,
            entityPacket,
            pending.delegationResults,
          ]
            .filter(Boolean)
            .join("\n\n");

          await active.session.state.set({
            ...stateWithoutMemory,
            ...(persistentMemoryContext ? { persistentMemoryContext } : {}),
          });

          if (active.admittingTurn?.turnId !== turnId) return;
          active.admittingTurn = null;
          beginPendingTurn(active, pending);
          await active.session.sendMessage(message);
          accepted = true;
        } finally {
          await memoryTurn.finishForeground(accepted, "foreground");

          if (reviewToolSession && active.toolSession === reviewToolSession) {
            active.toolSession = active.configuredToolSession;
            deps.toolRuntime.registerSession(String(threadId), active.toolSession);
          }

          if (deps.mastraMemoryTurns.get(reservationKey) === memoryTurn) {
            deps.mastraMemoryTurns.delete(reservationKey);
          }
        }
      }
    })();

    active.pendingDispatches.add(dispatch);
    void dispatch.then(
      () => active.pendingDispatches.delete(dispatch),
      () => active.pendingDispatches.delete(dispatch),
    );
    deps.forkPromise(
      "Akeru turn dispatch failed.",
      () =>
        dispatch.then(() => {
          const turn = active.activeTurn;

          if (turn?.turnId === turnId && !turn.waiting) {
            finishTurn(threadId, active, "completed");
          }
        }),
      {
        annotations: { threadId, turnId },
        onFailure: (cause) => handlePendingTurnFailure(active, pending, cause),
      },
    );
  };

  const admitPendingTurn = (active: ActiveSession, pending: PendingTurn) => {
    active.admittingTurn = pending;

    return deps.legacyProviderBridge
      .dispatchIfEnabled(active.providerInstanceId, "AgentController.startPendingTurn", () =>
        startAdmittedPendingTurn(active, pending),
      )
      .pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (active.admittingTurn?.turnId !== pending.turnId) return;
            active.admittingTurn = null;
            const nextTurn = active.pendingTurns.shift();

            if (nextTurn) deps.startPendingTurn(active, nextTurn);
          }),
        ),
      );
  };

  // Ends the current admission generation and cancels turns still preparing in it.
  const endTurnAdmissionGeneration = (active: ActiveSession) => {
    active.turnAdmissionGeneration += 1;
    Deferred.doneUnsafe(active.turnPreparationCancelled, Effect.void);
    active.turnPreparationCancelled = Deferred.makeUnsafe<void>();
  };

  const finishTurn = (
    threadId: ThreadId,
    active: ActiveSession,
    state: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) => {
    const turn = active.activeTurn;

    if (!turn || turn.finished) return;
    deps.queueTurnMemory(threadId, active, turn);
    turn.finished = true;
    deps.completeAssistantMessages(threadId, active, turn);
    cancelAllPendingApprovals(threadId, active);
    deps.publish({
      ...deps.baseEvent(threadId, active, turn.turnId),
      type: "turn.completed",
      payload: {
        state,
        ...(errorMessage ? { errorMessage } : {}),
      },
    });
    deps.resolveChildWaiter(threadId, {
      state: state === "completed" ? "completed" : "failed",
      turnId: turn.turnId,
      ...(state === "completed" && turn.assistantText.trim()
        ? { summary: turn.assistantText.trim() }
        : { error: errorMessage ?? `The delegated turn ${state}.` }),
      usage: { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens },
    });
    deps.fork(
      "Akeru worker could not record its turn outcome.",
      deps.workerRuntime.childTurnFinished(threadId, {
        state: state === "completed" ? "completed" : "failed",
        ...(state === "completed" && turn.assistantText.trim()
          ? { summary: turn.assistantText.trim() }
          : { error: errorMessage ?? `The worker turn ${state}.` }),
      }),
      { threadId, turnId: turn.turnId },
    );
    deps.fork(
      "Akeru workers could not settle after the parent turn.",
      deps.workerRuntime.parentTurnEnded(threadId, turn.turnId),
      {
        threadId,
        turnId: turn.turnId,
      },
    );
    const delegationRuntime = deps.wired().delegationRuntime;

    if (state !== "completed" && delegationRuntime) {
      deps.forkPromise(
        "Akeru delegated work could not settle after the parent turn.",
        () =>
          delegationRuntime.parentFinished({
            threadId,
            turnId: turn.turnId,
            failed: state === "failed",
          }),
        {
          annotations: { threadId, turnId: turn.turnId },
          onFailure: (cause) => {
            deps.publish({
              ...deps.baseEvent(threadId, active, turn.turnId),
              type: "runtime.error",
              payload: { message: deps.failureDetail(cause), class: "provider_error" },
            });
          },
        },
      );
    }

    for (const [requestId, request] of deps.pendingRoutineRequests.entries()) {
      if (request.threadId !== String(threadId)) continue;
      deps.pendingRoutineRequests.reject(
        requestId,
        new Error("The routine review ended before it received a response."),
      );
    }

    active.activeTurn = null;
    const nextTurn = active.pendingTurns.shift();

    if (nextTurn) {
      deps.startPendingTurn(active, nextTurn);
    } else if (state === "failed") {
      // Keep the failure visible until the next turn; publishing ready here
      // would overwrite the error state that turn.completed just recorded.
      deps.publishSessionState(threadId, active, "error", errorMessage);
    } else {
      deps.publishSessionState(threadId, active, "ready");
    }
  };

  return {
    turnStillWaiting,
    cancelPendingApproval,
    cancelAllPendingApprovals,
    beginPendingTurn,
    failActiveTurn,
    handlePendingTurnFailure,
    startAdmittedPendingTurn,
    admitPendingTurn,
    endTurnAdmissionGeneration,
    finishTurn,
  };
}

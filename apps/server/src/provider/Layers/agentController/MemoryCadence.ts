import type { AkeruRuntimeSeam } from "../../AkeruRuntimeSeam.ts";

import { type ProviderRuntimeEvent, ThreadId } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import type { AkeruControllerHarness } from "../../mastra/AkeruHarnessTypes.ts";

import { type AkeruMemoryTurn } from "../../AkeruMemoryTurnHarness.ts";
import { type AkeruDelegationChildOutcome } from "../../AkeruDelegationRuntime.ts";

import { AgentControllerRuntimeError } from "../../Errors.ts";

import {
  type ResolvedEngine,
  type ActiveTurn,
  type ActiveSession,
  type LegacyTurnMemoryState,
} from "./State.ts";

export function createMemoryCadence(deps: {
  readonly forkPromise: AkeruRuntimeSeam["forkPromise"];
  readonly mastraMemoryTurns: Map<string, AkeruMemoryTurn>;
  readonly runMastra: <A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<A, AgentControllerRuntimeError, never>;
  readonly hasLegacyPending: (key: string, pending: LegacyTurnMemoryState) => boolean;
  readonly resolveChildWaiter: (threadId: ThreadId, outcome: AkeruDelegationChildOutcome) => void;
  readonly restoreLegacyMemoryHandler: (key: string, pending: LegacyTurnMemoryState) => void;
  readonly removeLegacyPending: (key: string, pending: LegacyTurnMemoryState) => void;
  readonly legacyPending: (key: string) => LegacyTurnMemoryState[];
  readonly bundle: AkeruControllerHarness;
  readonly legacyBufferedTerminals: Map<string, Map<string, ProviderRuntimeEvent>>;
  readonly resolvedByThread: Map<string, ResolvedEngine>;
}) {
  const releaseMastraReservations = (threadId: ThreadId) =>
    Effect.forEach(
      [...deps.mastraMemoryTurns.entries()].filter(([key]) =>
        key.startsWith(`${String(threadId)}:`),
      ),
      ([key, memoryTurn]) =>
        deps
          .runMastra("memory.abandon", () => memoryTurn.abandon())
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (deps.mastraMemoryTurns.get(key) === memoryTurn) {
                  deps.mastraMemoryTurns.delete(key);
                }
              }),
            ),
            Effect.ignoreCause({ log: true }),
          ),
      { discard: true },
    );

  const settleLegacyTurnMemory = (
    key: string,
    pending: LegacyTurnMemoryState,
    event: ProviderRuntimeEvent,
  ) =>
    Effect.gen(function* () {
      if (!deps.hasLegacyPending(key, pending)) return;

      const foregroundSucceeded =
        event.type === "turn.completed" && event.payload.state === "completed";

      // Delegated children on legacy providers report back through the same waiter as Mastra.
      const assistantText = pending.assistant.trim();
      deps.resolveChildWaiter(ThreadId.make(key), {
        state: foregroundSucceeded ? "completed" : "failed",
        turnId: event.turnId ?? null,
        ...(foregroundSucceeded && assistantText
          ? { summary: assistantText }
          : {
              error:
                (event.type === "turn.completed" ? event.payload.errorMessage : undefined) ??
                "The delegated turn did not finish.",
            }),
      });

      if (!foregroundSucceeded) {
        deps.restoreLegacyMemoryHandler(key, pending);
        deps.removeLegacyPending(key, pending);

        if (pending.memoryTurn) {
          yield* deps
            .runMastra("memory.finishForeground", () =>
              pending.memoryTurn!.finishForeground(false, "foreground"),
            )
            .pipe(Effect.ignoreCause({ log: true }));
        }

        return;
      }

      if (pending.memoryTurn) {
        yield* deps
          .runMastra("memory.finishForeground", () =>
            pending.memoryTurn!.finishForeground(true, "foreground"),
          )
          .pipe(Effect.ignoreCause({ log: true }));
      }

      const mergedPrompts = deps
        .legacyPending(key)
        .filter((entry) => entry.turnId !== undefined && entry.turnId === pending.turnId);

      if (
        mergedPrompts[0] === pending &&
        !pending.observationRecorded &&
        mergedPrompts.some((entry) => entry.assistant.trim()) &&
        deps.bundle.observeExternalTurn
      ) {
        for (const entry of mergedPrompts) entry.observationRecorded = true;

        const assistant = mergedPrompts
          .map((entry) => entry.assistant)
          .toSorted((left, right) => right.length - left.length)[0]!;

        const observeExternalTurn = deps.bundle.observeExternalTurn;
        const turnId = pending.turnId ?? `legacy-${event.eventId}`;
        deps.forkPromise(
          "Akeru background observational memory failed.",
          () =>
            observeExternalTurn({
              threadId: key,
              turnId,
              modelId: pending.modelId,
              userMessages: mergedPrompts.map((entry) => ({
                id: entry.observationPromptId,
                text: entry.user,
              })),
              assistant,
              createdAt: event.createdAt,
            }),
          { annotations: { threadId: key, turnId } },
        );
      }

      deps.removeLegacyPending(key, pending);

      if (pending.memoryTurn?.reviewIncluded) {
        deps.restoreLegacyMemoryHandler(key, pending);
      }
    });

  const drainLegacyTerminals = (key: string) =>
    Effect.gen(function* () {
      const pendingTurns = deps.legacyPending(key);

      if (pendingTurns.some((pending) => !pending.dispatchReturned)) return;
      const terminals = deps.legacyBufferedTerminals.get(key);

      if (!terminals) return;

      for (const [turnId, terminal] of terminals) {
        const matching = deps.legacyPending(key).filter((pending) => pending.turnId === turnId);

        for (const pending of matching) {
          yield* settleLegacyTurnMemory(key, pending, terminal);
        }

        terminals.delete(turnId);
      }

      if (terminals.size === 0) deps.legacyBufferedTerminals.delete(key);
    });

  const queueTurnMemory = (threadId: ThreadId, active: ActiveSession, turn: ActiveTurn) => {
    const resolved = deps.resolvedByThread.get(String(threadId));

    if (turn.memoryQueued || !deps.bundle.observeAfterTurn || !resolved) return;
    turn.memoryQueued = true;
    const observeAfterTurn = deps.bundle.observeAfterTurn;
    deps.forkPromise(
      "Akeru background observational memory failed.",
      () =>
        observeAfterTurn({
          threadId: String(threadId),
          resourceId: String(threadId),
          modelId: resolved.mastraModelId,
          providerInstanceId: active.providerInstanceId,
          turnId: String(turn.turnId),
        }),
      {
        annotations: { threadId, turnId: turn.turnId },
        onFailure: () => {
          turn.memoryQueued = false;
        },
      },
    );
  };

  return {
    releaseMastraReservations,
    settleLegacyTurnMemory,
    drainLegacyTerminals,
    queueTurnMemory,
  };
}

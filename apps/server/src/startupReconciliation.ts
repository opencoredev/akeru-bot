import * as Data from "effect/Data";

import * as Predicate from "effect/Predicate";
import { type AkeruDelegationRecord, CommandId } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentController from "./provider/Services/AgentController.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";

export const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

export const reconcileProviderSessions = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const agentController = yield* AgentController.AgentController;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const liveThreadIds = new Set(
    (yield* agentController.listSessions()).map((session) => session.threadId),
  );

  const { threads } = yield* query.getCommandReadModel();

  const orphanedThreads = threads.filter(
    (thread) =>
      thread.session !== null &&
      (thread.session.status === "starting" ||
        thread.session.status === "running" ||
        thread.session.activeTurnId !== null) &&
      !liveThreadIds.has(thread.id),
  );

  for (const thread of orphanedThreads) {
    const session = thread.session;

    if (session === null) {
      continue;
    }

    yield* Effect.gen(function* () {
      const binding = yield* directory.getBinding(thread.id);

      if (Option.isSome(binding)) {
        yield* directory.upsert({
          ...binding.value,
          status: "stopped",
          runtimePayload: { activeTurnId: null },
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("failed to reconcile orphaned provider session directory binding", {
              threadId: thread.id,
              cause,
            }),
      ),
    );

    yield* Effect.gen(function* () {
      const reconciledAt = DateTime.formatIso(yield* DateTime.now);
      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId: thread.id,
        session: {
          ...session,
          status: "error",
          activeTurnId: null,
          lastError: ORPHANED_PROVIDER_SESSION_ERROR,
          updatedAt: reconciledAt,
        },
        createdAt: reconciledAt,
      });
    }).pipe(
      Effect.retry({ times: 1 }),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("failed to settle orphaned provider session projection", {
              threadId: thread.id,
              cause,
            }),
      ),
    );
  }
}).pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("provider session startup reconciliation failed", { cause }),
  ),
);

export const DELEGATION_RESTART_FAILURE_MESSAGE = "The server restarted before this work finished.";

/**
 * Fails bot work that was queued or running when the server last stopped. Its completion watch
 * lived in memory and did not survive, so nothing else would ever settle the card. Runs before the
 * reactors start, while no delegation of this process can exist yet. Blocked work waits on the
 * user and stays; terminal work is untouched, so a second run changes nothing.
 */
export const reconcileDelegations = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const { delegations } = yield* query.getCommandReadModel();

  for (const delegation of delegations) {
    const phase = delegation.phase;

    if (!Predicate.isTagged(phase, "Queued") && !Predicate.isTagged(phase, "Running")) {
      continue;
    }

    yield* Effect.gen(function* () {
      const reconciledAt = DateTime.formatIso(yield* DateTime.now);

      const completedAt =
        Date.parse(reconciledAt) >= Date.parse(delegation.updatedAt)
          ? reconciledAt
          : delegation.updatedAt;

      const failed: AkeruDelegationRecord = {
        ...delegation,
        phase: DelegationPhase["Failed"]({
          childThreadId: Predicate.isTagged(phase, "Queued") ? null : phase.childThreadId,
          childTurnId: Predicate.isTagged(phase, "Queued") ? null : phase.childTurnId,
          startedAt: Predicate.isTagged(phase, "Queued") ? null : phase.startedAt,
          completedAt,
          failure: { failureCode: "internal", message: DELEGATION_RESTART_FAILURE_MESSAGE },
          acknowledgedAt: null,
        }),
        updatedAt: completedAt,
      };

      yield* orchestrationEngine.dispatch({
        type: "delegation.state.set",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        delegation: failed,
      });
    }).pipe(
      Effect.retry({ times: 1 }),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("failed to settle orphaned delegation", {
              delegationId: delegation.delegationId,
              cause,
            }),
      ),
    );
  }
}).pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("delegation startup reconciliation failed", { cause }),
  ),
);

const DelegationPhase = Data.taggedEnum<AkeruDelegationRecord["phase"]>();

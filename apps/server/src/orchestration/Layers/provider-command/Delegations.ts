import * as Predicate from "effect/Predicate";
import {
  type AkeruDelegationRecord,
  releaseAkeruDelegationAcknowledgement,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { delegationResultsContext } from "../../../provider/delegationResultsContext.ts";
import { type ProviderIntentEvent } from "./Fields.ts";
import type { createDependencies } from "./Dependencies.ts";

export function createDelegations({
  serverCommandId,
  orchestrationEngine,
  projectionSnapshotQuery,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>>,
  "serverCommandId" | "orchestrationEngine" | "projectionSnapshotQuery"
>) {
  const dispatchDelegationRelease = (delegation: AkeruDelegationRecord) =>
    serverCommandId("delegation-release").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "delegation.state.set",
          commandId,
          delegation: releaseAkeruDelegationAcknowledgement(delegation),
        }),
      ),
    );

  // A turn that fails before its provider reads the results it acknowledged
  // hands them back, so the parent's next turn still receives them. Fails when
  // the release cannot be confirmed after a few quick attempts.
  const releaseDelegationResultsNow = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) => {
    const delegationIds = event.payload.acknowledgedDelegationIds ?? [];

    if (delegationIds.length === 0) return Effect.void;

    return projectionSnapshotQuery.getCommandReadModel().pipe(
      Effect.flatMap((readModel) =>
        Effect.forEach(
          readModel.delegations.filter(
            (delegation) =>
              delegationIds.includes(delegation.delegationId) &&
              (Predicate.isTagged(delegation.phase, "Completed") ||
                Predicate.isTagged(delegation.phase, "Failed")) &&
              delegation.phase.acknowledgedAt === event.payload.createdAt,
          ),
          dispatchDelegationRelease,
          { discard: true },
        ),
      ),
      Effect.retry(Schedule.max([Schedule.exponential("100 millis"), Schedule.recurs(3)])),
    );
  };

  // Releases the results on a failure path. A release that cannot be confirmed
  // keeps retrying in the background with capped backoff, so the results do
  // not stay marked as delivered to a turn that never received them. A restart
  // cancels that retry; startup recovery then releases the results of any turn
  // start with a recorded failure (see releaseStrandedDelegationResults).
  const releaseDelegationResults = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) =>
    releaseDelegationResultsNow(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("retrying release of delegated work results in the background", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(
                releaseDelegationResultsNow(event).pipe(
                  Effect.retry(
                    Schedule.min([Schedule.exponential("200 millis"), Schedule.spaced("1 minute")]),
                  ),
                  Effect.catchCause((retryCause) =>
                    Effect.logWarning("failed to release delegated work results", {
                      threadId: event.payload.threadId,
                      cause: Cause.pretty(retryCause),
                    }),
                  ),
                  Effect.forkScoped,
                ),
              ),
              Effect.asVoid,
            ),
      ),
    );

  // The decider acknowledged these results when it admitted the turn. If they
  // still cannot be read after a retry, the turn runs without them only once
  // their acknowledgements are released, so the parent's next turn receives
  // them. A release that cannot be confirmed fails the turn start instead.
  const readDelegationResults = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    options: { readonly channel: boolean },
  ) => {
    const delegationIds = event.payload.acknowledgedDelegationIds ?? [];

    if (delegationIds.length === 0) return Effect.succeed("");

    return projectionSnapshotQuery.getCommandReadModel().pipe(
      Effect.retry({ times: 1 }),
      Effect.map((readModel) =>
        delegationResultsContext(
          readModel.delegations.filter((delegation) =>
            delegationIds.includes(delegation.delegationId),
          ),
          readModel.bots,
          options,
        ),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("failed to read delegated work results for turn start", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(releaseDelegationResultsNow(event)), Effect.as("")),
      ),
    );
  };

  return {
    dispatchDelegationRelease,
    releaseDelegationResultsNow,
    releaseDelegationResults,
    readDelegationResults,
  };
}

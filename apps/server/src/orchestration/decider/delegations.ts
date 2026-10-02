import { AkeruDelegationPhase } from "@akeru/contracts";
import * as Predicate from "effect/Predicate";
import {
  AKERU_DELEGATION_MAX_CONCURRENCY,
  AKERU_DELEGATION_MAX_DEPTH,
  acknowledgeAkeruDelegation,
  isAkeruDelegationResultPending,
  releaseAkeruDelegationAcknowledgement,
  type AkeruDelegationRecord,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import * as NodeUtil from "node:util";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import type { OrchestrationDispatchActor } from "../Services/OrchestrationEngine.ts";
import {
  requireBotNotArchived,
  requireDelegation,
  requireDelegationAbsent,
  requireThread,
} from "../commandInvariants.ts";
import {
  delegationChildThreadId,
  TERMINAL_DELEGATION_PHASES,
  withEventBase,
  hasSameDelegationOwnership,
  delegationChildTurnId,
  isDelegationTransitionAllowed,
  type DecideOrchestrationCommandResult,
} from "./eventBase.ts";

export const decideDelegations = Effect.fn("decideDelegations")(function* ({
  command,
  readModel,
}: {
  readonly command: Extract<
    OrchestrationCommand,
    {
      type: "delegation.create" | "delegation.state.set" | "delegation.cancel" | "delegation.retry";
    }
  >;
  readonly readModel: OrchestrationReadModel;
  readonly actor?: OrchestrationDispatchActor;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "delegation.create": {
      const delegation = command.delegation;
      yield* requireDelegationAbsent({
        readModel,
        command,
        delegationId: delegation.delegationId,
      });
      yield* requireBotNotArchived({ readModel, command, botId: delegation.parentBotId });
      yield* requireBotNotArchived({ readModel, command, botId: delegation.childBotId });
      yield* requireThread({ readModel, command, threadId: delegation.parentThreadId });
      const createdChildThreadId = delegationChildThreadId(delegation.phase);

      if (createdChildThreadId !== null) {
        yield* requireThread({ readModel, command, threadId: createdChildThreadId });
      }

      if (delegation.billedBotId !== delegation.childBotId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${delegation.delegationId}' must bill child bot '${delegation.childBotId}'.`,
        });
      }

      const parentDelegation =
        delegation.parentDelegationId === null
          ? null
          : yield* requireDelegation({
              readModel,
              command,
              delegationId: delegation.parentDelegationId,
            });

      if (parentDelegation !== null && parentDelegation.childBotId !== delegation.parentBotId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Parent delegation '${parentDelegation.delegationId}' does not belong to bot '${delegation.parentBotId}'.`,
        });
      }

      const expectedDepth = parentDelegation === null ? 1 : parentDelegation.depth + 1;

      const expectedAncestorBotIds =
        parentDelegation === null
          ? [delegation.parentBotId]
          : [...parentDelegation.ancestorBotIds, delegation.parentBotId];

      if (
        expectedDepth > AKERU_DELEGATION_MAX_DEPTH ||
        delegation.depth !== expectedDepth ||
        !NodeUtil.isDeepStrictEqual(delegation.ancestorBotIds, expectedAncestorBotIds)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${delegation.delegationId}' has an invalid ancestor chain or depth.`,
        });
      }

      if (delegation.ancestorBotIds.includes(delegation.childBotId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${delegation.delegationId}' would create a bot cycle.`,
        });
      }

      const activeDelegationCount = readModel.delegations.filter(
        (candidate) =>
          candidate.parentBotId === delegation.parentBotId &&
          !TERMINAL_DELEGATION_PHASES.has(candidate.phase._tag),
      ).length;

      if (activeDelegationCount >= AKERU_DELEGATION_MAX_CONCURRENCY) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Bot '${delegation.parentBotId}' already has ${activeDelegationCount} active delegations.`,
        });
      }

      if (!Predicate.isTagged(delegation.phase, "Queued")) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "New delegations must start queued.",
        });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: delegation.delegationId,
          occurredAt: delegation.createdAt,
          commandId: command.commandId,
        })),
        type: "delegation.created",
        payload: { delegation },
      };
    }

    case "delegation.state.set": {
      const current = yield* requireDelegation({
        readModel,
        command,
        delegationId: command.delegation.delegationId,
      });

      const next = command.delegation;

      if (!hasSameDelegationOwnership(current, next)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${next.delegationId}' ownership and access fields are immutable.`,
        });
      }

      const currentChildThreadId = delegationChildThreadId(current.phase);
      const currentChildTurnId = delegationChildTurnId(current.phase);
      const nextChildThreadId = delegationChildThreadId(next.phase);
      const nextChildTurnId = delegationChildTurnId(next.phase);

      if (
        (currentChildThreadId !== null && nextChildThreadId !== currentChildThreadId) ||
        (currentChildTurnId !== null && nextChildTurnId !== currentChildTurnId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${next.delegationId}' child ownership is immutable once assigned.`,
        });
      }

      if (
        Predicate.isTagged(next.phase, "Completed") &&
        (next.phase.result.childThreadId !== next.phase.childThreadId ||
          next.phase.result.childTurnId !== next.phase.childTurnId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${next.delegationId}' result must come from its child thread and turn.`,
        });
      }

      if (nextChildThreadId !== null) {
        yield* requireThread({ readModel, command, threadId: nextChildThreadId });
      }

      if (!(Date.parse(next.updatedAt) >= Date.parse(current.updatedAt))) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${next.delegationId}' cannot move updatedAt backward.`,
        });
      }

      if (current.phase._tag === next.phase._tag) {
        const assignsChildOwnership =
          (currentChildThreadId === null && nextChildThreadId !== null) ||
          (currentChildTurnId === null && nextChildTurnId !== null);

        const changesOnlyChildOwnership = NodeUtil.isDeepStrictEqual(current, {
          ...next,
          phase: Predicate.isTagged(next.phase, "Queued")
            ? next.phase
            : {
                ...next.phase,
                childThreadId: currentChildThreadId,
                childTurnId: currentChildTurnId,
              },
          updatedAt: current.updatedAt,
        });

        // CheckAgent delivers a finished result by stamping acknowledgedAt.
        // That stamp is the only other same-phase change allowed.
        const acknowledgesOnly =
          isAkeruDelegationResultPending(current) &&
          (Predicate.isTagged(next.phase, "Completed") ||
            Predicate.isTagged(next.phase, "Failed")) &&
          next.phase.acknowledgedAt !== null &&
          NodeUtil.isDeepStrictEqual(
            acknowledgeAkeruDelegation(current, next.phase.acknowledgedAt),
            next,
          );

        // A turn start that fails before its provider reads the results
        // hands them back, clearing only the stamp.
        const released = releaseAkeruDelegationAcknowledgement(current);
        const releasesOnly = released !== current && NodeUtil.isDeepStrictEqual(released, next);

        if (
          !NodeUtil.isDeepStrictEqual(current, next) &&
          !acknowledgesOnly &&
          !releasesOnly &&
          (!assignsChildOwnership || !changesOnlyChildOwnership)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Delegation '${next.delegationId}' cannot change data without a state transition.`,
          });
        }
      } else if (!isDelegationTransitionAllowed(current.phase._tag, next.phase._tag)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${next.delegationId}' cannot transition from '${current.phase._tag}' to '${next.phase._tag}'.`,
        });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: next.delegationId,
          occurredAt: next.updatedAt,
          commandId: command.commandId,
        })),
        type: "delegation.updated",
        payload: { delegation: next },
      };
    }

    case "delegation.cancel": {
      const current = yield* requireDelegation({
        readModel,
        command,
        delegationId: command.delegationId,
      });

      const canceledAt =
        Date.parse(command.createdAt) >= Date.parse(current.updatedAt)
          ? command.createdAt
          : current.updatedAt;

      const delegation: AkeruDelegationRecord = command.keep
        ? { ...current, keep: true, updatedAt: canceledAt }
        : TERMINAL_DELEGATION_PHASES.has(current.phase._tag)
          ? current
          : {
              ...current,
              phase: AkeruDelegationPhase.cases.Canceled.make({
                childThreadId: delegationChildThreadId(current.phase),
                childTurnId: delegationChildTurnId(current.phase),
                startedAt: "startedAt" in current.phase ? current.phase.startedAt : null,
                completedAt: canceledAt,
                canceledBy: "user",
              }),
              updatedAt: canceledAt,
            };

      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: command.delegationId,
          occurredAt: delegation.updatedAt,
          commandId: command.commandId,
        })),
        type: "delegation.updated",
        payload: { delegation },
      };
    }

    case "delegation.retry": {
      const original = yield* requireDelegation({
        readModel,
        command,
        delegationId: command.delegationId,
      });

      if (
        !Predicate.isTagged(original.phase, "Failed") &&
        !Predicate.isTagged(original.phase, "Canceled")
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Only failed or canceled bot work can be retried.",
        });
      }

      if (
        readModel.delegations.some(
          (candidate) => candidate.retryOfDelegationId === original.delegationId,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This bot work was already retried. Use the newer card instead.",
        });
      }

      yield* requireThread({ readModel, command, threadId: original.parentThreadId });
      yield* requireBotNotArchived({ readModel, command, botId: original.parentBotId });
      yield* requireBotNotArchived({ readModel, command, botId: original.childBotId });

      const activeDelegationCount = readModel.delegations.filter(
        (candidate) =>
          candidate.parentBotId === original.parentBotId &&
          !TERMINAL_DELEGATION_PHASES.has(candidate.phase._tag),
      ).length;

      if (activeDelegationCount >= AKERU_DELEGATION_MAX_CONCURRENCY) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `This bot already has ${activeDelegationCount} bot work items running. Wait for one to finish, then retry.`,
        });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: command.delegationId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "delegation.retry-requested",
        payload: {
          delegationId: command.delegationId,
          parentThreadId: original.parentThreadId,
          createdAt: command.createdAt,
        },
      };
    }
  }
});

import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import type { OrchestrationDispatchActor } from "../Services/OrchestrationEngine.ts";
import {
  requireBotNotArchived,
  requireGroup,
  requireGroupThreadCreateAuthorized,
  requireProject,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "../commandInvariants.ts";
import { withEventBase, nowIso, type DecideOrchestrationCommandResult } from "./eventBase.ts";

export const decideThreadLifecycle = Effect.fn("decideThreadLifecycle")(function* ({
  command,
  readModel,
  actor,
}: {
  readonly command: Extract<
    OrchestrationCommand,
    {
      type:
        | "thread.create"
        | "thread.delete"
        | "thread.archive"
        | "thread.unarchive"
        | "thread.pin"
        | "thread.unpin"
        | "thread.pin.reorder"
        | "thread.meta.update"
        | "thread.title.regeneration.complete"
        | "thread.runtime-mode.set"
        | "thread.interaction-mode.set"
        | "thread.channel-delivery.set"
        | "thread.history.restore";
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
    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.botId != null && command.groupId != null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A thread cannot belong to both a bot and a group.",
        });
      }
      if (command.botId != null) {
        yield* requireBotNotArchived({ readModel, command, botId: command.botId });
      }
      if (command.groupId != null) {
        const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
        yield* requireGroupThreadCreateAuthorized({ group, command, actor });
      }
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          botId: command.botId ?? null,
          groupId: command.groupId ?? null,
          parentThreadId: command.parentThreadId ?? null,
          parentDelegationId: command.parentDelegationId ?? null,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }
    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }
    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }
    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }
    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }
    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }
    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }
    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }
    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }
    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }
    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }
    case "thread.channel-delivery.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Messages hydrate into the command model empty after a restart, so a
      // message missing here is not proof the id is wrong; the projector and
      // pipeline already no-op on unknown ids. Only reject a message the model
      // can actually see and that is not an assistant reply.
      const message = thread.messages.find((entry) => entry.id === command.messageId);
      if (message && message.role !== "assistant") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Channel delivery can only mark an assistant message in thread '${command.threadId}'.`,
        });
      }
      if (message?.channelDelivery === command.delivery) {
        return [];
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.channel-delivery-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          delivery: command.delivery,
          updatedAt: command.createdAt,
        },
      };
    }
    case "thread.history.restore": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      const eventBase = (occurredAt: string) =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
          metadata: { importedHistory: true },
        });

      for (const message of command.messages) {
        events.push({
          ...(yield* eventBase(message.updatedAt)),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.id,
            role: message.role,
            text: message.text,
            turnId: null,
            ...(message.respondingBotId !== undefined
              ? { respondingBotId: message.respondingBotId }
              : {}),
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        });
      }
      for (const proposedPlan of command.proposedPlans) {
        events.push({
          ...(yield* eventBase(proposedPlan.updatedAt)),
          type: "thread.proposed-plan-upserted",
          payload: { threadId: command.threadId, proposedPlan },
        });
      }
      for (const activity of command.activities) {
        events.push({
          ...(yield* eventBase(activity.createdAt)),
          type: "thread.activity-appended",
          payload: { threadId: command.threadId, activity },
        });
      }

      if (
        command.settledOverride !== thread.settledOverride ||
        command.settledAt !== thread.settledAt
      ) {
        if (command.settledOverride === "settled") {
          const settledAt = command.settledAt ?? command.updatedAt;
          events.push({
            ...(yield* eventBase(settledAt)),
            type: "thread.settled",
            payload: { threadId: command.threadId, settledAt, updatedAt: command.updatedAt },
          });
        } else {
          events.push({
            ...(yield* eventBase(command.updatedAt)),
            type: "thread.unsettled",
            payload: {
              threadId: command.threadId,
              reason: command.settledOverride === "active" ? "user" : "activity",
              updatedAt: command.updatedAt,
            },
          });
        }
      }
      if (
        command.snoozedUntil !== (thread.snoozedUntil ?? null) ||
        command.snoozedAt !== (thread.snoozedAt ?? null)
      ) {
        if (command.snoozedUntil !== null) {
          events.push({
            ...(yield* eventBase(command.snoozedAt ?? command.updatedAt)),
            type: "thread.snoozed",
            payload: {
              threadId: command.threadId,
              snoozedUntil: command.snoozedUntil,
              snoozedAt: command.snoozedAt ?? command.updatedAt,
              updatedAt: command.updatedAt,
            },
          });
        } else {
          events.push({
            ...(yield* eventBase(command.updatedAt)),
            type: "thread.unsnoozed",
            payload: { threadId: command.threadId, reason: "user", updatedAt: command.updatedAt },
          });
        }
      }
      if (
        command.pinnedAt !== (thread.pinnedAt ?? null) ||
        command.pinOrderKey !== (thread.pinOrderKey ?? null)
      ) {
        if (command.pinnedAt !== null) {
          events.push({
            ...(yield* eventBase(command.pinnedAt)),
            type: "thread.pinned",
            payload: {
              threadId: command.threadId,
              pinnedAt: command.pinnedAt,
              ...(command.pinOrderKey !== null ? { pinOrderKey: command.pinOrderKey } : {}),
              updatedAt: command.updatedAt,
            },
          });
        } else {
          events.push({
            ...(yield* eventBase(command.updatedAt)),
            type: "thread.unpinned",
            payload: { threadId: command.threadId, updatedAt: command.updatedAt },
          });
        }
      }
      if (command.archivedAt !== thread.archivedAt) {
        if (command.archivedAt !== null) {
          events.push({
            ...(yield* eventBase(command.archivedAt)),
            type: "thread.archived",
            payload: {
              threadId: command.threadId,
              archivedAt: command.archivedAt,
              updatedAt: command.updatedAt,
            },
          });
        } else {
          events.push({
            ...(yield* eventBase(command.updatedAt)),
            type: "thread.unarchived",
            payload: { threadId: command.threadId, updatedAt: command.updatedAt },
          });
        }
      }
      if (events.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' history already matches the restore command.`,
        });
      }
      return events;
    }
  }
});

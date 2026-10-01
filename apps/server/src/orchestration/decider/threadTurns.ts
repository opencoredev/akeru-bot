import {
  acknowledgeAkeruDelegation,
  isAkeruDelegationResultPending,
  MessageId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { resolveGroupResponderBotId } from "../groupResponder.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import type { OrchestrationDispatchActor } from "../Services/OrchestrationEngine.ts";
import {
  requireActiveGroupMember,
  requireBot,
  requireBotNotArchived,
  requireGroup,
  requireThread,
} from "../commandInvariants.ts";
import {
  activeGroupBotIds,
  withEventBase,
  requireActiveResponder,
  userInputAnswerText,
  type DecideOrchestrationCommandResult,
} from "./eventBase.ts";

export const decideThreadTurns = Effect.fn("decideThreadTurns")(function* ({
  command,
  readModel,
}: {
  readonly command: Extract<
    OrchestrationCommand,
    {
      type:
        | "thread.turn.start"
        | "thread.turn.resume"
        | "thread.turn.interrupt"
        | "thread.approval.respond"
        | "thread.user-input.respond"
        | "thread.turn.diff.complete";
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
    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      // Channel replies are sent only from the parent thread's turn, so a delegated child
      // thread must never carry an inbound channel message. See resolveCompletedChannelReply.
      if (targetThread.parentThreadId && command.message.channelOrigin !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegated thread '${command.threadId}' cannot receive channel messages.`,
        });
      }

      const sourceProposedPlan = command.sourceProposedPlan;

      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;

      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;

      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }

      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }

      let respondingBotId = targetThread.botId ?? null;
      const isGroupThread = targetThread.groupId !== null && targetThread.groupId !== undefined;

      // Direct chats refuse archived bots here so a stale client or queued send cannot
      // wake one. Group chats check the responding member below instead.
      let respondingBot =
        respondingBotId === null
          ? null
          : isGroupThread
            ? yield* requireBot({ readModel, command, botId: respondingBotId })
            : yield* requireBotNotArchived({ readModel, command, botId: respondingBotId });

      let personAssignedEvent: Omit<OrchestrationEvent, "sequence"> | null = null;

      if (targetThread.groupId !== null && targetThread.groupId !== undefined) {
        const group = yield* requireGroup({
          readModel,
          command,
          groupId: targetThread.groupId,
        });

        const activeMemberIds = activeGroupBotIds(readModel, group);

        const selectedBotId = yield* resolveGroupResponderBotId({
          group,
          respondingBotId: command.respondingBotId,
          text: command.message.text,
          isActive: (botId) => Effect.succeed(activeMemberIds.has(botId)),
        });

        if (selectedBotId === null) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Group '${group.id}' has no boss bot that can respond.`,
            }),
          );
        }

        respondingBot = yield* requireActiveGroupMember({
          readModel,
          command,
          groupId: group.id,
          botId: selectedBotId,
        });
        respondingBotId = selectedBotId;
        const personMembers = group.members.filter((member) => member.kind === "person");

        const senderIsMember = personMembers.some(
          (member) => member.personId === command.senderPersonId,
        );

        if (command.senderPersonId === undefined) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `A person member must send turns to group '${group.id}'.`,
            }),
          );
        }

        if (!senderIsMember) {
          if (personMembers.length === 0 && command.senderCanManageGroups === true) {
            personAssignedEvent = {
              ...(yield* withEventBase({
                aggregateKind: "group",
                aggregateId: group.id,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              })),
              type: "group.person-assigned",
              payload: {
                groupId: group.id,
                person: {
                  kind: "person",
                  personId: command.senderPersonId,
                  displayName: command.senderDisplayName ?? "Host",
                },
                updatedAt: command.createdAt,
              },
            };
          } else {
            return yield* Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: `Person '${command.senderPersonId}' is not a member of group '${group.id}'.`,
              }),
            );
          }
        }
      } else if (command.respondingBotId !== undefined) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot mentions can only route turns on a group-owned thread.`,
          }),
        );
      }

      // Finished child work this bot has not seen yet rides into this turn as
      // context. Stamping acknowledgedAt in the same command makes delivery
      // exactly once: the next turn start finds nothing pending.
      const acknowledgedDelegations = readModel.delegations
        .filter(
          (delegation) =>
            delegation.parentThreadId === command.threadId &&
            (respondingBotId === null || delegation.parentBotId === respondingBotId) &&
            isAkeruDelegationResultPending(delegation),
        )
        .map((delegation) => acknowledgeAkeruDelegation(delegation, command.createdAt));

      const acknowledgementEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];

      for (const delegation of acknowledgedDelegations) {
        acknowledgementEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "delegation",
            aggregateId: delegation.delegationId,
            occurredAt: delegation.updatedAt,
            commandId: command.commandId,
          })),
          type: "delegation.updated",
          payload: { delegation },
        });
      }

      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.message.channelOrigin !== undefined
            ? { channelOrigin: command.message.channelOrigin }
            : {}),
          turnId: null,
          authorPersonId: command.senderPersonId ?? null,
          authorDisplayName: command.senderDisplayName ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(respondingBot?.engine !== null && respondingBot?.engine !== undefined
            ? {
                modelSelection: {
                  instanceId: ProviderInstanceId.make(respondingBot.engine.provider),
                  model: respondingBot.engine.model,
                  ...(respondingBot.engine.options
                    ? { options: respondingBot.engine.options }
                    : {}),
                },
              }
            : command.modelSelection !== undefined
              ? { modelSelection: command.modelSelection }
              : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          respondingBotId,
          ...(command.timezone !== undefined ? { timezone: command.timezone } : {}),
          ...(acknowledgedDelegations.length > 0
            ? {
                acknowledgedDelegationIds: acknowledgedDelegations.map(
                  (delegation) => delegation.delegationId,
                ),
              }
            : {}),
          createdAt: command.createdAt,
        },
      };

      // Real activity resets any override. It wakes an explicitly settled
      // thread and clears an active override back to neutral.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];

      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }

      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }

      return [
        ...(personAssignedEvent === null ? [] : [personAssignedEvent]),
        ...lifecycleResetEvents,
        ...acknowledgementEvents,
        userMessageEvent,
        turnStartRequestedEvent,
      ];
    }

    case "thread.turn.resume": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      const failedBeforeProviderAccepted =
        thread.latestTurn === null && thread.session?.status === "error";

      if (
        !failedBeforeProviderAccepted &&
        (thread.latestTurn === null ||
          (thread.latestTurn.state !== "error" && thread.latestTurn.state !== "interrupted"))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Chat '${command.threadId}' does not have an interrupted request to resume.`,
        });
      }

      if (
        thread.session !== null &&
        thread.session.status !== "error" &&
        thread.session.status !== "interrupted" &&
        thread.session.status !== "stopped"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Chat '${command.threadId}' is already active.`,
        });
      }

      const group =
        thread.groupId === null || thread.groupId === undefined
          ? null
          : yield* requireGroup({ readModel, command, groupId: thread.groupId });

      // Resume answers with the same bot the provider reactor picks.
      yield* requireActiveResponder({
        readModel,
        command,
        groupId: thread.groupId,
        botId: thread.respondingBotId ?? thread.botId ?? group?.bossBotId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-resume-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
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
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      const group =
        thread.groupId === null || thread.groupId === undefined
          ? null
          : yield* requireGroup({ readModel, command, groupId: thread.groupId });

      yield* requireActiveResponder({
        readModel,
        command,
        groupId: thread.groupId,
        botId: thread.respondingBotId ?? thread.botId ?? group?.bossBotId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      const group =
        thread.groupId === null || thread.groupId === undefined
          ? null
          : yield* requireGroup({ readModel, command, groupId: thread.groupId });

      yield* requireActiveResponder({
        readModel,
        command,
        groupId: thread.groupId,
        botId: thread.respondingBotId ?? thread.botId ?? group?.bossBotId,
      });

      const responseRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };

      const answerText = userInputAnswerText(command.answers);

      if (answerText === null) return responseRequestedEvent;

      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: MessageId.make(`user-input:${command.threadId}:${command.requestId}`),
          role: "user",
          text: answerText,
          turnId: thread.session?.activeTurnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      return [
        userMessageEvent,
        { ...responseRequestedEvent, causationEventId: userMessageEvent.eventId },
      ];
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
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
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }
  }
});

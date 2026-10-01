import { AkeruDelegationPhase } from "@akeru/contracts";

import {
  BALANCED_BOT_PERSONALITY_TONE,
  DEFAULT_LOCAL_EXECUTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isGroupBotMember,
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
  requireBot,
  requireBotAbsent,
  requireBotArchived,
  requireBotNotArchived,
  requireGroup,
} from "../commandInvariants.ts";
import {
  type PlannedOrchestrationEvent,
  withEventBase,
  activeGroupBotIds,
  nowIso,
  TERMINAL_DELEGATION_PHASES,
  delegationChildThreadId,
  delegationChildTurnId,
  type DecideOrchestrationCommandResult,
} from "./eventBase.ts";

export const decideBots = Effect.fn("decideBots")(function* ({
  command,
  readModel,
}: {
  readonly command: Extract<
    OrchestrationCommand,
    { type: "bot.create" | "bot.update" | "bot.archive" | "bot.restore" | "bot.delete" }
  >;
  readonly readModel: OrchestrationReadModel;
  readonly actor?: OrchestrationDispatchActor;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "bot.create": {
      yield* requireBotAbsent({ readModel, command, botId: command.botId });

      const group =
        command.groupId === null
          ? null
          : yield* requireGroup({ readModel, command, groupId: command.groupId });

      const botCreatedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "bot",
          aggregateId: command.botId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "bot.created",
        payload: {
          botId: command.botId,
          name: command.name,
          title: command.title,
          label: command.label ?? null,
          description: command.description ?? null,
          disabledMcpServerIds: command.disabledMcpServerIds ?? [],
          avatar: command.avatar,
          engine: command.engine,
          sandbox: command.sandbox,
          runtimeMode:
            command.runtimeMode ??
            (command.sandbox === null || command.sandbox === "local"
              ? DEFAULT_LOCAL_EXECUTION_MODE
              : DEFAULT_RUNTIME_MODE),
          usageCap: command.usageCap,
          imageProvider: command.imageProvider ?? null,
          personalityTone: command.personalityTone ?? BALANCED_BOT_PERSONALITY_TONE,
          voiceEnabled: command.voiceEnabled ?? false,
          channelBindings: [],
          groupId: command.groupId,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      if (
        group === null ||
        group.members.some((member) => isGroupBotMember(member) && member.botId === command.botId)
      ) {
        return botCreatedEvent;
      }

      return [
        {
          ...(yield* withEventBase({
            aggregateKind: "group",
            aggregateId: group.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "group.member-assigned",
          payload: {
            groupId: group.id,
            member: { kind: "bot", botId: command.botId, role: "specialist" },
            updatedAt: command.createdAt,
          },
        },
        botCreatedEvent,
      ];
    }

    case "bot.update": {
      const bot = yield* requireBot({ readModel, command, botId: command.botId });

      const targetGroup =
        command.groupId == null
          ? null
          : yield* requireGroup({ readModel, command, groupId: command.groupId });

      if (command.groupId !== undefined && command.groupId !== null) {
        yield* requireBotNotArchived({ readModel, command, botId: command.botId });
      }

      const sourceGroup =
        command.groupId !== undefined && bot.groupId !== null && bot.groupId !== command.groupId
          ? readModel.groups.find((group) => group.id === bot.groupId)
          : undefined;

      const sourceMembership = sourceGroup?.members
        .filter(isGroupBotMember)
        .find((member) => member.botId === bot.id);

      if (sourceGroup && (sourceMembership?.role === "boss" || sourceGroup.bossBotId === bot.id)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${bot.id}' is the boss of group '${sourceGroup.id}'. Replace it with 'group.boss.set' before changing its group.`,
          }),
        );
      }

      if (sourceGroup && sourceMembership) {
        const remainingBotIds = activeGroupBotIds(readModel, sourceGroup);
        remainingBotIds.delete(bot.id);

        if (remainingBotIds.size < 2) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Group '${sourceGroup.id}' requires at least two active bots.`,
            }),
          );
        }
      }

      const occurredAt = yield* nowIso;
      const events: PlannedOrchestrationEvent[] = [];

      if (sourceGroup && sourceMembership) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "group",
            aggregateId: sourceGroup.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "group.member-unassigned",
          payload: { groupId: sourceGroup.id, botId: bot.id, updatedAt: occurredAt },
        });
      }

      if (
        command.groupId !== undefined &&
        targetGroup !== null &&
        targetGroup.id !== bot.groupId &&
        !targetGroup.members.some((member) => isGroupBotMember(member) && member.botId === bot.id)
      ) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "group",
            aggregateId: targetGroup.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "group.member-assigned",
          payload: {
            groupId: targetGroup.id,
            member: { kind: "bot", botId: bot.id, role: "specialist" },
            updatedAt: occurredAt,
          },
        });
      }

      events.push({
        ...(yield* withEventBase({
          aggregateKind: "bot",
          aggregateId: command.botId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "bot.updated",
        payload: {
          botId: command.botId,
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.label !== undefined ? { label: command.label } : {}),
          ...(command.description !== undefined ? { description: command.description } : {}),
          ...(command.disabledMcpServerIds !== undefined
            ? { disabledMcpServerIds: command.disabledMcpServerIds }
            : {}),
          ...(command.avatar !== undefined ? { avatar: command.avatar } : {}),
          ...(command.engine !== undefined ? { engine: command.engine } : {}),
          ...(command.sandbox !== undefined ? { sandbox: command.sandbox } : {}),
          ...(command.runtimeMode !== undefined ? { runtimeMode: command.runtimeMode } : {}),
          ...(command.usageCap !== undefined ? { usageCap: command.usageCap } : {}),
          ...(command.imageProvider !== undefined ? { imageProvider: command.imageProvider } : {}),
          ...(command.personalityTone !== undefined
            ? { personalityTone: command.personalityTone }
            : {}),
          ...(command.voiceEnabled !== undefined ? { voiceEnabled: command.voiceEnabled } : {}),
          ...(command.channelBindings !== undefined
            ? { channelBindings: command.channelBindings }
            : {}),
          ...(command.groupId !== undefined ? { groupId: command.groupId } : {}),
          updatedAt: occurredAt,
        },
      });

      return events;
    }

    case "bot.archive": {
      yield* requireBotNotArchived({ readModel, command, botId: command.botId });
      const bossGroup = readModel.groups.find((group) => group.bossBotId === command.botId);

      if (bossGroup) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${command.botId}' is the boss of group '${bossGroup.id}'. Set a new boss before archiving it.`,
          }),
        );
      }

      const undersizedGroup = readModel.groups.find((group) => {
        if (
          !group.members.some(
            (member) => isGroupBotMember(member) && member.botId === command.botId,
          )
        ) {
          return false;
        }

        const remainingBotIds = activeGroupBotIds(readModel, group);
        remainingBotIds.delete(command.botId);

        return remainingBotIds.size < 2;
      });

      if (undersizedGroup) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Group '${undersizedGroup.id}' requires at least two active bots.`,
          }),
        );
      }

      const occurredAt = yield* nowIso;

      const archivedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "bot",
          aggregateId: command.botId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "bot.archived" as const,
        payload: {
          botId: command.botId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };

      const pausedEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];

      for (const routine of readModel.routines ?? []) {
        if (
          routine.botId !== command.botId ||
          !routine.enabled ||
          routine.lifecycle === "deleted"
        ) {
          continue;
        }

        pausedEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "routine",
            aggregateId: routine.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "routine.paused",
          payload: {
            routine: {
              ...routine,
              enabled: false,
              lifecycle: "paused",
              nextRunAt: null,
              updatedAt: occurredAt,
            },
          },
        });
      }

      return [...pausedEvents, archivedEvent];
    }

    case "bot.restore": {
      yield* requireBotArchived({ readModel, command, botId: command.botId });
      const occurredAt = yield* nowIso;

      return {
        ...(yield* withEventBase({
          aggregateKind: "bot",
          aggregateId: command.botId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "bot.restored",
        payload: {
          botId: command.botId,
          updatedAt: occurredAt,
        },
      };
    }

    case "bot.delete": {
      const bot = yield* requireBot({ readModel, command, botId: command.botId });
      const bossGroup = readModel.groups.find((group) => group.bossBotId === command.botId);

      if (bossGroup) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${command.botId}' is the boss of group '${bossGroup.id}'. Set a new boss before deleting it.`,
          }),
        );
      }

      const undersizedGroup = readModel.groups.find((group) => {
        if (
          !group.members.some(
            (member) => isGroupBotMember(member) && member.botId === command.botId,
          )
        ) {
          return false;
        }

        const remainingBotIds = activeGroupBotIds(readModel, group);
        remainingBotIds.delete(command.botId);

        return remainingBotIds.size < 2;
      });

      if (undersizedGroup) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Group '${undersizedGroup.id}' requires at least two active bots.`,
          }),
        );
      }

      const occurredAt = yield* nowIso;
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];

      // Canceling interrupts each child turn, so work the bot sent or received stops with it.
      for (const delegation of readModel.delegations) {
        if (
          TERMINAL_DELEGATION_PHASES.has(delegation.phase._tag) ||
          (delegation.parentBotId !== bot.id &&
            delegation.childBotId !== bot.id &&
            !delegation.ancestorBotIds.includes(bot.id))
        ) {
          continue;
        }

        const canceledAt =
          Date.parse(occurredAt) >= Date.parse(delegation.updatedAt)
            ? occurredAt
            : delegation.updatedAt;

        events.push({
          ...(yield* withEventBase({
            aggregateKind: "delegation",
            aggregateId: delegation.delegationId,
            occurredAt: canceledAt,
            commandId: command.commandId,
          })),
          type: "delegation.updated",
          payload: {
            delegation: {
              ...delegation,
              phase: AkeruDelegationPhase.cases.Canceled.make({
                childThreadId: delegationChildThreadId(delegation.phase),
                childTurnId: delegationChildTurnId(delegation.phase),
                startedAt: "startedAt" in delegation.phase ? delegation.phase.startedAt : null,
                completedAt: canceledAt,
                canceledBy: "user",
              }),
              updatedAt: canceledAt,
            },
          },
        });
      }

      // Chats the bot owns or is answering in a group, plus their child chats, lose their agent.
      const liveThreads = readModel.threads.filter((thread) => thread.deletedAt === null);

      const stoppedThreadIds = new Set(
        liveThreads
          .filter((thread) => thread.botId === bot.id || thread.respondingBotId === bot.id)
          .map((thread) => thread.id),
      );

      for (let grew = true; grew; ) {
        grew = false;

        for (const thread of liveThreads) {
          if (
            !stoppedThreadIds.has(thread.id) &&
            thread.parentThreadId != null &&
            stoppedThreadIds.has(thread.parentThreadId)
          ) {
            stoppedThreadIds.add(thread.id);
            grew = true;
          }
        }
      }

      for (const thread of liveThreads) {
        if (
          !stoppedThreadIds.has(thread.id) ||
          !thread.session ||
          thread.session.status === "stopped"
        ) {
          continue;
        }

        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.session-stop-requested",
          payload: {
            threadId: thread.id,
            createdAt: occurredAt,
          },
        });
      }

      for (const group of readModel.groups) {
        if (!group.members.some((member) => isGroupBotMember(member) && member.botId === bot.id)) {
          continue;
        }

        events.push({
          ...(yield* withEventBase({
            aggregateKind: "group",
            aggregateId: group.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "group.member-unassigned",
          payload: {
            groupId: group.id,
            botId: bot.id,
            updatedAt: occurredAt,
          },
        });
      }

      for (const thread of liveThreads) {
        const owned = thread.botId === bot.id;

        if (!owned && thread.respondingBotId !== bot.id) {
          continue;
        }

        // An owned chat is detached. A group chat keeps its owners and only drops the responder.
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.ownership-updated",
          payload: {
            threadId: thread.id,
            botId: owned ? null : (thread.botId ?? null),
            groupId: owned ? null : (thread.groupId ?? null),
            updatedAt: occurredAt,
          },
        });
      }

      for (const routine of readModel.routines ?? []) {
        if (routine.botId !== bot.id || routine.lifecycle === "deleted") {
          continue;
        }

        events.push({
          ...(yield* withEventBase({
            aggregateKind: "routine",
            aggregateId: routine.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "routine.deleted",
          payload: {
            routine: {
              ...routine,
              enabled: false,
              lifecycle: "deleted",
              nextRunAt: null,
              updatedAt: occurredAt,
              deletedAt: occurredAt,
            },
          },
        });
      }

      for (const assignment of readModel.skillAssignments ?? []) {
        if (assignment.botId !== bot.id) {
          continue;
        }

        events.push({
          ...(yield* withEventBase({
            aggregateKind: "skill-assignment",
            aggregateId: assignment.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "skill-assignment.unassigned",
          payload: {
            assignmentId: assignment.id,
            botId: bot.id,
            removedAt: occurredAt,
          },
        });
      }

      events.push({
        ...(yield* withEventBase({
          aggregateKind: "bot",
          aggregateId: command.botId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "bot.deleted",
        payload: {
          botId: command.botId,
          deletedAt: occurredAt,
        },
      });

      return events;
    }
  }
});

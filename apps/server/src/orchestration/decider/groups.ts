import {
  isGroupBotMember,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import type { OrchestrationDispatchActor } from "../Services/OrchestrationEngine.ts";
import { requireBotNotArchived, requireGroup, requireGroupAbsent } from "../commandInvariants.ts";
import {
  type PlannedOrchestrationEvent,
  withEventBase,
  nowIso,
  botGroupUpdatedEvent,
  activeGroupBotIds,
  type DecideOrchestrationCommandResult,
} from "./eventBase.ts";

export const decideGroups = Effect.fn("decideGroups")(function* ({
  command,
  readModel,
}: {
  readonly command: Extract<
    OrchestrationCommand,
    {
      type:
        | "group.create"
        | "group.rename"
        | "group.delete"
        | "group.member.assign"
        | "group.member.unassign"
        | "group.person.assign"
        | "group.person.unassign"
        | "group.leave"
        | "group.boss.set";
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
    case "group.create": {
      yield* requireGroupAbsent({ readModel, command, groupId: command.groupId });
      if (command.bossBotId === undefined) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "A group requires a boss bot.",
          }),
        );
      }

      const memberBotIds = [
        command.bossBotId,
        ...new Set((command.specialistBotIds ?? []).filter((botId) => botId !== command.bossBotId)),
      ];
      yield* Effect.forEach(memberBotIds, (botId) =>
        requireBotNotArchived({ readModel, command, botId }),
      );
      if (memberBotIds.length < 2) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Group '${command.groupId}' requires at least two active bots.`,
          }),
        );
      }

      const groupCreatedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: command.groupId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "group.created",
        payload: {
          groupId: command.groupId,
          name: command.name,
          bossBotId: command.bossBotId,
          members: [
            ...memberBotIds.map((botId) => ({
              kind: "bot" as const,
              botId,
              role: botId === command.bossBotId ? ("boss" as const) : ("specialist" as const),
            })),
            ...(command.creator === undefined ? [] : [command.creator]),
          ],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      return groupCreatedEvent;
    }
    case "group.rename": {
      yield* requireGroup({ readModel, command, groupId: command.groupId });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: command.groupId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.renamed",
        payload: {
          groupId: command.groupId,
          name: command.name,
          updatedAt: occurredAt,
        },
      };
    }
    case "group.delete": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const occurredAt = yield* nowIso;
      const deletedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: command.groupId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.deleted",
        payload: {
          groupId: command.groupId,
          deletedAt: occurredAt,
        },
      };
      const botUpdatedEvents = yield* Effect.forEach(
        group.members
          .filter(isGroupBotMember)
          .filter(
            (member) =>
              readModel.bots.find((bot) => bot.id === member.botId)?.groupId === command.groupId,
          ),
        (member) =>
          botGroupUpdatedEvent({
            botId: member.botId,
            groupId: null,
            occurredAt,
            commandId: command.commandId,
          }),
      );
      const threadUpdatedEvents = yield* Effect.forEach(
        readModel.threads.filter((thread) => thread.groupId === command.groupId),
        Effect.fn(function* (thread) {
          return {
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: thread.id,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "thread.ownership-updated" as const,
            payload: {
              threadId: thread.id,
              botId: null,
              groupId: null,
              updatedAt: occurredAt,
            },
          };
        }),
      );
      return [...botUpdatedEvents, ...threadUpdatedEvents, deletedEvent];
    }
    case "group.member.assign": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const bot = yield* requireBotNotArchived({ readModel, command, botId: command.botId });
      if (command.role === "boss" && group.bossBotId !== null && group.bossBotId !== bot.id) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Group '${group.id}' already has boss bot '${group.bossBotId}'. Use 'group.boss.set' to replace it.`,
          }),
        );
      }
      if (command.role === "specialist" && group.bossBotId === bot.id) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${bot.id}' is the boss of group '${group.id}' and cannot be assigned as a specialist.`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      const assignedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: group.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.member-assigned",
        payload: {
          groupId: group.id,
          member: { kind: "bot", botId: bot.id, role: command.role },
          updatedAt: occurredAt,
        },
      };
      return assignedEvent;
    }
    case "group.member.unassign": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const member = group.members
        .filter(isGroupBotMember)
        .find((entry) => entry.botId === command.botId);
      if (!member) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${command.botId}' is not a member of group '${group.id}'.`,
          }),
        );
      }
      if (member.role === "boss" || group.bossBotId === command.botId) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${command.botId}' is the last boss of group '${group.id}'. Set a new boss and unassign the previous boss with one 'group.boss.set' command.`,
          }),
        );
      }
      const remainingBotIds = activeGroupBotIds(readModel, group);
      remainingBotIds.delete(command.botId);
      if (remainingBotIds.size < 2) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Group '${group.id}' requires at least two active bots.`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      const unassignedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: group.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.member-unassigned",
        payload: {
          groupId: group.id,
          botId: command.botId,
          updatedAt: occurredAt,
        },
      };
      return unassignedEvent;
    }
    case "group.person.assign": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: group.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.person-assigned",
        payload: {
          groupId: group.id,
          person: command.person,
          updatedAt: occurredAt,
        },
      };
    }
    case "group.person.unassign":
    case "group.leave": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const person = group.members.find(
        (member) => member.kind === "person" && member.personId === command.personId,
      );
      if (!person) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Person '${command.personId}' is not a member of group '${group.id}'.`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: group.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.person-unassigned",
        payload: {
          groupId: group.id,
          personId: command.personId,
          updatedAt: occurredAt,
        },
      };
    }
    case "group.boss.set": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const nextBoss = yield* requireBotNotArchived({
        readModel,
        command,
        botId: command.bossBotId,
      });
      if (group.bossBotId === nextBoss.id && command.unassignPreviousBoss === true) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${nextBoss.id}' is already the boss and cannot replace and unassign itself.`,
          }),
        );
      }
      if (command.unassignPreviousBoss === true) {
        const remainingBotIds = activeGroupBotIds(readModel, group);
        if (group.bossBotId !== null) remainingBotIds.delete(group.bossBotId);
        remainingBotIds.add(nextBoss.id);
        if (remainingBotIds.size < 2) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Group '${group.id}' requires at least two active bots.`,
            }),
          );
        }
      }

      const occurredAt = yield* nowIso;
      const previousBossBotId = group.bossBotId;
      const previousBossRole =
        previousBossBotId === null || previousBossBotId === nextBoss.id
          ? null
          : command.unassignPreviousBoss === true
            ? ("unassigned" as const)
            : ("specialist" as const);
      const bossSetEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: group.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.boss-set",
        payload: {
          groupId: group.id,
          bossBotId: nextBoss.id,
          previousBossBotId,
          previousBossRole,
          updatedAt: occurredAt,
        },
      };
      return bossSetEvent;
    }
  }
});

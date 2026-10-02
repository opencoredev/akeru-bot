import type { OrchestrationBot, OrchestrationGroup } from "@akeru/contracts";
import { isGroupBotMember } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import {
  BotArchivedPayload,
  BotCreatedPayload,
  BotDeletedPayload,
  BotRestoredPayload,
  BotUpdatedPayload,
  GroupBossSetPayload,
  GroupCreatedPayload,
  GroupDeletedPayload,
  GroupMemberAssignedPayload,
  GroupMemberUnassignedPayload,
  GroupPersonAssignedPayload,
  GroupPersonUnassignedPayload,
  GroupRenamedPayload,
} from "../Schemas.ts";
import type { OrchestrationReadModel, OrchestrationEvent } from "@akeru/contracts";
import type { OrchestrationProjectorDecodeError } from "../Errors.ts";
import { decodeForEvent, updateBot, updateGroup } from "./Updates.ts";

export function projectBotsAndGroups(
  nextBase: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  switch (event.type) {
    case "bot.created":
      return decodeForEvent(BotCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const bot: OrchestrationBot = {
            id: payload.botId,
            name: payload.name,
            title: payload.title,
            label: payload.label,
            description: payload.description,
            disabledMcpServerIds: payload.disabledMcpServerIds,
            avatar: payload.avatar,
            engine: payload.engine,
            sandbox: payload.sandbox,
            runtimeMode: payload.runtimeMode,
            usageCap: payload.usageCap,
            imageProvider: payload.imageProvider,
            personalityTone: payload.personalityTone,
            voiceEnabled: payload.voiceEnabled,
            channelBindings: payload.channelBindings,
            groupId: payload.groupId,
            archivedAt: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          };

          const existing = nextBase.bots.some((entry) => entry.id === payload.botId);

          return {
            ...nextBase,
            bots: existing
              ? nextBase.bots.map((entry) => (entry.id === payload.botId ? bot : entry))
              : [...nextBase.bots, bot],
          };
        }),
      );
    case "bot.updated":
      return decodeForEvent(BotUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          bots: updateBot(nextBase.bots, payload.botId, {
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.label !== undefined ? { label: payload.label } : {}),
            ...(payload.description !== undefined ? { description: payload.description } : {}),
            ...(payload.disabledMcpServerIds !== undefined
              ? { disabledMcpServerIds: payload.disabledMcpServerIds }
              : {}),
            ...(payload.avatar !== undefined ? { avatar: payload.avatar } : {}),
            ...(payload.engine !== undefined ? { engine: payload.engine } : {}),
            ...(payload.sandbox !== undefined ? { sandbox: payload.sandbox } : {}),
            ...(payload.runtimeMode !== undefined ? { runtimeMode: payload.runtimeMode } : {}),
            ...(payload.usageCap !== undefined ? { usageCap: payload.usageCap } : {}),
            ...(payload.imageProvider !== undefined
              ? { imageProvider: payload.imageProvider }
              : {}),
            ...(payload.personalityTone !== undefined
              ? { personalityTone: payload.personalityTone }
              : {}),
            ...(payload.voiceEnabled !== undefined ? { voiceEnabled: payload.voiceEnabled } : {}),
            ...(payload.channelBindings !== undefined
              ? { channelBindings: payload.channelBindings }
              : {}),
            ...(payload.groupId !== undefined ? { groupId: payload.groupId } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "bot.archived":
      return decodeForEvent(BotArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          bots: updateBot(nextBase.bots, payload.botId, {
            archivedAt: payload.archivedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "bot.restored":
      return decodeForEvent(BotRestoredPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          bots: updateBot(nextBase.bots, payload.botId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "bot.deleted":
      return decodeForEvent(BotDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          bots: nextBase.bots.filter((entry) => entry.id !== payload.botId),
        })),
      );
    case "group.created":
      return decodeForEvent(GroupCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const group: OrchestrationGroup = {
            id: payload.groupId,
            name: payload.name,
            bossBotId: payload.bossBotId,
            members: payload.members,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          };

          const existing = nextBase.groups.some((entry) => entry.id === payload.groupId);

          return {
            ...nextBase,
            groups: existing
              ? nextBase.groups.map((entry) => (entry.id === payload.groupId ? group : entry))
              : [...nextBase.groups, group],
          };
        }),
      );
    case "group.renamed":
      return decodeForEvent(GroupRenamedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          groups: nextBase.groups.map((group) =>
            group.id === payload.groupId
              ? { ...group, name: payload.name, updatedAt: payload.updatedAt }
              : group,
          ),
        })),
      );
    case "group.member-assigned":
      return decodeForEvent(GroupMemberAssignedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const group = nextBase.groups.find((entry) => entry.id === payload.groupId);

          if (!group) return nextBase;

          const members = group.members.some(
            (member) => isGroupBotMember(member) && member.botId === payload.member.botId,
          )
            ? group.members.map((member) =>
                isGroupBotMember(member) && member.botId === payload.member.botId
                  ? payload.member
                  : member,
              )
            : [...group.members, payload.member];

          return {
            ...nextBase,
            groups: updateGroup(nextBase.groups, payload.groupId, {
              members,
              bossBotId: payload.member.role === "boss" ? payload.member.botId : group.bossBotId,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );
    case "group.member-unassigned":
      return decodeForEvent(
        GroupMemberUnassignedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          groups: updateGroup(nextBase.groups, payload.groupId, {
            members:
              nextBase.groups
                .find((group) => group.id === payload.groupId)
                ?.members.filter(
                  (member) => !isGroupBotMember(member) || member.botId !== payload.botId,
                ) ?? [],
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "group.person-assigned":
      return decodeForEvent(GroupPersonAssignedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const group = nextBase.groups.find((entry) => entry.id === payload.groupId);

          if (!group) return nextBase;

          const members = [
            ...group.members.filter(
              (member) => member.kind !== "person" || member.personId !== payload.person.personId,
            ),
            payload.person,
          ];

          return {
            ...nextBase,
            groups: updateGroup(nextBase.groups, payload.groupId, {
              members,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );
    case "group.person-unassigned":
      return decodeForEvent(
        GroupPersonUnassignedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          groups: updateGroup(nextBase.groups, payload.groupId, {
            members:
              nextBase.groups
                .find((group) => group.id === payload.groupId)
                ?.members.filter(
                  (member) => member.kind !== "person" || member.personId !== payload.personId,
                ) ?? [],
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "group.boss-set":
      return decodeForEvent(GroupBossSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const group = nextBase.groups.find((entry) => entry.id === payload.groupId);

          if (!group) return nextBase;

          let members = group.members.filter(
            (member) => !isGroupBotMember(member) || member.botId !== payload.bossBotId,
          );

          if (payload.previousBossBotId !== null) {
            members = members.filter(
              (member) => !isGroupBotMember(member) || member.botId !== payload.previousBossBotId,
            );

            if (payload.previousBossRole === "specialist") {
              members = [
                ...members,
                { kind: "bot", botId: payload.previousBossBotId, role: "specialist" },
              ];
            }
          }

          members = [...members, { kind: "bot", botId: payload.bossBotId, role: "boss" }];

          return {
            ...nextBase,
            groups: updateGroup(nextBase.groups, payload.groupId, {
              bossBotId: payload.bossBotId,
              members,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );
    case "group.deleted":
      return decodeForEvent(GroupDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          groups: nextBase.groups.filter((group) => group.id !== payload.groupId),
        })),
      );
    default:
      throw new Error("Unexpected projector event: " + event.type);
  }
}

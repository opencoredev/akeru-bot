import { isGroupBotMember } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type ProjectionDependencies, type ProjectorDefinition } from "./Definitions.ts";

export function createGroups({
  projectionGroupRepository,
}: Pick<ProjectionDependencies, "projectionGroupRepository">) {
  const applyGroupsProjection: ProjectorDefinition["apply"] = Effect.fn("applyGroupsProjection")(
    function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "group.created":
          yield* projectionGroupRepository.upsert({
            groupId: event.payload.groupId,
            name: event.payload.name,
            bossBotId: event.payload.bossBotId,
            members: event.payload.members,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        case "group.renamed": {
          const existing = yield* projectionGroupRepository.getById({
            groupId: event.payload.groupId,
          });
          if (Option.isNone(existing)) return;
          yield* projectionGroupRepository.upsert({
            ...existing.value,
            name: event.payload.name,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }
        case "group.member-assigned": {
          const existing = yield* projectionGroupRepository.getById({
            groupId: event.payload.groupId,
          });
          if (Option.isNone(existing)) return;
          const members = existing.value.members.some(
            (member) => isGroupBotMember(member) && member.botId === event.payload.member.botId,
          )
            ? existing.value.members.map((member) =>
                isGroupBotMember(member) && member.botId === event.payload.member.botId
                  ? event.payload.member
                  : member,
              )
            : [...existing.value.members, event.payload.member];
          yield* projectionGroupRepository.upsert({
            ...existing.value,
            bossBotId:
              event.payload.member.role === "boss"
                ? event.payload.member.botId
                : existing.value.bossBotId,
            members,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }
        case "group.member-unassigned": {
          const existing = yield* projectionGroupRepository.getById({
            groupId: event.payload.groupId,
          });
          if (Option.isNone(existing)) return;
          yield* projectionGroupRepository.upsert({
            ...existing.value,
            members: existing.value.members.filter(
              (member) => !isGroupBotMember(member) || member.botId !== event.payload.botId,
            ),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }
        case "group.person-assigned": {
          const existing = yield* projectionGroupRepository.getById({
            groupId: event.payload.groupId,
          });
          if (Option.isNone(existing)) return;
          const members = existing.value.members.some(
            (member) =>
              member.kind === "person" && member.personId === event.payload.person.personId,
          )
            ? existing.value.members.map((member) =>
                member.kind === "person" && member.personId === event.payload.person.personId
                  ? event.payload.person
                  : member,
              )
            : [...existing.value.members, event.payload.person];
          yield* projectionGroupRepository.upsert({
            ...existing.value,
            members,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }
        case "group.person-unassigned": {
          const existing = yield* projectionGroupRepository.getById({
            groupId: event.payload.groupId,
          });
          if (Option.isNone(existing)) return;
          yield* projectionGroupRepository.upsert({
            ...existing.value,
            members: existing.value.members.filter(
              (member) => member.kind !== "person" || member.personId !== event.payload.personId,
            ),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }
        case "group.boss-set": {
          const existing = yield* projectionGroupRepository.getById({
            groupId: event.payload.groupId,
          });
          if (Option.isNone(existing)) return;
          let members = existing.value.members.filter(
            (member) => !isGroupBotMember(member) || member.botId !== event.payload.bossBotId,
          );
          if (event.payload.previousBossBotId !== null) {
            members = members.filter(
              (member) =>
                !isGroupBotMember(member) || member.botId !== event.payload.previousBossBotId,
            );
            if (event.payload.previousBossRole === "specialist") {
              members = [
                ...members,
                {
                  kind: "bot",
                  botId: event.payload.previousBossBotId,
                  role: "specialist",
                },
              ];
            }
          }
          yield* projectionGroupRepository.upsert({
            ...existing.value,
            bossBotId: event.payload.bossBotId,
            members: [...members, { kind: "bot", botId: event.payload.bossBotId, role: "boss" }],
            updatedAt: event.payload.updatedAt,
          });
          return;
        }
        case "group.deleted":
          yield* projectionGroupRepository.deleteById({ groupId: event.payload.groupId });
          return;
        default:
          return;
      }
    },
  );
  return { applyGroupsProjection };
}

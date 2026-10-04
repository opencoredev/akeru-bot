import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type ProjectionDependencies, type ProjectorDefinition } from "./Definitions.ts";

export function createBots({
  projectionBotRepository,
}: Pick<ProjectionDependencies, "projectionBotRepository">) {
  const applyBotsProjection: ProjectorDefinition["apply"] = Effect.fn("applyBotsProjection")(
    function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "bot.created":
          yield* projectionBotRepository.upsert({
            botId: event.payload.botId,
            name: event.payload.name,
            title: event.payload.title,
            label: event.payload.label,
            description: event.payload.description,
            disabledMcpServerIds: event.payload.disabledMcpServerIds,
            avatar: event.payload.avatar,
            engine: event.payload.engine,
            sandbox: event.payload.sandbox,
            runtimeMode: event.payload.runtimeMode,
            imageProvider: event.payload.imageProvider,
            personalityTone: event.payload.personalityTone,
            voiceEnabled: event.payload.voiceEnabled,
            channelBindings: event.payload.channelBindings,
            groupId: event.payload.groupId,
            archivedAt: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });

          return;
        case "bot.updated": {
          const existing = yield* projectionBotRepository.getById({ botId: event.payload.botId });

          if (Option.isNone(existing)) return;
          yield* projectionBotRepository.upsert({
            ...existing.value,
            ...(event.payload.name !== undefined ? { name: event.payload.name } : {}),
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.label !== undefined ? { label: event.payload.label } : {}),
            ...(event.payload.description !== undefined
              ? { description: event.payload.description }
              : {}),
            ...(event.payload.disabledMcpServerIds !== undefined
              ? { disabledMcpServerIds: event.payload.disabledMcpServerIds }
              : {}),
            ...(event.payload.avatar !== undefined ? { avatar: event.payload.avatar } : {}),
            ...(event.payload.engine !== undefined ? { engine: event.payload.engine } : {}),
            ...(event.payload.sandbox !== undefined ? { sandbox: event.payload.sandbox } : {}),
            ...(event.payload.runtimeMode !== undefined
              ? { runtimeMode: event.payload.runtimeMode }
              : {}),
            ...(event.payload.imageProvider !== undefined
              ? { imageProvider: event.payload.imageProvider }
              : {}),
            ...(event.payload.personalityTone !== undefined
              ? { personalityTone: event.payload.personalityTone }
              : {}),
            ...(event.payload.voiceEnabled !== undefined
              ? { voiceEnabled: event.payload.voiceEnabled }
              : {}),
            ...(event.payload.channelBindings !== undefined
              ? { channelBindings: event.payload.channelBindings }
              : {}),
            ...(event.payload.groupId !== undefined ? { groupId: event.payload.groupId } : {}),
            updatedAt: event.payload.updatedAt,
          });

          return;
        }

        case "bot.archived": {
          const existing = yield* projectionBotRepository.getById({ botId: event.payload.botId });

          if (Option.isNone(existing)) return;
          yield* projectionBotRepository.upsert({
            ...existing.value,
            archivedAt: event.payload.archivedAt,
            updatedAt: event.payload.updatedAt,
          });

          return;
        }

        case "bot.restored": {
          const existing = yield* projectionBotRepository.getById({ botId: event.payload.botId });

          if (Option.isNone(existing)) return;
          yield* projectionBotRepository.upsert({
            ...existing.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });

          return;
        }

        case "bot.deleted":
          yield* projectionBotRepository.deleteById({ botId: event.payload.botId });

          return;
        default:
          return;
      }
    },
  );

  return { applyBotsProjection };
}

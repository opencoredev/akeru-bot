import {
  BotAvatar,
  BotEngine,
  BotId,
  BotSandbox,
  BotUsageCap,
  ChannelBinding,
  GroupId,
  IsoDateTime,
  McpServerId,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionBot = Schema.Struct({
  botId: BotId,
  name: Schema.String,
  title: Schema.String,
  label: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  disabledMcpServerIds: Schema.Array(McpServerId),
  avatar: BotAvatar,
  engine: Schema.NullOr(BotEngine),
  sandbox: Schema.NullOr(BotSandbox),
  runtimeMode: RuntimeMode,
  usageCap: Schema.NullOr(BotUsageCap),
  voiceEnabled: Schema.Boolean,
  channelBindings: Schema.optional(Schema.Array(ChannelBinding)),
  groupId: Schema.NullOr(GroupId),
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionBot = typeof ProjectionBot.Type;

export const GetProjectionBotInput = Schema.Struct({ botId: BotId });
export type GetProjectionBotInput = typeof GetProjectionBotInput.Type;

export interface ProjectionBotRepositoryShape {
  readonly upsert: (bot: ProjectionBot) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionBotInput,
  ) => Effect.Effect<Option.Option<ProjectionBot>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionBot>, ProjectionRepositoryError>;
}

export class ProjectionBotRepository extends Context.Service<
  ProjectionBotRepository,
  ProjectionBotRepositoryShape
>()("akeru-bot/persistence/Services/ProjectionBots/ProjectionBotRepository") {}

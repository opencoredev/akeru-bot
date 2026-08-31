import { BotId, GroupId, GroupMembership, IsoDateTime } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionGroup = Schema.Struct({
  groupId: GroupId,
  name: Schema.String,
  bossBotId: Schema.NullOr(BotId),
  members: Schema.Array(GroupMembership),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionGroup = typeof ProjectionGroup.Type;

export const GetProjectionGroupInput = Schema.Struct({ groupId: GroupId });
export type GetProjectionGroupInput = typeof GetProjectionGroupInput.Type;

export interface ProjectionGroupRepositoryShape {
  readonly upsert: (group: ProjectionGroup) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionGroupInput,
  ) => Effect.Effect<Option.Option<ProjectionGroup>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionGroup>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: GetProjectionGroupInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionGroupRepository extends Context.Service<
  ProjectionGroupRepository,
  ProjectionGroupRepositoryShape
>()("akeru-bot/persistence/Services/ProjectionGroups/ProjectionGroupRepository") {}

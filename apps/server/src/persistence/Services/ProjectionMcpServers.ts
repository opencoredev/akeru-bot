/** Workspace-level raw MCP server projection persistence. */
import { McpServer, McpServerId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionMcpServer = McpServer;
export type ProjectionMcpServer = typeof ProjectionMcpServer.Type;

export const GetProjectionMcpServerInput = Schema.Struct({
  mcpServerId: McpServerId,
});
export type GetProjectionMcpServerInput = typeof GetProjectionMcpServerInput.Type;

export interface ProjectionMcpServerRepositoryShape {
  readonly upsert: (row: ProjectionMcpServer) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionMcpServerInput,
  ) => Effect.Effect<Option.Option<ProjectionMcpServer>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionMcpServer>,
    ProjectionRepositoryError
  >;
  readonly deleteById: (
    input: GetProjectionMcpServerInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionMcpServerRepository extends Context.Service<
  ProjectionMcpServerRepository,
  ProjectionMcpServerRepositoryShape
>()("akeru-bot/persistence/Services/ProjectionMcpServers/ProjectionMcpServerRepository") {}

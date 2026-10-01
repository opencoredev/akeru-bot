import * as Effect from "effect/Effect";
import { type ProjectionDependencies, type ProjectorDefinition } from "./Definitions.ts";

export function createMcpServers({
  projectionMcpServerRepository,
}: Pick<ProjectionDependencies, "projectionMcpServerRepository">) {
  const applyMcpServersProjection: ProjectorDefinition["apply"] = Effect.fn(
    "applyMcpServersProjection",
  )(function* (event, _attachmentSideEffects) {
    switch (event.type) {
      case "mcp-server.created":
      case "mcp-server.updated":
      case "mcp-server.enabled":
      case "mcp-server.disabled":
        yield* projectionMcpServerRepository.upsert(event.payload.mcpServer);

        return;
      case "mcp-server.deleted":
        yield* projectionMcpServerRepository.deleteById({
          mcpServerId: event.payload.mcpServerId,
        });

        return;
      default:
        return;
    }
  });

  return { applyMcpServersProjection };
}

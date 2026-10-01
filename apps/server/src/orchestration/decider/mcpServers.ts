import { type OrchestrationCommand, type OrchestrationReadModel } from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import type { OrchestrationDispatchActor } from "../Services/OrchestrationEngine.ts";
import { requireMcpServer, requireMcpServerAbsent } from "../commandInvariants.ts";
import { withEventBase, nowIso, type DecideOrchestrationCommandResult } from "./eventBase.ts";

export const decideMcpServers = Effect.fn("decideMcpServers")(function* ({
  command,
  readModel,
}: {
  readonly command: Extract<
    OrchestrationCommand,
    {
      type:
        | "mcp-server.create"
        | "mcp-server.update"
        | "mcp-server.instructions.set"
        | "mcp-server.delete"
        | "mcp-server.enable"
        | "mcp-server.disable";
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
    case "mcp-server.create": {
      yield* requireMcpServerAbsent({
        readModel,
        command,
        mcpServerId: command.mcpServerId,
      });
      const mcpServer =
        command.transport === "stdio"
          ? {
              id: command.mcpServerId,
              name: command.name,
              transport: command.transport,
              command: command.command,
              ...(command.args !== undefined ? { args: command.args } : {}),
              enabled: command.enabled ?? true,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
            }
          : {
              id: command.mcpServerId,
              name: command.name,
              transport: command.transport,
              url: command.url,
              enabled: command.enabled ?? true,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
            };

      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-server",
          aggregateId: command.mcpServerId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "mcp-server.created",
        payload: { mcpServer },
      };
    }
    case "mcp-server.update": {
      const existing = yield* requireMcpServer({
        readModel,
        command,
        mcpServerId: command.mcpServerId,
      });
      const occurredAt = yield* nowIso;
      const mcpServer =
        command.transport === "stdio"
          ? {
              id: existing.id,
              name: command.name,
              transport: command.transport,
              command: command.command,
              ...(command.args !== undefined ? { args: command.args } : {}),
              ...(existing.instructions !== undefined
                ? { instructions: existing.instructions }
                : {}),
              enabled: existing.enabled,
              createdAt: existing.createdAt,
              updatedAt: occurredAt,
            }
          : {
              id: existing.id,
              name: command.name,
              transport: command.transport,
              url: command.url,
              ...(existing.instructions !== undefined
                ? { instructions: existing.instructions }
                : {}),
              enabled: existing.enabled,
              createdAt: existing.createdAt,
              updatedAt: occurredAt,
            };

      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-server",
          aggregateId: command.mcpServerId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "mcp-server.updated",
        payload: { mcpServer },
      };
    }
    case "mcp-server.instructions.set": {
      const existing = yield* requireMcpServer({
        readModel,
        command,
        mcpServerId: command.mcpServerId,
      });
      const occurredAt = yield* nowIso;
      const { instructions: _previous, ...rest } = existing;
      const instructions = command.instructions.trim();
      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-server",
          aggregateId: command.mcpServerId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "mcp-server.updated",
        payload: {
          mcpServer: {
            ...rest,
            ...(instructions ? { instructions } : {}),
            updatedAt: occurredAt,
          },
        },
      };
    }
    case "mcp-server.delete": {
      yield* requireMcpServer({
        readModel,
        command,
        mcpServerId: command.mcpServerId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-server",
          aggregateId: command.mcpServerId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "mcp-server.deleted",
        payload: {
          mcpServerId: command.mcpServerId,
          deletedAt: occurredAt,
        },
      };
    }
    case "mcp-server.enable":
    case "mcp-server.disable": {
      const existing = yield* requireMcpServer({
        readModel,
        command,
        mcpServerId: command.mcpServerId,
      });
      const occurredAt = yield* nowIso;
      const enabled = command.type === "mcp-server.enable";
      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-server",
          aggregateId: command.mcpServerId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: enabled ? "mcp-server.enabled" : "mcp-server.disabled",
        payload: {
          mcpServer: {
            ...existing,
            enabled,
            updatedAt: occurredAt,
          },
        },
      };
    }
  }
});

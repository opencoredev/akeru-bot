import * as Effect from "effect/Effect";
import {
  type CommandInput,
  type CommandEffect,
  commandId,
  timestampedCommandMetadata,
  dispatch,
} from "./dispatch.ts";

export type CreateMcpServerInput = CommandInput<"mcp-server.create">;

export type UpdateMcpServerInput = CommandInput<"mcp-server.update">;

export type DeleteMcpServerInput = CommandInput<"mcp-server.delete">;

export type EnableMcpServerInput = CommandInput<"mcp-server.enable">;

export type DisableMcpServerInput = CommandInput<"mcp-server.disable">;

export const createMcpServer: (input: CreateMcpServerInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createMcpServer",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);

  if (input.transport === "stdio") {
    return yield* dispatch({
      ...input,
      type: "mcp-server.create",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  }

  return yield* dispatch({
    ...input,
    type: "mcp-server.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const updateMcpServer: (input: UpdateMcpServerInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateMcpServer",
)(function* (input) {
  const nextCommandId = yield* commandId(input);

  if (input.transport === "stdio") {
    return yield* dispatch({
      ...input,
      type: "mcp-server.update",
      commandId: nextCommandId,
    });
  }

  return yield* dispatch({
    ...input,
    type: "mcp-server.update",
    commandId: nextCommandId,
  });
});

export const deleteMcpServer: (input: DeleteMcpServerInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteMcpServer",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "mcp-server.delete",
    commandId: yield* commandId(input),
  });
});

export const enableMcpServer: (input: EnableMcpServerInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.enableMcpServer",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "mcp-server.enable",
    commandId: yield* commandId(input),
  });
});

export const disableMcpServer: (input: DisableMcpServerInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.disableMcpServer",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "mcp-server.disable",
    commandId: yield* commandId(input),
  });
});

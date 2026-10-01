import * as Effect from "effect/Effect";
import {
  type CommandInput,
  type CommandEffect,
  commandId,
  timestampedCommandMetadata,
  dispatch,
} from "./dispatch.ts";

export type CreateProjectInput = CommandInput<"project.create">;

export type UpdateProjectInput = CommandInput<"project.meta.update">;

export type DeleteProjectInput = CommandInput<"project.delete">;

export type ChangeChannelProjectInput = CommandInput<"channel.change-project">;

export const createProject: (input: CreateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createProject",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);

  return yield* dispatch({
    ...input,
    type: "project.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const updateProject: (input: UpdateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.meta.update",
    commandId: yield* commandId(input),
  });
});

export const deleteProject: (input: DeleteProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.delete",
    commandId: yield* commandId(input),
  });
});

export const changeChannelProject: (input: ChangeChannelProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.changeChannelProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.change-project",
    commandId: yield* commandId(input),
  });
});

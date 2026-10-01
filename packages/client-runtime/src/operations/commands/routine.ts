import * as Effect from "effect/Effect";
import {
  type CommandInput,
  type CommandEffect,
  timestampedCommandMetadata,
  dispatch,
} from "./dispatch.ts";

export type DraftRoutineInput = CommandInput<"routine.draft">;

export type ApproveRoutineInput = CommandInput<"routine.approve">;

export type EnableRoutineInput = CommandInput<"routine.enable">;

export type PauseRoutineInput = CommandInput<"routine.pause">;

export type RunRoutineInput = CommandInput<"routine.run">;

export type DeleteRoutineInput = CommandInput<"routine.delete">;

export type AssignRoutineSkillInput = CommandInput<"routine.skill.assign">;

export type UnassignRoutineSkillInput = CommandInput<"routine.skill.unassign">;

export const draftRoutine: (input: DraftRoutineInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.draftRoutine",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "routine.draft",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const approveRoutine: (input: ApproveRoutineInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.approveRoutine",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "routine.approve",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const enableRoutine: (input: EnableRoutineInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.enableRoutine",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "routine.enable",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const pauseRoutine: (input: PauseRoutineInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.pauseRoutine",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "routine.pause",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const runRoutine: (input: RunRoutineInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.runRoutine",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "routine.run",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const deleteRoutine: (input: DeleteRoutineInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteRoutine",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "routine.delete",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const assignRoutineSkill: (input: AssignRoutineSkillInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.assignRoutineSkill",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "routine.skill.assign",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const unassignRoutineSkill: (input: UnassignRoutineSkillInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unassignRoutineSkill",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "routine.skill.unassign",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

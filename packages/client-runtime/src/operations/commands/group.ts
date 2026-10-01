import * as Effect from "effect/Effect";
import {
  type CommandInput,
  type CommandEffect,
  commandId,
  timestampedCommandMetadata,
  dispatch,
} from "./dispatch.ts";

export type CreateGroupInput = CommandInput<"group.create">;

export type RenameGroupInput = CommandInput<"group.rename">;

export type DeleteGroupInput = CommandInput<"group.delete">;

export type AssignGroupMemberInput = CommandInput<"group.member.assign">;

export type UnassignGroupMemberInput = CommandInput<"group.member.unassign">;

export type AssignGroupPersonInput = CommandInput<"group.person.assign">;

export type UnassignGroupPersonInput = CommandInput<"group.person.unassign">;

export type LeaveGroupInput = CommandInput<"group.leave">;

export type SetGroupBossInput = CommandInput<"group.boss.set">;

export const createGroup: (input: CreateGroupInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createGroup",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "group.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const renameGroup: (input: RenameGroupInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.renameGroup",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "group.rename",
    commandId: yield* commandId(input),
  });
});

export const deleteGroup: (input: DeleteGroupInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteGroup",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "group.delete",
    commandId: yield* commandId(input),
  });
});

export const assignGroupMember: (input: AssignGroupMemberInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.assignGroupMember",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "group.member.assign",
    commandId: yield* commandId(input),
  });
});

export const unassignGroupMember: (input: UnassignGroupMemberInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unassignGroupMember",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "group.member.unassign",
    commandId: yield* commandId(input),
  });
});

export const assignGroupPerson: (input: AssignGroupPersonInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.assignGroupPerson",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "group.person.assign",
    commandId: yield* commandId(input),
  });
});

export const unassignGroupPerson: (input: UnassignGroupPersonInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unassignGroupPerson",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "group.person.unassign",
    commandId: yield* commandId(input),
  });
});

export const leaveGroup: (input: LeaveGroupInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.leaveGroup",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "group.leave",
    commandId: yield* commandId(input),
  });
});

export const setGroupBoss: (input: SetGroupBossInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setGroupBoss",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "group.boss.set",
    commandId: yield* commandId(input),
  });
});

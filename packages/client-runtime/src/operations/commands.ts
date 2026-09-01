import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

type CommandType = ClientOrchestrationCommand["type"];
type CommandOf<T extends CommandType> = Extract<ClientOrchestrationCommand, { readonly type: T }>;
type CommandInputFor<C extends ClientOrchestrationCommand> = C extends ClientOrchestrationCommand
  ? Omit<C, "type" | "commandId" | "createdAt"> & {
      readonly commandId?: CommandId;
    } & ("createdAt" extends keyof C
        ? {
            readonly createdAt?: C["createdAt"];
          }
        : {})
  : never;
type CommandInput<T extends CommandType> = CommandInputFor<CommandOf<T>>;

export type CreateProjectInput = CommandInput<"project.create">;
export type UpdateProjectInput = CommandInput<"project.meta.update">;
export type DeleteProjectInput = CommandInput<"project.delete">;
export type CreateBotInput = CommandInput<"bot.create">;
export type UpdateBotInput = CommandInput<"bot.update">;
export type ArchiveBotInput = CommandInput<"bot.archive">;
export type RestoreBotInput = CommandInput<"bot.restore">;
export type ConnectChannelInput = CommandInput<"channel.connect">;
export type SaveChannelConnectionInput = CommandInput<"channel.connection.save">;
export type DeleteChannelConnectionInput = CommandInput<"channel.connection.delete">;
export type AttachChannelInput = CommandInput<"channel.attach">;
export type DisconnectChannelInput = CommandInput<"channel.disconnect">;
export type ReconnectChannelInput = CommandInput<"channel.reconnect">;
export type SendChannelMessageInput = CommandInput<"channel.send">;
export type CreateGroupInput = CommandInput<"group.create">;
export type RenameGroupInput = CommandInput<"group.rename">;
export type DeleteGroupInput = CommandInput<"group.delete">;
export type AssignGroupMemberInput = CommandInput<"group.member.assign">;
export type UnassignGroupMemberInput = CommandInput<"group.member.unassign">;
export type AssignGroupPersonInput = CommandInput<"group.person.assign">;
export type UnassignGroupPersonInput = CommandInput<"group.person.unassign">;
export type LeaveGroupInput = CommandInput<"group.leave">;
export type SetGroupBossInput = CommandInput<"group.boss.set">;
export type CreateMcpServerInput = CommandInput<"mcp-server.create">;
export type UpdateMcpServerInput = CommandInput<"mcp-server.update">;
export type DeleteMcpServerInput = CommandInput<"mcp-server.delete">;
export type EnableMcpServerInput = CommandInput<"mcp-server.enable">;
export type DisableMcpServerInput = CommandInput<"mcp-server.disable">;
export type DraftRoutineInput = CommandInput<"routine.draft">;
export type ApproveRoutineInput = CommandInput<"routine.approve">;
export type EnableRoutineInput = CommandInput<"routine.enable">;
export type PauseRoutineInput = CommandInput<"routine.pause">;
export type RunRoutineInput = CommandInput<"routine.run">;
export type DeleteRoutineInput = CommandInput<"routine.delete">;
export type AssignRoutineSkillInput = CommandInput<"routine.skill.assign">;
export type UnassignRoutineSkillInput = CommandInput<"routine.skill.unassign">;
export type CreateThreadInput = CommandInput<"thread.create">;
export type DeleteThreadInput = CommandInput<"thread.delete">;
export type ArchiveThreadInput = CommandInput<"thread.archive">;
export type UnarchiveThreadInput = CommandInput<"thread.unarchive">;
export type SettleThreadInput = CommandInput<"thread.settle">;
export type UnsettleThreadInput = CommandInput<"thread.unsettle">;
export type SnoozeThreadInput = CommandInput<"thread.snooze">;
export type UnsnoozeThreadInput = CommandInput<"thread.unsnooze">;
export type PinThreadInput = CommandInput<"thread.pin">;
export type UnpinThreadInput = CommandInput<"thread.unpin">;
export type ReorderPinnedThreadInput = CommandInput<"thread.pin.reorder">;
export type UpdateThreadMetadataInput = CommandInput<"thread.meta.update">;
export type SetThreadRuntimeModeInput = CommandInput<"thread.runtime-mode.set">;
export type SetThreadInteractionModeInput = CommandInput<"thread.interaction-mode.set">;
export type StartThreadTurnInput = CommandInput<"thread.turn.start">;
export type AppendVoiceTranscriptInput = CommandInput<"thread.voice-transcript.append">;
export type InterruptThreadTurnInput = CommandInput<"thread.turn.interrupt">;
export type RespondToThreadApprovalInput = CommandInput<"thread.approval.respond">;
export type RespondToThreadUserInputInput = CommandInput<"thread.user-input.respond">;
export type RevertThreadCheckpointInput = CommandInput<"thread.checkpoint.revert">;
export type StopThreadSessionInput = CommandInput<"thread.session.stop">;
export type CancelDelegationInput = CommandInput<"delegation.cancel">;

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;
type CommandEffect = Effect.Effect<
  EnvironmentRpcSuccess<DispatchTag>,
  EnvironmentRpcFailure<DispatchTag> | EnvironmentRpcUnavailableError,
  Crypto.Crypto | EnvironmentSupervisor
>;

function commandId(input: { readonly commandId?: CommandId }) {
  return Effect.gen(function* () {
    if (input.commandId !== undefined) {
      return input.commandId;
    }
    const crypto = yield* Crypto.Crypto;
    return yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make));
  });
}

function timestampedCommandMetadata(input: {
  readonly commandId?: CommandId;
  readonly createdAt?: string;
}) {
  return Effect.all({
    commandId: commandId(input),
    createdAt:
      input.createdAt === undefined
        ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
        : Effect.succeed(input.createdAt),
  });
}

function dispatch(command: ClientOrchestrationCommand) {
  return request(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
}

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

export const createBot: (input: CreateBotInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createBot",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "bot.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

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

export const updateBot: (input: UpdateBotInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateBot",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "bot.update",
    commandId: yield* commandId(input),
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

export const archiveBot: (input: ArchiveBotInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.archiveBot",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "bot.archive",
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

export const restoreBot: (input: RestoreBotInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.restoreBot",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "bot.restore",
    commandId: yield* commandId(input),
  });
});

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

export const connectChannel: (input: ConnectChannelInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.connectChannel",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.connect",
    commandId: yield* commandId(input),
  });
});

export const saveChannelConnection: (input: SaveChannelConnectionInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.saveChannelConnection")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "channel.connection.save",
      commandId: yield* commandId(input),
    });
  });

export const deleteChannelConnection: (input: DeleteChannelConnectionInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.deleteChannelConnection")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "channel.connection.delete",
      commandId: yield* commandId(input),
    });
  });

export const attachChannel: (input: AttachChannelInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.attachChannel",
)(function* (input) {
  return yield* dispatch({ ...input, type: "channel.attach", commandId: yield* commandId(input) });
});

export const disconnectChannel: (input: DisconnectChannelInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.disconnectChannel",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.disconnect",
    commandId: yield* commandId(input),
  });
});

export const reconnectChannel: (input: ReconnectChannelInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reconnectChannel",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.reconnect",
    commandId: yield* commandId(input),
  });
});

export const sendChannelMessage: (input: SendChannelMessageInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.sendChannelMessage",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.send",
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

export const createThread: (input: CreateThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createThread",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const deleteThread: (input: DeleteThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.delete",
    commandId: yield* commandId(input),
  });
});

export const archiveThread: (input: ArchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.archiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.archive",
    commandId: yield* commandId(input),
  });
});

export const unarchiveThread: (input: UnarchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unarchiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unarchive",
    commandId: yield* commandId(input),
  });
});

export const settleThread: (input: SettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.settleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.settle",
    commandId: yield* commandId(input),
  });
});

export const unsettleThread: (input: UnsettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsettleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsettle",
    commandId: yield* commandId(input),
  });
});

export const snoozeThread: (input: SnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.snoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.snooze",
    commandId: yield* commandId(input),
  });
});

export const unsnoozeThread: (input: UnsnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsnoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsnooze",
    commandId: yield* commandId(input),
  });
});

export const pinThread: (input: PinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.pinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin",
    commandId: yield* commandId(input),
  });
});

export const unpinThread: (input: UnpinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unpinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unpin",
    commandId: yield* commandId(input),
  });
});

export const reorderPinnedThread: (input: ReorderPinnedThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderPinnedThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin.reorder",
    commandId: yield* commandId(input),
  });
});

export const updateThreadMetadata: (input: UpdateThreadMetadataInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateThreadMetadata",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.meta.update",
    commandId: yield* commandId(input),
  });
});

export const setThreadRuntimeMode: (input: SetThreadRuntimeModeInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setThreadRuntimeMode",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.runtime-mode.set",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const setThreadInteractionMode: (input: SetThreadInteractionModeInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.setThreadInteractionMode")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.interaction-mode.set",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const startThreadTurn: (input: StartThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.startThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    timezone: input.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    type: "thread.turn.start",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const appendVoiceTranscript: (input: AppendVoiceTranscriptInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.appendVoiceTranscript")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.voice-transcript.append",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const interruptThreadTurn: (input: InterruptThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.interruptThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.interrupt",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const respondToThreadApproval: (input: RespondToThreadApprovalInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadApproval")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.approval.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const respondToThreadUserInput: (input: RespondToThreadUserInputInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadUserInput")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.user-input.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const revertThreadCheckpoint: (input: RevertThreadCheckpointInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.revertThreadCheckpoint")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.checkpoint.revert",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const stopThreadSession: (input: StopThreadSessionInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.stopThreadSession",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.session.stop",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const cancelDelegation: (input: CancelDelegationInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.cancelDelegation",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "delegation.cancel",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

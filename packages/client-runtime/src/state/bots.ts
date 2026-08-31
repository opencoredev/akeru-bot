import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type ArchiveBotInput,
  type AssignGroupMemberInput,
  type AssignGroupPersonInput,
  type CreateBotInput,
  type ConnectChannelInput,
  type DisconnectChannelInput,
  type ReconnectChannelInput,
  type SendChannelMessageInput,
  type CreateGroupInput,
  type DeleteGroupInput,
  type RenameGroupInput,
  type RestoreBotInput,
  type SetGroupBossInput,
  type UnassignGroupMemberInput,
  type UnassignGroupPersonInput,
  type LeaveGroupInput,
  type UpdateBotInput,
  archiveBot,
  assignGroupMember,
  assignGroupPerson,
  createBot,
  connectChannel,
  disconnectChannel,
  reconnectChannel,
  sendChannelMessage,
  createGroup,
  deleteGroup,
  renameGroup,
  restoreBot,
  setGroupBoss,
  unassignGroupMember,
  unassignGroupPerson,
  leaveGroup,
  updateBot,
} from "../operations/commands.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

export type {
  ArchiveBotInput,
  AssignGroupMemberInput,
  AssignGroupPersonInput,
  CreateBotInput,
  ConnectChannelInput,
  DisconnectChannelInput,
  ReconnectChannelInput,
  SendChannelMessageInput,
  CreateGroupInput,
  DeleteGroupInput,
  RenameGroupInput,
  RestoreBotInput,
  SetGroupBossInput,
  UnassignGroupMemberInput,
  UnassignGroupPersonInput,
  LeaveGroupInput,
  UpdateBotInput,
} from "../operations/commands.ts";

export function createBotEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const botConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { botId: string } }) =>
      JSON.stringify([environmentId, "bot", input.botId]),
  };
  const groupConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { groupId: string } }) =>
      JSON.stringify([environmentId, "group", input.groupId]),
  };

  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:bot:create",
      execute: (input: CreateBotInput) => createBot(input),
      scheduler,
      concurrency: botConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:bot:update",
      execute: (input: UpdateBotInput) => updateBot(input),
      scheduler,
      concurrency: botConcurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:bot:archive",
      execute: (input: ArchiveBotInput) => archiveBot(input),
      scheduler,
      concurrency: botConcurrency,
    }),
    restore: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:bot:restore",
      execute: (input: RestoreBotInput) => restoreBot(input),
      scheduler,
      concurrency: botConcurrency,
    }),
    channels: {
      connect: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:channel:connect",
        execute: (input: ConnectChannelInput) => connectChannel(input),
        scheduler,
        concurrency: botConcurrency,
      }),
      disconnect: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:channel:disconnect",
        execute: (input: DisconnectChannelInput) => disconnectChannel(input),
        scheduler,
        concurrency: botConcurrency,
      }),
      reconnect: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:channel:reconnect",
        execute: (input: ReconnectChannelInput) => reconnectChannel(input),
        scheduler,
        concurrency: botConcurrency,
      }),
      send: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:channel:send",
        execute: (input: SendChannelMessageInput) => sendChannelMessage(input),
        scheduler,
        concurrency: botConcurrency,
      }),
    },
    groups: {
      create: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:group:create",
        execute: (input: CreateGroupInput) => createGroup(input),
        scheduler,
        concurrency: groupConcurrency,
      }),
      rename: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:group:rename",
        execute: (input: RenameGroupInput) => renameGroup(input),
        scheduler,
        concurrency: groupConcurrency,
      }),
      delete: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:group:delete",
        execute: (input: DeleteGroupInput) => deleteGroup(input),
        scheduler,
        concurrency: groupConcurrency,
      }),
      assignMember: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:group:member:assign",
        execute: (input: AssignGroupMemberInput) => assignGroupMember(input),
        scheduler,
        concurrency: groupConcurrency,
      }),
      unassignMember: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:group:member:unassign",
        execute: (input: UnassignGroupMemberInput) => unassignGroupMember(input),
        scheduler,
        concurrency: groupConcurrency,
      }),
      assignPerson: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:group:person:assign",
        execute: (input: AssignGroupPersonInput) => assignGroupPerson(input),
        scheduler,
        concurrency: groupConcurrency,
      }),
      unassignPerson: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:group:person:unassign",
        execute: (input: UnassignGroupPersonInput) => unassignGroupPerson(input),
        scheduler,
        concurrency: groupConcurrency,
      }),
      leave: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:group:leave",
        execute: (input: LeaveGroupInput) => leaveGroup(input),
        scheduler,
        concurrency: groupConcurrency,
      }),
      setBoss: createEnvironmentCommand(runtime, {
        label: "environment-data:commands:group:boss:set",
        execute: (input: SetGroupBossInput) => setGroupBoss(input),
        scheduler,
        concurrency: groupConcurrency,
      }),
    },
  };
}

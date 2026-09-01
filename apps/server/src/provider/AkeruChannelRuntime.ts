// @effect-diagnostics globalDate:off globalRandom:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  BotId,
  CommandId,
  GroupId,
  type AkeruToolInputSchemas,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface AkeruChannelRuntimeOptions {
  readonly readSnapshot: () => Promise<OrchestrationReadModel>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly now?: () => string;
  readonly id?: () => string;
}

export function createAkeruChannelRuntime(options: AkeruChannelRuntimeOptions) {
  const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
  const id = options.id ?? (() => NodeCrypto.randomUUID());

  const create = async (
    bossBotId: BotId,
    input: (typeof AkeruToolInputSchemas.CreateChannel)["Type"],
  ) => {
    const snapshot = await options.readSnapshot();
    const boss = snapshot.bots.find((bot) => bot.id === bossBotId && bot.archivedAt === null);
    if (!boss) throw new Error("The channel boss bot is not available.");

    const channelId = GroupId.make(`channel-${id()}`);
    await options.dispatch({
      type: "group.create",
      commandId: CommandId.make(`channel:create:${id()}`),
      groupId: channelId,
      name: input.name,
      bossBotId,
      specialistBotIds: input.specialistBotIds,
      createdAt: now(),
    });
    return channelId;
  };

  const update = async (
    botId: BotId,
    input: (typeof AkeruToolInputSchemas.UpdateChannel)["Type"],
  ) => {
    const snapshot = await options.readSnapshot();
    const channel = snapshot.groups.find((group) => group.id === input.channelId);
    if (!channel) throw new Error("The channel does not exist.");
    if (channel.bossBotId !== botId) throw new Error("Only the channel boss can update it.");

    await options.dispatch({
      type: "group.rename",
      commandId: CommandId.make(`channel:update:${id()}`),
      groupId: input.channelId,
      name: input.name,
    });
    return input.channelId;
  };

  return { create, update };
}

export type AkeruChannelRuntime = ReturnType<typeof createAkeruChannelRuntime>;

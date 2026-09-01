// @effect-diagnostics globalDate:off globalRandom:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  BotId,
  type AkeruMessageReactionResult,
  CommandId,
  GroupId,
  ThreadId,
  type AkeruToolInputSchemas,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface AkeruChannelRuntimeOptions {
  readonly readSnapshot: () => Promise<OrchestrationReadModel>;
  readonly readThread?: (threadId: ThreadId) => Promise<OrchestrationThread | undefined>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly now?: () => string;
  readonly id?: () => string;
  readonly supportsReactions?: (thread: OrchestrationThread) => boolean;
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

  const react = async (
    threadId: ThreadId,
    botId: BotId,
    input: (typeof AkeruToolInputSchemas.ReactToMessage)["Type"],
    toolCallId: string,
  ): Promise<AkeruMessageReactionResult> => {
    const snapshot = await options.readSnapshot();
    const thread = options.readThread
      ? await options.readThread(threadId)
      : snapshot.threads.find((entry) => entry.id === threadId);
    const message = thread?.messages.find((entry) => entry.id === input.messageId);
    if (!thread || !message) throw new Error("The target message is not visible to this bot.");
    const isVisible =
      thread.botId === botId ||
      (thread.groupId != null &&
        snapshot.groups
          .find((group) => group.id === thread.groupId)
          ?.members.some((member) => member.botId === botId));
    if (!isVisible) throw new Error("The target message is not visible to this bot.");
    if (options.supportsReactions?.(thread) === false) {
      return {
        status: "unsupported",
        messageId: input.messageId,
        reason: "channel-does-not-support-reactions",
      };
    }

    const present = (message.reactions ?? []).some(
      (reaction) => reaction.botId === botId && reaction.emoji === input.emoji,
    );
    const nextPresent = input.action === "add";
    if (present === nextPresent) return { status: "applied", ...input, changed: false };
    const commandKey = NodeCrypto.createHash("sha256")
      .update(`${threadId}\u0000${botId}\u0000${toolCallId}\u0000${snapshot.snapshotSequence}`)
      .digest("hex");
    await options.dispatch({
      type: "thread.message.reaction.set",
      commandId: CommandId.make(`reaction:${commandKey}`),
      threadId: thread.id,
      messageId: input.messageId,
      botId,
      emoji: input.emoji,
      present: nextPresent,
      updatedAt: now(),
    });
    return { status: "applied", ...input, changed: true };
  };

  return { create, update, react };
}

export type AkeruChannelRuntime = ReturnType<typeof createAkeruChannelRuntime>;

import * as Predicate from "effect/Predicate";
// @effect-diagnostics globalFetch:off nodeBuiltinImport:off

import {
  BotId,
  CommandId,
  DelegationId,
  EventId,
  MessageId,
  ThreadId,
  type AkeruDelegationRecord,
  akeruDelegationStateOf,
  type AkeruToolInputSchemas,
  type AkeruToolReceipt,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  isGroupBotMember,
} from "@akeru/contracts";

import {
  type AkeruDelegationRuntimeOptions,
  type AkeruDelegationParent,
  phaseChildThreadId,
  phaseChildTurnId,
  type AkeruGroupResultSkipReason,
} from "./AkeruDelegationPolicy.ts";

export function createAkeruDelegationDelivery(
  options: AkeruDelegationRuntimeOptions,
  now: () => string,
  id: () => string,
  commandId: (label: string) => CommandId,
  dispatch: (command: OrchestrationCommand) => Promise<void>,
) {
  const sendToUser = async (
    parent: AkeruDelegationParent,
    request: (typeof AkeruToolInputSchemas.SendToUser)["Type"],
  ): Promise<AkeruToolReceipt> => {
    const snapshot = await options.readSnapshot();
    const sourceThread = snapshot.threads.find((thread) => thread.id === parent.threadId);
    const sourceBot = snapshot.bots.find((bot) => bot.id === parent.botId);

    if (
      !sourceThread ||
      sourceThread.deletedAt !== null ||
      sourceThread.archivedAt !== null ||
      !sourceBot ||
      sourceBot.archivedAt !== null ||
      (sourceThread.respondingBotId ?? sourceThread.botId) !== parent.botId ||
      sourceThread.latestTurn?.turnId !== parent.turnId ||
      sourceThread.latestTurn.state !== "running"
    ) {
      throw new Error("The source bot is not authorized for this active chat.");
    }

    const messageId = MessageId.make(`bot-message-${id()}`);
    const createdAt = now();
    await options.dispatch({
      type: "thread.message.assistant.delta",
      commandId: commandId("message"),
      threadId: parent.threadId,
      messageId,
      delta: request.message,
      turnId: parent.turnId,
      createdAt,
    });
    await options.dispatch({
      type: "thread.message.assistant.complete",
      commandId: commandId("message-complete"),
      threadId: parent.threadId,
      messageId,
      turnId: parent.turnId,
      createdAt,
    });

    return {
      receiptId: `message:${messageId}`,
      toolId: "SendToUser",
      phase: "success",
      threadId: parent.threadId,
      botId: parent.botId,
      summary: "Message sent to the user.",
      fatalToThread: false,
      createdAt,
    };
  };

  const deliver = async (delegation: AkeruDelegationRecord, detail: string) => {
    const state = akeruDelegationStateOf(delegation.phase);
    const createdAt = now();
    await dispatch({
      type: "thread.activity.append",
      commandId: commandId("delivery"),
      threadId: delegation.parentThreadId,
      activity: {
        id: EventId.make(`delegation:${delegation.delegationId}:${state}:${id()}`),
        tone: state === "failed" ? "error" : "info",
        kind: `delegation.${state}`,
        summary: detail,
        payload: {
          delegationId: delegation.delegationId,
          childThreadId: phaseChildThreadId(delegation),
          childTurnId: phaseChildTurnId(delegation),
          childBotId: delegation.childBotId,
          state,
          result: Predicate.isTagged(delegation.phase, "Completed")
            ? delegation.phase.result
            : null,
          failure: Predicate.isTagged(delegation.phase, "Failed") ? delegation.phase.failure : null,
        },
        turnId: delegation.parentTurnId,
        createdAt,
      },
      createdAt,
    });
  };

  // Why the group chat cannot show a message from this bot right now, or null
  // when it can. Mirrors the decider's active-member check for attribution.
  const groupResultSkipReason = (
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    botId: BotId,
  ): AkeruGroupResultSkipReason | null => {
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);

    if (thread === undefined || thread.groupId === null) return "group_unavailable";
    const group = snapshot.groups.find((candidate) => candidate.id === thread.groupId);

    if (group === undefined) return "group_unavailable";
    const bot = snapshot.bots.find((candidate) => candidate.id === botId);
    const member = group.members.some((entry) => isGroupBotMember(entry) && entry.botId === botId);

    return bot === undefined || bot.archivedAt !== null || !member ? "bot_left_group" : null;
  };

  // Shows a group the finished work as a message from the bot that did it.
  // Server-authored, so it starts no turn; the parent still receives the result
  // on its next turn. Reads the group fresh so a renamed parent shows its
  // current name and a bot removed mid-task is reported as skipped rather
  // than as a dispatch failure.
  const postGroupResult = async (input: {
    readonly delegationId: DelegationId;
    readonly threadId: ThreadId;
    readonly botId: BotId;
    readonly parentBotId: BotId;
    readonly task: string;
    readonly summary: string;
  }) => {
    const snapshot = await options.readSnapshot();
    const skipped = groupResultSkipReason(snapshot, input.threadId, input.botId);

    if (skipped !== null) {
      options.onGroupResultSkipped?.(input.delegationId, skipped);

      return;
    }

    const parentBotName =
      snapshot.bots.find((candidate) => candidate.id === input.parentBotId)?.name ?? "the group";

    const messageId = MessageId.make(`delegation-result-${id()}`);
    const createdAt = now();

    try {
      await dispatch({
        type: "thread.message.assistant.delta",
        commandId: commandId("group-result"),
        threadId: input.threadId,
        messageId,
        delta: `Finished work for ${parentBotName}: ${input.task}\n\n${input.summary}`,
        respondingBotId: input.botId,
        createdAt,
      });
      await dispatch({
        type: "thread.message.assistant.complete",
        commandId: commandId("group-result-complete"),
        threadId: input.threadId,
        messageId,
        respondingBotId: input.botId,
        createdAt,
      });
    } catch (cause) {
      // The bot can leave between the read and the dispatch; the decider then
      // refuses the attribution. Report that as a skip, anything else as an error.
      const raced = groupResultSkipReason(
        await options.readSnapshot(),
        input.threadId,
        input.botId,
      );

      if (raced === null) throw cause;
      options.onGroupResultSkipped?.(input.delegationId, raced);
    }
  };

  return { sendToUser, deliver, groupResultSkipReason, postGroupResult };
}

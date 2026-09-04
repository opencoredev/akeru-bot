// @effect-diagnostics globalDate:off globalRandom:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AKERU_DELEGATION_MAX_CONCURRENCY,
  AKERU_DELEGATION_MAX_DEPTH,
  AKERU_TOOL_CATALOG,
  BotId,
  CommandId,
  DelegationId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type AkeruDelegationAccessGrant,
  type AkeruDelegationFailureCode,
  type AkeruDelegationRecord,
  type AkeruToolInputSchemas,
  type AkeruToolReceipt,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type TurnId,
  isGroupBotMember,
} from "@t3tools/contracts";

import { intersectDelegationAccess } from "./AkeruToolRuntime.ts";

const TERMINAL_STATES = new Set<AkeruDelegationRecord["state"]>([
  "completed",
  "failed",
  "canceled",
]);

export interface AkeruDelegationParent {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly botId: BotId;
  readonly parentDelegationId: DelegationId | null;
  readonly ancestorBotIds: ReadonlyArray<BotId>;
  readonly depth: number;
  readonly access: AkeruDelegationAccessGrant;
}

export interface AkeruDelegationChildOutcome {
  readonly state: "completed" | "failed" | "blocked";
  readonly turnId: TurnId | null;
  readonly summary?: string;
  readonly error?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

export interface AkeruDelegationRuntimeOptions {
  readonly readSnapshot: () => Promise<OrchestrationReadModel>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly awaitChild: (
    threadId: ThreadId,
    deadline: string | null,
  ) => Promise<AkeruDelegationChildOutcome>;
  readonly interruptChild: (threadId: ThreadId, turnId: TurnId | null) => Promise<void>;
  readonly recordUsage?: (input: {
    readonly botId: BotId;
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly category: "delegated";
    readonly inputTokens: number;
    readonly outputTokens: number;
  }) => Promise<void>;
  readonly now?: () => string;
  readonly id?: () => string;
}

function childAccess(
  bot: OrchestrationBot,
  parentMcpServerIds: ReadonlyArray<AkeruDelegationAccessGrant["enabledMcpServerIds"][number]>,
): AkeruDelegationAccessGrant {
  return {
    allowedToolIds: AKERU_TOOL_CATALOG.map((tool) => tool.id),
    memoryScopes: [],
    sandbox: bot.sandbox,
    runtimeMode: bot.runtimeMode,
    hasUserComputer: bot.sandbox === "local",
    enabledMcpServerIds: parentMcpServerIds.filter(
      (serverId) => !bot.disabledMcpServerIds.includes(serverId),
    ),
    disabledMcpServerIds: bot.disabledMcpServerIds,
    approvalCeiling: "secrets",
  };
}

function childInstructions(input: {
  readonly task: string;
  readonly expectedResult: string;
  readonly deadline: string | null;
}): string {
  return [
    "This work was delegated from another bot chat.",
    `Task: ${input.task}`,
    `Expected result: ${input.expectedResult}`,
    ...(input.deadline ? [`Deadline: ${input.deadline}`] : []),
    "Return a concise final result to the parent chat. Report a concrete blocker or failure.",
  ].join("\n");
}

export function createAkeruDelegationRuntime(options: AkeruDelegationRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? (() => NodeCrypto.randomUUID());
  const accessByThread = new Map<ThreadId, AkeruDelegationAccessGrant>();
  const activeByParent = new Map<
    ThreadId,
    Map<DelegationId, { threadId: ThreadId; turnId: TurnId | null }>
  >();

  const dispatch = (command: OrchestrationCommand) =>
    options.dispatch(command).then(() => undefined);
  const commandId = (label: string) => CommandId.make(`delegation:${label}:${id()}`);

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

  const deliver = async (
    delegation: AkeruDelegationRecord,
    state: AkeruDelegationRecord["state"],
    detail: string,
  ) => {
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
          childThreadId: delegation.childThreadId,
          childTurnId: delegation.childTurnId,
          childBotId: delegation.childBotId,
          state,
          result: delegation.result,
          failure: delegation.failure,
        },
        turnId: delegation.parentTurnId,
        createdAt,
      },
      createdAt,
    });
  };

  const setState = async (delegation: AkeruDelegationRecord) => {
    await dispatch({
      type: "delegation.state.set",
      commandId: commandId(delegation.state),
      delegation,
    });
  };

  const availableBot = (
    snapshot: OrchestrationReadModel,
    parent: AkeruDelegationParent,
    botId: BotId,
  ) => {
    const parentThread = snapshot.threads.find((thread) => thread.id === parent.threadId);
    const bot = snapshot.bots.find((candidate) => candidate.id === botId);
    if (!parentThread || !bot || bot.archivedAt !== null) {
      throw new Error("The target bot is not available in this workspace.");
    }
    if (parentThread.groupId !== null && bot.groupId !== parentThread.groupId) {
      throw new Error("The target bot is not available in the current group.");
    }
    return { parentThread, bot };
  };

  const create = async (
    parent: AkeruDelegationParent,
    request: (typeof AkeruToolInputSchemas.CreateAgent)["Type"],
  ) => {
    const snapshot = await options.readSnapshot();
    const { parentThread, bot: parentBot } = availableBot(snapshot, parent, parent.botId);
    if (
      snapshot.bots.some(
        (candidate) =>
          candidate.archivedAt === null &&
          candidate.name.localeCompare(request.name, undefined, { sensitivity: "accent" }) === 0,
      )
    ) {
      throw new Error(`A bot named '${request.name}' already exists.`);
    }
    const botId = BotId.make(`bot-${id()}`);
    await dispatch({
      type: "bot.create",
      commandId: commandId("bot-create"),
      botId,
      name: request.name,
      title: request.title ?? "Bot",
      label: null,
      description: request.description ?? null,
      disabledMcpServerIds: parentBot.disabledMcpServerIds,
      avatar: { kind: "dither", seed: String(botId) },
      engine: parentBot.engine,
      sandbox: parentBot.sandbox,
      runtimeMode: parent.access.runtimeMode,
      usageCap: null,
      voiceEnabled: false,
      groupId: parentThread.groupId ?? null,
      createdAt: now(),
    });
    return { botId, name: request.name };
  };

  const check = async (
    parent: AkeruDelegationParent,
    request: (typeof AkeruToolInputSchemas.CheckAgent)["Type"],
  ) => {
    const snapshot = await options.readSnapshot();
    const { bot } = availableBot(snapshot, parent, request.botId);
    return {
      botId: bot.id,
      name: bot.name,
      title: bot.title,
      delegations: snapshot.delegations
        .filter(
          (delegation) =>
            delegation.parentThreadId === parent.threadId && delegation.childBotId === bot.id,
        )
        .map((delegation) => ({
          delegationId: delegation.delegationId,
          state: delegation.state,
          childThreadId: delegation.childThreadId,
          result: delegation.result,
          failure: delegation.failure,
        })),
    };
  };

  const stop = async (
    parent: AkeruDelegationParent,
    request: (typeof AkeruToolInputSchemas.StopAgent)["Type"],
  ) => {
    const snapshot = await options.readSnapshot();
    availableBot(snapshot, parent, request.botId);
    const active = snapshot.delegations.filter(
      (delegation) =>
        delegation.parentThreadId === parent.threadId &&
        delegation.childBotId === request.botId &&
        !TERMINAL_STATES.has(delegation.state),
    );
    if (active.length === 0) throw new Error("The target bot has no active delegated work.");
    for (const delegation of active) {
      await dispatch({
        type: "delegation.cancel",
        commandId: commandId("stop"),
        delegationId: delegation.delegationId,
        keep: false,
        createdAt: now(),
      });
    }
    return { botId: request.botId, stopped: active.map((entry) => entry.delegationId) };
  };

  const fail = async (
    delegation: AkeruDelegationRecord,
    failureCode: AkeruDelegationFailureCode,
    message: string,
  ) => {
    const completedAt = now();
    const failed: AkeruDelegationRecord = {
      ...delegation,
      state: "failed",
      result: null,
      failure: { failureCode, message },
      updatedAt: completedAt,
      completedAt,
    };
    await setState(failed);
    await deliver(failed, "failed", message);
    return failed;
  };

  const send = async (
    parent: AkeruDelegationParent,
    request: (typeof AkeruToolInputSchemas.SendToAgent)["Type"],
  ) => {
    const snapshot = await options.readSnapshot();
    const parentThread = snapshot.threads.find((thread) => thread.id === parent.threadId);
    const bot = snapshot.bots.find((candidate) => candidate.id === request.botId);
    if (!parentThread || !bot || bot.archivedAt !== null) {
      throw new Error("The target bot is not available in this workspace.");
    }
    if (bot.id === parent.botId || parent.ancestorBotIds.includes(bot.id)) {
      throw new Error("Bot work would create a self-call or cycle.");
    }
    if (parent.depth >= AKERU_DELEGATION_MAX_DEPTH) {
      throw new Error(`Bot work depth cannot exceed ${AKERU_DELEGATION_MAX_DEPTH}.`);
    }
    const active = snapshot.delegations.filter(
      (delegation) =>
        delegation.parentThreadId === parent.threadId && !TERMINAL_STATES.has(delegation.state),
    );
    if (active.length >= AKERU_DELEGATION_MAX_CONCURRENCY) {
      throw new Error(
        `A turn cannot run more than ${AKERU_DELEGATION_MAX_CONCURRENCY} bot work items.`,
      );
    }
    if (request.memoryScopes && request.memoryScopes.length > 0) {
      throw new Error("Bot work memory is unavailable until the child memory packet is bounded.");
    }

    const group = bot.groupId
      ? snapshot.groups.find((candidate) => candidate.id === bot.groupId)
      : undefined;
    if (
      bot.groupId !== null &&
      (!group ||
        parentThread.groupId !== group.id ||
        !group.members.some((member) => isGroupBotMember(member) && member.botId === bot.id))
    ) {
      throw new Error("The target bot is not available in the current group.");
    }

    const grant = intersectDelegationAccess({
      parent: parent.access,
      child: childAccess(bot, parent.access.enabledMcpServerIds),
      requested: request,
    });
    const childThreadId = ThreadId.make(`delegation-thread-${id()}`);
    const createdAt = now();
    await dispatch({
      type: "thread.create",
      commandId: commandId("thread"),
      threadId: childThreadId,
      projectId: parentThread.projectId,
      botId: group ? null : bot.id,
      groupId: group?.id ?? null,
      title: `Bot work for ${bot.name}`,
      modelSelection:
        bot.engine === null
          ? parentThread.modelSelection
          : {
              instanceId: ProviderInstanceId.make(bot.engine.provider),
              model: bot.engine.model,
              ...(bot.engine.options ? { options: bot.engine.options } : {}),
            },
      runtimeMode: grant.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });

    const delegationId = DelegationId.make(`delegation-${id()}`);
    let delegation: AkeruDelegationRecord = {
      delegationId,
      parentDelegationId: parent.parentDelegationId,
      parentBotId: parent.botId,
      childBotId: bot.id,
      parentThreadId: parent.threadId,
      childThreadId: null,
      parentTurnId: parent.turnId,
      childTurnId: null,
      ancestorBotIds: [...parent.ancestorBotIds, parent.botId],
      depth: parent.depth + 1,
      task: request.task,
      expectedResult: request.expectedResult,
      deadline: request.deadline ?? null,
      access: grant,
      state: "queued",
      billedBotId: bot.id,
      result: null,
      failure: null,
      keep: false,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
    };
    try {
      await dispatch({
        type: "delegation.create",
        commandId: commandId("create"),
        delegation,
      });
    } catch (cause) {
      await dispatch({
        type: "thread.delete",
        commandId: commandId("cleanup"),
        threadId: childThreadId,
      });
      throw cause;
    }

    const startedAt = now();
    delegation = {
      ...delegation,
      childThreadId,
      state: "running",
      updatedAt: startedAt,
      startedAt,
    };
    await setState(delegation);
    accessByThread.set(childThreadId, grant);
    const byParent = activeByParent.get(parent.threadId) ?? new Map();
    byParent.set(delegationId, { threadId: childThreadId, turnId: null });
    activeByParent.set(parent.threadId, byParent);
    await deliver(delegation, "running", `Sent bot work to ${bot.name}.`);

    await dispatch({
      type: "thread.turn.start",
      commandId: commandId("turn"),
      threadId: childThreadId,
      message: {
        messageId: MessageId.make(`delegation-message-${id()}`),
        role: "user",
        text: childInstructions({
          task: request.task,
          expectedResult: request.expectedResult,
          deadline: request.deadline ?? null,
        }),
        attachments: [],
      },
      runtimeMode: grant.runtimeMode,
      interactionMode: "default",
      ...(group ? { respondingBotId: bot.id } : {}),
      createdAt: now(),
    });

    try {
      const outcome = await options.awaitChild(childThreadId, request.deadline ?? null);
      const current = activeByParent.get(parent.threadId)?.get(delegationId);
      if (!current) {
        return { canceled: true, childThreadId, childTurnId: outcome.turnId };
      }
      current.turnId = outcome.turnId;
      if (outcome.state !== "completed" || !outcome.summary?.trim()) {
        if (outcome.state === "blocked") {
          const blocked: AkeruDelegationRecord = {
            ...delegation,
            childTurnId: outcome.turnId,
            state: "blocked",
            updatedAt: now(),
          };
          await setState(blocked);
          await deliver(blocked, "blocked", outcome.error ?? "The bot is blocked.");
          return { blocked: true, childThreadId, childTurnId: outcome.turnId };
        }
        return await fail(
          { ...delegation, childTurnId: outcome.turnId },
          "child_failed",
          outcome.error ?? "The bot did not return a result.",
        );
      }
      const completedAt = now();
      const completed: AkeruDelegationRecord = {
        ...delegation,
        childTurnId: outcome.turnId,
        state: "completed",
        result: {
          summary: outcome.summary.trim(),
          childThreadId,
          childTurnId: outcome.turnId,
        },
        failure: null,
        updatedAt: completedAt,
        completedAt,
      };
      await setState(completed);
      await options.recordUsage?.({
        botId: bot.id,
        threadId: childThreadId,
        turnId: outcome.turnId,
        category: "delegated",
        inputTokens: outcome.usage?.inputTokens ?? 0,
        outputTokens: outcome.usage?.outputTokens ?? 0,
      });
      await deliver(completed, "completed", outcome.summary.trim());
      return completed.result;
    } catch (cause) {
      const timeout =
        request.deadline !== undefined && Date.parse(request.deadline) <= Date.parse(now());
      if (timeout) await options.interruptChild(childThreadId, null);
      return await fail(
        delegation,
        timeout ? "timeout" : "internal",
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      accessByThread.delete(childThreadId);
      byParent.delete(delegationId);
      if (byParent.size === 0) activeByParent.delete(parent.threadId);
    }
  };

  const parentFinished = async (input: {
    readonly threadId: ThreadId;
    readonly failed: boolean;
    readonly keep?: ReadonlySet<DelegationId>;
  }) => {
    const snapshot = await options.readSnapshot();
    const records = snapshot.delegations.filter(
      (delegation) =>
        delegation.parentThreadId === input.threadId && !TERMINAL_STATES.has(delegation.state),
    );
    const children = activeByParent.get(input.threadId);
    for (const record of records) {
      const keep = record.keep || input.keep?.has(record.delegationId) === true;
      const child = children?.get(record.delegationId);
      const childThreadId = child?.threadId ?? record.childThreadId;
      if (keep || !input.failed) {
        await dispatch({
          type: "delegation.cancel",
          commandId: commandId("cancel"),
          delegationId: record.delegationId,
          keep,
          createdAt: now(),
        });
      }
      if (keep) continue;
      children?.delete(record.delegationId);
      if (childThreadId) accessByThread.delete(childThreadId);
      if (input.failed) {
        await fail(record, "parent_failed", "The parent turn failed.");
        if (childThreadId) {
          await options.interruptChild(childThreadId, child?.turnId ?? record.childTurnId);
        }
      }
    }
    if (children?.size === 0) activeByParent.delete(input.threadId);
  };

  return {
    create,
    check,
    send,
    stop,
    sendToUser,
    parentFinished,
    readSnapshot: options.readSnapshot,
    accessForThread: (threadId: ThreadId) => accessByThread.get(threadId),
  };
}

export type AkeruDelegationRuntime = ReturnType<typeof createAkeruDelegationRuntime>;

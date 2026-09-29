// @effect-diagnostics globalDate:off globalRandom:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AKERU_DELEGATION_CONTEXT_MAX_CHARS,
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
  type AkeruDelegationPhase,
  type AkeruDelegationRecord,
  akeruDelegationStateOf,
  type AkeruToolInputSchemas,
  type AkeruToolReceipt,
  AkeruDelegationContextTooLongError,
  acknowledgeAkeruDelegation,
  isAkeruDelegationResultPending,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type TurnId,
  isGroupBotMember,
} from "@t3tools/contracts";

import { intersectDelegationAccess } from "./AkeruToolRuntime.ts";

const TERMINAL_PHASES = new Set<AkeruDelegationPhase["_tag"]>(["Completed", "Failed", "Canceled"]);
const phaseChildThreadId = (delegation: AkeruDelegationRecord): ThreadId | null =>
  delegation.phase._tag === "Queued" ? null : delegation.phase.childThreadId;
const phaseChildTurnId = (delegation: AkeruDelegationRecord): TurnId | null =>
  delegation.phase._tag === "Queued" ? null : delegation.phase.childTurnId;
const phaseStartedAt = (delegation: AkeruDelegationRecord): string | null =>
  delegation.phase._tag === "Queued" ? null : delegation.phase.startedAt;

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
  /** Reports a background child watch that could not record its outcome. */
  readonly onWatchError?: (delegationId: DelegationId, cause: unknown) => void;
  readonly now?: () => string;
  readonly id?: () => string;
}

/** Returned by SendToAgent and MessageAgent as soon as the child turn is dispatched. */
export interface AkeruDelegationHandle {
  readonly delegationId: DelegationId;
  readonly childThreadId: ThreadId;
  readonly childBotId: BotId;
  readonly name: string;
  readonly phase: "running";
}

// The child offers every memory scope; intersectDelegationAccess narrows it to
// what the parent holds and the request names, so an omitted request grants none.
function childAccess(
  bot: OrchestrationBot,
  parentMcpServerIds: ReadonlyArray<AkeruDelegationAccessGrant["enabledMcpServerIds"][number]>,
  requestedMemoryScopes: AkeruDelegationAccessGrant["memoryScopes"] | undefined,
): AkeruDelegationAccessGrant {
  return {
    allowedToolIds: AKERU_TOOL_CATALOG.map((tool) => tool.id),
    memoryScopes: requestedMemoryScopes ?? [],
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
  readonly context: string | undefined;
}): string {
  return [
    "This work was delegated from another bot chat.",
    `Task: ${input.task}`,
    `Expected result: ${input.expectedResult}`,
    ...(input.deadline ? [`Deadline: ${input.deadline}`] : []),
    ...(input.context?.trim() ? ["Context from the parent bot:", input.context.trim()] : []),
    "Return a concise final result to the parent chat. Report a concrete blocker or failure.",
  ].join("\n");
}

export function createAkeruDelegationRuntime(options: AkeruDelegationRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? (() => NodeCrypto.randomUUID());
  const accessByThread = new Map<ThreadId, AkeruDelegationAccessGrant>();
  const watchers = new Set<Promise<void>>();
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
          result: delegation.phase._tag === "Completed" ? delegation.phase.result : null,
          failure: delegation.phase._tag === "Failed" ? delegation.phase.failure : null,
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
      commandId: commandId(akeruDelegationStateOf(delegation.phase)),
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
      imageProvider: null,
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
    // A group thread holds work from several parent bots; each bot reads and
    // acknowledges only its own results.
    const delegations = snapshot.delegations.filter(
      (delegation) =>
        delegation.parentThreadId === parent.threadId &&
        delegation.parentBotId === parent.botId &&
        delegation.childBotId === bot.id,
    );
    // Reading a finished result here is its delivery, so the next parent turn
    // does not receive it again.
    for (const delegation of delegations) {
      if (isAkeruDelegationResultPending(delegation)) {
        await setState(acknowledgeAkeruDelegation(delegation, now()));
      }
    }
    return {
      botId: bot.id,
      name: bot.name,
      title: bot.title,
      delegations: delegations.map((delegation) => ({
        delegationId: delegation.delegationId,
        state: akeruDelegationStateOf(delegation.phase),
        childThreadId: phaseChildThreadId(delegation),
        summary:
          delegation.phase._tag === "Completed"
            ? delegation.phase.result.summary
            : delegation.phase._tag === "Failed"
              ? delegation.phase.failure.message
              : null,
        result: delegation.phase._tag === "Completed" ? delegation.phase.result : null,
        failure: delegation.phase._tag === "Failed" ? delegation.phase.failure : null,
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
        !TERMINAL_PHASES.has(delegation.phase._tag),
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
      phase: {
        _tag: "Failed",
        childThreadId: phaseChildThreadId(delegation),
        childTurnId: phaseChildTurnId(delegation),
        startedAt: phaseStartedAt(delegation),
        completedAt,
        failure: { failureCode, message },
        acknowledgedAt: null,
      },
      updatedAt: completedAt,
    };
    await setState(failed);
    await deliver(failed, message);
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
        delegation.parentThreadId === parent.threadId &&
        !TERMINAL_PHASES.has(delegation.phase._tag),
    );
    if (active.length >= AKERU_DELEGATION_MAX_CONCURRENCY) {
      throw new Error(
        `A turn cannot run more than ${AKERU_DELEGATION_MAX_CONCURRENCY} bot work items.`,
      );
    }
    if (
      request.context !== undefined &&
      request.context.length > AKERU_DELEGATION_CONTEXT_MAX_CHARS
    ) {
      throw new AkeruDelegationContextTooLongError({
        length: request.context.length,
        maxLength: AKERU_DELEGATION_CONTEXT_MAX_CHARS,
      });
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
      child: childAccess(bot, parent.access.enabledMcpServerIds, request.memoryScopes),
      requested: request,
    });
    const delegationId = DelegationId.make(`delegation-${id()}`);
    const childThreadId = ThreadId.make(`delegation-thread-${id()}`);
    const createdAt = now();
    await dispatch({
      type: "thread.create",
      commandId: commandId("thread"),
      threadId: childThreadId,
      projectId: parentThread.projectId,
      botId: group ? null : bot.id,
      groupId: group?.id ?? null,
      parentThreadId: parent.threadId,
      parentDelegationId: delegationId,
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

    let delegation: AkeruDelegationRecord = {
      delegationId,
      parentDelegationId: parent.parentDelegationId,
      parentBotId: parent.botId,
      childBotId: bot.id,
      parentThreadId: parent.threadId,
      parentTurnId: parent.turnId,
      ancestorBotIds: [...parent.ancestorBotIds, parent.botId],
      depth: parent.depth + 1,
      task: request.task,
      expectedResult: request.expectedResult,
      deadline: request.deadline ?? null,
      access: grant,
      billedBotId: bot.id,
      keep: false,
      createdAt,
      updatedAt: createdAt,
      phase: { _tag: "Queued" },
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
      phase: { _tag: "Running", childThreadId, childTurnId: null, startedAt, progress: null },
      updatedAt: startedAt,
    };
    await setState(delegation);
    accessByThread.set(childThreadId, grant);
    const byParent = activeByParent.get(parent.threadId) ?? new Map();
    byParent.set(delegationId, { threadId: childThreadId, turnId: null });
    activeByParent.set(parent.threadId, byParent);
    await deliver(delegation, `Sent bot work to ${bot.name}.`);

    // The waiter must exist before the child turn starts: a child that ends
    // quickly reports its outcome once, and an outcome with no waiter is lost.
    const childOutcome = options.awaitChild(childThreadId, request.deadline ?? null);
    childOutcome.catch(() => undefined);
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
          context: request.context,
        }),
        attachments: [],
      },
      runtimeMode: grant.runtimeMode,
      interactionMode: "default",
      ...(group ? { respondingBotId: bot.id } : {}),
      createdAt: now(),
    });

    const watch = async () => {
      // StopAgent or a parent interrupt may have settled the record while the
      // child ran, and a keep-cancel may have stamped the record meanwhile.
      // Completion writes must build on the latest stored record: rebuilding
      // from `delegation` would reset keep/ownership fields and trip the
      // decider's immutability invariant.
      const latestRecord = async () => {
        const latest = (await options.readSnapshot()).delegations.find(
          (entry) => entry.delegationId === delegationId,
        );
        return latest !== undefined && !TERMINAL_PHASES.has(latest.phase._tag) ? latest : undefined;
      };
      try {
        const outcome = await childOutcome;
        const current = activeByParent.get(parent.threadId)?.get(delegationId);
        const latest = await latestRecord();
        if (!current || latest === undefined) return;
        const record = latest;
        current.turnId = outcome.turnId;
        if (outcome.state !== "completed" || !outcome.summary?.trim()) {
          if (outcome.state === "blocked") {
            const blocked: AkeruDelegationRecord = {
              ...record,
              phase: {
                _tag: "Blocked",
                childThreadId,
                childTurnId: outcome.turnId,
                startedAt,
                reason: outcome.error ?? "The bot is blocked.",
              },
              updatedAt: now(),
            };
            await setState(blocked);
            await deliver(blocked, outcome.error ?? "The bot is blocked.");
            return;
          }
          await fail(
            {
              ...record,
              phase: {
                _tag: "Running",
                childThreadId,
                childTurnId: outcome.turnId,
                startedAt,
                progress: null,
              },
            },
            "child_failed",
            outcome.error ?? "The bot did not return a result.",
          );
          return;
        }
        const completedAt = now();
        const result = {
          summary: outcome.summary.trim(),
          childThreadId,
          childTurnId: outcome.turnId,
        };
        const completed: AkeruDelegationRecord = {
          ...record,
          phase: {
            _tag: "Completed",
            childThreadId,
            childTurnId: outcome.turnId,
            startedAt,
            completedAt,
            result,
            acknowledgedAt: null,
          },
          updatedAt: completedAt,
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
        await deliver(completed, result.summary);
      } catch (cause) {
        const latest = await latestRecord();
        if (latest === undefined) return;
        const timeout =
          request.deadline !== undefined && Date.parse(request.deadline) <= Date.parse(now());
        if (timeout) await options.interruptChild(childThreadId, null);
        await fail(
          latest,
          timeout ? "timeout" : "internal",
          cause instanceof Error ? cause.message : String(cause),
        );
      } finally {
        accessByThread.delete(childThreadId);
        byParent.delete(delegationId);
        if (byParent.size === 0) activeByParent.delete(parent.threadId);
      }
    };
    const watching = watch()
      .catch((cause) => options.onWatchError?.(delegationId, cause))
      .finally(() => watchers.delete(watching));
    watchers.add(watching);

    const handle: AkeruDelegationHandle = {
      delegationId,
      childThreadId,
      childBotId: bot.id,
      name: bot.name,
      phase: "running",
    };
    return handle;
  };

  // Settles only the children the ended turn started. Children from earlier,
  // completed turns keep running and report to the chat when they finish.
  const parentFinished = async (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly failed: boolean;
    readonly keep?: ReadonlySet<DelegationId>;
  }) => {
    const snapshot = await options.readSnapshot();
    const records = snapshot.delegations.filter(
      (delegation) =>
        delegation.parentThreadId === input.threadId &&
        delegation.parentTurnId === input.turnId &&
        !TERMINAL_PHASES.has(delegation.phase._tag),
    );
    const children = activeByParent.get(input.threadId);
    for (const record of records) {
      const keep = record.keep || input.keep?.has(record.delegationId) === true;
      const child = children?.get(record.delegationId);
      const childThreadId = child?.threadId ?? phaseChildThreadId(record);
      // A failed parent turn must record Failed straight from the open phase:
      // canceling first would land the record in the terminal Canceled phase
      // and the follow-up state.set would hit the rejected Canceled -> Failed
      // transition. The cancel command stays for interrupted turns and for
      // marking kept children.
      if (input.failed ? keep : true) {
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
        // A child that finished between the snapshot read and this write must
        // not be sent back to Failed, and a rejected write must not stop the
        // remaining children from being failed and interrupted.
        try {
          const latest = (await options.readSnapshot()).delegations.find(
            (entry) => entry.delegationId === record.delegationId,
          );
          if (latest === undefined || TERMINAL_PHASES.has(latest.phase._tag)) continue;
          // The child stops even when its Failed record cannot be written.
          try {
            await fail(latest, "parent_failed", "The parent turn failed.");
          } finally {
            const latestChildThreadId = phaseChildThreadId(latest) ?? childThreadId;
            if (latestChildThreadId) {
              await options.interruptChild(
                latestChildThreadId,
                child?.turnId ?? phaseChildTurnId(latest),
              );
            }
          }
        } catch (cause) {
          options.onWatchError?.(record.delegationId, cause);
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
    /** Resolves once every background child watch has recorded its outcome. */
    drain: async () => {
      while (watchers.size > 0) await Promise.all(watchers);
    },
    accessForThread: (threadId: ThreadId) => accessByThread.get(threadId),
  };
}

export type AkeruDelegationRuntime = ReturnType<typeof createAkeruDelegationRuntime>;

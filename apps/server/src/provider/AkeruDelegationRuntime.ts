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
  AkeruDelegationProviderUnsupportedError,
  acknowledgeAkeruDelegation,
  isAkeruDelegationResultPending,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  TurnId,
  isGroupBotMember,
} from "@t3tools/contracts";
import { driverSupportsDelegation } from "@t3tools/shared/delegationProviders";
import * as Schema from "effect/Schema";

import { intersectDelegationAccess } from "./AkeruToolRuntime.ts";
import { PendingWaiterTimeoutError } from "./PendingWaiters.ts";

const isPendingWaiterTimeout = Schema.is(PendingWaiterTimeoutError);
const TERMINAL_PHASES = new Set<AkeruDelegationPhase["_tag"]>(["Completed", "Failed", "Canceled"]);
const phaseChildThreadId = (delegation: AkeruDelegationRecord): ThreadId | null =>
  delegation.phase._tag === "Queued" ? null : delegation.phase.childThreadId;
const phaseChildTurnId = (delegation: AkeruDelegationRecord): TurnId | null =>
  delegation.phase._tag === "Queued" ? null : delegation.phase.childTurnId;
const phaseStartedAt = (delegation: AkeruDelegationRecord): string | null =>
  delegation.phase._tag === "Queued" ? null : delegation.phase.startedAt;

/**
 * The user message that started the parent turn, so clients can place the work
 * card under it. Null when the turn has no recorded request message; clients
 * then fall back to parentTurnId.
 */
const parentTurnRequestMessageId = (
  thread: OrchestrationReadModel["threads"][number],
  turnId: TurnId,
): MessageId | null =>
  thread.latestTurn?.turnId === turnId ? (thread.latestTurn.requestMessageId ?? null) : null;

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
  /**
   * Resolves with the child's turn outcome. Rejects with
   * `PendingWaiterTimeoutError` at the deadline, or after a bounded default
   * when the deadline is null, so a silent child never hangs the watch.
   */
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
  /**
   * Driver kind behind a provider instance, or null when the instance is
   * unknown. SendToAgent refuses a target whose instance is unknown or whose
   * driver cannot run delegated work before it creates the child thread.
   */
  readonly providerDriverKind?: (instanceId: ProviderInstanceId) => Promise<string | null>;
  /** Reports a background child watch that could not record its outcome. */
  readonly onWatchError?: (delegationId: DelegationId, cause: unknown) => void;
  /**
   * Reports a completed result the group chat did not show because the child
   * bot is no longer an active member or the group is gone. The result stays
   * recorded and reaches the parent on its next turn.
   */
  readonly onGroupResultSkipped?: (
    delegationId: DelegationId,
    reason: AkeruGroupResultSkipReason,
  ) => void;
  readonly now?: () => string;
  readonly id?: () => string;
}

/**
 * Bot work started without a live parent turn. `Retry` repeats a Failed or
 * Canceled record; `Scheduled` is a routine run handing work from the owner
 * chat to another bot.
 */
export type AkeruDelegationDispatch =
  | { readonly _tag: "Retry"; readonly delegationId: DelegationId }
  | {
      readonly _tag: "Scheduled";
      readonly parentThreadId: ThreadId;
      readonly parentBotId: BotId;
      readonly childBotId: BotId;
      readonly task: string;
      readonly expectedResult: string;
      readonly runtimeMode: AkeruDelegationAccessGrant["runtimeMode"];
    };

/** How a record was started, when not by a bot tool call inside a live turn. */
interface AkeruDelegationOrigin {
  readonly trigger: AkeruDelegationRecord["trigger"];
  readonly retryOfDelegationId: DelegationId | null;
  readonly anchorMessageId: MessageId | null;
}

const isDispatchedDelegation = (delegation: AkeruDelegationRecord) =>
  delegation.trigger !== "bot" || delegation.retryOfDelegationId !== null;
/** Why a group chat did not receive a finished delegation's result message. */
export type AkeruGroupResultSkipReason = "bot_left_group" | "group_unavailable";

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

/**
 * A bot can take work from a group chat only when it is a member of that
 * group. A bot may belong to several groups, so membership is read from the
 * group, not from the bot's legacy `groupId`. A direct chat can reach any bot.
 */
function isReachableFromThread(
  snapshot: OrchestrationReadModel,
  parentThread: OrchestrationReadModel["threads"][number],
  bot: OrchestrationBot,
): boolean {
  if (parentThread.groupId === null) return true;
  const group = snapshot.groups.find((candidate) => candidate.id === parentThread.groupId);
  return (
    group !== undefined &&
    group.members.some((member) => isGroupBotMember(member) && member.botId === bot.id)
  );
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
    if (!isReachableFromThread(snapshot, parentThread, bot)) {
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
    origin?: AkeruDelegationOrigin,
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

    if (!isReachableFromThread(snapshot, parentThread, bot)) {
      throw new Error("The target bot is not available in the current group.");
    }
    const modelSelection =
      bot.engine === null
        ? parentThread.modelSelection
        : {
            instanceId: ProviderInstanceId.make(bot.engine.provider),
            model: bot.engine.model,
            ...(bot.engine.options ? { options: bot.engine.options } : {}),
          };
    if (options.providerDriverKind) {
      const driverKind = await options.providerDriverKind(modelSelection.instanceId);
      if (driverKind === null) {
        throw new Error("The target bot is not available in this workspace.");
      }
      if (!driverSupportsDelegation(driverKind)) {
        throw new AkeruDelegationProviderUnsupportedError({ botName: bot.name, driverKind });
      }
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
      // A child is a direct thread of the target bot, even when a group chat
      // sent the work; the group sees the result as an attributed message.
      botId: bot.id,
      groupId: null,
      parentThreadId: parent.threadId,
      parentDelegationId: delegationId,
      title: `Bot work for ${bot.name}`,
      modelSelection,
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
      keep: request.keep ?? false,
      anchorMessageId: origin
        ? origin.anchorMessageId
        : parentTurnRequestMessageId(parentThread, parent.turnId),
      retryOfDelegationId: origin?.retryOfDelegationId ?? null,
      trigger: origin?.trigger ?? "bot",
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
        // The result is recorded, so a failed usage write must not keep it
        // from reaching the chat.
        await Promise.resolve()
          .then(() =>
            options.recordUsage?.({
              botId: bot.id,
              threadId: childThreadId,
              turnId: outcome.turnId,
              category: "delegated",
              inputTokens: outcome.usage?.inputTokens ?? 0,
              outputTokens: outcome.usage?.outputTokens ?? 0,
            }),
          )
          .catch((cause) => options.onWatchError?.(delegationId, cause));
        await deliver(completed, result.summary);
        if (parentThread.groupId !== null) {
          // The result is already recorded; a group that cannot take the
          // message (deleted, bot removed) must not turn it into a failure.
          await postGroupResult({
            delegationId,
            threadId: parent.threadId,
            botId: bot.id,
            parentBotId: parent.botId,
            task: request.task,
            summary: result.summary,
          }).catch((cause) => options.onWatchError?.(delegationId, cause));
        }
      } catch (cause) {
        const latest = await latestRecord();
        if (latest === undefined) return;
        // The waiter also times out a silent child that has no deadline.
        const timeout =
          isPendingWaiterTimeout(cause) ||
          (request.deadline !== undefined && Date.parse(request.deadline) <= Date.parse(now()));
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

  /**
   * Starts bot work that no live parent turn owns. The record reuses the parent
   * chain the original (or the routine's owner chat) implies, so the decider's
   * depth, cycle, and cap rules apply unchanged. `parentFinished` leaves these
   * records alone; they settle on the child's outcome or a cancel.
   */
  const dispatchDelegation = async (input: AkeruDelegationDispatch) => {
    const snapshot = await options.readSnapshot();
    if (input._tag === "Retry") {
      const original = snapshot.delegations.find(
        (delegation) => delegation.delegationId === input.delegationId,
      );
      if (!original) throw new Error("The bot work to retry no longer exists.");
      if (original.phase._tag !== "Failed" && original.phase._tag !== "Canceled") {
        throw new Error("Only failed or canceled bot work can be retried.");
      }
      const deadline =
        original.deadline !== null && Date.parse(original.deadline) > Date.parse(now())
          ? original.deadline
          : undefined;
      return send(
        {
          threadId: original.parentThreadId,
          turnId: original.parentTurnId,
          botId: original.parentBotId,
          parentDelegationId: original.parentDelegationId,
          ancestorBotIds: original.ancestorBotIds.slice(0, -1),
          depth: original.depth - 1,
          access: original.access,
        },
        {
          botId: original.childBotId,
          task: original.task,
          expectedResult: original.expectedResult,
          ...(deadline ? { deadline } : {}),
          allowedToolIds: original.access.allowedToolIds,
          memoryScopes: original.access.memoryScopes,
          mcpServerIds: original.access.enabledMcpServerIds,
          sandbox: original.access.sandbox,
          runtimeMode: original.access.runtimeMode,
          approvalCeiling: original.access.approvalCeiling,
          keep: original.keep,
        },
        {
          trigger: original.trigger,
          retryOfDelegationId: original.delegationId,
          anchorMessageId: original.anchorMessageId,
        },
      );
    }

    const parentThread = snapshot.threads.find((thread) => thread.id === input.parentThreadId);
    const owner = snapshot.bots.find((bot) => bot.id === input.parentBotId);
    if (!parentThread || !owner || owner.archivedAt !== null) {
      throw new Error("The routine's chat or bot is not available.");
    }
    // The owner's default grant, the same one an ordinary turn in this chat gets.
    const access: AkeruDelegationAccessGrant = {
      allowedToolIds: AKERU_TOOL_CATALOG.map((tool) => tool.id),
      memoryScopes: ["private", "bot", "project", "group", "workspace"],
      sandbox: owner.sandbox,
      runtimeMode: input.runtimeMode,
      hasUserComputer: owner.sandbox === "local",
      enabledMcpServerIds: (snapshot.mcpServers ?? [])
        .filter((server) => server.enabled && !owner.disabledMcpServerIds.includes(server.id))
        .map((server) => server.id),
      disabledMcpServerIds: owner.disabledMcpServerIds,
      approvalCeiling: "secrets",
    };
    return send(
      {
        threadId: parentThread.id,
        turnId: parentThread.latestTurn?.turnId ?? TurnId.make(`scheduled-${id()}`),
        botId: owner.id,
        parentDelegationId: null,
        ancestorBotIds: [],
        depth: 0,
        access,
      },
      { botId: input.childBotId, task: input.task, expectedResult: input.expectedResult },
      {
        trigger: "scheduled",
        retryOfDelegationId: null,
        // The card sits where the chat was when the routine fired.
        anchorMessageId: parentThread.messages.at(-1)?.id ?? null,
      },
    );
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
        !isDispatchedDelegation(delegation) &&
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
    dispatchDelegation,
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

import * as Predicate from "effect/Predicate";
import { createAkeruDelegationControls } from "./delegation/AkeruDelegationControls.ts";
import { createAkeruDelegationDelivery } from "./delegation/AkeruDelegationDelivery.ts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import {
  AkeruDelegationPhase,
  AKERU_DELEGATION_CONTEXT_MAX_CHARS,
  AKERU_DELEGATION_MAX_CONCURRENCY,
  AKERU_DELEGATION_MAX_DEPTH,
  AKERU_TOOL_CATALOG,
  CommandId,
  DelegationId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type AkeruDelegationAccessGrant,
  type AkeruDelegationFailureCode,
  type AkeruDelegationRecord,
  akeruDelegationStateOf,
  type AkeruToolInputSchemas,
  AkeruDelegationContextTooLongError,
  AkeruDelegationProviderUnsupportedError,
  type OrchestrationCommand,
  TurnId,
} from "@akeru/contracts";
import { driverSupportsDelegation } from "@akeru/shared/delegationProviders";
import { withoutErrorStack } from "@akeru/shared/errorText";
import { intersectDelegationAccess } from "./tools/AkeruToolAuthorization.ts";
import {
  type AkeruDelegationRuntimeOptions,
  type AkeruDelegationParent,
  phaseChildThreadId,
  phaseChildTurnId,
  isReachableFromThread,
  TERMINAL_PHASES,
  phaseStartedAt,
  type AkeruDelegationOrigin,
  childAccess,
  parentTurnRequestMessageId,
  type AkeruDelegationChildOutcome,
  childInstructions,
  isPendingWaiterTimeout,
  type AkeruDelegationHandle,
  type AkeruDelegationDispatch,
  isDispatchedDelegation,
} from "./delegation/AkeruDelegationPolicy.ts";

export function createAkeruDelegationRuntime(options: AkeruDelegationRuntimeOptions) {
  const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
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

  const { sendToUser, deliver, postGroupResult } = createAkeruDelegationDelivery(
    options,
    now,
    id,
    commandId,
    dispatch,
  );

  const setState = async (delegation: AkeruDelegationRecord) => {
    await dispatch({
      type: "delegation.state.set",
      commandId: commandId(akeruDelegationStateOf(delegation.phase)),
      delegation,
    });
  };

  const { create, check, stop } = createAkeruDelegationControls(
    options,
    now,
    id,
    commandId,
    dispatch,
    setState,
  );

  // Every failure lands here, so the card and the parent's activity get one
  // readable line whatever error produced it. A stack never reaches the
  // record; the provider reactor logs the full cause of a failed start.
  const fail = async (
    delegation: AkeruDelegationRecord,
    failureCode: AkeruDelegationFailureCode,
    detail: string,
  ) => {
    const message = withoutErrorStack(detail) || "The bot work failed.";
    const completedAt = now();

    const failed: AkeruDelegationRecord = {
      ...delegation,
      phase: AkeruDelegationPhase.cases.Failed.make({
        childThreadId: phaseChildThreadId(delegation),
        childTurnId: phaseChildTurnId(delegation),
        startedAt: phaseStartedAt(delegation),
        completedAt,
        failure: { failureCode, message },
        acknowledgedAt: null,
      }),
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
      phase: AkeruDelegationPhase.cases.Queued.make({}),
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
      phase: AkeruDelegationPhase.cases.Running.make({
        childThreadId,
        childTurnId: null,
        startedAt,
        progress: null,
      }),
      updatedAt: startedAt,
    };
    const byParent = activeByParent.get(parent.threadId) ?? new Map();

    const forget = () => {
      accessByThread.delete(childThreadId);
      byParent.delete(delegationId);

      if (byParent.size === 0) activeByParent.delete(parent.threadId);
    };

    let childOutcome: Promise<AkeruDelegationChildOutcome> | undefined;

    try {
      await setState(delegation);
      accessByThread.set(childThreadId, grant);
      byParent.set(delegationId, { threadId: childThreadId, turnId: null });
      activeByParent.set(parent.threadId, byParent);
      await deliver(delegation, `Sent bot work to ${bot.name}.`);
      // The waiter must exist before the child turn starts: a child that ends
      // quickly reports its outcome once, and an outcome with no waiter is lost.
      childOutcome = options.awaitChild(childThreadId, request.deadline ?? null);
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
    } catch (cause) {
      // The record exists but nothing watches it, so it fails now and stays retryable.
      forget();

      const latest = (await options.readSnapshot()).delegations.find(
        (entry) => entry.delegationId === delegationId,
      );

      if (latest !== undefined && !TERMINAL_PHASES.has(latest.phase._tag)) {
        await fail(
          latest,
          "internal",
          cause instanceof Error ? cause.message : String(cause),
        ).catch(() => undefined);
      }

      throw cause;
    }

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
        const outcome = await (childOutcome ??
          options.awaitChild(childThreadId, request.deadline ?? null));

        const current = activeByParent.get(parent.threadId)?.get(delegationId);
        const latest = await latestRecord();

        if (!current || latest === undefined) return;
        const record = latest;
        current.turnId = outcome.turnId;

        if (outcome.state !== "completed" || !outcome.summary?.trim()) {
          if (outcome.state === "blocked") {
            const blocked: AkeruDelegationRecord = {
              ...record,
              phase: AkeruDelegationPhase.cases.Blocked.make({
                childThreadId,
                childTurnId: outcome.turnId,
                startedAt,
                reason: outcome.error ?? "The bot is blocked.",
              }),
              updatedAt: now(),
            };

            await setState(blocked);
            await deliver(blocked, outcome.error ?? "The bot is blocked.");

            return;
          }

          await fail(
            {
              ...record,
              phase: AkeruDelegationPhase.cases.Running.make({
                childThreadId,
                childTurnId: outcome.turnId,
                startedAt,
                progress: null,
              }),
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
          phase: AkeruDelegationPhase.cases.Completed.make({
            childThreadId,
            childTurnId: outcome.turnId,
            startedAt,
            completedAt,
            result,
            acknowledgedAt: null,
          }),
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
        forget();
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

    if (Predicate.isTagged(input, "Retry")) {
      const original = snapshot.delegations.find(
        (delegation) => delegation.delegationId === input.delegationId,
      );

      if (!original) throw new Error("The bot work to retry no longer exists.");

      if (
        !Predicate.isTagged(original.phase, "Failed") &&
        !Predicate.isTagged(original.phase, "Canceled")
      ) {
        throw new Error("Only failed or canceled bot work can be retried.");
      }

      // Two retries accepted before either started must not both start work.
      if (
        snapshot.delegations.some(
          (delegation) => delegation.retryOfDelegationId === original.delegationId,
        )
      ) {
        throw new Error("This bot work was already retried. Use the newer card instead.");
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
        // Scheduled work belongs to no chat turn, so the chat's current turn neither
        // moves its card nor cancels it when that turn ends.
        turnId: TurnId.make(`scheduled-${id()}`),
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

export {
  type AkeruDelegationParent,
  type AkeruDelegationChildOutcome,
  type AkeruDelegationRuntimeOptions,
  type AkeruDelegationDispatch,
  type AkeruGroupResultSkipReason,
  type AkeruDelegationHandle,
} from "./delegation/AkeruDelegationPolicy.ts";

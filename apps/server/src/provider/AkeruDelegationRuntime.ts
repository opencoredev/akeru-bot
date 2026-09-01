// @effect-diagnostics globalDate:off globalRandom:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AKERU_DELEGATION_MAX_DEPTH,
  CommandId,
  DelegationId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type AkeruDelegationRecord,
  type AkeruToolInputSchemas,
  type AkeruToolReceipt,
  type BotId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface AkeruDelegationParent {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly botId: BotId;
  readonly depth: number;
}

export interface AkeruDelegationChildOutcome {
  readonly turnId: TurnId | null;
  readonly result?: string;
  readonly error?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface AkeruDelegationRuntimeOptions {
  readonly readSnapshot: () => Promise<OrchestrationReadModel>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly awaitChild: (threadId: ThreadId) => Promise<AkeruDelegationChildOutcome>;
  readonly now?: () => string;
  readonly id?: () => string;
}

export function createAkeruDelegationRuntime(options: AkeruDelegationRuntimeOptions) {
  const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
  const id = options.id ?? (() => NodeCrypto.randomUUID());
  const commandId = (label: string) => CommandId.make(`delegation:${label}:${id()}`);

  const send = async (
    parent: AkeruDelegationParent,
    request: (typeof AkeruToolInputSchemas.SendToAgent)["Type"],
  ): Promise<AkeruToolReceipt> => {
    if (parent.depth >= AKERU_DELEGATION_MAX_DEPTH) {
      throw new Error(`Delegation depth cannot exceed ${AKERU_DELEGATION_MAX_DEPTH}.`);
    }
    const snapshot = await options.readSnapshot();
    const sourceThread = snapshot.threads.find((thread) => thread.id === parent.threadId);
    const targetBot = snapshot.bots.find((bot) => bot.id === request.botId);
    if (!sourceThread || !targetBot || targetBot.archivedAt !== null) {
      throw new Error("The target bot is not available.");
    }
    if (targetBot.id === parent.botId) throw new Error("A bot cannot delegate to itself.");

    const childThreadId = ThreadId.make(`delegation-thread-${id()}`);
    const createdAt = now();
    await options.dispatch({
      type: "thread.create",
      commandId: commandId("thread"),
      threadId: childThreadId,
      projectId: sourceThread.projectId,
      botId: targetBot.id,
      groupId: null,
      title: `Delegation to ${targetBot.name}`,
      modelSelection:
        targetBot.engine === null
          ? sourceThread.modelSelection
          : {
              instanceId: ProviderInstanceId.make(targetBot.engine.provider),
              model: targetBot.engine.model,
            },
      runtimeMode: targetBot.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    const delegationId = DelegationId.make(`delegation-${id()}`);
    const active = {
      delegationId,
      sourceThreadId: parent.threadId,
      sourceTurnId: parent.turnId,
      sourceBotId: parent.botId,
      targetBotId: targetBot.id,
      childThreadId,
      childTurnId: null,
      depth: parent.depth + 1,
      billedBotId: targetBot.id,
      task: request.task,
      expectedResult: request.expectedResult,
      outcome: null,
      createdAt,
      completedAt: null,
    } satisfies AkeruDelegationRecord;
    await options.dispatch({
      type: "delegation.create",
      commandId: commandId("create"),
      delegation: active,
    });
    await options.dispatch({
      type: "thread.turn.start",
      commandId: commandId("turn"),
      threadId: childThreadId,
      message: {
        messageId: MessageId.make(`delegation-message-${id()}`),
        role: "user",
        text: `${request.task}\n\nExpected result: ${request.expectedResult}`,
        attachments: [],
      },
      runtimeMode: targetBot.runtimeMode,
      interactionMode: "default",
      createdAt: now(),
    });

    const child = await options.awaitChild(childThreadId);
    const completedAt = now();
    const result = child.result?.trim();
    const completed: AkeruDelegationRecord = {
      ...active,
      childTurnId: child.turnId,
      outcome: result
        ? { status: "succeeded", result }
        : { status: "failed", error: child.error ?? "The delegated bot did not return a result." },
      completedAt,
    };
    await options.dispatch({
      type: "delegation.complete",
      commandId: commandId("complete"),
      delegation: completed,
    });

    return {
      receiptId: `delegation:${delegationId}`,
      toolId: "SendToAgent",
      phase: result ? "success" : "failure",
      threadId: parent.threadId,
      botId: parent.botId,
      summary: result ?? child.error ?? "The delegated bot did not return a result.",
      ...(result ? {} : { failureCode: "internal" as const }),
      fatalToThread: false,
      billedBotId: targetBot.id,
      usage: {
        inputTokens: child.usage?.inputTokens ?? 0,
        outputTokens: child.usage?.outputTokens ?? 0,
      },
      createdAt: completedAt,
    };
  };

  return { send, readSnapshot: options.readSnapshot };
}

export type AkeruDelegationRuntime = ReturnType<typeof createAkeruDelegationRuntime>;

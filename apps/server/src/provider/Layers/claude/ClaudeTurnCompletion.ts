import { isSdkRecord } from "../ProtocolJson.ts";
import * as Predicate from "effect/Predicate";
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import { type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ThreadTokenUsageSnapshot,
} from "@akeru/contracts";

import * as Effect from "effect/Effect";

import { ProviderAdapterRequestError } from "../../Errors.ts";

import {
  PROVIDER,
  type AssistantTextBlockState,
  type ClaudeSessionContext,
} from "./ClaudeAdapterState.ts";
import {
  asRuntimeItemId,
  asCanonicalTurnId,
  nativeProviderRefs,
  exitPlanCaptureKey,
} from "./ClaudeProtocolValues.ts";
import { planStepsFromClaudeTasks } from "./ClaudeTasks.ts";
import {
  maxClaudeContextWindowFromModelUsage,
  claudeUsageInputTokens,
  claudeUsageOutputTokens,
  lastClaudeUsageIteration,
  claudeTotalProcessedTokens,
  normalizeClaudeActiveTokenUsage,
} from "./ClaudeUsage.ts";

export function createClaudeTurnCompletion(deps: {
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError,
    never
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly completeAssistantTextBlock: (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?:
      | { readonly force?: boolean; readonly rawMethod?: string; readonly rawPayload?: unknown }
      | undefined,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly nowIso: Effect.Effect<string, never, never>;
  readonly updateResumeCursor: (context: ClaudeSessionContext) => Effect.Effect<void, never, never>;
}) {
  const emitThreadTokenUsage = Effect.fn("emitThreadTokenUsage")(function* (
    context: ClaudeSessionContext,
    usage: ThreadTokenUsageSnapshot | undefined,
    options?: {
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    if (!usage) {
      return;
    }

    context.lastKnownTokenUsage = usage;
    context.lastKnownTotalProcessedTokens =
      usage.totalProcessedTokens ?? context.lastKnownTotalProcessedTokens;

    const turnState = context.turnState;
    const stamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: turnState.turnId } : {}),
      payload: {
        usage,
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options.rawPayload,
            },
          }
        : {}),
    });
  });

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();

    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });

    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }

    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const emitClaudeTaskPlanUpdated = Effect.fn("emitClaudeTaskPlanUpdated")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly toolUseId: string;
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const plan = planStepsFromClaudeTasks(context.claudeTasks);

    if (plan.length === 0) {
      return;
    }

    const stamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "turn.plan.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        explanation: "Claude Tasks",
        plan,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: "claude.sdk.message",
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ) {
    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);

    if (resultContextWindow !== undefined) {
      context.lastKnownContextWindow = resultContextWindow;
    }

    const maxTokens = resultContextWindow ?? context.lastKnownContextWindow;
    const accumulatedTotalProcessedTokens = claudeTotalProcessedTokens(result?.usage);

    if (accumulatedTotalProcessedTokens !== undefined) {
      context.lastKnownTotalProcessedTokens = accumulatedTotalProcessedTokens;
    }

    // Avoid getContextUsage because its token-count fallback can make extra model requests.
    const resultUsageRecord =
      result?.usage && isSdkRecord(result.usage) && !Array.isArray(result.usage)
        ? result.usage
        : undefined;

    const hasResultUsageIteration =
      resultUsageRecord !== undefined && lastClaudeUsageIteration(resultUsageRecord) !== undefined;

    const resultHasActiveUsage =
      resultUsageRecord !== undefined &&
      (hasResultUsageIteration ||
        claudeUsageInputTokens(resultUsageRecord) + claudeUsageOutputTokens(resultUsageRecord) > 0);

    const resultTotalOnly =
      resultUsageRecord !== undefined &&
      !resultHasActiveUsage &&
      claudeTotalProcessedTokens(resultUsageRecord) !== undefined;

    const resultIterationSnapshot = resultUsageRecord
      ? normalizeClaudeActiveTokenUsage(
          resultUsageRecord,
          maxTokens,
          accumulatedTotalProcessedTokens ?? context.lastKnownTotalProcessedTokens,
        )
      : undefined;

    const latestAssistantSnapshot = normalizeClaudeActiveTokenUsage(
      context.turnState?.latestAssistantUsage,
      maxTokens,
      accumulatedTotalProcessedTokens ?? context.lastKnownTotalProcessedTokens,
    );

    const lastGoodUsage = context.lastKnownTokenUsage;

    const usageSnapshot: ThreadTokenUsageSnapshot | undefined =
      latestAssistantSnapshot ??
      (context.turnState?.compactedSinceLatestAssistantUsage
        ? undefined
        : resultTotalOnly && lastGoodUsage
          ? {
              ...lastGoodUsage,
              ...(Predicate.isNumber(maxTokens) && Number.isFinite(maxTokens) && maxTokens > 0
                ? { maxTokens }
                : {}),
              ...(Predicate.isNumber(accumulatedTotalProcessedTokens) &&
              Number.isFinite(accumulatedTotalProcessedTokens) &&
              accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
                ? {
                    totalProcessedTokens: accumulatedTotalProcessedTokens,
                  }
                : {}),
            }
          : resultIterationSnapshot) ??
      (lastGoodUsage
        ? {
            ...lastGoodUsage,
            ...(Predicate.isNumber(maxTokens) && Number.isFinite(maxTokens) && maxTokens > 0
              ? { maxTokens }
              : {}),
            ...(Predicate.isNumber(accumulatedTotalProcessedTokens) &&
            Number.isFinite(accumulatedTotalProcessedTokens) &&
            accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
              ? {
                  totalProcessedTokens: accumulatedTotalProcessedTokens,
                }
              : {}),
          }
        : undefined);

    const turnState = context.turnState;

    if (!turnState) {
      yield* emitThreadTokenUsage(context, usageSnapshot, {
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });

      // A result with no local turn is never a turn this adapter started:
      // real turns get turnState in sendTurn, and assistant messages that
      // arrive outside a turn auto-start a synthetic one. What lands here is
      // the resume handshake (system/init + result(num_turns: 0)), a late
      // result for a turn already completed locally (steer auto-close,
      // stream teardown), or a stream failure with no turn in flight. The
      // untargeted turn.completed this branch used to emit carried no turnId,
      // so ingestion could not attribute it — and whenever the projection had
      // no active turn (a pending turn start included) it flipped the session
      // lifecycle for a turn that never existed. Keep the usage emission,
      // drop the lifecycle event, and leave a tripwire so the upstream
      // trigger stays measurable in the field.
      yield* Effect.logInfo("claude.turn.result-without-active-turn", {
        threadId: context.session.threadId,
        status,
        numTurns: result?.num_turns,
        hasUsage: result?.usage !== undefined,
        ...(errorMessage ? { errorMessage } : {}),
      });

      return;
    }

    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: tool.input,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      context.inFlightTools.delete(index);
    }

    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* deps.completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }

    context.turns.push({
      id: turnState.turnId,
      items: [...turnState.items],
    });

    yield* emitThreadTokenUsage(context, usageSnapshot, {
      rawMethod: "claude/result",
      rawPayload: result ?? { status },
    });

    const stamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: status,
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
        ...(Predicate.isNumber(result?.total_cost_usd)
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });

    const updatedAt = yield* deps.nowIso;
    context.turnState = undefined;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt,
      ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
    };
    yield* deps.updateResumeCursor(context);
  });

  return {
    emitThreadTokenUsage,
    emitProposedPlanCompleted,
    emitClaudeTaskPlanUpdated,
    completeTurn,
  };
}

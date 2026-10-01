import {
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ModelSelection,
  type ProviderRuntimeTurnStatus,
  type ThreadTokenUsageSnapshot,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import { resolveClaudeContextWindow } from "./ClaudeModels.ts";
import { ProviderAdapterProcessError } from "../../Errors.ts";

import { type ClaudeSessionContext } from "./ClaudeAdapterState.ts";
import { toMessage, normalizeClaudeStreamMessages } from "./ClaudeProtocolValues.ts";

export function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

export function isClaudeInterruptedCause(cause: Cause.Cause<ProviderAdapterProcessError>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage) ||
    cause.reasons.some(
      (reason) =>
        Cause.isFailReason(reason) && isClaudeInterruptedMessage(toMessage(reason.error.cause, "")),
    )
  );
}

export function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

/** Failure text for structured terminal reasons, including success-tagged failures. */
export function terminalResultError(
  reason: SDKResultMessage["terminal_reason"] | string | undefined,
  failureHint?: string,
): string | undefined {
  switch (reason) {
    case "api_error":
      return failureHint ?? "Claude gave up after repeated API errors.";
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls.";
    case "budget_exhausted":
      return "Claude stopped: the turn's token budget was exhausted.";
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output.";
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed":
      return "Claude could not start the turn.";
    case "blocking_limit":
      return "Claude stopped: a usage limit blocked the request.";
    case "rapid_refill_breaker":
      return "Claude stopped: the context refilled too quickly after compaction.";
    case "prompt_too_long":
      return "Claude stopped: the prompt exceeds the model's context window.";
    case "image_error":
      return "Claude stopped: an image in the conversation could not be processed.";
    case "model_error":
      return "Claude stopped: the model returned an error.";
    default:
      return undefined;
  }
}

export function isInterruptedResult(result: SDKResultMessage): boolean {
  // The CLI stamps user aborts explicitly: interrupting mid-tool-call yields
  // "aborted_tools" (with an internal "[ede_diagnostic] ..." error and
  // is_error: true), interrupting mid-stream yields "aborted_streaming".
  if (
    result.terminal_reason === "aborted_tools" ||
    result.terminal_reason === "aborted_streaming"
  ) {
    return true;
  }

  const errors = resultErrorsText(result);

  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

export const CLAUDE_USAGE_LIMIT_WINDOWS = {
  five_hour: "5-hour",
  seven_day: "7-day",
  seven_day_opus: "7-day Opus",
  seven_day_sonnet: "7-day Sonnet",
  overage: "overage",
} satisfies Record<NonNullable<SDKRateLimitInfo["rateLimitType"]>, string>;

/** Beyond this the reset time is not credible, so the row ships without a wait. */
export const CLAUDE_USAGE_LIMIT_MAX_WAIT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `resetsAt` is epoch seconds. The row states the remaining wait rather than a
 * wall-clock time: this renders on the server, while the row is read on clients
 * that may sit in another timezone and locale, and that carry their own
 * timestamp preference. A wait reads the same everywhere.
 */
export function describeClaudeUsageLimit(info: SDKRateLimitInfo, nowMs: number): string {
  const label = info.rateLimitType ? CLAUDE_USAGE_LIMIT_WINDOWS[info.rateLimitType] : undefined;
  const resetsAtMs = info.resetsAt === undefined ? undefined : info.resetsAt * 1000;

  const waitMs =
    resetsAtMs === undefined || !Number.isFinite(nowMs) ? undefined : resetsAtMs - nowMs;

  const wait =
    waitMs !== undefined && waitMs > 0 && waitMs <= CLAUDE_USAGE_LIMIT_MAX_WAIT_MS
      ? formatClaudeUsageLimitWait(waitMs)
      : undefined;

  return `Claude usage limit reached. This turn is paused until the ${
    label ? `${label} ` : ""
  }limit resets${wait ? ` in ${wait}` : ""}.`;
}

export function formatClaudeUsageLimitWait(waitMs: number): string {
  const totalMinutes = Math.ceil(waitMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${totalMinutes}m`;

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function maxClaudeContextWindowFromModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;

  let maxContextWindow: number | undefined;

  for (const value of Object.values(modelUsage)) {
    const contextWindow = value.contextWindow;
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

export function selectedClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
): number | undefined {
  switch (modelSelection?.model) {
    case "claude-opus-4-8":
    case "claude-opus-4-7":
      // Always 1M at the API; these models expose no contextWindow option.
      return 1_000_000;
  }

  switch (resolveClaudeContextWindow(modelSelection)) {
    case "1m":
      return 1_000_000;
    case "200k":
      return 200_000;
    default:
      return undefined;
  }
}

export function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

export function claudeUsageInputTokens(usage: Record<string, unknown>): number {
  return (
    (finiteNonNegativeInteger(usage.input_tokens) ?? 0) +
    (finiteNonNegativeInteger(usage.cache_creation_input_tokens) ?? 0) +
    (finiteNonNegativeInteger(usage.cache_read_input_tokens) ?? 0)
  );
}

export function claudeUsageOutputTokens(usage: Record<string, unknown>): number {
  return finiteNonNegativeInteger(usage.output_tokens) ?? 0;
}

export function lastClaudeUsageIteration(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const iterations = Array.isArray(value.iterations) ? value.iterations : [];

  return iterations.findLast(
    (iteration): iteration is Record<string, unknown> =>
      iteration !== null && typeof iteration === "object" && !Array.isArray(iteration),
  );
}

export function claudeTotalProcessedTokens(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const explicitTotal = finiteNonNegativeInteger(usage.total_tokens);

  if (explicitTotal !== undefined && explicitTotal > 0) {
    return explicitTotal;
  }

  const total = claudeUsageInputTokens(usage) + claudeUsageOutputTokens(usage);

  return total > 0 ? total : undefined;
}

export function makeClaudeTokenUsageSnapshot(input: {
  readonly activeTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly outputTokens?: number;
  readonly contextWindow?: number;
  readonly totalProcessedTokens?: number;
  readonly lastUsedTokens?: number;
  readonly compactsAutomatically?: boolean;
  readonly autoCompactThreshold?: number;
}): ThreadTokenUsageSnapshot | undefined {
  const activeTokens = finiteNonNegativeInteger(input.activeTokens);

  if (activeTokens === undefined || activeTokens <= 0) {
    return undefined;
  }

  const maxTokens = finitePositiveInteger(input.contextWindow);
  const usedTokens = maxTokens !== undefined ? Math.min(activeTokens, maxTokens) : activeTokens;

  const lastUsedTokens =
    finiteNonNegativeInteger(input.lastUsedTokens) ??
    (maxTokens !== undefined ? Math.min(activeTokens, maxTokens) : activeTokens);

  const totalProcessedTokens = finiteNonNegativeInteger(input.totalProcessedTokens);
  const inputTokens = finiteNonNegativeInteger(input.inputTokens);
  const cachedInputTokens = finiteNonNegativeInteger(input.cachedInputTokens);
  const cacheCreationTokens = finiteNonNegativeInteger(input.cacheCreationTokens);
  const outputTokens = finiteNonNegativeInteger(input.outputTokens);

  return {
    usedTokens,
    lastUsedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input.compactsAutomatically !== undefined
      ? { compactsAutomatically: input.compactsAutomatically }
      : {}),
    ...(input.autoCompactThreshold !== undefined
      ? { autoCompactThreshold: input.autoCompactThreshold }
      : {}),
  };
}

export function normalizeClaudeActiveTokenUsage(
  value: unknown,
  contextWindow?: number,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const activeUsage = lastClaudeUsageIteration(usage) ?? usage;
  const inputTokens = claudeUsageInputTokens(activeUsage);
  const outputTokens = claudeUsageOutputTokens(activeUsage);
  const activeTokens = claudeTotalProcessedTokens(activeUsage) ?? inputTokens + outputTokens;

  if (activeTokens <= 0) {
    return undefined;
  }

  return makeClaudeTokenUsageSnapshot({
    activeTokens,
    inputTokens,
    cachedInputTokens: finiteNonNegativeInteger(activeUsage.cache_read_input_tokens) ?? 0,
    cacheCreationTokens: finiteNonNegativeInteger(activeUsage.cache_creation_input_tokens) ?? 0,
    outputTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
  });
}

export function compactBoundaryTokenUsageSnapshot(
  message: Record<string, unknown>,
  contextWindow?: number,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot | undefined {
  const metadata = message.compact_metadata;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const compactMetadata = metadata as Record<string, unknown>;
  const postTokens = finiteNonNegativeInteger(compactMetadata.post_tokens);

  if (postTokens === undefined || postTokens <= 0) {
    return undefined;
  }

  const preTokens = finiteNonNegativeInteger(compactMetadata.pre_tokens);

  return makeClaudeTokenUsageSnapshot({
    activeTokens: postTokens,
    ...(preTokens !== undefined ? { lastUsedTokens: preTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
  });
}

export function normalizeClaudeTaskProgressTokenUsage(
  value: unknown,
  context: ClaudeSessionContext,
): ThreadTokenUsageSnapshot | undefined {
  const totalTokens = claudeTotalProcessedTokens(value);

  if (totalTokens === undefined || totalTokens <= 0) {
    return undefined;
  }

  const lastUsedTokens = context.lastKnownTokenUsage?.usedTokens;

  const activeTokens =
    lastUsedTokens !== undefined ? Math.max(totalTokens, lastUsedTokens) : totalTokens;

  if (lastUsedTokens !== undefined && activeTokens === lastUsedTokens) {
    return undefined;
  }

  const usage = value as Record<string, unknown>;

  const snapshot = makeClaudeTokenUsageSnapshot({
    activeTokens,
    ...(context.lastKnownContextWindow !== undefined
      ? { contextWindow: context.lastKnownContextWindow }
      : {}),
    totalProcessedTokens: Math.max(
      totalTokens,
      context.lastKnownTotalProcessedTokens ?? totalTokens,
    ),
  });

  if (!snapshot) {
    return undefined;
  }

  const toolUses = finiteNonNegativeInteger(usage.tool_uses);
  const durationMs = finiteNonNegativeInteger(usage.duration_ms);

  return {
    ...snapshot,
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/**
 * The CLI reports repeated 529 overload failures as a success-subtype result
 * with api_error_status 529 and an empty error list; the status code is the
 * only structured signal.
 */
export function isOverloadedResult(result: SDKResultMessage): boolean {
  return result.subtype === "success" && result.api_error_status === 529;
}

/** Derives turn status and its error from the same provider result. */
export function resultOutcome(
  result: SDKResultMessage,
  failureHint?: string,
): {
  status: ProviderRuntimeTurnStatus;
  errorMessage: string | undefined;
} {
  // A success result flagged is_error only fails when the turn already
  // reported its cause (expired login, rejected usage window).
  const successTaggedFailure = result.subtype === "success" && result.is_error === true;

  const structuredError = isOverloadedResult(result)
    ? "Claude API is overloaded (529). Try again shortly."
    : (terminalResultError(result.terminal_reason, failureHint) ??
      (successTaggedFailure ? failureHint : undefined));

  // CLI diagnostic entries must not become the error banner. Success results
  // carry no typed error list, but a success-tagged failure may still list one.
  const listedErrors: ReadonlyArray<unknown> =
    "errors" in result && Array.isArray(result.errors) ? result.errors : [];

  const listedError =
    result.subtype === "success" && !successTaggedFailure
      ? undefined
      : listedErrors.find(
          (error): error is string =>
            typeof error === "string" && !error.startsWith("[ede_diagnostic]"),
        );

  const errorMessage = listedError || structuredError;

  if (structuredError !== undefined) return { status: "failed", errorMessage };

  if (result.subtype === "success") return { status: "completed", errorMessage };

  if (isInterruptedResult(result)) return { status: "interrupted", errorMessage };

  return {
    status: resultErrorsText(result).includes("cancel") ? "cancelled" : "failed",
    errorMessage,
  };
}

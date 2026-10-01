import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { storedField } from "./persistedSchema";
import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@akeru/contracts";

const StoredContextWindow = Schema.Struct({
  usedTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  totalProcessedTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  maxTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  inputTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  cachedInputTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  outputTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  reasoningOutputTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  lastUsedTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  lastInputTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  lastCachedInputTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  lastOutputTokens: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  lastReasoningOutputTokens: storedField(
    Schema.NullOr(Schema.Number.check(Schema.isFinite())),
    null,
  ),
  toolUses: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  durationMs: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  autoCompactThreshold: storedField(Schema.NullOr(Schema.Number.check(Schema.isFinite())), null),
  compactsAutomatically: storedField(Schema.Boolean, false),
});

const decodeContextWindow = Schema.decodeUnknownOption(StoredContextWindow);

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";

  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "opencodeGo":
      return "OpenCode Go";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();

      if (trimmed.length === 0) return provider;

      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];

    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const decoded = decodeContextWindow(activity.payload);

    if (Option.isNone(decoded)) continue;
    const payload = decoded.value;
    const usedTokens = payload.usedTokens;

    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = payload.maxTokens;

    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;

    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;

    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: payload.totalProcessedTokens,
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: payload.inputTokens,
      cachedInputTokens: payload.cachedInputTokens,
      outputTokens: payload.outputTokens,
      reasoningOutputTokens: payload.reasoningOutputTokens,
      lastUsedTokens: payload.lastUsedTokens,
      lastInputTokens: payload.lastInputTokens,
      lastCachedInputTokens: payload.lastCachedInputTokens,
      lastOutputTokens: payload.lastOutputTokens,
      lastReasoningOutputTokens: payload.lastReasoningOutputTokens,
      toolUses: payload.toolUses,
      durationMs: payload.durationMs,
      compactsAutomatically: payload.compactsAutomatically,
      autoCompactThreshold: payload.autoCompactThreshold,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }

  if (value < 1_000) {
    return `${Math.round(value)}`;
  }

  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }

  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }

  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

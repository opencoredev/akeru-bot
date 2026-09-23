import {
  isServerProviderUnavailability,
  latestTurnFailure,
} from "@t3tools/client-runtime/provider-availability";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThreadActivity,
  ServerProviderUnavailability,
} from "@t3tools/contracts";

export function activeThreadRuntimeWarning(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurn: OrchestrationLatestTurn | null,
): string | null {
  if (latestTurn?.state !== "running") return null;

  const resolvedKeys = new Set<string>();
  const newestFirst = activities.toSorted(
    (left, right) =>
      (right.sequence ?? -1) - (left.sequence ?? -1) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
  );
  for (const activity of newestFirst) {
    if (!activity || activity.kind !== "runtime.warning" || activity.turnId !== latestTurn.turnId) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const key = typeof payload?.key === "string" ? payload.key : null;
    if (payload?.resolved === true) {
      if (key) resolvedKeys.add(key);
      continue;
    }
    if (key && resolvedKeys.has(key)) continue;
    return typeof payload?.message === "string" && payload.message.trim().length > 0
      ? payload.message
      : activity.summary;
  }

  return null;
}

/** Returns the persisted error for the latest failed turn, even after the session recovers. */
export function latestThreadRuntimeError(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurn: OrchestrationLatestTurn | null,
): string | null {
  if (!latestTurn || latestTurn.state !== "error") return null;
  const activity = activities
    .toSorted(
      (left, right) =>
        (right.sequence ?? -1) - (left.sequence ?? -1) ||
        right.createdAt.localeCompare(left.createdAt),
    )
    .find(
      (candidate) => candidate.kind === "runtime.error" && candidate.turnId === latestTurn.turnId,
    );
  if (!activity) return null;
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.message === "string" && payload.message.trim()
    ? payload.message
    : activity.summary;
}

export interface BotThreadFailure {
  readonly message: string;
  readonly unavailability: ServerProviderUnavailability | null;
}

/** A failed command, keeping the category the server attached to a provider failure. */
export function commandFailure(
  result: Parameters<typeof squashAtomCommandFailure>[0],
): BotThreadFailure {
  const error = squashAtomCommandFailure(result);
  const unavailability =
    error && typeof error === "object" && "unavailability" in error ? error.unavailability : null;
  return {
    message: error instanceof Error ? error.message : "Could not send the message.",
    unavailability: isServerProviderUnavailability(unavailability) ? unavailability : null,
  };
}

export function localFailure(message: string): BotThreadFailure {
  return { message, unavailability: null };
}

/**
 * Why the chat's latest request has no reply. Covers a turn that failed
 * mid-run and a request the provider never started, where the user message is
 * persisted but no turn exists for it. The activity log carries the failure
 * category; the session keeps only its text once projected.
 */
export function latestBotThreadFailure(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: Pick<OrchestrationSession, "status" | "lastError" | "unavailability"> | null;
  readonly lastUserMessageAt: string | null;
}): BotThreadFailure | null {
  const { activities, latestTurn, session, lastUserMessageAt } = input;
  if (latestTurn?.state === "error") {
    const message =
      latestThreadRuntimeError(activities, latestTurn) ??
      latestTurn.errorMessage ??
      session?.lastError ??
      null;
    if (!message) return null;
    return {
      message,
      unavailability:
        latestTurn.unavailability ??
        session?.unavailability ??
        latestTurnFailure(activities, latestTurn.requestedAt)?.unavailability ??
        null,
    };
  }
  const unanswered =
    lastUserMessageAt !== null &&
    (latestTurn === null || latestTurn.requestedAt < lastUserMessageAt);
  if (!unanswered || session?.status !== "error") return null;
  const failure = latestTurnFailure(activities, lastUserMessageAt);
  const message = failure?.detail ?? session.lastError;
  if (!message) return null;
  return {
    message,
    unavailability: failure?.unavailability ?? session.unavailability ?? null,
  };
}

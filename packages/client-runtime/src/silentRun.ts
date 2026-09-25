import {
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationThreadActivity,
  THREAD_SILENT_RUN_ACTIVITY_KIND,
  THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND,
  ThreadSilentRunActivityPayload,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface ThreadSilentRun {
  readonly provider: ThreadSilentRunActivityPayload["provider"];
  readonly providerName: string;
  /** When the provider last produced output; the silence is measured from here. */
  readonly lastActivityAt: string;
}

const isSilentRunPayload = Schema.is(ThreadSilentRunActivityPayload);

/** Silent-run activities drive the chat status line, not the work log. */
export function isSilentRunActivity(activity: Pick<OrchestrationThreadActivity, "kind">): boolean {
  return (
    activity.kind === THREAD_SILENT_RUN_ACTIVITY_KIND ||
    activity.kind === THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND
  );
}

/**
 * The silent-run state of a running turn: the latest silent or cleared activity for
 * that turn decides it. Callers pass the turn only while it is still running, since
 * a turn that ended is never silent.
 */
export function threadSilentRun(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: string | null | undefined,
): ThreadSilentRun | null {
  if (!turnId) return null;
  let latest: OrchestrationThreadActivity | null = null;
  for (const activity of activities) {
    if (activity.turnId !== turnId || !isSilentRunActivity(activity)) continue;
    // A clear always follows its silence, so it wins a timestamp tie.
    if (
      latest === null ||
      activity.createdAt > latest.createdAt ||
      (activity.createdAt === latest.createdAt &&
        activity.kind === THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND)
    ) {
      latest = activity;
    }
  }
  if (latest?.kind !== THREAD_SILENT_RUN_ACTIVITY_KIND || !isSilentRunPayload(latest.payload)) {
    return null;
  }
  const { provider, lastActivityAt } = latest.payload;
  return {
    provider,
    providerName: PROVIDER_DISPLAY_NAMES[provider] ?? provider,
    lastActivityAt,
  };
}

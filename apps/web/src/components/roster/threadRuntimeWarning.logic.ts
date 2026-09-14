import type { OrchestrationLatestTurn, OrchestrationThreadActivity } from "@t3tools/contracts";

export function activeThreadRuntimeWarning(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurn: OrchestrationLatestTurn | null,
): string | null {
  if (latestTurn?.state !== "running") return null;

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "runtime.warning" || activity.turnId !== latestTurn.turnId) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    return typeof payload?.message === "string" && payload.message.trim().length > 0
      ? payload.message
      : activity.summary;
  }

  return null;
}

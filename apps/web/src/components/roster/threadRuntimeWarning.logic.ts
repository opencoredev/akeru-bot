import type { OrchestrationLatestTurn, OrchestrationThreadActivity } from "@t3tools/contracts";

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

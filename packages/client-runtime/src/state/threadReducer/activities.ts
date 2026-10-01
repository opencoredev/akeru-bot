import { asRecord } from "../../work-log-command.ts";
import * as Predicate from "effect/Predicate";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";

import {
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@akeru/contracts";
import type { ThreadDetailReducerResult } from "./types.ts";

import * as O from "effect/Order";

export const activityOrder = O.combineAll<OrchestrationThreadActivity>([
  O.mapInput(O.Number, (a) => a.sequence ?? Number.MAX_SAFE_INTEGER),
  O.mapInput(O.String, (a) => a.createdAt),
  O.mapInput(O.String, (a) => a.id),
]);

// Per-array id index so the streaming append path can reject a re-delivered
// id without rescanning the history. Only arrays this reducer produced are
// indexed: presence also proves the array is activityOrder-sorted, which
// snapshot-loaded arrays (DB order, null sequences first) are not.
export const activityIdIndex = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  Set<OrchestrationThreadActivity["id"]>
>();

/**
 * Matches the validity rule in `deriveLatestContextWindowSnapshot` (and the
 * server's snapshot-side `dropStaleContextWindowActivities`): rows without a
 * finite, non-negative `usedTokens` are skipped during the consumer's backward
 * walk, so they must not replace an earlier resolvable row here.
 */
export function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }

  const payload = asRecord(activity.payload);

  const usedTokens = payload?.usedTokens;

  return Predicate.isNumber(usedTokens) && Number.isFinite(usedTokens) && usedTokens >= 0;
}

export function applyActivityAppendedEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.activity-appended" }>,
): ThreadDetailReducerResult {
  const activity = event.payload.activity;
  // A resolvable context-window update supersedes earlier resolvable ones
  // for the same turn: consumers only read the latest value (walking the
  // array backwards), and providers stream these updates continuously, so
  // retaining the history grows the thread by thousands of rows over a
  // long session. Mirrors the server-side snapshot rule in
  // dropStaleContextWindowActivities; retention stays per turn so a
  // thread.reverted that discards turns can still resolve a value from
  // the turns that survive.
  const supersedesContextWindow = isResolvableContextWindowActivity(activity);
  // Live streams append in order: an unseen id sorting at/after the tail
  // of a known-sorted array appends without re-filtering and re-sorting
  // the whole history on every event. The id set moves forward to the new
  // array; a superseded array falls back to the sorting path.
  const ids = activityIdIndex.get(thread.activities);
  const lastActivity = thread.activities.at(-1);

  if (
    ids !== undefined &&
    (lastActivity === undefined || activityOrder(lastActivity, activity) <= 0) &&
    !ids.has(activity.id)
  ) {
    let activities: ReadonlyArray<OrchestrationThreadActivity>;

    if (supersedesContextWindow) {
      // Dropping rows from a sorted array keeps it sorted, so a superseding
      // update copies once and appends instead of re-sorting the history.
      const retained: Array<OrchestrationThreadActivity> = [];

      for (const entry of thread.activities) {
        if (entry.turnId === activity.turnId && isResolvableContextWindowActivity(entry)) {
          ids.delete(entry.id);
        } else {
          retained.push(entry);
        }
      }

      retained.push(activity);
      activities = retained;
    } else {
      activities = Arr.append(thread.activities, activity);
    }

    activityIdIndex.delete(thread.activities);
    ids.add(activity.id);
    activityIdIndex.set(activities, ids);

    return {
      kind: "updated",
      thread: {
        ...thread,
        activities,
        updatedAt: event.occurredAt,
      },
    };
  }

  const activities = pipe(
    thread.activities,
    Arr.filter(
      (entry) =>
        entry.id !== activity.id &&
        !(
          supersedesContextWindow &&
          entry.turnId === activity.turnId &&
          isResolvableContextWindowActivity(entry)
        ),
    ),
    Arr.append(activity),
    Arr.sort(activityOrder),
  );

  activityIdIndex.set(activities, new Set(activities.map((entry) => entry.id)));

  return {
    kind: "updated",
    thread: { ...thread, activities, updatedAt: event.occurredAt },
  };
}

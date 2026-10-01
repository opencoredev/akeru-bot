import { ThreadId } from "@akeru/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { createMessages } from "./Messages.ts";
import type { createPlans } from "./Plans.ts";
import type { createTasks } from "./Tasks.ts";

export function createCleanup({
  turnMessageIdsByTurnKey,
  assistantSegmentStateByTurnKey,
  bufferedProposedPlanById,
  taskDescriptionByTaskKey,
  clearAssistantMessageState,
}: Pick<
  Effect.Success<ReturnType<typeof createMessages>> &
    Effect.Success<ReturnType<typeof createPlans>> &
    Effect.Success<ReturnType<typeof createTasks>>,
  | "turnMessageIdsByTurnKey"
  | "assistantSegmentStateByTurnKey"
  | "bufferedProposedPlanById"
  | "taskDescriptionByTaskKey"
  | "clearAssistantMessageState"
>) {
  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      const taskDescriptionKeys = Array.from(yield* Cache.keys(taskDescriptionByTaskKey));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);

            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        taskDescriptionKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(taskDescriptionByTaskKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  return { clearTurnStateForSession };
}

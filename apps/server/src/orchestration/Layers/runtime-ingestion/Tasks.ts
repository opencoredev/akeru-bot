import { ThreadId } from "@akeru/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
  TASK_DESCRIPTION_BY_TASK_TTL,
  providerTaskKey,
} from "./EventFields.ts";

export const createTasks = Effect.fn("makeRuntimeTasks")(function* () {
  // Task names arrive on task.started/task.progress but not on task.completed,
  // so remember them per task to title the completion activity.
  const taskDescriptionByTaskKey = yield* Cache.make<string, string>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () => Effect.succeed(""),
  });

  const rememberTaskDescription = (threadId: ThreadId, taskId: string, description: string) =>
    Cache.set(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId), description);

  // Entries are left in place after completion so replayed or duplicate
  // terminal events stay titled; TTL, capacity, and the session-exit sweep
  // bound the cache.
  const lookupTaskDescription = (threadId: ThreadId, taskId: string) =>
    Cache.getOption(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.map((description) =>
        Option.filter(description, (value) => value.length > 0).pipe(Option.getOrUndefined),
      ),
    );

  return { taskDescriptionByTaskKey, rememberTaskDescription, lookupTaskDescription };
});

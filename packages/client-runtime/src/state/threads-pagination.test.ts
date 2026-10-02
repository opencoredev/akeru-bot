import { type OrchestrationThreadDetailSnapshot } from "@akeru/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { INITIAL_THREAD_USER_TURN_LIMIT, requestOlderThreadTurns } from "./threads.ts";
import {
  TARGET,
  THREAD_ID,
  BASE_THREAD,
  WINDOWED_SNAPSHOT,
  OLDER_PAGE,
  makeHarness,
  hasMessage,
} from "./threads-pagination.test-support.ts";

describe("thread pagination state", () => {
  it.effect("windows the initial load when the server advertises pagination", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      const state = yield* harness.awaitState((value) => Option.isSome(value.page));
      expect(Option.getOrThrow(state.page)).toEqual({
        beforeCursor: "cursor-1",
        hasMore: true,
        loadingOlder: false,
      });
      const windows = yield* Ref.get(harness.loaderWindows);
      expect(windows[0]?.turnLimit).toBe(INITIAL_THREAD_USER_TURN_LIMIT);
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput);
      expect(subscribeInput?.turnLimit).toBe(INITIAL_THREAD_USER_TURN_LIMIT);
    }),
  );

  it.effect("does not send a window to servers without the capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        paginationCapability: false,
        initialResponse: Option.some({ snapshotSequence: 10, thread: BASE_THREAD }),
      });

      const state = yield* harness.awaitState((value) => Option.isSome(value.data));
      expect(Option.isNone(state.page)).toBe(true);
      const windows = yield* Ref.get(harness.loaderWindows);
      expect(windows[0]).toBeUndefined();
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput);
      expect(subscribeInput?.turnLimit).toBeUndefined();
    }),
  );

  it.effect("merges an older page below the loaded window and clears the cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      expect(requestOlderThreadTurns(TARGET.environmentId, THREAD_ID)).toBe(true);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));

      const state = yield* harness.awaitState((value) => hasMessage(value, "message-old"));
      const thread = Option.getOrThrow(state.data);
      // Older rows land before the loaded window's rows.
      expect(thread.messages.map((entry) => entry.id)).toEqual(["message-old", "message-recent"]);
      expect(Option.getOrThrow(state.page)).toEqual({
        beforeCursor: null,
        hasMore: false,
        loadingOlder: false,
      });
    }),
  );

  it.effect("drops a windowed cache when the server lacks the pagination capability", () =>
    Effect.gen(function* () {
      // Resuming a windowed cache via afterSequence against a pre-pagination
      // server would render only the window forever with no way to load the
      // rest: the machine must discard the cache and take a full snapshot.
      const fullSnapshot: OrchestrationThreadDetailSnapshot = {
        snapshotSequence: 20,
        thread: { ...BASE_THREAD, title: "Full reload" },
      };

      const harness = yield* makeHarness({
        paginationCapability: false,
        cached: WINDOWED_SNAPSHOT,
        initialResponse: Option.some(fullSnapshot),
      });

      const state = yield* harness.awaitState((value) =>
        Option.match(value.data, {
          onNone: () => false,
          onSome: (thread) => thread.title === "Full reload",
        }),
      );

      expect(Option.isNone(state.page)).toBe(true);
      // The subscription resumed from the fresh full snapshot, not the
      // discarded windowed cache's watermark, and sent no window fields.
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput);
      expect(subscribeInput?.turnLimit).toBeUndefined();
      expect(subscribeInput?.afterSequence).toBe(20);
    }),
  );

  it.effect("keeps a windowed cache when the server supports pagination", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: WINDOWED_SNAPSHOT });
      const state = yield* harness.awaitState((value) => Option.isSome(value.page));
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");

      // Wait for the subscription (recorded when the WS method is invoked)
      // before asserting its input.
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput).pipe(
        Effect.repeat({ until: (input) => input !== undefined }),
      );

      expect(subscribeInput?.afterSequence).toBe(10);
    }),
  );
});

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { requestOlderThreadTurns } from "./threads.ts";
import {
  TARGET,
  THREAD_ID,
  BASE_THREAD,
  WINDOWED_SNAPSHOT,
  OLDER_PAGE,
  makeHarness,
  hasMessage,
  titleEvent,
  revertEvent,
} from "./threads-pagination.test-support.ts";

describe("thread pagination state", () => {
  it.effect("discards an in-flight older page when a revert rewrites history", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      // Revert lands while the page fetch is in flight and removes turn-2.
      yield* Queue.offer(harness.inputs, revertEvent(11));
      yield* harness.awaitState((value) => !hasMessage(value, "message-recent"));
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));

      const state = yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => !page.loadingOlder }),
      );
      // The stale page was dropped: no resurrected rows, cursor unchanged.
      expect(hasMessage(state, "message-old")).toBe(false);
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
    }),
  );

  it.effect("discards an in-flight older page when a fresh snapshot replaces the thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 20,
          thread: { ...BASE_THREAD, title: "Replaced thread" },
          page: { beforeCursor: "cursor-2", hasMore: true, snapshotSequence: 20 },
        },
      });
      yield* harness.awaitState((value) =>
        Option.match(value.data, {
          onNone: () => false,
          onSome: (thread) => thread.title === "Replaced thread",
        }),
      );
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));

      const state = yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => !page.loadingOlder }),
      );
      expect(hasMessage(state, "message-old")).toBe(false);
      // The replacement snapshot's cursor wins over the discarded page's.
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-2");
    }),
  );

  it.effect("discards an older page read from a projection behind the loaded state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* harness.resolveNextPage(Option.some({ ...OLDER_PAGE, snapshotSequence: 5 }));

      const state = yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => !page.loadingOlder }),
      );
      expect(hasMessage(state, "message-old")).toBe(false);
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
    }),
  );

  it.effect("a merged history page never advances the live-event dedupe sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      // The page was captured at a newer projection sequence (12) than the
      // loaded state (10); merging it must not swallow events 11-12.
      yield* harness.resolveNextPage(
        Option.some({
          ...OLDER_PAGE,
          snapshotSequence: 12,
          page: { beforeCursor: null, hasMore: false, snapshotSequence: 12 },
        }),
      );
      yield* harness.awaitState((value) => hasMessage(value, "message-old"));

      // Event at sequence 11 must still apply after the merge: the revert
      // discards turn-2, so the loaded window's row disappears while the
      // merged older turn-1 row survives. If the merge had advanced the
      // dedupe sequence to the page's 12, this event would be swallowed.
      yield* Queue.offer(harness.inputs, revertEvent(11));
      const state = yield* harness.awaitState(
        (value) => !hasMessage(value, "message-recent") && hasMessage(value, "message-old"),
      );
      expect(hasMessage(state, "message-old")).toBe(true);
    }),
  );

  it.effect("parks a page read ahead of the live state until events catch up", () =>
    Effect.gen(function* () {
      // A page whose thread watermark is ahead of the loaded state may
      // contain streaming content the subscription has not delivered yet
      // (e.g. an out-of-window subagent turn mid-stream); merging it
      // immediately and then replaying those deltas would duplicate text.
      // The page parks until the live state reaches the watermark.
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      // Page watermark 11 > loaded sequence 10: must park, not merge.
      yield* harness.resolveNextPage(
        Option.some({
          ...OLDER_PAGE,
          snapshotSequence: 11,
          page: { beforeCursor: null, hasMore: false, snapshotSequence: 11, threadSequence: 11 },
        }),
      );

      // A live event at sequence 11 arrives; only then does the page merge.
      yield* Queue.offer(harness.inputs, titleEvent("Advanced past watermark", 11));
      const state = yield* harness.awaitState((value) => hasMessage(value, "message-old"));
      expect(hasMessage(state, "message-recent")).toBe(true);
      expect(Option.getOrThrow(state.page).loadingOlder).toBe(false);
    }),
  );

  it.effect("a revert keeps the page cursor and triggers no refresh fetch", () =>
    Effect.gen(function* () {
      // Cursors are an (anchor, turnId) keyset derived from event content, so
      // they survive the revert projector's row rewrite: the machine keeps
      // the stored cursor and performs no snapshot re-fetch. The revert
      // reducer's turn filtering alone handles loaded history.
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      yield* Queue.offer(harness.inputs, revertEvent(11));
      const state = yield* harness.awaitState((value) => !hasMessage(value, "message-recent"));

      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
      const windows = yield* Ref.get(harness.loaderWindows);
      // Only the initial load hit the loader — no post-revert refresh fetch.
      expect(windows.length).toBe(1);
    }),
  );
});

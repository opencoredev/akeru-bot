import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  __testing,
  applyPreviewServerEvent as applyPreviewServerEventImpl,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  readThreadPreviewState,
} from "./previewStateStore";

import {
  ref,
  makeSnapshot,
  serverEpoch,
  applyPreviewServerEvent,
  resetPreviewTestFixtures,
} from "./previewStateStore.test-support";

beforeEach(resetPreviewTestFixtures);

describe("previewStateStore (single-tab)", () => {
  it("optimistically removes a session before the server close event arrives", () => {
    const first = makeSnapshot({ tabId: "tab_a" });

    const second = makeSnapshot({
      tabId: "tab_b",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);

    beginPreviewSessionClose(ref, second.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId]);
    expect(state.activeTabId).toBe(first.tabId);
    expect(state.snapshot?.tabId).toBe(first.tabId);
  });

  it("treats a late server close event after optimistic removal as a no-op", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.snapshot).toBeNull();
  });

  it("does not resurrect an intentionally closed tab from a stale list snapshot", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    applyPreviewServerSnapshot(ref, snapshot);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.snapshot).toBeNull();
  });

  it("can restore a suppressed tab after a failed close", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    cancelPreviewSessionClose(ref, snapshot, snapshot.tabId);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({ [snapshot.tabId]: snapshot });
    expect(state.snapshot).toEqual(snapshot);
  });

  it("does not resurrect a tab from an event older than its close", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 1,
      snapshot,
    });

    expect(readThreadPreviewState(ref).sessions).toEqual({});
  });
});

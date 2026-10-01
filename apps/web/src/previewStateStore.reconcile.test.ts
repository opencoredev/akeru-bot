import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  __testing,
  applyPreviewDesktopState,
  applyPreviewServerEvent as applyPreviewServerEventImpl,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  setActivePreviewTab,
  updatePreviewServerSnapshot,
} from "./previewStateStore";

import {
  ref,
  makeSnapshot,
  serverEpoch,
  resetPreviewTestFixtures,
} from "./previewStateStore.test-support";

beforeEach(resetPreviewTestFixtures);
describe("previewStateStore (single-tab)", () => {
  it("retains multiple tabs and switches active desktop state", () => {
    const first = makeSnapshot();
    const second = { ...makeSnapshot(), tabId: "tab_2", updatedAt: "2026-01-02T00:00:00.000Z" };
    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);
    applyPreviewDesktopState(ref, first.tabId, {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });
    setActivePreviewTab(ref, first.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId, second.tabId]);
    expect(state.snapshot?.tabId).toBe(first.tabId);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
  });

  it("updates a background snapshot without changing the active tab", () => {
    const background = makeSnapshot({ tabId: "tab_a" });

    const active = makeSnapshot({
      tabId: "tab_b",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    applyPreviewServerSnapshot(ref, background);
    applyPreviewServerSnapshot(ref, active);

    const resized = {
      ...background,
      viewport: { _tag: "freeform" as const, width: 900, height: 700 },
      updatedAt: "2026-01-01T00:00:02.000Z",
    };

    updatePreviewServerSnapshot(ref, resized);

    const state = readThreadPreviewState(ref);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.snapshot?.tabId).toBe(active.tabId);
    expect(state.sessions[background.tabId]).toEqual(resized);
  });

  it("reconciles an authoritative session list without focusing a background tab", () => {
    const active = makeSnapshot({ tabId: "tab_a" });

    const stale = makeSnapshot({
      tabId: "tab_stale",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    applyPreviewServerSnapshot(ref, stale);
    applyPreviewServerSnapshot(ref, active);
    applyPreviewDesktopState(ref, stale.tabId, {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });

    reconcilePreviewServerSessions(ref, { sessions: [active], serverEpoch, revision: 1 });

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([active.tabId]);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.snapshot).toEqual(active);
    expect(state.desktopByTabId[stale.tabId]).toBeUndefined();
  });

  it("clears stale sessions when an authoritative list is empty", () => {
    applyPreviewServerSnapshot(ref, makeSnapshot());

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.activeTabId).toBeNull();
    expect(state.snapshot).toBeNull();
  });

  it("accepts a lower revision from a newly restarted server", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot,
    });

    reconcilePreviewServerSessions(ref, {
      sessions: [],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.serverEpoch).toBe("server-b");
    expect(state.serverRevision).toBe(0);
  });

  it("does not carry raw-tab state across a server restart", () => {
    const previous = makeSnapshot({
      navStatus: { _tag: "Success", url: "https://old.example", title: "Old" },
      updatedAt: "2026-01-01T00:00:02.000Z",
    });

    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: previous.tabId,
      createdAt: previous.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot: previous,
    });
    beginPreviewSessionClose(ref, previous.tabId);
    applyPreviewDesktopState(ref, previous.tabId, {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });

    const restarted = makeSnapshot({
      navStatus: { _tag: "Success", url: "https://new.example", title: "New" },
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    reconcilePreviewServerSessions(ref, {
      sessions: [restarted],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions[restarted.tabId]).toEqual(restarted);
    expect(state.suppressedTabIds).toEqual(new Set());
    expect(state.desktopByTabId).toEqual({});
    expect(state.desktopOverlay).toBeNull();
  });

  it("does not replace a streamed snapshot with older SWR data", () => {
    applyPreviewServerSnapshot(
      ref,
      makeSnapshot({
        navStatus: { _tag: "Success", url: "http://localhost:5173/new", title: "New" },
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    applyPreviewServerSnapshot(
      ref,
      makeSnapshot({
        navStatus: { _tag: "Success", url: "http://localhost:5173/old", title: "Old" },
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus).toEqual({
      _tag: "Success",
      url: "http://localhost:5173/new",
      title: "New",
    });
  });
});

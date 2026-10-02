import { scopedThreadKey } from "@akeru/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  __testing,
  applyPreviewDesktopState,
  applyPreviewServerSnapshot,
  previewStateAtom,
  readThreadPreviewState,
  rememberPreviewUrl,
  removePreviewThread,
  subscribeThreadPreviewState,
} from "./previewStateStore";
import {
  ref,
  otherRef,
  makeSnapshot,
  applyPreviewServerEvent,
  resetPreviewTestFixtures,
} from "./previewStateStore.test-support";

beforeEach(resetPreviewTestFixtures);

describe("previewStateStore (single-tab)", () => {
  it("keeps independent state atoms for each thread", () => {
    expect(previewStateAtom(scopedThreadKey(ref))).toBe(previewStateAtom(scopedThreadKey(ref)));
    expect(previewStateAtom(scopedThreadKey(ref))).not.toBe(
      previewStateAtom(scopedThreadKey(otherRef)),
    );

    applyPreviewServerSnapshot(ref, makeSnapshot());
    expect(readThreadPreviewState(ref).snapshot?.tabId).toBe("tab_a");
    expect(readThreadPreviewState(otherRef)).toEqual(__testing.EMPTY_THREAD_PREVIEW_STATE);
  });

  it("a second `opened` for a different tab replaces the rendered snapshot", () => {
    const a = makeSnapshot({ tabId: "tab_a" });
    const b = makeSnapshot({ tabId: "tab_b" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: a.tabId,
      createdAt: a.updatedAt,
      snapshot: a,
    });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: b.tabId,
      createdAt: b.updatedAt,
      snapshot: b,
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.tabId).toBe(b.tabId);
  });

  it("desktopOverlay updates independently of snapshot", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewDesktopState(ref, snapshot.tabId, {
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
    const state = readThreadPreviewState(ref);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
    expect(state.snapshot?.canGoBack).toBe(false);
  });

  it("does not publish duplicate desktop browser state", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);

    const overlay = {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system" as const,
      audioMuted: false,
      audible: false,
      controller: "none" as const,
      favicon: {
        dataUrl: "data:image/png;base64,AA==",
        pageUrl: "https://example.com",
        capturedAt: 1,
      },
    };

    let updateCount = 0;

    const unsubscribe = subscribeThreadPreviewState(ref, () => {
      updateCount += 1;
    });

    applyPreviewDesktopState(ref, snapshot.tabId, overlay);
    applyPreviewDesktopState(ref, snapshot.tabId, { ...overlay, favicon: { ...overlay.favicon } });
    unsubscribe();

    expect(updateCount).toBe(1);
  });

  it("applyServerSnapshot null clears snapshot for a thread that had one", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    applyPreviewServerSnapshot(ref, null);
    const state = readThreadPreviewState(ref);
    expect(state.snapshot).toBeNull();
  });

  it("rememberUrl dedupes and caps at limit", () => {
    for (let i = 0; i < __testing.RECENT_URL_LIMIT + 5; i += 1) {
      rememberPreviewUrl(ref, `http://localhost:${5000 + i}/`);
    }

    const state = readThreadPreviewState(ref);
    expect(state.recentlySeenUrls.length).toBeLessThanOrEqual(__testing.RECENT_URL_LIMIT);
    expect(state.recentlySeenUrls[0]).toBe(
      `http://localhost:${5000 + __testing.RECENT_URL_LIMIT + 4}/`,
    );
  });

  it("removeThread strips the entry", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    removePreviewThread(ref);
    const state = readThreadPreviewState(ref);
    expect(state).toEqual(__testing.EMPTY_THREAD_PREVIEW_STATE);
  });
});

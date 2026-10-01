import {
  events,
  frameSubscription,
  onFrame,
  save,
  startScreencast,
  surfaceState,
  setupRecordingTest,
  cleanupRecordingTest,
} from "./browserRecording.test-support";
import { EnvironmentId, ThreadId } from "@akeru/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BrowserRecordingConflictError,
  findActiveBrowserRecordingRuntimeTabId,
  readActiveBrowserRecordingTabIds,
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
} from "./browserRecording";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
describe("browser recording", () => {
  beforeEach(setupRecordingTest);
  afterEach(cleanupRecordingTest);

  it("draws the newest decoded frames without starving behind decode latency", async () => {
    const drawImage = vi.fn();

    class DeferredImage {
      static readonly instances: DeferredImage[] = [];
      private loadListener: EventListenerOrEventListenerObject | undefined;

      constructor() {
        DeferredImage.instances.push(this);
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (type === "load") this.loadListener = listener;
      }

      set src(_value: string) {}

      finishLoading(): void {
        const event = new Event("load");

        if (typeof this.loadListener === "function") this.loadListener(event);
        else this.loadListener?.handleEvent(event);
      }
    }

    vi.stubGlobal("Image", DeferredImage as unknown as typeof Image);
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        captureStream: () => ({}),
        getContext: () => ({ drawImage, fillRect: vi.fn(), fillStyle: "" }),
      }),
    });

    await startBrowserRecording("recording-tab");
    frameSubscription.listener?.({
      tabId: "recording-tab",
      data: "second-frame",
      width: 800,
      height: 600,
      receivedAt: "2026-06-26T00:00:01.000Z",
    });
    frameSubscription.listener?.({
      tabId: "recording-tab",
      data: "third-frame",
      width: 800,
      height: 600,
      receivedAt: "2026-06-26T00:00:02.000Z",
    });

    DeferredImage.instances[1]?.finishLoading();
    expect(drawImage).toHaveBeenCalledOnce();
    DeferredImage.instances[2]?.finishLoading();
    expect(drawImage).toHaveBeenCalledTimes(2);
    DeferredImage.instances[0]?.finishLoading();
    expect(drawImage).toHaveBeenCalledTimes(2);

    await stopBrowserRecording("recording-tab");
  });

  it("records separate tabs concurrently", async () => {
    const firstThreadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-first"),
    };

    const secondThreadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-second"),
    };

    surfaceState.byTabId = {
      ...surfaceState.byTabId,
      "recording-tab-2": {
        visible: false,
        rect: { x: 0, y: 0, width: 390, height: 844 },
        content: { x: 0, y: 0, width: 390, height: 844, scale: 1, scrollLeft: 0, scrollTop: 0 },
      },
    };

    await Promise.all([
      startBrowserRecording("recording-tab", firstThreadRef),
      startBrowserRecording("recording-tab-2", secondThreadRef),
    ]);

    expect(startScreencast).toHaveBeenCalledTimes(2);
    expect(onFrame).toHaveBeenCalledOnce();
    expect(events).toContain("publish:recording-tab,recording-tab-2");
    expect(readActiveBrowserRecordingTabIds()).toEqual(
      new Set(["recording-tab", "recording-tab-2"]),
    );
    expect(readActiveBrowserRecordingTabIds(firstThreadRef)).toEqual(new Set(["recording-tab"]));
    expect(readActiveBrowserRecordingTabIds(secondThreadRef)).toEqual(new Set(["recording-tab-2"]));

    await stopBrowserRecording("recording-tab");
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set(["recording-tab-2"]));
    await stopBrowserRecording("recording-tab-2");
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps a recording reachable through its runtime id after a server epoch changes", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-scoped"),
    };

    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-a", "tab_1");
    surfaceState.byTabId = {
      [runtimeTabId]: {
        visible: false,
        rect: { x: 0, y: 0, width: 1280, height: 800 },
        content: {
          x: 0,
          y: 0,
          width: 1280,
          height: 800,
          scale: 1,
          scrollLeft: 0,
          scrollTop: 0,
        },
      },
    };

    await startBrowserRecording(runtimeTabId, threadRef, "tab_1");

    expect(startScreencast).toHaveBeenCalledWith(runtimeTabId);
    expect(readActiveBrowserRecordingTabIds(threadRef)).toEqual(new Set([runtimeTabId]));
    expect(readActiveBrowserRecordingTargets(threadRef)).toEqual([
      { runtimeTabId, serverTabId: "tab_1" },
    ]);
    expect(findActiveBrowserRecordingRuntimeTabId(threadRef, "tab_1")).toBe(runtimeTabId);

    const replacementRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-b", "tab_1");
    await expect(
      startBrowserRecording(replacementRuntimeTabId, threadRef, "tab_1"),
    ).rejects.toBeInstanceOf(BrowserRecordingConflictError);
    expect(startScreencast).toHaveBeenCalledTimes(1);

    await stopBrowserRecording(runtimeTabId);
  });
});

import {
  events,
  frameSubscription,
  startScreencast,
  stopScreencast,
  surfaceState,
  setupRecordingTest,
  cleanupRecordingTest,
} from "./browserRecording.test-support";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BROWSER_RECORDING_FIRST_FRAME_SIZE_TIMEOUT_MS,
  BrowserRecordingConflictError,
  startBrowserRecording,
  stopBrowserRecording,
} from "./browserRecording";

describe("browser recording", () => {
  beforeEach(setupRecordingTest);
  afterEach(cleanupRecordingTest);

  it("starts recording for a visible tab", async () => {
    await startBrowserRecording("recording-tab");
    const startupEvents = [...events];

    await stopBrowserRecording("recording-tab");
    expect(startupEvents).toEqual(["publish:recording-tab", "start-screencast"]);
  });

  it("records a hidden tab without requiring it to become visible", async () => {
    surfaceState.byTabId = {
      "recording-tab": {
        visible: false,
        rect: { x: 0, y: 0, width: 800, height: 600 },
        content: { x: 0, y: 0, width: 800, height: 600, scale: 1, scrollLeft: 0, scrollTop: 0 },
      },
    };

    await startBrowserRecording("recording-tab");
    const startupEvents = [...events];

    expect(startScreencast).toHaveBeenCalledWith("recording-tab");
    await stopBrowserRecording("recording-tab");
    expect(startupEvents).toEqual(["publish:recording-tab", "start-screencast"]);
  });

  it("fails startup instead of locking a fallback size when no frame arrives", async () => {
    vi.useFakeTimers();
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
    });

    const startPromise = startBrowserRecording("recording-tab");

    const rejection = expect(startPromise).rejects.toMatchObject({
      operation: "wait-first-frame",
      tabId: "recording-tab",
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_FIRST_FRAME_SIZE_TIMEOUT_MS);

    await rejection;
    expect(stopScreencast).toHaveBeenCalledWith("recording-tab");
    expect(events.at(-1)).toBe("clear");
  });

  it("fixes hidden recording dimensions before MediaRecorder starts", async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    let capturedStreamSize: { readonly width: number; readonly height: number } | undefined;

    const canvas = {
      width: 0,
      height: 0,
      captureStream: () => {
        capturedStreamSize = { width: canvas.width, height: canvas.height };

        return {};
      },
      getContext: () => ({ drawImage, fillRect, fillStyle: "" }),
    };

    vi.stubGlobal("document", {
      createElement: () => canvas,
    });
    surfaceState.byTabId = {};
    startScreencast.mockImplementationOnce(async (tabId: string) => {
      events.push("start-screencast");
      frameSubscription.listener?.({
        tabId,
        data: "captured-frame",
        width: 390,
        height: 844,
        receivedAt: "2026-06-26T00:00:00.000Z",
      });
    });

    await startBrowserRecording("recording-tab");

    expect(canvas).toMatchObject({ width: 390, height: 844 });
    expect(capturedStreamSize).toEqual({ width: 390, height: 844 });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 390, 844);

    frameSubscription.listener?.({
      tabId: "recording-tab",
      data: "different-sized-frame",
      width: 1280,
      height: 720,
      receivedAt: "2026-06-26T00:00:01.000Z",
    });

    expect(canvas).toMatchObject({ width: 390, height: 844 });
    expect(fillRect).toHaveBeenLastCalledWith(0, 0, 390, 844);

    await stopBrowserRecording("recording-tab");
  });

  it("does not report success for a second start while the first is still starting", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async (tabId: string) => {
      events.push("start-screencast");
      frameSubscription.listener?.({
        tabId,
        data: "initial-frame",
        width: 800,
        height: 600,
        receivedAt: "2026-06-26T00:00:00.000Z",
      });
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await firstStart;
    await stopBrowserRecording("recording-tab");
  });
});

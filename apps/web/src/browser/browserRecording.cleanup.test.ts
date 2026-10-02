import {
  events,
  save,
  startScreencast,
  stopScreencast,
  emitRecordingFrame,
  setupRecordingTest,
  cleanupRecordingTest,
} from "./browserRecording.test-support";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
  BrowserRecordingConflictError,
  startBrowserRecording,
  stopBrowserRecording,
} from "./browserRecording";

describe("browser recording", () => {
  beforeEach(setupRecordingTest);
  afterEach(cleanupRecordingTest);

  it("does not report success for a start while the recording is stopping", async () => {
    let finishStoppingScreencast: (() => void) | undefined;
    stopScreencast.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishStoppingScreencast = resolve;
      });

      return undefined;
    });

    await startBrowserRecording("recording-tab");
    const stopPromise = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());

    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStoppingScreencast?.();
    await stopPromise;
  });

  it("shares an in-progress stop with duplicate callers", async () => {
    let finishStoppingScreencast: (() => void) | undefined;
    stopScreencast.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishStoppingScreencast = resolve;
      });

      return undefined;
    });

    await startBrowserRecording("recording-tab");
    const firstStop = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());
    const duplicateStop = stopBrowserRecording("recording-tab");

    finishStoppingScreencast?.();
    const [firstArtifact, duplicateArtifact] = await Promise.all([firstStop, duplicateStop]);

    expect(duplicateArtifact).toEqual(firstArtifact);
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("finishes startup before stopping so an active recording yields an artifact", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
      emitRecordingFrame();
    });

    const startPromise = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    expect(stopScreencast).not.toHaveBeenCalled();
    finishStartingScreencast?.();

    await startPromise;
    await expect(stopPromise).resolves.toMatchObject({ tabId: "recording-tab" });
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(events.at(-1)).toBe("clear");
  });

  it("does not release the recording slot until a cancelled start settles", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
      emitRecordingFrame();
    });

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    const restartAfterStop = stopPromise.then(() => startBrowserRecording("recording-tab"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startCallsBeforeFirstSettled = startScreencast.mock.calls.length;

    finishStartingScreencast?.();
    await firstStart;
    await stopPromise;
    await restartAfterStop;
    await stopBrowserRecording("recording-tab");

    expect(startCallsBeforeFirstSettled).toBe(1);
  });

  it("keeps the recording slot while a failed stop waits for startup", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
      emitRecordingFrame();
    });
    stopScreencast.mockRejectedValueOnce(new Error("initial stop failed"));

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");

    const rejectedStop = expect(stopPromise).rejects.toMatchObject({
      operation: "stop-screencast",
      tabId: "recording-tab",
    });

    expect(stopScreencast).not.toHaveBeenCalled();
    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await firstStart;
    await rejectedStop;
    expect(stopScreencast).toHaveBeenCalledOnce();

    await startBrowserRecording("recording-tab");
    await stopBrowserRecording("recording-tab");
  });

  it("fails a stop that waits too long for startup without freeing the recording slot", async () => {
    vi.useFakeTimers();
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
      emitRecordingFrame();
    });

    const startPromise = startBrowserRecording("recording-tab");
    expect(startScreencast).toHaveBeenCalledOnce();

    const stopPromise = stopBrowserRecording("recording-tab");
    await Promise.resolve();
    await Promise.resolve();
    expect(stopScreencast).not.toHaveBeenCalled();

    const rejection = expect(stopPromise).rejects.toMatchObject({
      operation: "wait-startup",
      tabId: "recording-tab",
    });

    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);

    await rejection;
    expect(save).not.toHaveBeenCalled();
    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await startPromise;
    const cleanupResult = await stopBrowserRecording("recording-tab");
    expect(cleanupResult).toBeNull();
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("clear");
  });
});

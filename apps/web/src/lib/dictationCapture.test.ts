import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startDictationCapture, type DictationCaptureDependencies } from "./dictationCapture";

class Recorder extends EventTarget {
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
  });
  data(text: string) {
    const event = new Event("dataavailable");
    Object.defineProperty(event, "data", { value: new Blob([text], { type: this.mimeType }) });
    this.dispatchEvent(event);
  }
  finish() {
    this.dispatchEvent(new Event("stop"));
  }
}

function fixture() {
  const track = Object.assign(new EventTarget(), { readyState: "live", stop: vi.fn() });
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const mediaDevices = Object.assign(new EventTarget(), {
    getUserMedia: vi.fn(async () => stream),
  });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const recorder = new Recorder();
  const deps: DictationCaptureDependencies = {
    mediaDevices,
    document,
    createRecorder: vi.fn(() => recorder),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  return { track, stream, mediaDevices, document, recorder, deps };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startDictationCapture", () => {
  it("records in memory and release waits for the final chunk, stopping tracks immediately", async () => {
    const f = fixture();
    const capture = await startDictationCapture({}, f.deps);
    expect(f.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(f.recorder.start).toHaveBeenCalledWith(250);
    f.recorder.data("first");
    const result = capture.release();
    expect(capture.release()).toBe(result);
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.recorder.stop).toHaveBeenCalledTimes(1);
    f.recorder.data("last");
    f.recorder.finish();
    const blob = await result;
    expect(blob.type).toBe("audio/webm");
    expect(await blob.text()).toBe("firstlast");
    capture.cancel();
    f.mediaDevices.dispatchEvent(new Event("devicechange"));
    expect(await capture.result).toBe(blob);
  });

  it("does not request permission when already aborted", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      startDictationCapture({ signal: controller.signal }, f.deps),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("aborts pending permission immediately and stops a late stream", async () => {
    const f = fixture();
    let grant!: (stream: MediaStream) => void;
    f.mediaDevices.getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = startDictationCapture({ signal: controller.signal }, f.deps);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    grant(f.stream);
    await Promise.resolve();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.deps.createRecorder).not.toHaveBeenCalled();
  });

  it("propagates permission denial", async () => {
    const f = fixture();
    const error = new DOMException("Denied", "NotAllowedError");
    f.mediaDevices.getUserMedia.mockRejectedValue(error);
    await expect(startDictationCapture({}, f.deps)).rejects.toBe(error);
    expect(f.deps.createRecorder).not.toHaveBeenCalled();
  });

  it.each(["cancel", "abort", "devicechange", "ended", "hidden", "error", "stop"])(
    "cleans up on %s during recording",
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      const controller = new AbortController();
      const capture = await startDictationCapture({ signal: controller.signal }, f.deps);
      if (reason === "cancel") capture.cancel();
      if (reason === "abort") controller.abort();
      if (reason === "devicechange") f.mediaDevices.dispatchEvent(new Event(reason));
      if (reason === "ended") f.track.dispatchEvent(new Event(reason));
      if (reason === "hidden") {
        f.document.hidden = true;
        f.document.dispatchEvent(new Event("visibilitychange"));
      }
      if (reason === "error" || reason === "stop") f.recorder.dispatchEvent(new Event(reason));
      await expect(capture.result).rejects.toBeInstanceOf(Error);
      expect(f.track.stop).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      capture.cancel();
      await expect(capture.release()).rejects.toBeInstanceOf(Error);
      expect(f.track.stop).toHaveBeenCalledTimes(1);
    },
  );

  it("enforces duration without waiting for data events", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const capture = await startDictationCapture({ maxDurationMs: 50 }, f.deps);
    vi.advanceTimersByTime(50);
    await expect(capture.result).rejects.toThrow("duration limit");
    expect(f.track.stop).toHaveBeenCalled();
  });

  it.each([false, true])(
    "enforces cumulative size including final chunks (releasing: %s)",
    async (releasing) => {
      const f = fixture();
      const capture = await startDictationCapture({ maxBytes: 4 }, f.deps);
      f.recorder.data("1234");
      if (releasing) void capture.release();
      f.recorder.data("5");
      f.recorder.finish();
      await expect(capture.result).rejects.toThrow("size limit");
      expect(f.track.stop).toHaveBeenCalled();
    },
  );

  it.each(["construct", "start", "stop"])("stops tracks when recorder %s throws", async (phase) => {
    const f = fixture();
    const fail = () => {
      throw new Error("recorder failure");
    };
    if (phase === "construct") f.deps.createRecorder = fail;
    if (phase === "start") f.recorder.start.mockImplementation(fail);
    if (phase === "stop") f.recorder.stop.mockImplementation(fail);
    if (phase === "stop") {
      const capture = await startDictationCapture({}, f.deps);
      await expect(capture.release()).rejects.toThrow("recorder failure");
    } else {
      await expect(startDictationCapture({}, f.deps)).rejects.toThrow("recorder failure");
    }
    expect(f.track.stop).toHaveBeenCalled();
  });

  it("rejects hidden pages without requesting permission", async () => {
    const f = fixture();
    f.document.hidden = true;
    await expect(startDictationCapture({}, f.deps)).rejects.toThrow("hidden");
    expect(f.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it.each(["hidden", "devicechange"])("interrupts pending permission on %s", async (reason) => {
    const f = fixture();
    let grant!: (stream: MediaStream) => void;
    f.mediaDevices.getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const pending = startDictationCapture({}, f.deps);
    if (reason === "hidden") {
      f.document.hidden = true;
      f.document.dispatchEvent(new Event("visibilitychange"));
    } else {
      f.mediaDevices.dispatchEvent(new Event("devicechange"));
    }
    await expect(pending).rejects.toBeInstanceOf(Error);
    grant(f.stream);
    await Promise.resolve();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.deps.createRecorder).not.toHaveBeenCalled();
  });

  it("rejects an already ended track and releases its stream", async () => {
    const f = fixture();
    f.track.readyState = "ended";
    await expect(startDictationCapture({}, f.deps)).rejects.toThrow("track ended");
    expect(f.track.stop).toHaveBeenCalledTimes(1);
  });

  it("removes every event listener after release", async () => {
    const f = fixture();
    const targets = [f.mediaDevices, f.document, f.track, f.recorder];
    const listeners = targets.map((target) => ({
      add: vi.spyOn(target, "addEventListener"),
      remove: vi.spyOn(target, "removeEventListener"),
    }));
    const capture = await startDictationCapture({}, f.deps);
    const result = capture.release();
    f.recorder.finish();
    await result;
    for (const { add, remove } of listeners) {
      expect(add.mock.calls.length).toBeGreaterThan(0);
      expect(remove.mock.calls).toEqual(add.mock.calls);
    }
  });

  it.each([0, -1, Infinity, NaN])("rejects invalid limits (%s)", async (limit) => {
    const f = fixture();
    await expect(startDictationCapture({ maxBytes: limit }, f.deps)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(startDictationCapture({ maxDurationMs: limit }, f.deps)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(f.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
});

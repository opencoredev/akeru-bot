import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { DictationDraft } from "./draft.ts";
import {
  createDictationSession,
  type DictationAudio,
  type DictationCapture,
  type DictationDependencies,
  type DictationLimits,
} from "./session.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(options: Partial<DictationLimits> = {}) {
  let draft: DictationDraft = {
    identity: { environmentId: "environment", threadId: "thread", draftId: "draft", generation: 1 },
    text: "hello",
    selection: { start: 5, end: 5 },
  };
  const audio: DictationAudio = {
    bytes: new Uint8Array([1, 2]),
    durationMs: 10,
    mediaType: "audio/webm",
  };
  const recording = { stop: vi.fn(async () => audio), dispose: vi.fn() };
  const transcription = deferred<string>();
  const invoked = deferred<void>();
  const capture = vi.fn<DictationDependencies["capture"]>(async () => recording);
  const transcribe = vi.fn<DictationDependencies["transcribe"]>(() => {
    invoked.resolve();
    return transcription.promise;
  });
  const updateDraft = vi.fn<DictationDependencies["updateDraft"]>((update) => {
    draft = update(draft);
  });
  const session = createDictationSession(
    {
      capture,
      transcribe,
      updateDraft,
      schedule: (callback, milliseconds) => globalThis["setTimeout"](callback, milliseconds),
      cancelSchedule: (timer) => globalThis["clearTimeout"](timer as number),
    },
    options,
  );
  return {
    session,
    capture,
    recording,
    transcribe,
    updateDraft,
    transcription,
    invoked,
    audio,
    get draft() {
      return draft;
    },
    set draft(value: DictationDraft) {
      draft = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isolated dictation lifecycle", () => {
  it("captures locally, releases capture before transcription, and only merges the latest draft", async () => {
    const h = setup();
    await h.session.start(h.draft);
    expect(h.session.status).toBe("recording");
    const finish = h.session.finish();
    await h.invoked.promise;
    expect(h.recording.dispose).toHaveBeenCalledTimes(1);
    expect(h.transcribe.mock.calls[0]?.[0].audio).toBe(h.audio);
    h.draft = { ...h.draft, text: "concurrent edit", selection: { start: 0, end: 10 } };
    h.transcription.resolve("spoken words");
    await finish;
    expect(h.draft.text).toBe("concurrent edit spoken words");
    expect(h.draft.selection).toEqual({ start: 0, end: 10 });
    expect(h.session.status).toBe("completed");
    expect(h.updateDraft).toHaveBeenCalledTimes(1);
    expect(h.capture.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it.each(["cancel", "navigation", "disconnect", "disposed"] as const)(
    "aborts %s during capture",
    async (reason) => {
      const h = setup();
      await h.session.start(h.draft);
      h.session.cancel(reason);
      h.session.cancel(reason);
      expect(h.session.status).toBe("cancelled");
      expect(h.capture.mock.calls[0]?.[0].signal.aborted).toBe(true);
      expect(h.recording.dispose).toHaveBeenCalledTimes(1);
      await h.session.finish();
      expect(h.transcribe).not.toHaveBeenCalled();
    },
  );

  it("settles cancellation while permission is pending and cleans up a late capture", async () => {
    const h = setup();
    const acquisition = deferred<DictationCapture>();
    h.capture.mockReturnValueOnce(acquisition.promise);
    const start = h.session.start(h.draft);
    h.session.cancel();
    await start;
    acquisition.resolve(h.recording);
    await acquisition.promise;
    expect(h.recording.dispose).toHaveBeenCalledTimes(1);
    expect(h.session.status).toBe("cancelled");
  });

  it.each(["environmentId", "threadId", "draftId", "generation"] as const)(
    "invalidates active work on %s change",
    async (key) => {
      const h = setup();
      await h.session.start(h.draft);
      const finish = h.session.finish();
      await h.invoked.promise;
      h.session.updateContext(
        { ...h.draft.identity, [key]: key === "generation" ? 2 : "other" },
        true,
      );
      await finish;
      h.transcription.resolve("late");
      expect(h.transcribe.mock.calls[0]?.[0].signal.aborted).toBe(true);
      expect(h.updateDraft).not.toHaveBeenCalled();
    },
  );

  it("cancels on disconnect and permits an explicit new session after reconnect", async () => {
    const h = setup();
    await h.session.start(h.draft);
    h.session.updateContext(h.draft.identity, false);
    expect(h.session.status).toBe("cancelled");
    await h.session.start(h.draft);
    expect(h.session.status).toBe("recording");
    h.session.dispose();
    await expect(h.session.start(h.draft)).rejects.toThrow("disposed");
  });

  it("ignores an older transcription after restart on the same identity", async () => {
    const h = setup();
    await h.session.start(h.draft);
    const first = h.session.finish();
    await h.invoked.promise;
    await h.session.start(h.draft);
    await first;
    h.transcription.resolve("stale");
    expect(h.session.status).toBe("recording");
    expect(h.updateDraft).not.toHaveBeenCalled();
    h.session.dispose();
  });

  it("checks draft identity at merge even without a context notification", async () => {
    const h = setup();
    await h.session.start(h.draft);
    const finish = h.session.finish();
    await h.invoked.promise;
    h.draft = { ...h.draft, identity: { ...h.draft.identity, generation: 2 }, text: "replacement" };
    h.transcription.resolve("stale");
    await finish;
    expect(h.draft.text).toBe("replacement");
  });

  it("deduplicates finish and cleans up failures", async () => {
    const h = setup();
    await h.session.start(h.draft);
    const finish = h.session.finish();
    await h.session.finish();
    await h.invoked.promise;
    h.transcription.reject(new Error("unavailable"));
    await finish;
    expect(h.session.status).toBe("error");
    expect(h.recording.stop).toHaveBeenCalledTimes(1);
    expect(h.recording.dispose).toHaveBeenCalledTimes(1);
    expect(h.updateDraft).not.toHaveBeenCalled();
  });

  it("retries after a failed transcription without touching the typed draft", async () => {
    const h = setup();
    h.transcribe.mockRejectedValueOnce(new Error("provider down")).mockResolvedValueOnce("world");
    await h.session.start(h.draft);
    await h.session.finish();
    expect(h.session.status).toBe("error");
    expect(h.draft.text).toBe("hello");
    await h.session.start(h.draft);
    expect(h.session.error).toBeUndefined();
    await h.session.finish();
    expect(h.session.status).toBe("completed");
    expect(h.draft.text).toBe("hello world");
    h.session.cancel();
    expect(h.session.status).toBe("cancelled");
  });

  it("handles capture denial and stop failure", async () => {
    const h = setup();
    h.capture.mockRejectedValueOnce(new Error("permission denied"));
    await h.session.start(h.draft);
    expect(h.session.status).toBe("error");
    await h.session.start(h.draft);
    h.recording.stop.mockRejectedValueOnce(new Error("capture failed"));
    await h.session.finish();
    expect(h.session.status).toBe("error");
    expect(h.recording.dispose).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending stop and releases its recording", async () => {
    const h = setup();
    const stop = deferred<DictationAudio>();
    h.recording.stop.mockReturnValueOnce(stop.promise);
    await h.session.start(h.draft);
    const finish = h.session.finish();
    h.session.cancel();
    await finish;
    stop.resolve(h.audio);
    expect(h.recording.dispose).toHaveBeenCalledTimes(1);
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it.each([{ maxAudioBytes: 1 }, { maxRecordingMs: 1 }])(
    "rejects oversized audio %j",
    async (limits) => {
      const h = setup(limits);
      await h.session.start(h.draft);
      await h.session.finish();
      expect(h.session.status).toBe("error");
      expect(h.transcribe).not.toHaveBeenCalled();
      expect(h.recording.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects oversized transcripts and leaves drafts untouched", async () => {
    const h = setup({ maxTranscriptCharacters: 2 });
    await h.session.start(h.draft);
    h.transcription.resolve("long");
    await h.session.finish();
    expect(h.session.status).toBe("error");
    expect(h.updateDraft).not.toHaveBeenCalled();
  });

  it("enforces recording and transcription deadlines without automatic submission", async () => {
    vi.useFakeTimers();
    const h = setup({ maxRecordingMs: 100, maxTranscriptionMs: 50 });
    await h.session.start(h.draft);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.session.status).toBe("error");
    expect(h.transcribe).not.toHaveBeenCalled();
    await h.session.start(h.draft);
    const finish = h.session.finish();
    await h.invoked.promise;
    await vi.advanceTimersByTimeAsync(50);
    await finish;
    expect(h.session.status).toBe("error");
    expect(h.transcribe.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(h.updateDraft).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels permission acquisition on release and disposes a late recording", async () => {
    vi.useFakeTimers();
    const h = setup();
    const acquisition = deferred<DictationCapture>();
    h.capture.mockReturnValueOnce(acquisition.promise);
    const start = h.session.start(h.draft);
    await h.session.finish();
    await start;
    expect(h.session.status).toBe("cancelled");
    expect(h.capture.mock.calls[0]?.[0].signal.aborted).toBe(true);
    acquisition.resolve(h.recording);
    await acquisition.promise;
    expect(h.recording.dispose).toHaveBeenCalledTimes(1);
    expect(h.recording.stop).not.toHaveBeenCalled();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.updateDraft).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies subscribers of transitions and supports unsubscribe", async () => {
    const h = setup();
    const states: string[] = [];
    const unsubscribe = h.session.subscribe(() => states.push(h.session.status));
    await h.session.start(h.draft);
    h.transcription.resolve("words");
    await h.session.finish();
    expect(states).toEqual(["starting", "recording", "transcribing", "completed"]);
    unsubscribe();
    unsubscribe();
    h.session.dispose();
    expect(states).toHaveLength(4);
  });

  it.each(["cancel", "navigation", "disconnect", "disposed"] as const)(
    "notifies subscribers of %s cleanup",
    async (reason) => {
      const h = setup();
      await h.session.start(h.draft);
      const listener = vi.fn(() => {
        expect(h.session.status).toBe("cancelled");
        expect(h.recording.dispose).toHaveBeenCalledTimes(1);
        expect(h.capture.mock.calls[0]?.[0].signal.aborted).toBe(true);
      });
      h.session.subscribe(listener);
      if (reason === "navigation")
        h.session.updateContext({ ...h.draft.identity, threadId: "other" }, true);
      else if (reason === "disconnect") h.session.updateContext(h.draft.identity, false);
      else if (reason === "disposed") h.session.dispose();
      else h.session.cancel();
      h.session.cancel();
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["recording", "transcribing"] as const)(
    "notifies subscribers when the %s deadline fails",
    async (phase) => {
      vi.useFakeTimers();
      const h = setup({ maxRecordingMs: 100, maxTranscriptionMs: 50 });
      const failure = deferred<unknown>();
      h.session.subscribe(() => {
        if (h.session.status === "error") failure.resolve(h.session.error);
      });
      await h.session.start(h.draft);
      const finish = phase === "transcribing" ? h.session.finish() : undefined;
      if (finish) await h.invoked.promise;
      await vi.advanceTimersByTimeAsync(phase === "transcribing" ? 50 : 100);
      expect(await failure.promise).toEqual(new Error("Dictation time limit exceeded"));
      await finish;
      expect(h.updateDraft).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reports platform interruption before finish and releases capture immediately", async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.session.start(h.draft);
    const states: unknown[] = [];
    h.session.subscribe(() => states.push({ status: h.session.status, error: h.session.error }));
    const cause = new Error("microphone disconnected");
    const input = h.capture.mock.calls[0]?.[0];
    input?.onError(cause);
    expect(states).toEqual([{ status: "error", error: cause }]);
    expect(input?.signal.aborted).toBe(true);
    expect(h.recording.dispose).toHaveBeenCalledTimes(1);
    await h.session.finish();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles synchronous platform errors during acquisition and cleans up the late handle", async () => {
    const h = setup();
    const cause = new Error("capture interrupted");
    h.capture.mockImplementationOnce(async ({ onError }) => {
      onError(cause);
      return h.recording;
    });
    await h.session.start(h.draft);
    expect(h.session.status).toBe("error");
    expect(h.session.error).toBe(cause);
    expect(h.recording.dispose).toHaveBeenCalledTimes(1);
  });

  it("ignores old platform callbacks after restart and disposal", async () => {
    const h = setup();
    await h.session.start(h.draft);
    const oldInput = h.capture.mock.calls[0]?.[0];
    await h.session.start(h.draft);
    const listener = vi.fn();
    h.session.subscribe(listener);
    oldInput?.onError(new Error("late failure"));
    expect(h.session.status).toBe("recording");
    expect(listener).not.toHaveBeenCalled();
    h.session.dispose();
    listener.mockClear();
    h.capture.mock.calls[1]?.[0].onError(new Error("disposed failure"));
    expect(h.session.status).toBe("cancelled");
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(["starting", "transcribing"] as const)(
    "allows subscribers to cancel during %s without starting new work",
    async (phase) => {
      const h = setup();
      h.session.subscribe(() => {
        if (h.session.status === phase) h.session.cancel();
      });
      await h.session.start(h.draft);
      if (phase === "transcribing") await h.session.finish();
      expect(h.session.status).toBe("cancelled");
      if (phase === "starting") expect(h.capture).not.toHaveBeenCalled();
      expect(h.recording.stop).not.toHaveBeenCalled();
      expect(h.transcribe).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid limit %s", (maxAudioBytes) => {
    expect(() => setup({ maxAudioBytes })).toThrow(RangeError);
  });
});

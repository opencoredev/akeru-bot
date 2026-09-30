import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DictationDraft } from "@akeru/client-runtime/dictation";
import { browserDictationCaptureReason, createBrowserDictationSession } from "./browserDictation";
import { startDictationCapture } from "./dictationCapture";

vi.mock("./dictationCapture", () => ({ startDictationCapture: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixture(captureResult?: Promise<Blob>) {
  let draft: DictationDraft = {
    identity: { environmentId: "remote", threadId: "thread", draftId: "draft", generation: 0 },
    text: "Keep this",
    selection: { start: 9, end: 9 },
  };
  const cancel = vi.fn();
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  vi.mocked(startDictationCapture).mockResolvedValue({
    result: captureResult ?? Promise.resolve(blob),
    release: vi.fn(async () => blob),
    cancel,
  });
  vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(200);
  const transcribe = vi.fn(async () => "spoken words");
  const session = createBrowserDictationSession(
    {
      transcribe,
      updateDraft: (update) => {
        draft = update(draft);
      },
    },
    { maxAudioBytes: 1024, maxRecordingMs: 1000 },
  );
  return { session, transcribe, cancel, draft: () => draft };
}

describe("browser dictation boundary", () => {
  it("passes local bytes and scoped identity to transcription, then edits only the draft", async () => {
    const f = fixture();
    await f.session.start(f.draft());
    expect(startDictationCapture).toHaveBeenCalledWith(
      {
        signal: expect.any(AbortSignal),
        maxDurationMs: 1000,
        maxBytes: 1024,
      },
      undefined,
    );
    await f.session.finish();
    expect(f.transcribe).toHaveBeenCalledExactlyOnceWith({
      audio: { bytes: new Uint8Array([1, 2, 3]), mediaType: "audio/webm", durationMs: 100 },
      signal: expect.any(AbortSignal),
      identity: f.draft().identity,
    });
    expect(f.draft().text).toBe("Keep this spoken words");
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.session.status).toBe("completed");
  });

  it("reports browser interruption immediately rather than waiting for release", async () => {
    const captureResult = deferred<Blob>();
    const f = fixture(captureResult.promise);
    await f.session.start(f.draft());
    const changed = deferred<void>();
    const unsubscribe = f.session.subscribe(() => {
      if (f.session.status === "error") changed.resolve();
    });
    captureResult.reject(new Error("Microphone devices changed."));
    await changed.promise;
    expect(f.session.status).toBe("error");
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.transcribe).not.toHaveBeenCalled();
    expect(f.draft().text).toBe("Keep this");
    unsubscribe();
  });

  it("cancels capture on remote disconnect without invoking transcription", async () => {
    const f = fixture();
    await f.session.start(f.draft());
    f.session.updateContext(f.draft().identity, false);
    await f.session.finish();
    expect(f.transcribe).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.draft().text).toBe("Keep this");
  });
});

describe("browserDictationCaptureReason", () => {
  it("explains insecure pages and missing recorders", () => {
    const mediaDevices = { getUserMedia: () => undefined };
    expect(
      browserDictationCaptureReason({
        isSecureContext: false,
        navigator: { mediaDevices },
        MediaRecorder: class {},
      }),
    ).toContain("HTTPS");
    expect(
      browserDictationCaptureReason({
        isSecureContext: true,
        navigator: {},
        MediaRecorder: class {},
      }),
    ).toBe("This browser can't record audio.");
    expect(
      browserDictationCaptureReason({
        isSecureContext: true,
        navigator: { mediaDevices },
        MediaRecorder: class {},
      }),
    ).toBeNull();
  });
});

export interface DictationCaptureDependencies {
  mediaDevices: Pick<MediaDevices, "getUserMedia" | "addEventListener" | "removeEventListener">;
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
  createRecorder: (
    stream: MediaStream,
  ) => Pick<
    MediaRecorder,
    "start" | "stop" | "state" | "mimeType" | "addEventListener" | "removeEventListener"
  >;
  setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface DictationCaptureOptions {
  signal?: AbortSignal;
  maxDurationMs?: number;
  maxBytes?: number;
}

export interface DictationCapture {
  /** Resolves after release, or rejects when recording is interrupted. */
  result: Promise<Blob>;
  release: () => Promise<Blob>;
  cancel: () => void;
}

function browserDependencies(): DictationCaptureDependencies {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof MediaRecorder === "undefined"
  ) {
    throw new Error("Microphone recording is not supported in this browser.");
  }
  return {
    mediaDevices: navigator.mediaDevices,
    document,
    createRecorder: (stream) => new MediaRecorder(stream),
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
  };
}

/** Captures audio in memory only; cancellation also handles permission grants arriving late. */
export async function startDictationCapture(
  options: DictationCaptureOptions = {},
  dependencies?: DictationCaptureDependencies,
): Promise<DictationCapture> {
  const aborted = () => new DOMException("Microphone capture was cancelled.", "AbortError");
  if (options.signal?.aborted) throw aborted();
  const maxDurationMs = options.maxDurationMs ?? 120_000;
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  if (
    !Number.isFinite(maxDurationMs) ||
    maxDurationMs <= 0 ||
    !Number.isFinite(maxBytes) ||
    maxBytes <= 0
  ) {
    throw new RangeError("Capture limits must be positive finite numbers.");
  }
  const deps = dependencies ?? browserDependencies();
  let stream: MediaStream | undefined;
  let recorder: ReturnType<DictationCaptureDependencies["createRecorder"]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let releasing = false;
  let bytes = 0;
  const chunks: Blob[] = [];
  const removers: Array<() => void> = [];
  let resolveResult!: (blob: Blob) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Interruptions can precede the caller awaiting release.
  void result.catch(() => {});
  let rejectStart!: (error: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStart = reject;
  });
  const stopTracks = (value: MediaStream) => {
    for (const track of value.getTracks()) track.stop();
  };
  const cleanup = () => {
    for (const remove of removers.splice(0)) remove();
    if (timer !== undefined) deps.clearTimeout(timer);
    if (stream) stopTracks(stream);
  };
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {
      // Tracks are already stopped even when the recorder cannot stop.
    }
    chunks.length = 0;
    rejectResult(error);
    rejectStart(error);
  };
  const listen = (
    target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
    name: string,
    listener: EventListener,
  ) => {
    target.addEventListener(name, listener);
    removers.push(() => target.removeEventListener(name, listener));
  };
  const cancel = () => fail(aborted());
  if (options.signal) listen(options.signal, "abort", cancel);
  listen(deps.document, "visibilitychange", () => {
    if (deps.document.hidden)
      fail(new Error("Microphone capture stopped because the page is hidden."));
  });
  listen(deps.mediaDevices, "devicechange", () => fail(new Error("Microphone devices changed.")));

  try {
    if (deps.document.hidden) throw new Error("Cannot record while the page is hidden.");
    const permission = deps.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((value) => {
        if (finished) {
          stopTracks(value);
          throw aborted();
        }
        return value;
      });
    stream = await Promise.race([permission, interrupted]);
    // An abort can occur between permission resolution and this continuation.
    if (finished) {
      stopTracks(stream);
      await interrupted;
    }
    for (const track of stream.getTracks()) {
      listen(track, "ended", () => fail(new Error("Microphone track ended.")));
      if (track.readyState === "ended") throw new Error("Microphone track ended.");
    }
    recorder = deps.createRecorder(stream);
    listen(recorder, "dataavailable", (event) => {
      const { data } = event as BlobEvent;
      bytes += data.size;
      if (bytes > maxBytes) {
        fail(new Error("Microphone capture exceeded the size limit."));
      } else if (data.size > 0) {
        chunks.push(data);
      }
    });
    listen(recorder, "error", () => fail(new Error("Microphone recording failed.")));
    listen(recorder, "stop", () => {
      if (!releasing) {
        fail(new Error("Microphone recording stopped unexpectedly."));
        return;
      }
      if (finished) return;
      finished = true;
      const audio = new Blob(chunks, {
        type: recorder?.mimeType || chunks[0]?.type || "audio/webm",
      });
      chunks.length = 0;
      cleanup();
      resolveResult(audio);
    });
    recorder.start(250);
    timer = deps.setTimeout(
      () => fail(new Error("Microphone capture exceeded the duration limit.")),
      maxDurationMs,
    );
    return {
      result,
      cancel,
      release: () => {
        if (!finished && !releasing) {
          releasing = true;
          try {
            recorder!.stop();
            // The final dataavailable/stop events are asynchronous in browsers.
            if (stream) stopTracks(stream);
          } catch (error) {
            fail(error);
          }
        }
        return result;
      },
    };
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    // Permission failures may happen before the race installs its rejection handler.
    void interrupted.catch(() => {});
  }
}

import {
  mergeDictationDraft,
  sameDictationIdentity,
  type DictationDraft,
  type DictationIdentity,
} from "./draft.ts";

export interface DictationAudio {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly durationMs: number;
}

export interface DictationLimits {
  readonly maxRecordingMs: number;
  readonly maxAudioBytes: number;
  readonly maxTranscriptionMs: number;
  readonly maxTranscriptCharacters: number;
  readonly maxDraftCharacters: number;
}

export const DEFAULT_DICTATION_LIMITS: DictationLimits = {
  maxRecordingMs: 60_000,
  maxAudioBytes: 10 * 1024 * 1024,
  maxTranscriptionMs: 30_000,
  maxTranscriptCharacters: 20_000,
  maxDraftCharacters: 100_000,
};

export interface DictationCapture {
  /** Stop recording and return owned audio bytes that remain valid after disposal. */
  stop(): Promise<DictationAudio>;
  /** Idempotently release local tracks, buffers, and temporary files synchronously; must not throw. */
  dispose(): void;
}

export interface DictationDependencies {
  /** Capture on this client, enforce limits while recording, and release resources on abort. */
  capture(input: {
    signal: AbortSignal;
    limits: DictationLimits;
    onError(cause: unknown): void;
  }): Promise<DictationCapture>;
  /** Inject a real transcription implementation; this module supplies no provider or transport. */
  transcribe(input: {
    audio: DictationAudio;
    signal: AbortSignal;
    identity: DictationIdentity;
  }): Promise<string>;
  /** Synchronously and atomically update the latest draft; never defer the updater or send a message. */
  updateDraft(update: (current: DictationDraft) => DictationDraft): void;
  schedule(callback: () => void, milliseconds: number): unknown;
  cancelSchedule(timer: unknown): void;
}

export type DictationStatus =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing"
  | "completed"
  | "cancelled"
  | "error";
export type DictationCancelReason = "cancel" | "navigation" | "disconnect" | "disposed";

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      void promise.catch(() => undefined);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One local dictation at a time; all completion effects are guarded by session and draft identity. */
export function createDictationSession(
  dependencies: DictationDependencies,
  options: Partial<DictationLimits> = {},
) {
  const limits = Object.freeze({ ...DEFAULT_DICTATION_LIMITS, ...options });
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
      throw new RangeError("Invalid dictation limit");
  }
  let status: DictationStatus = "idle";
  let error: unknown;
  let disposed = false;
  const listeners = new Set<() => void>();

  function transition(next: DictationStatus, cause?: unknown) {
    const nextError = next === "error" ? cause : undefined;
    if (status === next && Object.is(error, nextError)) return;
    status = next;
    error = nextError;
    // Subscription changes apply to the next transition.
    const pendingListeners = [...listeners];
    for (const listener of pendingListeners) listener();
  }
  let active:
    | {
        original: DictationDraft;
        controller: AbortController;
        capture?: DictationCapture;
        timer?: unknown;
      }
    | undefined;

  function releaseCapture(run: NonNullable<typeof active>) {
    const capture = run.capture;
    delete run.capture;
    capture?.dispose();
  }

  function releaseActive(reason?: unknown) {
    const run = active;
    active = undefined;
    if (!run) return;
    dependencies.cancelSchedule(run.timer);
    run.controller.abort(reason);
    releaseCapture(run);
  }

  function terminate(next: DictationStatus, reason?: unknown) {
    releaseActive(reason);
    transition(next, reason);
  }

  function deadline(run: NonNullable<typeof active>, milliseconds: number) {
    dependencies.cancelSchedule(run.timer);
    run.timer = dependencies.schedule(() => {
      if (active === run) terminate("error", new Error("Dictation time limit exceeded"));
    }, milliseconds);
  }

  return {
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    /** Observe transitions synchronously; listeners must not throw. Returns an unsubscribe function. */
    subscribe(listener: () => void) {
      if (!disposed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start(draft: DictationDraft) {
      if (disposed) throw new Error("Dictation session is disposed");
      releaseActive();
      const run: NonNullable<typeof active> = {
        original: { ...draft, identity: { ...draft.identity }, selection: { ...draft.selection } },
        controller: new AbortController(),
      };
      active = run;
      deadline(run, limits.maxRecordingMs);
      transition("starting");
      if (active !== run) return;
      try {
        const acquisition = dependencies
          .capture({
            signal: run.controller.signal,
            limits,
            onError(cause) {
              if (active === run) terminate("error", cause);
            },
          })
          .then((capture) => {
            if (active !== run) capture.dispose();
            else run.capture = capture;
            return capture;
          });
        await abortable(acquisition, run.controller.signal);
        if (active === run) transition("recording");
      } catch (cause) {
        if (active === run) terminate("error", cause);
      }
    },
    async finish() {
      if (status === "starting") {
        terminate("cancelled", "cancel");
        return;
      }
      const run = active;
      if (!run?.capture || status !== "recording") return;
      const capture = run.capture;
      deadline(run, limits.maxTranscriptionMs);
      transition("transcribing");
      if (active !== run) return;
      try {
        const audio = await abortable(capture.stop(), run.controller.signal);
        releaseCapture(run);
        if (active !== run) return;
        if (
          audio.bytes.byteLength === 0 ||
          audio.bytes.byteLength > limits.maxAudioBytes ||
          !Number.isFinite(audio.durationMs) ||
          audio.durationMs <= 0 ||
          audio.durationMs > limits.maxRecordingMs ||
          !audio.mediaType.trim()
        ) {
          throw new Error("Invalid dictation audio or audio limit exceeded");
        }
        const transcript = await abortable(
          dependencies.transcribe({
            audio,
            signal: run.controller.signal,
            identity: run.original.identity,
          }),
          run.controller.signal,
        );
        if (active !== run) return;
        if (transcript.length > limits.maxTranscriptCharacters)
          throw new Error("Dictation transcript limit exceeded");
        dependencies.updateDraft((current) =>
          active === run
            ? mergeDictationDraft(run.original, current, transcript, limits.maxDraftCharacters)
            : current,
        );
        if (active === run) terminate("completed");
      } catch (cause) {
        if (active === run) terminate("error", cause);
      }
    },
    cancel(reason: DictationCancelReason = "cancel") {
      terminate("cancelled", reason);
    },
    /** Call on navigation, draft replacement, and connectivity changes, including a return to the same chat. */
    updateContext(identity: DictationIdentity, connected: boolean) {
      if (active && (!connected || !sameDictationIdentity(active.original.identity, identity))) {
        terminate("cancelled", connected ? "navigation" : "disconnect");
      }
    },
    dispose() {
      disposed = true;
      terminate("cancelled", "disposed");
      listeners.clear();
    },
  };
}

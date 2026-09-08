export interface ReplyPlaybackIdentity {
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly contentVersion: string;
  readonly provider: string;
  readonly voice: string;
}

export interface ReplyAudioHandle {
  play(): Promise<void>;
  pause(): void;
  dispose(): void;
}

export interface ReplyAudioEvents {
  onEnded(): void;
  onError(): void;
  onInterrupted(): void;
}

export interface ReplyPlaybackRequest {
  readonly identity: ReplyPlaybackIdentity;
  readonly text: string;
  readonly automatic: boolean;
}

export type ReplyPlaybackState =
  | { readonly status: "idle" }
  | {
      readonly status: "loading" | "playing" | "paused" | "error";
      readonly identity: ReplyPlaybackIdentity;
      readonly automatic: boolean;
      readonly error?: "generation" | "playback";
    };

export interface ReplyPlaybackContext {
  readonly environmentId: string;
  readonly threadId: string;
  readonly provider: string;
  readonly voice: string;
  readonly connected: boolean;
  readonly mediaBlocked: boolean;
}

export function sameReplyPlaybackIdentity(a: ReplyPlaybackIdentity, b: ReplyPlaybackIdentity) {
  return (
    a.environmentId === b.environmentId &&
    a.threadId === b.threadId &&
    a.messageId === b.messageId &&
    a.contentVersion === b.contentVersion &&
    a.provider === b.provider &&
    a.voice === b.voice
  );
}

/** One instance belongs to one client, outside individual message components. */
export function createReplyPlaybackController(
  prepare: (
    request: ReplyPlaybackRequest,
    signal: AbortSignal,
    events: ReplyAudioEvents,
  ) => Promise<ReplyAudioHandle>,
) {
  let state: ReplyPlaybackState = { status: "idle" };
  let context: ReplyPlaybackContext | null = null;
  let request: ReplyPlaybackRequest | null = null;
  let abort: AbortController | null = null;
  let audio: ReplyAudioHandle | null = null;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: ReplyPlaybackState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const release = () => {
    generation += 1;
    abort?.abort();
    abort = null;
    const previous = audio;
    audio = null;
    previous?.dispose();
  };
  const stop = () => {
    release();
    request = null;
    publish({ status: "idle" });
  };
  const allowed = (identity: ReplyPlaybackIdentity) =>
    !disposed &&
    context !== null &&
    context.connected &&
    !context.mediaBlocked &&
    context.environmentId === identity.environmentId &&
    context.threadId === identity.threadId &&
    context.provider === identity.provider &&
    context.voice === identity.voice;
  const fail = (error: "generation" | "playback") => {
    const failed = request;
    release();
    if (failed)
      publish({ status: "error", identity: failed.identity, automatic: failed.automatic, error });
  };
  const start = async (next: ReplyPlaybackRequest) => {
    stop();
    if (!allowed(next.identity) || !next.text.trim()) return;
    request = next;
    abort = new AbortController();
    const token = generation;
    const current = () => token === generation && allowed(next.identity);
    publish({ status: "loading", identity: next.identity, automatic: next.automatic });
    let prepared: ReplyAudioHandle;
    try {
      prepared = await prepare(next, abort.signal, {
        onEnded: () => {
          if (current()) stop();
        },
        onError: () => {
          if (current()) fail("playback");
        },
        onInterrupted: () => {
          if (current()) stop();
        },
      });
    } catch {
      if (current()) fail("generation");
      return;
    }
    if (!current()) {
      prepared.dispose();
      return;
    }
    audio = prepared;
    try {
      await prepared.play();
      if (current())
        publish({ status: "playing", identity: next.identity, automatic: next.automatic });
    } catch {
      if (current()) fail("playback");
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    pause: () => {
      if (state.status !== "playing" || !audio) return;
      audio.pause();
      publish({ ...state, status: "paused" });
    },
    resume: async () => {
      if (state.status !== "paused" || !audio) return;
      const token = generation;
      const paused = state;
      try {
        await audio.play();
        if (token === generation && state.status === "paused")
          publish({ ...paused, status: "playing" });
      } catch {
        if (token === generation) fail("playback");
      }
    },
    retry: async () => {
      if (state.status === "error" && request) await start(request);
    },
    setContext: (next: ReplyPlaybackContext | null) => {
      context = next;
      if (request && !allowed(request.identity)) stop();
    },
    reconcileMessages: (messages: ReadonlyMap<string, string>) => {
      if (request && messages.get(request.identity.messageId) !== request.identity.contentVersion)
        stop();
    },
    disableAutomaticReadout: () => {
      if (request?.automatic) stop();
    },
    dispose: () => {
      disposed = true;
      stop();
      listeners.clear();
    },
  };
}

export type ReplyPlaybackController = ReturnType<typeof createReplyPlaybackController>;

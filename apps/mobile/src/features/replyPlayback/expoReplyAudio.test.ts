import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AudioStatus } from "expo-audio";
import type { AppStateStatus } from "react-native";

const native = vi.hoisted(() => ({
  create: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
  release: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  createPlayer: vi.fn(),
  statusRemove: vi.fn(),
  appRemove: vi.fn(),
  mode: vi.fn(async () => {}),
  appState: { currentState: "active" as AppStateStatus },
  status: {} as AudioStatus,
  emitStatus: (_status: AudioStatus) => {},
  emitApp: (_state: AppStateStatus) => {},
  uuid: 0,
}));
vi.mock("expo-audio", () => ({
  createAudioPlayer: native.createPlayer,
  setAudioModeAsync: native.mode,
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => String(++native.uuid) }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///private/cache" },
  File: class {
    exists = false;
    uri: string;
    constructor(parent: string, name: string) {
      this.uri = `${parent}/${name}`;
    }
    create() {
      native.create(this.uri);
      this.exists = true;
    }
    write(bytes: Uint8Array) {
      native.write(bytes);
    }
    delete() {
      native.delete(this.uri);
      this.exists = false;
    }
  },
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return native.appState.currentState;
    },
    addEventListener: (_event: string, listener: typeof native.emitApp) => {
      native.emitApp = listener;
      return { remove: native.appRemove };
    },
  },
}));

import {
  createExpoReplyAudio,
  MAX_NATIVE_REPLY_AUDIO_BYTES,
  NATIVE_REPLY_AUDIO_START_TIMEOUT_MS,
} from "./expoReplyAudio";

function status(update: Partial<AudioStatus> = {}): AudioStatus {
  return {
    id: "audio",
    currentTime: 0,
    playbackState: "readyToPlay",
    timeControlStatus: "paused",
    reasonForWaitingToPlay: "",
    mute: false,
    duration: 2,
    playing: false,
    loop: false,
    didJustFinish: false,
    isBuffering: false,
    isLoaded: true,
    playbackRate: 1,
    shouldCorrectPitch: true,
    isLive: false,
    currentOffsetFromLive: null,
    error: null,
    ...update,
  };
}
function emit(update: Partial<AudioStatus>) {
  native.status = status(update);
  native.emitStatus(native.status);
}
function setup() {
  const events = { onEnded: vi.fn(), onError: vi.fn(), onInterrupted: vi.fn() };
  const handle = createExpoReplyAudio(new Uint8Array([1, 2, 3]), "audio/mpeg", events);
  return { handle, events };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  native.appState.currentState = "active";
  native.status = status();
  native.mode.mockResolvedValue();
  native.createPlayer.mockImplementation(() => ({
    get currentStatus() {
      return native.status;
    },
    play: native.play,
    pause: native.pause,
    release: native.release,
    addListener: (_event: string, listener: typeof native.emitStatus) => {
      native.emitStatus = listener;
      return { remove: native.statusRemove };
    },
  }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Expo reply audio binding", () => {
  it("owns a unique cache file and performs no audio-mode setup before play", () => {
    const first = setup();
    const second = setup();
    expect(native.mode).not.toHaveBeenCalled();
    expect(native.play).not.toHaveBeenCalled();
    expect(native.write).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(native.create.mock.calls[0]![0]).not.toBe(native.create.mock.calls[1]![0]);
    expect(native.createPlayer).toHaveBeenCalledWith(
      { uri: expect.stringMatching(/^file:\/\/\/private\/cache\/reply-playback-\d+\.mp3$/) },
      { downloadFirst: false, keepAudioSessionActive: false, updateInterval: 500 },
    );
    first.handle.dispose();
    second.handle.dispose();
    expect(native.delete).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new Uint8Array(), "audio/mpeg"],
    [new Uint8Array(MAX_NATIVE_REPLY_AUDIO_BYTES + 1), "audio/mpeg"],
    [new Uint8Array([1]), "text/plain"],
    [new Uint8Array([1]), "audio/pcm"],
  ])(
    "rejects empty, excessive, or unsupported input before touching native resources",
    (bytes, mime) => {
      expect(() =>
        createExpoReplyAudio(bytes, mime, { onEnded() {}, onError() {}, onInterrupted() {} }),
      ).toThrow("playback limit");
      expect(native.create).not.toHaveBeenCalled();
      expect(native.createPlayer).not.toHaveBeenCalled();
    },
  );

  it("waits for a native playing event and never changes recording policy", async () => {
    const { handle } = setup();
    const called = deferred();
    native.play.mockImplementation(called.resolve);
    const resolved = vi.fn();
    const playing = handle.play().then(resolved);
    await called.promise;
    expect(resolved).not.toHaveBeenCalled();
    expect(native.mode).toHaveBeenCalledWith({
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      interruptionMode: "doNotMix",
    });
    emit({ playing: true, isBuffering: true });
    expect(resolved).not.toHaveBeenCalled();
    emit({ playing: true });
    await playing;
    handle.dispose();
    expect(native.release).toHaveBeenCalledOnce();
    expect(native.delete).toHaveBeenCalledOnce();
  });

  it("pauses and resumes explicitly, distinguishing buffering from focus loss", async () => {
    native.play.mockImplementation(() => emit({ playing: true }));
    const { handle, events } = setup();
    await handle.play();
    emit({ playing: false, isBuffering: true });
    expect(events.onInterrupted).not.toHaveBeenCalled();
    handle.pause();
    emit({ playing: false });
    expect(events.onInterrupted).not.toHaveBeenCalled();
    await handle.play();
    emit({ playing: false });
    expect(events.onInterrupted).toHaveBeenCalledOnce();
    handle.dispose();
  });

  it.each(["inactive", "background"] as const)(
    "interrupts on %s and ignores returning to active",
    async (state) => {
      native.play.mockImplementation(() => emit({ playing: true }));
      const { handle, events } = setup();
      await handle.play();
      native.emitApp(state);
      native.emitApp("active");
      expect(events.onInterrupted).toHaveBeenCalledOnce();
      expect(native.play).toHaveBeenCalledOnce();
      handle.dispose();
      expect(native.appRemove).toHaveBeenCalledOnce();
      expect(native.statusRemove).toHaveBeenCalledOnce();
    },
  );

  it("does not start while backgrounded", async () => {
    native.appState.currentState = "background";
    const { handle, events } = setup();
    await expect(handle.play()).rejects.toThrow("foreground");
    expect(events.onInterrupted).toHaveBeenCalledOnce();
    expect(native.mode).not.toHaveBeenCalled();
    expect(native.play).not.toHaveBeenCalled();
    handle.dispose();
  });

  it.each(["pause", "dispose"] as const)(
    "cancels pending audio-mode setup on %s",
    async (action) => {
      const mode = deferred();
      native.mode.mockReturnValue(mode.promise);
      const { handle, events } = setup();
      const playing = handle.play();
      await Promise.resolve();
      const rejected = expect(playing).rejects.toThrow("cancelled");
      handle[action]();
      mode.resolve();
      await rejected;
      expect(native.play).not.toHaveBeenCalled();
      expect(events.onError).not.toHaveBeenCalled();
      handle.dispose();
    },
  );

  it("stops native automatic recovery after media-services reset", async () => {
    native.play.mockImplementation(() => emit({ playing: true }));
    const { handle, events } = setup();
    await handle.play();
    emit({ mediaServicesDidReset: true });
    expect(events.onInterrupted).toHaveBeenCalledOnce();
    const pauses = native.pause.mock.calls.length;
    emit({ playing: true });
    expect(native.pause.mock.calls.length).toBe(pauses + 1);
    handle.dispose();
  });

  it("reports native errors and end-of-file without leaking after disposal", async () => {
    native.play.mockImplementation(() => emit({ playing: true }));
    const { handle, events } = setup();
    await handle.play();
    emit({ didJustFinish: true });
    expect(events.onEnded).toHaveBeenCalledOnce();
    handle.dispose();
    handle.dispose();
    emit({ error: "private native error" });
    native.emitApp("background");
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onInterrupted).not.toHaveBeenCalled();
    expect(native.release).toHaveBeenCalledOnce();
    expect(native.delete).toHaveBeenCalledOnce();
  });

  it("rejects decoder errors while waiting for native playback", async () => {
    const called = deferred();
    native.play.mockImplementation(called.resolve);
    const { handle, events } = setup();
    const playing = handle.play();
    await called.promise;
    const rejected = expect(playing).rejects.toThrow("playback failed");
    emit({ error: "decoder failed" });
    await rejected;
    expect(events.onError).toHaveBeenCalledOnce();
    handle.dispose();
  });

  it("bounds a native start that never reports success", async () => {
    vi.useFakeTimers();
    const { handle, events } = setup();
    const playing = handle.play();
    const rejected = expect(playing).rejects.toThrow("did not start");
    await vi.advanceTimersByTimeAsync(NATIVE_REPLY_AUDIO_START_TIMEOUT_MS);
    await rejected;
    expect(events.onError).toHaveBeenCalledOnce();
    handle.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deletes a partial file if writing fails", () => {
    native.write.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(setup).toThrow("disk full");
    expect(native.delete).toHaveBeenCalledOnce();
    expect(native.createPlayer).not.toHaveBeenCalled();
  });

  it("does not delete a file it failed to create exclusively", () => {
    native.create.mockImplementation(() => {
      throw new Error("already exists");
    });
    expect(setup).toThrow("already exists");
    expect(native.delete).not.toHaveBeenCalled();
  });

  it("deletes the owned file if player creation or release fails", () => {
    native.createPlayer.mockImplementationOnce(() => {
      throw new Error("missing native module");
    });
    expect(setup).toThrow("missing native module");
    expect(native.delete).toHaveBeenCalledOnce();
    const { handle } = setup();
    native.release.mockImplementation(() => {
      throw new Error("release");
    });
    expect(() => handle.dispose()).toThrow("release");
    expect(native.delete).toHaveBeenCalledTimes(2);
  });
});

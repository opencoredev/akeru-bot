import { DEFAULT_DICTATION_LIMITS } from "@t3tools/client-runtime/dictation";
import type { RecordingStatus } from "expo-audio";
import type { AppStateStatus } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  granted: true,
  listenerFails: false,
  mode: vi.fn(async (_mode: unknown) => {}),
  prepare: vi.fn(async (_options: unknown) => {}),
  record: vi.fn(),
  stop: vi.fn(async () => {}),
  release: vi.fn(),
  deleted: [] as string[],
  size: 4,
  isRecording: false,
  emitStatus: (_status: RecordingStatus) => {},
  emitApp: (_state: AppStateStatus) => {},
  statusRemove: vi.fn(),
  appRemove: vi.fn(),
}));
vi.mock("expo-audio", () => ({
  AudioQuality: { MEDIUM: 64 },
  IOSOutputFormat: { MPEG4AAC: "aac " },
  requestRecordingPermissionsAsync: async () => ({ granted: native.granted }),
  setAudioModeAsync: native.mode,
  AudioModule: {
    AudioRecorder: class {
      uri: string | null = null;
      get isRecording() {
        return native.isRecording;
      }
      addListener(_event: string, listener: typeof native.emitStatus) {
        if (native.listenerFails) throw new Error("listener registration failed");
        native.emitStatus = listener;
        return { remove: native.statusRemove };
      }
      prepareToRecordAsync(options: unknown) {
        this.uri = "file:///cache/recording.m4a";
        return native.prepare(options);
      }
      record() {
        native.isRecording = true;
        native.record();
      }
      async stop() {
        native.isRecording = false;
        await native.stop();
      }
      release() {
        native.release();
      }
    },
  },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists() {
      return !native.deleted.includes(this.uri);
    }
    get size() {
      return native.size;
    }
    async bytes() {
      return new Uint8Array([1, 2, 3, 4]);
    }
    delete() {
      native.deleted.push(this.uri);
    }
  },
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: typeof native.emitApp) => {
      native.emitApp = listener;
      return { remove: native.appRemove };
    },
  },
}));

import { DICTATION_RECORDING, startExpoDictationCapture } from "./expoDictationCapture";

function start(signal = new AbortController().signal) {
  const onError = vi.fn();
  return {
    onError,
    capture: startExpoDictationCapture({ signal, limits: DEFAULT_DICTATION_LIMITS, onError }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.granted = true;
  native.listenerFails = false;
  native.deleted = [];
  native.size = 4;
  native.isRecording = false;
});

describe("startExpoDictationCapture", () => {
  it("records mono AAC and returns owned bytes, then deletes the file on dispose", async () => {
    const capture = await start().capture;
    expect(native.prepare).toHaveBeenCalledWith(DICTATION_RECORDING);
    expect(native.mode).toHaveBeenCalledWith(expect.objectContaining({ allowsRecording: true }));
    expect(native.record).toHaveBeenCalledTimes(1);
    const audio = await capture.stop();
    expect(audio).toMatchObject({ mediaType: "audio/mp4", bytes: new Uint8Array([1, 2, 3, 4]) });
    capture.dispose();
    capture.dispose();
    expect(native.deleted).toEqual(["file:///cache/recording.m4a"]);
    expect(native.release).toHaveBeenCalledTimes(1);
    expect(native.mode).toHaveBeenLastCalledWith({ allowsRecording: false });
  });

  it("leaves recording mode when recorder setup fails", async () => {
    native.listenerFails = true;
    await expect(start().capture).rejects.toThrow("listener registration failed");
    expect(native.release).toHaveBeenCalledTimes(1);
    expect(native.mode).toHaveBeenLastCalledWith({ allowsRecording: false });
  });

  it("explains a denied permission without creating a recorder", async () => {
    native.granted = false;
    await expect(start().capture).rejects.toThrow("Microphone permission was denied");
    expect(native.prepare).not.toHaveBeenCalled();
  });

  it("ends the capture when the app leaves the foreground or the recorder fails", async () => {
    const run = start();
    await run.capture;
    native.emitApp("background");
    native.emitStatus({
      id: "1",
      isFinished: false,
      hasError: true,
      error: "Input lost",
      url: null,
    });
    expect(run.onError).toHaveBeenCalledTimes(2);
    expect(run.onError.mock.calls[1]![0]).toEqual(new Error("Input lost"));
  });

  it("stops recording and cleans up when aborted", async () => {
    const controller = new AbortController();
    await start(controller.signal).capture;
    controller.abort();
    await vi.waitFor(() => expect(native.release).toHaveBeenCalledTimes(1));
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(native.deleted).toEqual(["file:///cache/recording.m4a"]);
    expect(native.statusRemove).toHaveBeenCalled();
    expect(native.appRemove).toHaveBeenCalled();
  });

  it("rejects a recording over the upload limit", async () => {
    native.size = DEFAULT_DICTATION_LIMITS.maxAudioBytes + 1;
    const capture = await start().capture;
    await expect(capture.stop()).rejects.toThrow("too long");
  });
});

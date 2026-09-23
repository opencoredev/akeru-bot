import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { captureVoiceUtterance, playVoiceAudio } from "./browserVoiceAudio";

let level = 0;
let latestRecorder: TestRecorder;
const closeContext = vi.fn(async () => {});
const disconnectSource = vi.fn();
class TestRecorder {
  static isTypeSupported(type: string) {
    return type.startsWith("audio/webm");
  }
  readonly mimeType = "audio/webm;codecs=opus";
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  starts = 0;
  constructor() {
    latestRecorder = this;
  }
  start() {
    this.state = "recording";
    this.starts += 1;
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}
const track = { enabled: false };
const microphone = { getAudioTracks: () => [track] } as unknown as MediaStream;

beforeEach(() => {
  vi.clearAllMocks();
  level = 0;
  track.enabled = false;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  vi.stubGlobal("MediaRecorder", TestRecorder);
  vi.stubGlobal(
    "AudioContext",
    class {
      createMediaStreamSource() {
        return { connect() {}, disconnect: disconnectSource };
      }
      createAnalyser() {
        return {
          fftSize: 2048,
          getFloatTimeDomainData(samples: Float32Array) {
            samples.fill(level);
          },
        };
      }
      async resume() {}
      close = closeContext;
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded browser voice capture", () => {
  it("captures automatically and stops after speech followed by silence, disabling the mic between utterances", async () => {
    const capture = captureVoiceUtterance(microphone, new AbortController().signal);
    expect(track.enabled).toBe(true);
    level = 0.1;
    vi.advanceTimersByTime(100);
    level = 0;
    vi.advanceTimersByTime(900);
    await expect(capture).resolves.toEqual({ audioBase64: btoa("audio"), mimeType: "audio/webm" });
    expect(track.enabled).toBe(false);
    expect(closeContext).toHaveBeenCalledOnce();
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds continuous speech to twenty seconds", async () => {
    level = 0.1;
    const capture = captureVoiceUtterance(microphone, new AbortController().signal);
    vi.advanceTimersByTime(20_000);
    await expect(capture).resolves.toMatchObject({ mimeType: "audio/webm" });
    expect(latestRecorder.state).toBe("inactive");
  });

  it("discards bounded silence rather than sending empty recordings and cleans up on cancellation", async () => {
    const controller = new AbortController();
    const capture = captureVoiceUtterance(microphone, controller.signal);
    const stopped = expect(capture).rejects.toMatchObject({ name: "AbortError" });
    vi.advanceTimersByTime(40_000);
    expect(latestRecorder.starts).toBe(3);
    controller.abort();
    await stopped;
    expect(latestRecorder.state).toBe("inactive");
    expect(track.enabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports unavailable native/browser recording instead of claiming audio support", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    await expect(captureVoiceUtterance(microphone, new AbortController().signal)).rejects.toThrow(
      "unavailable on this client",
    );
  });
});

describe("browser voice playback", () => {
  it.each(["ended", "abort"])("waits for %s and revokes the audio URL", async (completion) => {
    class Speaker extends EventTarget {
      src = "";
      play = vi.fn(async () => {});
      pause = vi.fn();
      removeAttribute = vi.fn();
    }
    const speaker = new Speaker();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const controller = new AbortController();
    const playing = playVoiceAudio(
      speaker as unknown as HTMLAudioElement,
      { audioBase64: "YQ==", mimeType: "audio/mpeg" },
      controller.signal,
    );
    const settled =
      completion === "abort"
        ? expect(playing).rejects.toMatchObject({ name: "AbortError" })
        : expect(playing).resolves.toBeUndefined();
    expect(speaker.pause).not.toHaveBeenCalled();
    if (completion === "abort") controller.abort();
    else speaker.dispatchEvent(new Event("ended"));
    await settled;
    expect(revoke).toHaveBeenCalledWith(speaker.src);
    expect(speaker.pause).toHaveBeenCalledOnce();
    revoke.mockRestore();
  });
});

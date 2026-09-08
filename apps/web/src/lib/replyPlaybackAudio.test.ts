import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createBrowserReplyAudio, MAX_REPLY_AUDIO_BYTES } from "./replyPlaybackAudio";

class TestAudio extends EventTarget {
  preload = "";
  src = "";
  ended = false;
  play = vi.fn(async () => {});
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
}
function setup() {
  const audio = new TestAudio();
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { hidden: false });
  const revoke = vi.fn();
  vi.stubGlobal("Audio", function Audio() {
    return audio;
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
  const events = { onEnded: vi.fn(), onError: vi.fn(), onInterrupted: vi.fn() };
  return { audio, browser, document, revoke, events };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser reply media", () => {
  it("plays, pauses and releases its object URL exactly once", async () => {
    const { audio, events, revoke } = setup();
    const handle = createBrowserReplyAudio(new Blob(["fixture"], { type: "audio/wav" }), events);
    await handle.play();
    handle.pause();
    audio.dispatchEvent(new Event("pause"));
    expect(events.onInterrupted).not.toHaveBeenCalled();
    handle.dispose();
    handle.dispose();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:fixture");
    await expect(handle.play()).rejects.toThrow("released");
  });
  it("forwards completion, failure, device interruption and page lifecycle", async () => {
    const { audio, browser, document, events } = setup();
    const handle = createBrowserReplyAudio(new Blob(["fixture"], { type: "audio/wav" }), events);
    await handle.play();
    audio.dispatchEvent(new Event("ended"));
    audio.dispatchEvent(new Event("error"));
    audio.dispatchEvent(new Event("pause"));
    browser.dispatchEvent(new Event("pagehide"));
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(events.onEnded).toHaveBeenCalledOnce();
    expect(events.onError).toHaveBeenCalledOnce();
    expect(events.onInterrupted).toHaveBeenCalledTimes(3);
    handle.dispose();
    browser.dispatchEvent(new Event("pagehide"));
    audio.dispatchEvent(new Event("error"));
    expect(events.onInterrupted).toHaveBeenCalledTimes(3);
    expect(events.onError).toHaveBeenCalledOnce();
  });
  it.each([
    new Blob([], { type: "audio/wav" }),
    new Blob(["not audio"], { type: "text/plain" }),
    new Blob([new Uint8Array(MAX_REPLY_AUDIO_BYTES + 1)], { type: "audio/wav" }),
  ])("rejects unusable or oversized media before creating an object URL", (blob) => {
    const { events } = setup();
    expect(() => createBrowserReplyAudio(blob, events)).toThrow("playback limit");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

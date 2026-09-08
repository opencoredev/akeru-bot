import { describe, expect, it, vi } from "vite-plus/test";

import {
  createNativeReplyAudioHandle,
  type NativeReplyAudioEvent,
  type NativeReplyAudioPlayer,
} from "./nativeReplyAudio";

function setup() {
  let listener: (event: NativeReplyAudioEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const player = {
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    dispose: vi.fn(),
    subscribe: vi.fn((next: typeof listener) => {
      listener = next;
      return unsubscribe;
    }),
  } satisfies NativeReplyAudioPlayer;
  const callbacks = {
    onEnded: vi.fn(),
    onError: vi.fn(),
    onInterrupted: vi.fn(),
  };
  const handle = createNativeReplyAudioHandle(player, callbacks);
  return {
    player,
    callbacks,
    handle,
    unsubscribe,
    emit: (event: NativeReplyAudioEvent) => listener(event),
  };
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

describe("createNativeReplyAudioHandle", () => {
  it("delegates playback and supports pause/resume without recreating the player", async () => {
    const { handle, player, callbacks } = setup();
    const first = handle.play();
    expect(handle.play()).toBe(first);
    await first;
    expect(player.play).toHaveBeenCalledTimes(1);
    handle.pause();
    handle.pause();
    expect(player.pause).toHaveBeenCalledTimes(1);
    await handle.play();
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(callbacks.onInterrupted).not.toHaveBeenCalled();
    expect(callbacks.onEnded).not.toHaveBeenCalled();
  });

  it("waits for native playback to start", async () => {
    const { handle, player } = setup();
    const start = deferred();
    player.play.mockReturnValue(start.promise);
    const completed = vi.fn();
    const playing = handle.play().then(completed);
    await Promise.resolve();
    expect(player.play).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    start.resolve();
    await playing;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("only reports end once and requires a new handle for replay", async () => {
    const { handle, emit, callbacks } = setup();
    emit("ended");
    expect(callbacks.onEnded).not.toHaveBeenCalled();
    await handle.play();
    emit("ended");
    emit("ended");
    emit("error");
    expect(callbacks.onEnded).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
    await expect(handle.play()).rejects.toThrow("ended");
  });

  it("pauses on native interruption and never automatically resumes", async () => {
    const { handle, player, emit, callbacks } = setup();
    await handle.play();
    emit("interrupted");
    emit("interrupted");
    emit("ended");
    expect(player.pause).toHaveBeenCalledOnce();
    expect(callbacks.onInterrupted).toHaveBeenCalledOnce();
    expect(callbacks.onEnded).not.toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledOnce();
    await handle.play();
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it("reports native load errors even before play and deduplicates failures", async () => {
    const { handle, emit, callbacks, player } = setup();
    emit("error");
    emit("error");
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(player.pause).toHaveBeenCalledOnce();
    await expect(handle.play()).rejects.toThrow("failed");
  });

  it.each([false, true])("reports a native play failure (synchronous: %s)", async (synchronous) => {
    const { handle, player, callbacks, emit } = setup();
    const error = new Error("native failure");
    player.play.mockImplementation(() => {
      if (synchronous) throw error;
      return Promise.reject(error);
    });
    await expect(handle.play()).rejects.toBe(error);
    emit("error");
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(player.pause).toHaveBeenCalledOnce();
  });

  it.each(["pause", "dispose"] as const)("cancels a queued start on %s", async (action) => {
    const { handle, player } = setup();
    const playing = handle.play();
    handle[action]();
    await playing;
    expect(player.play).not.toHaveBeenCalled();
  });

  it("does not let a stale start failure affect resumed playback", async () => {
    const { handle, player, callbacks } = setup();
    const start = deferred();
    player.play.mockReturnValueOnce(start.promise);
    const oldPlay = handle.play();
    await Promise.resolve();
    handle.pause();
    await handle.play();
    const rejected = expect(oldPlay).rejects.toThrow("cancelled");
    start.reject(new Error("cancelled"));
    await rejected;
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(player.pause).toHaveBeenCalledOnce();
  });

  it("releases the player once and ignores late events and start failures", async () => {
    const { handle, player, emit, callbacks, unsubscribe } = setup();
    const start = deferred();
    player.play.mockReturnValue(start.promise);
    const playing = handle.play();
    await Promise.resolve();
    handle.dispose();
    handle.dispose();
    handle.pause();
    emit("ended");
    emit("error");
    emit("interrupted");
    const rejected = expect(playing).rejects.toThrow("released");
    start.reject(new Error("released"));
    await rejected;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(player.dispose).toHaveBeenCalledOnce();
    expect(callbacks.onEnded).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onInterrupted).not.toHaveBeenCalled();
    await expect(handle.play()).rejects.toThrow("disposed");
  });

  it("still releases native resources if listener removal throws", () => {
    const { handle, player, unsubscribe } = setup();
    unsubscribe.mockImplementation(() => {
      throw new Error("unsubscribe");
    });
    expect(() => handle.dispose()).toThrow("unsubscribe");
    handle.dispose();
    expect(player.dispose).toHaveBeenCalledOnce();
  });

  it("releases the player if subscription setup fails", () => {
    const { player, callbacks } = setup();
    player.subscribe.mockImplementation(() => {
      throw new Error("subscribe");
    });
    expect(() => createNativeReplyAudioHandle(player, callbacks)).toThrow("subscribe");
    expect(player.dispose).toHaveBeenCalledOnce();
  });
});

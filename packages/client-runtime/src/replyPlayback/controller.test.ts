import { describe, expect, it, vi } from "vite-plus/test";
import {
  createReplyPlaybackController,
  type ReplyAudioEvents,
  type ReplyPlaybackRequest,
} from "./controller.ts";

const identity = {
  environmentId: "remote",
  threadId: "chat",
  messageId: "reply",
  contentVersion: "v1",
  provider: "speech",
  voice: "voice",
};
const request: ReplyPlaybackRequest = { identity, text: "Stored reply", automatic: false };
const context = { ...identity, connected: true, mediaBlocked: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const handle = () => ({ play: vi.fn(async () => {}), pause: vi.fn(), dispose: vi.fn() });
  const handles: ReturnType<typeof handle>[] = [];
  const events: ReplyAudioEvents[] = [];
  const signals: AbortSignal[] = [];
  const prepare = vi.fn(
    async (_request: ReplyPlaybackRequest, signal: AbortSignal, next: ReplyAudioEvents) => {
      signals.push(signal);
      events.push(next);
      const audio = handle();
      handles.push(audio);
      return audio;
    },
  );
  const controller = createReplyPlaybackController(prepare);
  controller.setContext(context);
  return { controller, handles, events, signals, prepare, handle };
}

describe("reply playback ownership", () => {
  it("plays the supplied stored text, pauses, resumes, stops and replays", async () => {
    const { controller, prepare, handles } = setup();
    await controller.start(request);
    expect(prepare.mock.calls[0]?.[0]).toEqual(request);
    expect(controller.getSnapshot().status).toBe("playing");
    controller.pause();
    expect(controller.getSnapshot().status).toBe("paused");
    expect(handles[0]?.pause).toHaveBeenCalledOnce();
    await controller.resume();
    expect(handles[0]?.play).toHaveBeenCalledTimes(2);
    controller.stop();
    expect(handles[0]?.dispose).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toEqual({ status: "idle" });
    await controller.start(request);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("disposes late generation without playing it after replacement", async () => {
    const { controller, prepare, handle, signals } = setup();
    const pending = deferred<ReturnType<typeof handle>>();
    prepare.mockImplementationOnce(async (_request, signal) => {
      signals.push(signal);
      return pending.promise;
    });
    const first = controller.start(request);
    await controller.start({ ...request, identity: { ...identity, messageId: "second" } });
    expect(signals[0]?.aborted).toBe(true);
    const stale = handle();
    pending.resolve(stale);
    await first;
    expect(stale.play).not.toHaveBeenCalled();
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      status: "playing",
      identity: { messageId: "second" },
    });
  });

  it.each([
    { ...context, threadId: "elsewhere" },
    { ...context, environmentId: "another-server" },
    { ...context, provider: "other-provider" },
    { ...context, voice: "other-voice" },
    { ...context, connected: false },
    { ...context, mediaBlocked: true },
    null,
  ])("stops on navigation, settings, disconnect, call/dictation or logout: %j", async (next) => {
    const { controller, handles, signals } = setup();
    await controller.start(request);
    controller.setContext(next);
    expect(controller.getSnapshot().status).toBe("idle");
    expect(handles[0]?.dispose).toHaveBeenCalledOnce();
    expect(signals[0]?.aborted).toBe(true);
    await controller.start(request);
    expect(controller.getSnapshot().status).toBe("idle");
  });

  it("invalidates edited or deleted content and ignores stale callbacks", async () => {
    const { controller, events, handles } = setup();
    await controller.start(request);
    controller.reconcileMessages(new Map([[identity.messageId, "edited"]]));
    expect(handles[0]?.dispose).toHaveBeenCalledOnce();
    await controller.start({ ...request, identity: { ...identity, contentVersion: "edited" } });
    events[0]?.onEnded();
    events[0]?.onError();
    expect(controller.getSnapshot().status).toBe("playing");
    controller.reconcileMessages(new Map());
    expect(controller.getSnapshot().status).toBe("idle");
  });

  it("exposes safe retry after generation failure without leaking the error", async () => {
    const { controller, prepare } = setup();
    prepare.mockRejectedValueOnce(new Error("secret credential and private transcript"));
    await controller.start(request);
    expect(controller.getSnapshot()).toEqual({
      status: "error",
      identity,
      automatic: false,
      error: "generation",
    });
    await controller.retry();
    expect(controller.getSnapshot().status).toBe("playing");
  });

  it("releases failed autoplay audio and offers an explicit retry", async () => {
    const { controller, prepare, handle } = setup();
    const audio = handle();
    audio.play.mockRejectedValueOnce(new Error("NotAllowedError"));
    prepare.mockResolvedValueOnce(audio);
    await controller.start(request);
    expect(controller.getSnapshot()).toMatchObject({ status: "error", error: "playback" });
    expect(audio.dispose).toHaveBeenCalledOnce();
    await controller.retry();
    expect(controller.getSnapshot().status).toBe("playing");
  });

  it("still goes idle when native disposal throws", async () => {
    const { controller, handles } = setup();
    await controller.start(request);
    handles[0]?.dispose.mockImplementation(() => {
      throw new Error("Native player already released.");
    });
    controller.stop();
    expect(controller.getSnapshot()).toEqual({ status: "idle" });
  });

  it.each(["onEnded", "onInterrupted"] as const)("releases media on %s", async (event) => {
    const { controller, events, handles } = setup();
    await controller.start(request);
    events[0]?.[event]();
    expect(controller.getSnapshot().status).toBe("idle");
    expect(handles[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("disabling automatic readout stops only automatic playback", async () => {
    const { controller } = setup();
    await controller.start({ ...request, automatic: true });
    controller.disableAutomaticReadout();
    expect(controller.getSnapshot().status).toBe("idle");
    await controller.start(request);
    controller.disableAutomaticReadout();
    expect(controller.getSnapshot().status).toBe("playing");
  });

  it("cancels pending resume and rejects playback after disposal", async () => {
    const { controller, handles } = setup();
    await controller.start(request);
    controller.pause();
    const pending = deferred<void>();
    handles[0]?.play.mockReturnValueOnce(pending.promise);
    const resume = controller.resume();
    controller.dispose();
    pending.resolve();
    await resume;
    await controller.start(request);
    expect(controller.getSnapshot().status).toBe("idle");
  });
});

import { describe, expect, it, vi } from "vite-plus/test";
import { STORED_REPLY_SYNTHESIS_UNAVAILABLE } from "./capability.ts";
import { createReplyPlaybackSession } from "./session.ts";

const message = {
  id: "reply-1",
  role: "assistant" as const,
  streaming: false,
  text: "**Stored** answer",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const later = { ...message, id: "reply-2", updatedAt: "2026-09-08T00:01:00.000Z" };
const history = { ...message, id: "old", updatedAt: "2026-09-07T00:00:00.000Z" };
const context = {
  environmentId: "environment",
  threadId: "thread",
  provider: "unavailable",
  voice: "unavailable",
  connected: true,
  mediaBlocked: false,
};

function setup(available = false) {
  const prepare = vi.fn(async () => ({
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    dispose: vi.fn(),
  }));
  const session = available
    ? createReplyPlaybackSession({
        storage: { getItem: async () => "true", setItem: async () => {} },
        prepare,
        synthesis: { available: true, provider: "speech", voice: "voice" },
      })
    : createReplyPlaybackSession({
        storage: { getItem: async () => "true", setItem: async () => {} },
        prepare,
      });
  session.setContext(available ? { ...context, provider: "speech", voice: "voice" } : context);
  return { session, prepare };
}

describe("reply playback session", () => {
  it("exposes settled assistant readout without starting a turn", () => {
    const { session, prepare } = setup();
    expect(session.actionFor(message)).toMatchObject({
      request: { text: "Stored answer", automatic: false },
      unavailableReason: STORED_REPLY_SYNTHESIS_UNAVAILABLE,
    });
    expect(session.actionFor({ ...message, role: "user" })).toBeNull();
    expect(session.actionFor({ ...message, streaming: true })).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("hydrates history and loaded-earlier replies without automatic playback", async () => {
    const { session, prepare } = setup(true);
    await session.preference.load();
    session.observe([message]);
    session.observe([history, message]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("reads a newly completed reply once after opt-in, then stops when disabled", async () => {
    const { session, prepare } = setup(true);
    await session.preference.load();
    session.observe([message]);
    session.observe([message, later]);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        automatic: true,
        identity: expect.objectContaining({ messageId: "reply-2" }),
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    await session.preference.setEnabled(false);
    session.observe([
      message,
      later,
      { ...later, id: "reply-3", updatedAt: "2026-09-08T00:02:00.000Z" },
    ]);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("does not replay after reconnect on the same chat", async () => {
    const { session, prepare } = setup(true);
    await session.preference.load();
    session.observe([message]);
    session.observe([message, later]);
    session.setContext({ ...context, provider: "speech", voice: "voice", connected: false });
    session.setContext({ ...context, provider: "speech", voice: "voice", connected: true });
    session.observe([message, later]);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("clears only the owning chat so a stacked route can restore the revealed one", async () => {
    const { session } = setup(true);
    session.setContext({ ...context, threadId: "other", provider: "speech", voice: "voice" });
    await session.controller.start({
      identity: {
        ...context,
        threadId: "other",
        provider: "speech",
        voice: "voice",
        messageId: "reply-1",
        contentVersion: message.updatedAt,
      },
      text: "Stored answer",
      automatic: false,
    });
    session.clearContextIf(context.environmentId, context.threadId);
    expect(session.controller.getSnapshot()).toMatchObject({
      status: "playing",
      identity: { threadId: "other" },
    });
    session.clearContextIf(context.environmentId, "other");
    expect(session.controller.getSnapshot().status).toBe("idle");
  });

  it("stops playback when the active chat changes", async () => {
    const { session } = setup(true);
    await session.controller.start({
      identity: {
        ...context,
        provider: "speech",
        voice: "voice",
        messageId: "reply-1",
        contentVersion: message.updatedAt,
      },
      text: "Stored answer",
      automatic: false,
    });
    session.setContext({ ...context, threadId: "other", provider: "speech", voice: "voice" });
    expect(session.controller.getSnapshot().status).toBe("idle");
  });
});

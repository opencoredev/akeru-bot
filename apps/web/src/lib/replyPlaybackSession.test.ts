import { describe, expect, it, vi } from "vite-plus/test";
import { createWebReplyPlaybackSession } from "./replyPlaybackSession";

describe("web reply playback synthesis", () => {
  it("uses the configured synthesis capability", () => {
    const session = createWebReplyPlaybackSession({
      environmentId: "environment" as never,
      voice: {
        enabled: true,
        provider: "composed",
        synthesisProvider: "openai",
        synthesisVoices: { openai: "alloy" },
      },
      synthesize: vi.fn(),
      cancel: vi.fn(),
    });
    expect(session.synthesisFor("environment")).toEqual({
      available: true,
      provider: "openai",
      voice: "alloy",
    });
    session.dispose();
  });

  it("uses the server defaults when provider and voice are omitted", () => {
    const session = createWebReplyPlaybackSession({
      environmentId: "environment" as never,
      voice: { enabled: true, provider: "composed" },
      synthesize: vi.fn(),
      cancel: vi.fn(),
    });
    expect(session.synthesisFor("environment")).toEqual({
      available: true,
      provider: "openai",
      voice: "alloy",
    });
    session.dispose();
  });

  it("leaves replies from another environment unavailable", async () => {
    const synthesize = vi.fn();
    const session = createWebReplyPlaybackSession({
      environmentId: "primary" as never,
      voice: { enabled: true, provider: "composed" },
      synthesize,
      cancel: vi.fn(),
    });
    expect(session.synthesisFor("remote")).toMatchObject({ available: false });
    expect(session.synthesisFor("primary")).toMatchObject({ available: true });
    session.dispose();
  });

  it("keeps other environments unavailable after a voice change", () => {
    let voice: { enabled: boolean; provider: "composed"; synthesisVoices?: { openai: string } } = {
      enabled: true,
      provider: "composed",
    };
    const session = createWebReplyPlaybackSession({
      environmentId: "primary" as never,
      voice: () => voice as never,
      synthesize: vi.fn(),
      cancel: vi.fn(),
    });
    const listener = vi.fn();
    session.subscribeSynthesis(listener);
    voice = { ...voice, synthesisVoices: { openai: "nova" } };
    session.setContext({ environmentId: "primary", threadId: "thread" } as never);
    const before = session.getSynthesisSnapshot();
    expect(session.getSynthesisSnapshot()).toBe(before);
    session.refreshSynthesis();
    expect(listener).toHaveBeenCalledOnce();
    expect(session.getSynthesisSnapshot()).toMatchObject({ voice: "nova" });
    expect(session.synthesisFor("primary")).toMatchObject({ available: true, voice: "nova" });
    expect(session.synthesisFor("remote")).toMatchObject({ available: false });
    session.dispose();
  });
});

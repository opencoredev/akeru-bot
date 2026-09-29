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
});

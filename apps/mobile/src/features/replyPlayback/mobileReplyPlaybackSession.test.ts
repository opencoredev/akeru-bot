import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@akeru/contracts";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => {}),
}));
vi.mock("./expoReplyAudio", () => ({
  createExpoReplyAudio: vi.fn((bytes: Uint8Array, mimeType: string) => ({
    uri: `bytes:${bytes.byteLength}:${mimeType}`,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    dispose: vi.fn(),
  })),
}));

import { createMobileReplyPlaybackSession } from "./mobileReplyPlaybackSession";

const events = {
  onEnded: () => {},
  onError: () => {},
  onInterrupted: () => {},
};

const request = (environmentId: string) => ({
  identity: {
    environmentId,
    threadId: "thread",
    messageId: "reply-1",
    contentVersion: "v1",
    provider: "speech",
    voice: "voice",
  },
  text: "Stored answer",
  automatic: false,
});

describe("mobile reply playback session", () => {
  it("resolves the synthesis capability for the requesting environment", () => {
    const session = createMobileReplyPlaybackSession({
      synthesize: vi.fn(),
      cancel: vi.fn(),
      voiceSettings: (environmentId) =>
        environmentId === "environment"
          ? {
              enabled: true,
              provider: "composed",
              synthesisProvider: "openai",
              synthesisVoices: { openai: "alloy" },
            }
          : { enabled: false },
    });
    expect(session.synthesisFor("environment")).toEqual({
      available: true,
      provider: "openai",
      voice: "alloy",
    });
    expect(session.synthesisFor("other").available).toBe(false);
    session.dispose();
  });

  it("prepares audio against the environment on the request, not a route", async () => {
    const synthesize = vi.fn(async () => ({
      _tag: "Success" as const,
      value: {
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mimeType: "audio/mpeg",
      },
    }));
    const cancel = vi.fn(async () => ({}));
    const session = createMobileReplyPlaybackSession({
      synthesize,
      cancel,
      voiceSettings: () => ({}),
    });
    // Drive prepare through the controller's start path.
    session.setContext({
      environmentId: "environment",
      threadId: "thread",
      provider: "speech",
      voice: "voice",
      connected: true,
      mediaBlocked: false,
    });
    await session.controller.start(request("environment"));
    expect(synthesize).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment"),
      input: expect.objectContaining({ text: "Stored answer" }),
    });
    session.dispose();
  });
});

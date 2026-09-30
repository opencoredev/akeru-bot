import { describe, expect, it } from "vite-plus/test";
import { storedReplySynthesisCapability } from "@akeru/client-runtime/reply-playback";

describe("mobile reply playback synthesis", () => {
  it("accepts a configured provider capability for native playback", () => {
    expect(
      storedReplySynthesisCapability({
        enabled: true,
        provider: "composed",
        synthesisProvider: "elevenlabs",
        synthesisVoices: { elevenlabs: "voice-1" },
      }),
    ).toEqual({ available: true, provider: "elevenlabs", voice: "voice-1" });
  });

  it("uses the server defaults when provider and voice are omitted", () => {
    expect(storedReplySynthesisCapability({ enabled: true, provider: "composed" })).toEqual({
      available: true,
      provider: "openai",
      voice: "alloy",
    });
  });
});

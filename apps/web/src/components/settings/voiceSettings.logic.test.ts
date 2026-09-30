import { DEFAULT_SERVER_SETTINGS, VoiceCallError } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_SYNTHESIS_PROVIDERS,
  VOICE_TRANSCRIPTION_PROVIDERS,
  nextVoiceKeyRejected,
  selectedSynthesisVoice,
  voiceCapabilityLabel,
  voiceSetupProblem,
} from "./voiceSettings.logic";

const base = DEFAULT_SERVER_SETTINGS.voice;

describe("voice settings logic", () => {
  it("only offers providers for the capability they have", () => {
    expect(VOICE_TRANSCRIPTION_PROVIDERS).toEqual(["openai", "elevenlabs", "cartesia"]);
    expect(VOICE_SYNTHESIS_PROVIDERS).toEqual(["openai", "elevenlabs", "cartesia", "fish"]);
    expect(voiceCapabilityLabel("openai")).toBe(
      "Live calls with interruption · Transcription · Speech",
    );
    expect(voiceCapabilityLabel("fish")).toBe("Speech");
    expect(voiceCapabilityLabel("elevenlabs")).not.toContain("interruption");
  });

  it("never asks the ChatGPT subscription path for an API key", () => {
    expect(voiceSetupProblem(base, [])).toBeNull();
  });

  it("names every missing key without suggesting a fallback provider", () => {
    const composed = {
      ...base,
      provider: "composed" as const,
      transcriptionProvider: "cartesia" as const,
      synthesisProvider: "fish" as const,
      synthesisVoices: { fish: "fish-voice" },
    };
    expect(voiceSetupProblem(composed, ["openai"])).toBe(
      "Connect Cartesia and Fish Audio under API connections before starting a call. Akeru will not switch to another provider or billing source.",
    );
    expect(voiceSetupProblem(composed, ["cartesia", "fish"])).toBeNull();
    expect(voiceSetupProblem({ ...base, provider: "openai" }, [])).toContain("OpenAI API");
    expect(voiceSetupProblem({ ...base, provider: "openai" }, null)).toBeNull();
  });

  it("requires a voice for account-specific speech providers", () => {
    const composed = {
      ...base,
      provider: "composed" as const,
      transcriptionProvider: "openai" as const,
      synthesisProvider: "elevenlabs" as const,
    };
    expect(selectedSynthesisVoice(composed)).toBeUndefined();
    expect(voiceSetupProblem(composed, ["openai", "elevenlabs"])).toBe(
      "Choose a voice for ElevenLabs before starting a call.",
    );
    expect(selectedSynthesisVoice({ ...composed, synthesisProvider: "openai" })).toBe("alloy");
  });

  it("marks a key rejected after a failed test and clears it when the key is replaced", () => {
    const auth = new VoiceCallError({ reason: "provider-auth", message: "rejected" });
    const network = new VoiceCallError({ reason: "network", message: "offline" });
    const rejected = nextVoiceKeyRejected(false, auth);
    expect(rejected).toBe(true);
    // A network failure says nothing new about the key.
    expect(nextVoiceKeyRejected(rejected, network)).toBe(true);
    expect(nextVoiceKeyRejected(false, network)).toBe(false);
    // Saving a replacement key, a passing test, or disconnecting all succeed.
    expect(nextVoiceKeyRejected(rejected, null)).toBe(false);
  });
});

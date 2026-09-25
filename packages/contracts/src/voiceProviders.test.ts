import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  VoiceSettings,
  VoiceCallStartInput,
  VoiceCallStartResult,
  VoiceTranscribeInput,
  VoiceSynthesizeInput,
  VoiceConnectInput,
  VOICE_AUDIO_MAX_BYTES,
  VOICE_PROVIDER_CAPABILITIES,
  voiceMissingApiProviders,
  voiceRequiredApiProviders,
} from "./voiceCall.ts";
import { ServerSettingsPatch } from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(VoiceSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeStart = Schema.decodeUnknownSync(VoiceCallStartInput);
const decodeResult = Schema.decodeUnknownSync(VoiceCallStartResult);
const isSettings = Schema.is(VoiceSettings);
const isTranscribe = Schema.is(VoiceTranscribeInput);
const isSynthesize = Schema.is(VoiceSynthesizeInput);
const isConnect = Schema.is(VoiceConnectInput);
const isStart = Schema.is(VoiceCallStartInput);

describe("voice provider contracts", () => {
  it("preserves legacy ChatGPT settings unchanged", () => {
    const legacy = { enabled: true, provider: "chatgpt", voice: "alloy" };
    expect(decodeSettings(legacy)).toEqual(legacy);
    expect(decodeSettings({})).toEqual(legacy);
  });
  it("accepts explicit independent capability settings and retains every patch field", () => {
    const voice = {
      provider: "composed",
      openaiVoice: "marin",
      transcriptionProvider: "cartesia",
      synthesisProvider: "fish",
      synthesisVoices: {
        openai: "cedar",
        elevenlabs: "eleven-id",
        cartesia: "cartesia-id",
        fish: "fish-id",
      },
    };
    expect(decodePatch({ voice })).toEqual({ voice });
    expect(isSettings({ enabled: true, voice: "alloy", ...voice })).toBe(true);
    expect(
      isSettings({
        enabled: true,
        voice: "alloy",
        ...voice,
        transcriptionProvider: "fish",
      }),
    ).toBe(false);
  });
  it("supports composed starts without SDP", () => {
    expect(decodeStart({ botId: "bot" })).toEqual({
      botId: "bot",
    });
    const result = decodeResult({
      call: {
        callId: "call",
        botId: "bot",
        botName: "Akeru",
        status: "live",
        startedAt: "2026-08-27T00:00:00.000Z",
      },
      transport: "composed",
      settings: { provider: "composed" },
    });
    expect(result.transport).toBe("composed");
    expect(result.answerSdp).toBeUndefined();
  });
  it("bounds audio, text, keys, and SDP", () => {
    const input = { operationId: "operation", mimeType: "audio/wav", audioBase64: "YQ==" };
    expect(isTranscribe(input)).toBe(true);
    expect(
      isTranscribe({
        ...input,
        audioBase64: "A".repeat(4 * Math.floor(VOICE_AUDIO_MAX_BYTES / 3)),
      }),
    ).toBe(true);
    expect(isTranscribe({ ...input, mimeType: "text/html" })).toBe(false);
    expect(isTranscribe({ ...input, audioBase64: "not base64" })).toBe(false);
    expect(
      isTranscribe({
        ...input,
        audioBase64: "A".repeat(4 * Math.ceil(VOICE_AUDIO_MAX_BYTES / 3) + 4),
      }),
    ).toBe(false);
    expect(isSynthesize({ operationId: "operation", text: "x".repeat(4001) })).toBe(false);
    expect(isConnect({ provider: "openai", apiKey: "x".repeat(4097) })).toBe(false);
    expect(isStart({ botId: "bot", sdp: "x".repeat(65537) })).toBe(false);
  });
  it("derives capabilities and required keys without switching billing source", () => {
    expect(
      Object.entries(VOICE_PROVIDER_CAPABILITIES)
        .filter(([, capability]) => capability.realtime)
        .map(([provider]) => provider),
    ).toEqual(["openai"]);
    expect(VOICE_PROVIDER_CAPABILITIES.fish.transcription).toBe(false);
    const legacy = decodeSettings({});
    expect(voiceRequiredApiProviders(legacy)).toEqual([]);
    expect(voiceRequiredApiProviders({ ...legacy, provider: "openai" })).toEqual(["openai"]);
    const composed = {
      ...legacy,
      provider: "composed" as const,
      transcriptionProvider: "cartesia" as const,
      synthesisProvider: "fish" as const,
    };
    expect(voiceRequiredApiProviders(composed)).toEqual(["cartesia", "fish"]);
    expect(voiceRequiredApiProviders({ ...legacy, provider: "composed" })).toEqual(["openai"]);
    expect(voiceMissingApiProviders(composed, ["fish", "openai"])).toEqual(["cartesia"]);
    expect(voiceMissingApiProviders(composed, ["cartesia", "fish"])).toEqual([]);
  });
});

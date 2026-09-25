import {
  VOICE_API_PROVIDERS,
  VOICE_PROVIDER_CAPABILITIES,
  voiceMissingApiProviders,
  type VoiceApiProvider,
  type VoiceProvider,
  type VoiceSettings,
  type VoiceTranscriptionProvider,
} from "@t3tools/contracts";

export const VOICE_MODE_LABELS: Readonly<Record<VoiceProvider, string>> = {
  chatgpt: "ChatGPT subscription",
  openai: "OpenAI API realtime",
  composed: "Transcribe, reply, speak",
};

export const VOICE_MODE_DESCRIPTIONS: Readonly<Record<VoiceProvider, string>> = {
  chatgpt:
    "Live calls use the ChatGPT subscription connected to this environment. No API key is billed.",
  openai:
    "Live calls use your OpenAI API key and are billed to that API account. You can interrupt the bot while it speaks.",
  composed:
    "Each thing you say is transcribed, sent to the bot as a chat message, and the reply is spoken. Calls take turns and cannot be interrupted. Usage is billed to the API keys you choose.",
};

export const VOICE_API_PROVIDER_LABELS: Readonly<Record<VoiceApiProvider, string>> = {
  openai: "OpenAI API",
  elevenlabs: "ElevenLabs",
  cartesia: "Cartesia",
  fish: "Fish Audio",
};

/** The API product each key belongs to. Key labels read "{api} key", so "OpenAI API" never doubles up. */
export const VOICE_API_NAMES: Readonly<Record<VoiceApiProvider, string>> = {
  openai: "OpenAI API",
  elevenlabs: "ElevenLabs API",
  cartesia: "Cartesia API",
  fish: "Fish Audio API",
};

export const VOICE_TRANSCRIPTION_PROVIDERS = VOICE_API_PROVIDERS.filter(
  (provider): provider is VoiceTranscriptionProvider =>
    VOICE_PROVIDER_CAPABILITIES[provider].transcription,
);
export const VOICE_SYNTHESIS_PROVIDERS = VOICE_API_PROVIDERS.filter(
  (provider) => VOICE_PROVIDER_CAPABILITIES[provider].synthesis,
);

/** Plain-language list of what a provider can do in Akeru voice calls. */
export function voiceCapabilityLabel(provider: VoiceApiProvider): string {
  const capability = VOICE_PROVIDER_CAPABILITIES[provider];
  const parts = [
    capability.realtime ? "Live calls with interruption" : null,
    capability.transcription ? "Transcription" : null,
    capability.synthesis ? "Speech" : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
}

/** True when a voice command failed because the provider refused the saved key. */
export function voiceKeyWasRejected(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "provider-auth"
  );
}

/**
 * Whether a saved key should show as rejected after a connect, test, or disconnect.
 * `failure` is null on success. Any success clears the verdict, including saving a
 * replacement key; only a key rejection sets it, so a network error keeps the last verdict.
 */
export function nextVoiceKeyRejected(previous: boolean, failure: unknown): boolean {
  if (failure === null) return false;
  return voiceKeyWasRejected(failure) || previous;
}

/** Explains why a call cannot start with these settings, or null when it can. */
export function voiceSetupProblem(
  settings: VoiceSettings,
  connected: ReadonlyArray<VoiceApiProvider> | null,
): string | null {
  if (connected === null) return null;
  const missing = voiceMissingApiProviders(settings, connected);
  if (missing.length > 0) {
    const names = missing.map((provider) => VOICE_API_PROVIDER_LABELS[provider]).join(" and ");
    return `Connect ${names} under API connections before starting a call. Akeru will not switch to another provider or billing source.`;
  }
  if (settings.provider === "composed" && selectedSynthesisVoice(settings) === undefined) {
    const provider = VOICE_API_PROVIDER_LABELS[settings.synthesisProvider ?? "openai"];
    return `Choose a voice for ${provider} before starting a call.`;
  }
  return null;
}

/** The synthesis voice a call will use. OpenAI falls back to Alloy, as the server does. */
export function selectedSynthesisVoice(settings: VoiceSettings): string | undefined {
  const provider = settings.synthesisProvider ?? "openai";
  return settings.synthesisVoices?.[provider] ?? (provider === "openai" ? "alloy" : undefined);
}

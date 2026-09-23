export const STORED_REPLY_SYNTHESIS_UNAVAILABLE =
  "Stored-reply speech is unavailable. Connect a supported speech provider in Settings → Voice.";

export type StoredReplySynthesisCapability =
  | {
      readonly available: false;
      readonly provider: string;
      readonly voice: string;
      readonly reason: string;
    }
  | {
      readonly available: true;
      readonly provider: string;
      readonly voice: string;
    };

type VoiceSettingsSnapshot = {
  readonly enabled?: boolean;
  readonly provider?: string;
  readonly synthesisProvider?: string;
  readonly synthesisVoices?: Readonly<Record<string, string | undefined>>;
  readonly openaiVoice?: string;
};

/** Resolves stored-reply speech using the same defaults as the server synthesis path. */
export function storedReplySynthesisCapability(
  voice: VoiceSettingsSnapshot = {},
): StoredReplySynthesisCapability {
  if (voice.enabled === false) {
    return { available: false, provider: "unavailable", voice: "unavailable", reason: "Voice is disabled in Settings." };
  }
  if (voice.provider === undefined) {
    return {
      available: false,
      provider: "unavailable",
      voice: "unavailable",
      reason: STORED_REPLY_SYNTHESIS_UNAVAILABLE,
    };
  }
  if (voice.provider === "chatgpt") {
    return {
      available: false,
      provider: "chatgpt",
      voice: voice.openaiVoice ?? "unavailable",
      reason: STORED_REPLY_SYNTHESIS_UNAVAILABLE,
    };
  }
  const provider = voice.synthesisProvider ?? "openai";
  const selectedVoice = provider === "openai" ? (voice.synthesisVoices?.openai ?? voice.openaiVoice ?? "alloy") : provider ? voice.synthesisVoices?.[provider] : undefined;
  if (!provider || !selectedVoice) {
    return { available: false, provider: provider ?? "unavailable", voice: selectedVoice ?? "unavailable", reason: STORED_REPLY_SYNTHESIS_UNAVAILABLE };
  }
  return { available: true, provider, voice: selectedVoice };
}

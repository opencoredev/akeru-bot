import { createReplyPlaybackSession } from "@t3tools/client-runtime/reply-playback";
import { EnvironmentId } from "@t3tools/contracts";
import { storedReplySynthesisCapability } from "@t3tools/client-runtime/reply-playback";
import { createExpoReplyAudio } from "./expoReplyAudio";
import { synthesizeVoiceChunks } from "@t3tools/client-runtime/voice";
import { decodeReplyAudioBase64 } from "./base64";
import * as SecureStore from "expo-secure-store";

type VoiceSettings = Parameters<typeof storedReplySynthesisCapability>[0];

/** The session lives above the navigator, so per-environment state comes from
    the playback request identity instead of a navigation route. */
export function createMobileReplyPlaybackSession(options: {
  readonly synthesize: (target: {
    environmentId: EnvironmentId;
    input: { operationId: string; text: string };
  }) => Promise<{
    _tag: string;
    value?: { audioBase64: string; mimeType: string };
  }>;
  readonly cancel: (target: {
    environmentId: EnvironmentId;
    input: { operationId: string };
  }) => Promise<unknown>;
  readonly voiceSettings: (environmentId: string) => VoiceSettings;
}) {
  return createReplyPlaybackSession({
    storage: {
      getItem: async (key) => SecureStore.getItemAsync(key),
      setItem: async (key, value) => {
        await SecureStore.setItemAsync(key, value);
      },
    },
    synthesis: (environmentId) =>
      storedReplySynthesisCapability(options.voiceSettings(environmentId)),
    prepare: async (request, signal, events) => {
      const environmentId = EnvironmentId.make(request.identity.environmentId);
      const operationId = `voice-${Date.now()}-${Math.random()}`;
      const abort = () => {
        void options.cancel({ environmentId, input: { operationId } });
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const segments: Uint8Array[] = [];
        let mimeType = "audio/mpeg";
        const results = await synthesizeVoiceChunks(request.text, signal, (text) =>
          options.synthesize({ environmentId, input: { operationId, text } }),
        );
        for (const result of results) {
          if (result._tag !== "Success" || !result.value)
            throw new Error("Voice synthesis failed.");
          segments.push(decodeReplyAudioBase64(result.value.audioBase64));
          mimeType = result.value.mimeType;
        }
        const bytes = new Uint8Array(
          segments.reduce((total, segment) => total + segment.length, 0),
        );
        let offset = 0;
        for (const segment of segments) {
          bytes.set(segment, offset);
          offset += segment.length;
        }
        return createExpoReplyAudio(bytes, mimeType, events);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  });
}

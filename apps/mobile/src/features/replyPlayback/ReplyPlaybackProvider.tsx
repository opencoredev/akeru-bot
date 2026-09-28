import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  createReplyPlaybackSession,
  type ReplyPlaybackSession,
} from "@t3tools/client-runtime/reply-playback";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { storedReplySynthesisCapability } from "@t3tools/client-runtime/reply-playback";
import { useAtomValue } from "@effect/atom-react";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { useThreadSelection } from "../../state/use-thread-selection";
import { createExpoReplyAudio } from "./expoReplyAudio";
import { synthesizeVoiceChunks } from "@t3tools/client-runtime/voice";
import { decodeReplyAudioBase64 } from "./base64";
import * as SecureStore from "expo-secure-store";

const ReplyPlaybackContext = createContext<ReplyPlaybackSession | null>(null);

export function ReplyPlaybackProvider({ children }: { readonly children: ReactNode }) {
  const { selectedThread } = useThreadSelection();
  const environmentId = selectedThread?.environmentId ?? null;
  const settings =
    useAtomValue(
      serverEnvironment.settingsValueAtom(environmentId ?? EnvironmentId.make("none")),
    ) ?? DEFAULT_SERVER_SETTINGS;
  const synthesize = useAtomCommand(serverEnvironment.synthesizeVoice, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelVoice, { reportFailure: false });
  const session = useMemo(
    () =>
      createReplyPlaybackSession({
        storage: {
          getItem: async (key) => SecureStore.getItemAsync(key),
          setItem: async (key, value) => {
            await SecureStore.setItemAsync(key, value);
          },
        },
        synthesis: storedReplySynthesisCapability(settings.voice),
        prepare: async (request, signal, events) => {
          if (!environmentId) throw new Error("Voice synthesis is unavailable.");
          const operationId = `voice-${Date.now()}-${Math.random()}`;
          const abort = () => {
            void cancel({ environmentId, input: { operationId } });
          };
          signal.addEventListener("abort", abort, { once: true });
          try {
            const segments: Uint8Array[] = [];
            let mimeType = "audio/mpeg";
            const results = await synthesizeVoiceChunks(request.text, signal, (text) =>
              synthesize({ environmentId, input: { operationId, text } }),
            );
            for (const result of results) {
              if (result._tag !== "Success") throw new Error("Voice synthesis failed.");
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
      }),
    [cancel, environmentId, settings.voice, synthesize],
  );
  useEffect(() => {
    void session.preference.load();
    return () => session.dispose();
  }, [session]);
  return <ReplyPlaybackContext.Provider value={session}>{children}</ReplyPlaybackContext.Provider>;
}

export function useOptionalReplyPlayback() {
  return useContext(ReplyPlaybackContext);
}

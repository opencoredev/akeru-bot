import { createReplyPlaybackSession } from "@t3tools/client-runtime/reply-playback";
import { storedReplySynthesisCapability } from "@t3tools/client-runtime/reply-playback";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState } from "react";
import { useAtomCommand } from "~/state/use-atom-command";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { createBrowserReplyAudio } from "./replyPlaybackAudio";
import { synthesizeVoiceChunks } from "@t3tools/client-runtime/voice";

const OTHER_ENVIRONMENT_SPEECH_UNAVAILABLE =
  "Reading replies aloud is only available for this device's primary environment.";

let operationSequence = 0;
const operationId = () => `voice-${Date.now()}-${operationSequence++}`;

export function useWebReplyPlaybackSession() {
  const environmentId = usePrimaryEnvironmentId();
  const settings = useAtomValue(primaryServerSettingsAtom);
  const synthesize = useAtomCommand(serverEnvironment.synthesizeVoice, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelVoice, { reportFailure: false });
  const voice = settings.voice;
  const [initialVoice] = useState(voice);
  const session = useMemo(
    () =>
      createWebReplyPlaybackSession({
        ...(environmentId ? { environmentId } : {}),
        voice: initialVoice,
        ...(environmentId ? { synthesize: synthesize as never, cancel: cancel as never } : {}),
      }),
    [cancel, environmentId, initialVoice, synthesize],
  );
  // Voice setting changes update the live session, so playback and automatic readout survive them.
  // They belong to the primary environment, so replies from other environments stay unavailable.
  useEffect(() => {
    if (environmentId) session.setSynthesis(storedReplySynthesisCapability(voice), environmentId);
  }, [environmentId, session, voice]);
  return session;
}

export function createWebReplyPlaybackSession(
  options: {
    readonly environmentId?: string | null;
    readonly voice?: Parameters<typeof storedReplySynthesisCapability>[0];
    readonly synthesize?: (target: {
      environmentId: string;
      input: { operationId: string; text: string };
    }) => Promise<{ _tag: string; value?: { audioBase64: string; mimeType: "audio/mpeg" } }>;
    readonly cancel?: (target: {
      environmentId: string;
      input: { operationId: string };
    }) => Promise<unknown>;
  } = {},
) {
  const environmentId = options.environmentId ?? null;
  return createReplyPlaybackSession({
    storage: {
      getItem: async (key) =>
        typeof localStorage === "undefined" ? null : localStorage.getItem(key),
      setItem: async (key, value) => {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(key, value);
      },
    },
    // Speech runs on the primary environment with its voice settings, so replies from another
    // environment stay unavailable instead of being read by the wrong server.
    synthesis: (replyEnvironmentId) =>
      replyEnvironmentId === environmentId
        ? storedReplySynthesisCapability(options.voice)
        : {
            available: false,
            provider: "unavailable",
            voice: "unavailable",
            reason: OTHER_ENVIRONMENT_SPEECH_UNAVAILABLE,
          },
    prepare: async (request, signal, events) => {
      if (!environmentId || !options.synthesize || !options.cancel)
        throw new Error("Voice synthesis is unavailable.");
      if (request.identity.environmentId !== environmentId)
        throw new Error(OTHER_ENVIRONMENT_SPEECH_UNAVAILABLE);
      const id = operationId();
      const abort = () => {
        void options.cancel?.({ environmentId, input: { operationId: id } });
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const parts: BlobPart[] = [];
        let mimeType = "audio/mpeg";
        for (const result of await synthesizeVoiceChunks(request.text, signal, (text) =>
          options.synthesize!({ environmentId, input: { operationId: id, text } }),
        )) {
          if (result._tag !== "Success" || !result.value)
            throw new Error("Voice synthesis failed.");
          signal.throwIfAborted();
          const binary = atob(result.value.audioBase64);
          parts.push(Uint8Array.from(binary, (value) => value.charCodeAt(0)));
          mimeType = result.value.mimeType;
        }
        return createBrowserReplyAudio(new Blob(parts, { type: mimeType }), events);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  });
}

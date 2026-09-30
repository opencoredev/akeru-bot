import {
  createVoiceDictationTranscriber,
  dictationTranscriptionCapability,
  type DictationDraft,
} from "@akeru/client-runtime/dictation";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import type { DictationControlsProps } from "~/components/chat/DictationControls";
import { useOptionalVoiceCall } from "~/components/voice/VoiceCall";
import { useEnvironmentConnectionState, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { browserDictationCaptureReason } from "./browserDictation";
import { useComposerDictation } from "./useComposerDictation";

let operationSequence = 0;
const nextOperationId = () => `dictation-${Date.now()}-${operationSequence++}`;

/**
 * Binds a composer to the primary environment: `voice.transcribe`, the voice capability,
 * the connection, and the active voice call, which owns the microphone while it runs.
 */
export function useEnvironmentComposerDictation(input: {
  readonly threadId: string;
  readonly draftId: string;
  readonly generation: number;
  /** Reads the live text and caret; identity comes from the props above. */
  readonly getDraft: () => Omit<DictationDraft, "identity">;
  readonly applyDraft: (draft: DictationDraft) => void;
}): DictationControlsProps {
  const environmentId = usePrimaryEnvironmentId();
  const connection = useEnvironmentConnectionState(environmentId).data;
  const settings = useAtomValue(primaryServerSettingsAtom);
  const providers = useEnvironmentQuery(
    environmentId ? serverEnvironment.voiceProviders({ environmentId, input: {} }) : null,
  ).data;
  const voiceCall = useOptionalVoiceCall();
  const transcribeVoice = useAtomCommand(serverEnvironment.transcribeVoice, {
    reportFailure: false,
  });
  const cancelVoice = useAtomCommand(serverEnvironment.cancelVoice, { reportFailure: false });
  const transcribe = useMemo(
    () =>
      createVoiceDictationTranscriber({
        transcribe: transcribeVoice,
        cancel: cancelVoice,
        nextOperationId,
      }),
    [cancelVoice, transcribeVoice],
  );
  const identity = useMemo(
    () => ({
      environmentId: environmentId ?? "",
      threadId: input.threadId,
      draftId: input.draftId,
      generation: input.generation,
    }),
    [environmentId, input.draftId, input.generation, input.threadId],
  );
  const captureReason = browserDictationCaptureReason();
  return useComposerDictation({
    identity,
    captureAvailable: captureReason === null,
    captureReason,
    connected: environmentId !== null && (connection == null || connection.phase === "connected"),
    callActive: voiceCall?.activeCall != null || voiceCall?.startingBotId != null,
    transcribe,
    transcription: dictationTranscriptionCapability({
      voice: settings.voice,
      ...(providers ? { providers: providers.providers } : {}),
    }),
    getDraft: () => ({ identity, ...input.getDraft() }),
    applyDraft: input.applyDraft,
  });
}

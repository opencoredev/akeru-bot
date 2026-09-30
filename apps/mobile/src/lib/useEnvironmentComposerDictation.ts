import { useAtomValue } from "@effect/atom-react";
import {
  createVoiceDictationTranscriber,
  dictationTranscriptionCapability,
  type DictationDraft,
} from "@akeru/client-runtime/dictation";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@akeru/contracts";
import { useEffect, useMemo } from "react";
import { Alert } from "react-native";

import type { DictationControlsProps } from "../components/DictationControls";
import { useMobileI18n } from "./i18n";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useComposerDictation } from "./useComposerDictation";

let operationSequence = 0;
const nextOperationId = () => `dictation-${Date.now()}-${operationSequence++}`;

const NO_ENVIRONMENT = EnvironmentId.make("none");

/**
 * Binds a mobile composer to its environment's `voice.transcribe`, voice capability, and connection.
 * Mobile has no voice call, so dictation never has to yield the microphone to one.
 */
export function useEnvironmentComposerDictation(input: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly threadId: string;
  readonly draftId: string;
  readonly generation: number;
  /** Reads the live text and caret; identity comes from the props above. */
  readonly getDraft: () => Omit<DictationDraft, "identity">;
  readonly applyDraft: (draft: DictationDraft) => void;
}): DictationControlsProps {
  const { environmentId } = input;
  const { t } = useMobileI18n();
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId ?? NO_ENVIRONMENT)) ??
    DEFAULT_SERVER_SETTINGS;
  const providers = useEnvironmentQuery(
    environmentId ? serverEnvironment.voiceProviders({ environmentId, input: {} }) : null,
  ).data;
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
  const { errorMessage, ...dictation } = useComposerDictation({
    identity,
    connected: environmentId !== null && input.connected,
    callActive: false,
    transcribe,
    transcription: dictationTranscriptionCapability({
      voice: settings.voice,
      ...(providers ? { providers: providers.providers } : {}),
    }),
    getDraft: () => ({ identity, ...input.getDraft() }),
    applyDraft: input.applyDraft,
  });
  // Titles are interface copy; the message and reason stay as the provider reported them.
  useEffect(() => {
    if (errorMessage) Alert.alert(t("Could not dictate"), errorMessage);
  }, [errorMessage]);
  return {
    ...dictation,
    onBlockedPress: (reason) => Alert.alert(t("Dictation unavailable"), reason),
  };
}

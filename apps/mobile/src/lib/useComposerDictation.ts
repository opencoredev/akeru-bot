import {
  DICTATION_UNAVAILABLE,
  VOICE_DICTATION_LIMITS,
  createDictationSession,
  dictationControlStatus,
  dictationUnavailableReason,
  type DictationDependencies,
  type DictationDraft,
  type DictationIdentity,
  type DictationTranscriptionCapability,
} from "@t3tools/client-runtime/dictation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DictationControlsProps } from "../components/DictationControls";
import { startExpoDictationCapture } from "./expoDictationCapture";

type ComposerDictationSession = ReturnType<typeof createDictationSession>;

export interface ComposerDictationBinding {
  readonly identity: DictationIdentity;
  readonly connected: boolean;
  readonly callActive: boolean;
  readonly captureAvailable?: boolean;
  readonly captureReason?: string | null;
  readonly transcribe?: DictationDependencies["transcribe"] | null;
  /** Omit when the caller only knows transcription is wired; failures still surface after release. */
  readonly transcription?: DictationTranscriptionCapability;
  readonly getDraft: () => DictationDraft;
  readonly applyDraft: (draft: DictationDraft) => void;
  readonly createSession?: (
    dependencies: Omit<DictationDependencies, "capture">,
  ) => ComposerDictationSession;
}

function nativeSession(dependencies: Omit<DictationDependencies, "capture">) {
  return createDictationSession(
    { ...dependencies, capture: startExpoDictationCapture },
    VOICE_DICTATION_LIMITS,
  );
}

export function useComposerDictation(
  input: ComposerDictationBinding,
): DictationControlsProps & { readonly errorMessage: string | null } {
  const getDraft = useRef(input.getDraft);
  getDraft.current = input.getDraft;
  const applyDraft = useRef(input.applyDraft);
  applyDraft.current = input.applyDraft;
  const transcribe = useRef(input.transcribe);
  transcribe.current = input.transcribe;
  const unavailableReason = dictationUnavailableReason({
    callActive: input.callActive,
    connected: input.connected,
    captureAvailable: input.captureAvailable ?? true,
    captureReason: input.captureReason ?? null,
    transcriptionAvailable: input.transcription?.available ?? true,
    transcriptionReason:
      input.transcription && !input.transcription.available ? input.transcription.reason : null,
  });
  const session = useMemo(
    () =>
      (input.createSession ?? nativeSession)({
        schedule: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
        cancelSchedule: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
        transcribe: (request) => {
          const operation = transcribe.current;
          if (!operation) {
            return Promise.reject(new Error(DICTATION_UNAVAILABLE.transcription));
          }
          return operation(request);
        },
        updateDraft: (update) => applyDraft.current(update(getDraft.current())),
      }),
    [input.createSession],
  );
  const [status, setStatus] = useState(() => dictationControlStatus(session.status));
  useEffect(
    () => session.subscribe(() => setStatus(dictationControlStatus(session.status))),
    [session],
  );
  useEffect(() => {
    session.updateContext(input.identity, input.connected && !input.callActive);
  }, [input.callActive, input.connected, input.identity, session]);
  useEffect(() => () => session.dispose(), [session]);

  const onStart = useCallback(() => {
    if (unavailableReason) return;
    return session.start(getDraft.current());
  }, [session, unavailableReason]);
  const onRelease = useCallback(() => {
    return session.finish();
  }, [session]);
  const onCancel = useCallback(() => {
    session.cancel();
  }, [session]);

  return {
    status,
    unavailableReason,
    errorMessage: status === "failed" ? describeDictationFailure(session.error) : null,
    onStart,
    onRelease,
    onCancel,
  };
}

function describeDictationFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Dictation failed.";
}

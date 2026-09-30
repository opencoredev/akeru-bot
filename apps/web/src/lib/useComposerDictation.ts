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

import { createBrowserDictationSession } from "./browserDictation";
import type { DictationControlsProps } from "../components/chat/DictationControls";

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

export function useComposerDictation(input: ComposerDictationBinding): DictationControlsProps {
  const getDraft = useRef(input.getDraft);
  getDraft.current = input.getDraft;
  const applyDraft = useRef(input.applyDraft);
  applyDraft.current = input.applyDraft;
  const transcribe = useRef(input.transcribe);
  transcribe.current = input.transcribe;
  const captureAvailable = input.captureAvailable ?? true;
  const unavailableReason = dictationUnavailableReason({
    callActive: input.callActive,
    connected: input.connected,
    captureAvailable,
    captureReason: input.captureReason ?? null,
    transcriptionAvailable: input.transcription?.available ?? true,
    transcriptionReason:
      input.transcription && !input.transcription.available ? input.transcription.reason : null,
  });
  const session = useMemo(() => {
    const dependencies: Omit<DictationDependencies, "capture"> = {
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
    };
    return input.createSession
      ? input.createSession(dependencies)
      : createBrowserDictationSession(dependencies, VOICE_DICTATION_LIMITS);
  }, [input.createSession]);
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
    errorMessage: describeDictationFailure(session.error),
    onStart,
    onRelease,
    onCancel,
  };
}

function describeDictationFailure(error: unknown): string | null {
  if (error == null) return null;
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "This page is not HTTPS, so the browser will not open the microphone.";
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone permission was denied. Allow it in the browser's site settings.";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Dictation failed.";
}

export function createUnavailableDictationSession() {
  return createDictationSession({
    capture: async () => {
      throw new Error(DICTATION_UNAVAILABLE.capture);
    },
    transcribe: async () => {
      throw new Error(DICTATION_UNAVAILABLE.transcription);
    },
    updateDraft: () => undefined,
    schedule: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    cancelSchedule: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
}

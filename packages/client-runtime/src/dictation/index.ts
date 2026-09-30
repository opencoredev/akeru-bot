export { mergeDictationDraft, sameDictationIdentity } from "./draft.ts";
export type { DictationDraft, DictationIdentity } from "./draft.ts";
export {
  DICTATION_UNAVAILABLE,
  composerActionIsDictation,
  dictationControlStatus,
  dictationUnavailableReason,
} from "./presentation.ts";
export type { DictationControlStatus } from "./presentation.ts";
export { createDictationSession, DEFAULT_DICTATION_LIMITS } from "./session.ts";
export type {
  DictationAudio,
  DictationCapture,
  DictationDependencies,
  DictationLimits,
  DictationStatus,
  DictationCancelReason,
} from "./session.ts";
export {
  DICTATION_TRANSCRIPTION_UNAVAILABLE,
  VOICE_DICTATION_LIMITS,
  createVoiceDictationTranscriber,
  dictationAudioMediaType,
  dictationTranscriptionCapability,
  encodeDictationAudioBase64,
} from "./transcription.ts";
export type { DictationTranscriptionCapability } from "./transcription.ts";

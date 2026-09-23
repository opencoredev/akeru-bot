import * as Cause from "effect/Cause";

import {
  VOICE_AUDIO_MAX_BYTES,
  type EnvironmentId,
  type VoiceTranscribeInput,
} from "@t3tools/contracts";

import type { DictationAudio, DictationDependencies, DictationLimits } from "./session.ts";

/** Server-side `voice.transcribe` accepts at most this much decoded audio. */
export const VOICE_DICTATION_LIMITS: Partial<DictationLimits> = {
  maxAudioBytes: VOICE_AUDIO_MAX_BYTES,
  maxTranscriptCharacters: 16_000,
};

export const DICTATION_TRANSCRIPTION_UNAVAILABLE = {
  disabled: "Voice is turned off. Turn it on in Settings, Voice.",
  noProvider: "Connect a transcription provider in Settings, Voice.",
} as const;

export type DictationTranscriptionCapability =
  | { readonly available: true; readonly provider: string }
  | { readonly available: false; readonly reason: string };

/** Mirrors the server's standalone transcription path: voice enabled and a connected provider key. */
export function dictationTranscriptionCapability(input: {
  readonly voice?: { readonly enabled?: boolean; readonly transcriptionProvider?: string };
  readonly providers?: ReadonlyArray<{ readonly provider: string; readonly connected: boolean }>;
}): DictationTranscriptionCapability {
  if (input.voice?.enabled === false) {
    return { available: false, reason: DICTATION_TRANSCRIPTION_UNAVAILABLE.disabled };
  }
  const provider = input.voice?.transcriptionProvider ?? "openai";
  const connected = input.providers?.some(
    (status) => status.provider === provider && status.connected,
  );
  return connected
    ? { available: true, provider }
    : { available: false, reason: DICTATION_TRANSCRIPTION_UNAVAILABLE.noProvider };
}

const MEDIA_TYPES: Readonly<Record<string, VoiceTranscribeInput["mimeType"]>> = {
  "audio/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "audio/mp4": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/aac": "audio/mp4",
  "audio/mpeg": "audio/mpeg",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "video/webm": "audio/webm",
};

/** Drops codec parameters so recorder output such as `audio/webm;codecs=opus` fits the RPC schema. */
export function dictationAudioMediaType(mediaType: string) {
  return MEDIA_TYPES[mediaType.split(";", 1)[0]!.trim().toLowerCase()] ?? null;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeDictationAudioBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const chunk = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    output +=
      BASE64[(chunk >> 18) & 63]! +
      BASE64[(chunk >> 12) & 63]! +
      (b === undefined ? "=" : BASE64[(chunk >> 6) & 63]!) +
      (c === undefined ? "=" : BASE64[chunk & 63]!);
  }
  return output;
}

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  "voice-disabled": DICTATION_TRANSCRIPTION_UNAVAILABLE.disabled,
  "provider-unavailable": DICTATION_TRANSCRIPTION_UNAVAILABLE.noProvider,
  busy: "Too many voice requests are running. Try again in a moment.",
  "invalid-input": "The recording could not be transcribed. Try a shorter recording.",
};

type TranscribeResult =
  | { readonly _tag: "Success"; readonly value: { readonly text: string } }
  | { readonly _tag: "Failure"; readonly cause: unknown };

function failureReason(cause: unknown): string | null {
  const error = Cause.isCause(cause) ? Cause.squash(cause) : cause;
  if (typeof error !== "object" || error === null) return null;
  const record = error as { readonly _tag?: unknown; readonly reason?: unknown };
  return record._tag === "VoiceCallError" && typeof record.reason === "string"
    ? record.reason
    : null;
}

/** Binds dictation to the environment's `voice.transcribe` RPC, cancelling it server-side on abort. */
export function createVoiceDictationTranscriber(options: {
  readonly transcribe: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: VoiceTranscribeInput;
  }) => Promise<TranscribeResult>;
  readonly cancel: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly operationId: string };
  }) => Promise<unknown>;
  readonly nextOperationId: () => string;
}): DictationDependencies["transcribe"] {
  return async ({
    audio,
    signal,
    identity,
  }: {
    audio: DictationAudio;
    signal: AbortSignal;
    identity: { readonly environmentId: string };
  }) => {
    signal.throwIfAborted();
    const mimeType = dictationAudioMediaType(audio.mediaType);
    if (!mimeType) throw new Error("This recording format can't be transcribed.");
    // Dictation identities carry the id of the environment the composer was bound to.
    const environmentId = identity.environmentId as EnvironmentId;
    const operationId = options.nextOperationId();
    const abort = () => {
      void options.cancel({ environmentId, input: { operationId } }).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await options.transcribe({
        environmentId,
        input: { operationId, audioBase64: encodeDictationAudioBase64(audio.bytes), mimeType },
      });
      signal.throwIfAborted();
      if (result._tag === "Success") return result.value.text;
      const reason = failureReason(result.cause);
      throw new Error((reason && FAILURE_MESSAGES[reason]) ?? "Transcription failed. Try again.");
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
}

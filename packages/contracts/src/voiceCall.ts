import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BotId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CHATGPT_REALTIME_VOICE_MODEL = "gpt-realtime-2.1";
export const CHATGPT_REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
export const ChatGptRealtimeVoice = Schema.Literals(CHATGPT_REALTIME_VOICES);
export type ChatGptRealtimeVoice = typeof ChatGptRealtimeVoice.Type;

export const VOICE_API_PROVIDERS = ["openai", "elevenlabs", "cartesia", "fish"] as const;
export const VoiceApiProvider = Schema.Literals(VOICE_API_PROVIDERS);
export type VoiceApiProvider = typeof VoiceApiProvider.Type;
export const VoiceTranscriptionProvider = Schema.Literals(["openai", "elevenlabs", "cartesia"]);
export const VoiceId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const VoiceSynthesisVoices = Schema.Struct({
  openai: Schema.optionalKey(VoiceId),
  elevenlabs: Schema.optionalKey(VoiceId),
  cartesia: Schema.optionalKey(VoiceId),
  fish: Schema.optionalKey(VoiceId),
});
export const VoiceProvider = Schema.Literals(["chatgpt", "openai", "composed"]);
export type VoiceProvider = typeof VoiceProvider.Type;

export const VoiceSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  provider: VoiceProvider.pipe(Schema.withDecodingDefault(Effect.succeed("chatgpt" as const))),
  voice: ChatGptRealtimeVoice.pipe(Schema.withDecodingDefault(Effect.succeed("alloy" as const))),
  openaiVoice: Schema.optionalKey(ChatGptRealtimeVoice),
  transcriptionProvider: Schema.optionalKey(VoiceTranscriptionProvider),
  synthesisProvider: Schema.optionalKey(VoiceApiProvider),
  synthesisVoices: Schema.optionalKey(VoiceSynthesisVoices),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type VoiceSettings = typeof VoiceSettings.Type;

export const VoiceCallIdle = Schema.Struct({ status: Schema.Literal("idle") });

export const VoiceCallActive = Schema.Struct({
  callId: TrimmedNonEmptyString,
  status: Schema.Literals(["starting", "live"]),
  botId: BotId,
  botName: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
});

export const VoiceCallSnapshot = Schema.Union([VoiceCallIdle, VoiceCallActive]);
export type VoiceCallSnapshot = typeof VoiceCallSnapshot.Type;

export const VoiceSessionDescription = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(65_536),
);

export const VoiceCallStartInput = Schema.Struct({
  botId: BotId,
  sdp: Schema.optionalKey(VoiceSessionDescription),
});
export type VoiceCallStartInput = typeof VoiceCallStartInput.Type;

export const VoiceCallHangupInput = Schema.Struct({ callId: TrimmedNonEmptyString });
export type VoiceCallHangupInput = typeof VoiceCallHangupInput.Type;

export const VoiceCallStartResult = Schema.Struct({
  call: VoiceCallActive,
  answerSdp: Schema.optionalKey(VoiceSessionDescription),
  transport: Schema.Literals(["webrtc", "composed"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("webrtc" as const)),
  ),
  settings: VoiceSettings,
});
export type VoiceCallStartResult = typeof VoiceCallStartResult.Type;

export const VOICE_AUDIO_MAX_BYTES = 4 * 1024 * 1024;
export const VoiceAudioBase64 = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4 * Math.ceil(VOICE_AUDIO_MAX_BYTES / 3)),
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  Schema.makeFilter((value) => value.length % 4 === 0),
);
export const VoiceProviderInput = Schema.Struct({ provider: VoiceApiProvider });
export const VoiceConnectInput = Schema.Struct({
  provider: VoiceApiProvider,
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export const VoiceProviderStatus = Schema.Struct({
  provider: VoiceApiProvider,
  connected: Schema.Boolean,
});
export const VoiceProvidersResult = Schema.Struct({ providers: Schema.Array(VoiceProviderStatus) });
export const VoiceListVoicesInput = Schema.Struct({
  provider: VoiceApiProvider,
  cursor: Schema.optionalKey(VoiceId),
});
export const VoiceListVoicesResult = Schema.Struct({
  voices: Schema.Array(
    Schema.Struct({ id: VoiceId, name: Schema.String.check(Schema.isMaxLength(256)) }),
  ).check(Schema.isMaxLength(200)),
  nextCursor: Schema.optionalKey(VoiceId),
});
export type VoiceListVoicesResult = typeof VoiceListVoicesResult.Type;
export const VoiceOperationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const VoiceTranscribeInput = Schema.Struct({
  operationId: VoiceOperationId,
  callId: Schema.optionalKey(VoiceId),
  audioBase64: VoiceAudioBase64,
  mimeType: Schema.Literals(["audio/webm", "audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg"]),
});
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;
export const VoiceTranscribeResult = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(16_000)),
});
export const VoiceSynthesizeInput = Schema.Struct({
  operationId: VoiceOperationId,
  callId: Schema.optionalKey(VoiceId),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_000)),
});
export type VoiceSynthesizeInput = typeof VoiceSynthesizeInput.Type;
export const VoiceSynthesizeResult = Schema.Struct({
  audioBase64: VoiceAudioBase64,
  mimeType: Schema.Literal("audio/mpeg"),
});
export const VoiceCancelInput = Schema.Struct({ operationId: VoiceOperationId });
export const VoiceCancelResult = Schema.Struct({ cancelled: Schema.Boolean });

export class VoiceCallError extends Schema.TaggedErrorClass<VoiceCallError>()("VoiceCallError", {
  reason: Schema.Literals([
    "already-active",
    "bot-not-found",
    "voice-disabled",
    "subscription-unavailable",
    "upstream-failed",
    "call-not-active",
    "provider-unavailable",
    "provider-in-use",
    "invalid-input",
    "invalid-voice",
    "cancelled",
    "busy",
  ]),
  message: TrimmedNonEmptyString,
}) {}

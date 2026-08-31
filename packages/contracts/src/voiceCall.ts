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

export const VoiceProvider = Schema.Literal("chatgpt");
export type VoiceProvider = typeof VoiceProvider.Type;

export const VoiceSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  provider: VoiceProvider.pipe(Schema.withDecodingDefault(Effect.succeed("chatgpt" as const))),
  voice: ChatGptRealtimeVoice.pipe(Schema.withDecodingDefault(Effect.succeed("alloy" as const))),
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

export const VoiceSessionDescription = Schema.String.check(Schema.isNonEmpty());

export const VoiceCallStartInput = Schema.Struct({
  botId: BotId,
  sdp: VoiceSessionDescription,
});
export type VoiceCallStartInput = typeof VoiceCallStartInput.Type;

export const VoiceCallHangupInput = Schema.Struct({ callId: TrimmedNonEmptyString });
export type VoiceCallHangupInput = typeof VoiceCallHangupInput.Type;

export const VoiceCallStartResult = Schema.Struct({
  call: VoiceCallActive,
  answerSdp: VoiceSessionDescription,
});
export type VoiceCallStartResult = typeof VoiceCallStartResult.Type;

export class VoiceCallError extends Schema.TaggedErrorClass<VoiceCallError>()("VoiceCallError", {
  reason: Schema.Literals([
    "already-active",
    "bot-not-found",
    "voice-disabled",
    "subscription-unavailable",
    "upstream-failed",
    "call-not-active",
  ]),
  message: TrimmedNonEmptyString,
}) {}

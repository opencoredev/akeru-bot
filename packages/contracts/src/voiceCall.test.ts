import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BotId } from "./baseSchemas.ts";
import { VoiceCallStartInput, VoiceCallStartResult } from "./voiceCall.ts";

const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

describe("voice call contracts", () => {
  it("preserves SDP line endings across the RPC boundary", () => {
    const input = Schema.decodeUnknownSync(VoiceCallStartInput)({
      botId: BotId.make("bot-voice"),
      sdp,
    });
    expect(input.sdp).toBe(sdp);

    const result = Schema.decodeUnknownSync(VoiceCallStartResult)({
      call: {
        callId: "call-1",
        status: "live",
        botId: BotId.make("bot-voice"),
        botName: "Akeru",
        startedAt: "2026-08-27T00:00:00.000Z",
      },
      answerSdp: sdp,
    });
    expect(result.answerSdp).toBe(sdp);
  });
});

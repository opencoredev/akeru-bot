// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";
import {
  CHATGPT_REALTIME_VOICES,
  CHATGPT_REALTIME_VOICE_MODEL,
  VOICE_AUDIO_MAX_BYTES,
  VoiceCallError,
  VoiceId,
  VoiceTranscribeResult,
  type VoiceApiProvider,
  type VoiceListVoicesResult,
  type VoiceTranscribeInput,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";

export const OPENAI_SYNTHESIS_VOICES = [
  ...CHATGPT_REALTIME_VOICES,
  "fable",
  "onyx",
  "nova",
] as const;
const origins = {
  openai: "https://api.openai.com",
  elevenlabs: "https://api.elevenlabs.io",
  cartesia: "https://api.cartesia.ai",
  fish: "https://api.fish.audio",
} as const;
const Name = Schema.String.check(Schema.isMaxLength(256));
const Voice = Schema.Struct({ id: VoiceId, name: Name });
const ElevenVoice = Schema.Struct({ voice_id: VoiceId, name: Schema.optionalKey(Name) });
const FishVoice = Schema.Struct({
  _id: VoiceId,
  title: Name,
  type: Schema.String,
  state: Schema.String,
});
const CartesiaPage = Schema.Struct({
  data: Schema.Array(Voice).check(Schema.isMaxLength(200)),
  has_more: Schema.Boolean,
  next_page: Schema.optionalKey(Schema.NullOr(VoiceId)),
});
const ElevenPage = Schema.Struct({
  voices: Schema.Array(ElevenVoice).check(Schema.isMaxLength(200)),
  has_more: Schema.Boolean,
  next_page_token: Schema.optionalKey(Schema.NullOr(VoiceId)),
});
const FishPage = Schema.Struct({
  items: Schema.Array(FishVoice).check(Schema.isMaxLength(100)),
  total: Schema.Number,
  has_more: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});

const decodeElevenPage = Schema.decodeUnknownSync(ElevenPage);
const decodeCartesiaPage = Schema.decodeUnknownSync(CartesiaPage);
const decodeFishPage = Schema.decodeUnknownSync(FishPage);
const decodeElevenVoice = Schema.decodeUnknownSync(ElevenVoice);
const decodeFishVoice = Schema.decodeUnknownSync(FishVoice);
const decodeCartesiaVoice = Schema.decodeUnknownSync(
  Schema.Struct({ id: VoiceId, status: Schema.Literal("active") }),
);
const decodeTranscript = Schema.decodeUnknownSync(VoiceTranscribeResult);
const isVoiceId = Schema.is(VoiceId);
const isVoiceCallError = Schema.is(VoiceCallError);

/** Keeps a classified adapter failure, otherwise reports `fallback`. Never copies upstream detail. */
export function classifyVoiceFailure(
  cause: unknown,
  signal?: AbortSignal,
  fallback: VoiceCallError["reason"] = "upstream-failed",
): VoiceCallError {
  if (signal?.aborted) return voiceFailure("cancelled");
  return voiceFailure(isVoiceCallError(cause) ? cause.reason : fallback);
}

function statusFailure(status: number): VoiceCallError {
  if (status === 401 || status === 403) return voiceFailure("provider-auth");
  if (status === 402 || status === 429) return voiceFailure("provider-quota");
  return voiceFailure();
}

export function voiceFailure(reason: VoiceCallError["reason"] = "upstream-failed"): VoiceCallError {
  const messages = {
    "upstream-failed": "The voice provider request failed. Check the connection and try again.",
    "invalid-input": "The voice request is invalid or exceeds its size limit.",
    "invalid-voice": "Select an available voice for this provider in Settings.",
    "provider-unavailable": "Connect the selected voice provider in Settings.",
    "provider-in-use": "Hang up the active call before changing this provider's key.",
    cancelled: "The voice operation was cancelled.",
    busy: "Too many voice operations are in progress.",
    "provider-auth":
      "The voice provider rejected the API key. Replace the key in Settings and test it.",
    "provider-quota":
      "The voice provider reported a quota, billing, or rate limit. Check that provider account.",
    network: "Could not reach the voice provider. Check the network and try again.",
  };
  return new VoiceCallError({
    reason,
    message:
      reason in messages
        ? messages[reason as keyof typeof messages]
        : "The voice call is unavailable.",
  });
}

export async function readVoiceResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw response.ok ? voiceFailure() : statusFailure(response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw voiceFailure();
      chunks.push(chunk.value);
    }
    return NodeBuffer.Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type VoiceFetch = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => Promise<Response>;

export function makeVoiceAdapters(fetcher: VoiceFetch = fetch) {
  async function request(
    provider: VoiceApiProvider,
    key: string,
    path: string,
    signal: AbortSignal,
    body?: RequestInit["body"],
    json = false,
    maxBytes = 1024 * 1024,
  ): Promise<Uint8Array> {
    try {
      signal.throwIfAborted();
      const headers: Record<string, string> =
        provider === "elevenlabs" ? { "xi-api-key": key } : { Authorization: `Bearer ${key}` };
      if (provider === "cartesia") headers["Cartesia-Version"] = "2026-08-14";
      if (provider === "fish" && json) headers.model = "s2.1-pro";
      if (json) headers["Content-Type"] = "application/json";
      const response = await fetcher(origins[provider] + path, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        redirect: "error",
      }).catch(() => {
        throw voiceFailure("network");
      });
      const bytes = await readVoiceResponse(response, maxBytes);
      signal.throwIfAborted();
      return bytes;
    } catch (cause) {
      throw classifyVoiceFailure(cause, signal);
    }
  }
  async function json(
    provider: VoiceApiProvider,
    key: string,
    path: string,
    signal: AbortSignal,
    body?: RequestInit["body"],
  ): Promise<unknown> {
    try {
      return JSON.parse(new TextDecoder().decode(await request(provider, key, path, signal, body)));
    } catch (cause) {
      throw classifyVoiceFailure(cause, signal);
    }
  }
  async function listVoices(
    provider: VoiceApiProvider,
    key: string,
    signal: AbortSignal,
    cursor?: string,
  ): Promise<VoiceListVoicesResult> {
    try {
      if (provider === "openai")
        return { voices: OPENAI_SYNTHESIS_VOICES.map((id) => ({ id, name: id })) };
      if (provider === "elevenlabs") {
        const page = decodeElevenPage(
          await json(
            provider,
            key,
            `/v2/voices?page_size=100&include_total_count=false${cursor ? `&next_page_token=${encodeURIComponent(cursor)}` : ""}`,
            signal,
          ),
        );
        return {
          voices: page.voices.map((v) => ({ id: v.voice_id, name: v.name ?? v.voice_id })),
          ...(page.has_more && page.next_page_token ? { nextCursor: page.next_page_token } : {}),
        };
      }
      if (provider === "cartesia") {
        const page = decodeCartesiaPage(
          await json(
            provider,
            key,
            `/voices?limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`,
            signal,
          ),
        );
        const next = page.next_page ?? page.data.at(-1)?.id;
        return { voices: page.data, ...(page.has_more && next ? { nextCursor: next } : {}) };
      }
      const pageNumber = cursor === undefined ? 1 : Number(cursor);
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000)
        throw voiceFailure("invalid-input");
      const page = decodeFishPage(
        await json(provider, key, `/model?page_size=100&page_number=${pageNumber}`, signal),
      );
      return {
        voices: page.items
          .filter((v) => v.type === "tts" && v.state === "trained")
          .map((v) => ({ id: v._id, name: v.title })),
        ...((page.has_more ?? pageNumber * 100 < page.total) && pageNumber < 1000
          ? { nextCursor: String(pageNumber + 1) }
          : {}),
      };
    } catch (cause) {
      throw classifyVoiceFailure(cause, signal);
    }
  }
  async function validateVoice(
    provider: VoiceApiProvider,
    key: string,
    voice: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (!isVoiceId(voice) || voice === "." || voice === "..") throw voiceFailure("invalid-voice");
      if (provider === "openai") {
        if (!OPENAI_SYNTHESIS_VOICES.some((v) => v === voice)) throw voiceFailure("invalid-voice");
        return;
      }
      if (provider === "elevenlabs") {
        const result = decodeElevenVoice(
          await json(provider, key, `/v1/voices/${encodeURIComponent(voice)}`, signal),
        );
        if (result.voice_id !== voice) throw voiceFailure("invalid-voice");
      } else if (provider === "cartesia") {
        const result = decodeCartesiaVoice(
          await json(provider, key, `/voices/${encodeURIComponent(voice)}`, signal),
        );
        if (result.id !== voice) throw voiceFailure("invalid-voice");
      } else {
        const result = decodeFishVoice(
          await json(provider, key, `/model/${encodeURIComponent(voice)}`, signal),
        );
        if (result._id !== voice || result.type !== "tts" || result.state !== "trained")
          throw voiceFailure("invalid-voice");
      }
    } catch (cause) {
      const failure = classifyVoiceFailure(cause, signal, "invalid-voice");
      throw failure.reason === "upstream-failed" ? voiceFailure("invalid-voice") : failure;
    }
  }
  async function transcribe(
    provider: Exclude<VoiceApiProvider, "fish">,
    key: string,
    input: VoiceTranscribeInput,
    signal: AbortSignal,
  ) {
    if (input.audioBase64.length > 4 * Math.ceil(VOICE_AUDIO_MAX_BYTES / 3))
      throw voiceFailure("invalid-input");
    const audio = NodeBuffer.Buffer.from(input.audioBase64, "base64");
    if (
      !audio.length ||
      audio.length > VOICE_AUDIO_MAX_BYTES ||
      audio.toString("base64") !== input.audioBase64
    )
      throw voiceFailure("invalid-input");
    const extension = {
      "audio/webm": "webm",
      "audio/wav": "wav",
      "audio/mpeg": "mp3",
      "audio/mp4": "mp4",
      "audio/ogg": "ogg",
    }[input.mimeType];
    const form = new FormData();
    form.set("file", new Blob([audio], { type: input.mimeType }), `audio.${extension}`);
    form.set(
      provider === "elevenlabs" ? "model_id" : "model",
      { openai: "gpt-4o-mini-transcribe", elevenlabs: "scribe_v2", cartesia: "ink-whisper" }[
        provider
      ],
    );
    if (provider === "elevenlabs") {
      form.set("tag_audio_events", "false");
      form.set("diarize", "false");
    }
    try {
      return decodeTranscript(
        await json(
          provider,
          key,
          {
            openai: "/v1/audio/transcriptions",
            elevenlabs: "/v1/speech-to-text",
            cartesia: "/stt",
          }[provider],
          signal,
          form,
        ),
      );
    } catch (cause) {
      throw classifyVoiceFailure(cause, signal);
    }
  }
  async function synthesize(
    provider: VoiceApiProvider,
    key: string,
    voice: string,
    text: string,
    signal: AbortSignal,
  ) {
    if (!text.trim() || text.length > 4000) throw voiceFailure("invalid-input");
    const paths = {
      openai: "/v1/audio/speech",
      elevenlabs: `/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      cartesia: "/tts/bytes",
      fish: "/v1/tts",
    };
    const bodies = {
      openai: { model: "gpt-4o-mini-tts", input: text, voice, response_format: "mp3" },
      elevenlabs: { model_id: "eleven_multilingual_v2", text },
      cartesia: {
        model_id: "sonic-3.6",
        transcript: text,
        voice: { id: voice },
        output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      },
      fish: { text, reference_id: voice, format: "mp3" },
    };
    const audio = await request(
      provider,
      key,
      paths[provider],
      signal,
      JSON.stringify(bodies[provider]),
      true,
      VOICE_AUDIO_MAX_BYTES,
    );
    if (!audio.length) throw voiceFailure();
    return {
      audioBase64: NodeBuffer.Buffer.from(audio).toString("base64"),
      mimeType: "audio/mpeg" as const,
    };
  }
  async function negotiate(
    key: string,
    sdp: string,
    instructions: string,
    voice: string,
    signal: AbortSignal,
  ) {
    if (!CHATGPT_REALTIME_VOICES.some((v) => v === voice)) throw voiceFailure("invalid-voice");
    const form = new FormData();
    form.set("sdp", sdp);
    form.set(
      "session",
      JSON.stringify({
        type: "realtime",
        model: CHATGPT_REALTIME_VOICE_MODEL,
        instructions,
        audio: {
          input: {
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: { type: "semantic_vad", interrupt_response: false },
          },
          output: { voice },
        },
        tools: [
          {
            type: "function",
            name: "send_to_chat",
            description: "Send workspace work to the bot's existing chat.",
            parameters: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        ],
        tool_choice: "auto",
      }),
    );
    const answer = new TextDecoder().decode(
      await request("openai", key, "/v1/realtime/calls", signal, form, false, 65_536),
    );
    if (!answer.trim()) throw voiceFailure();
    return answer;
  }
  async function test(provider: VoiceApiProvider, key: string, signal: AbortSignal) {
    if (provider === "openai") await request(provider, key, "/v1/models", signal);
    else await listVoices(provider, key, signal);
  }
  return { listVoices, validateVoice, transcribe, synthesize, negotiate, test };
}
export type VoiceAdapters = ReturnType<typeof makeVoiceAdapters>;

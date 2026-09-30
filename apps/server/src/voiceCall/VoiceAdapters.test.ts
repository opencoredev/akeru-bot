import * as NodeBuffer from "node:buffer";
import { describe, expect, it, vi } from "vite-plus/test";
import { VOICE_AUDIO_MAX_BYTES } from "@akeru/contracts";
import { makeVoiceAdapters, readVoiceResponse, type VoiceFetch } from "./VoiceAdapters.ts";

const signal = () => new AbortController().signal;
const audio = { operationId: "operation", audioBase64: "YXVkaW8=", mimeType: "audio/wav" as const };

describe("voice capability adapters", () => {
  it.each([
    ["openai", "https://api.openai.com/v1/audio/transcriptions", "model", "gpt-4o-mini-transcribe"],
    ["elevenlabs", "https://api.elevenlabs.io/v1/speech-to-text", "model_id", "scribe_v2"],
    ["cartesia", "https://api.cartesia.ai/stt", "model", "ink-whisper"],
  ] as const)(
    "transcribes with the official %s multipart API",
    async (provider, url, modelField, model) => {
      const fetcher = vi.fn<VoiceFetch>(async (actual, init) => {
        expect(String(actual)).toBe(url);
        const headers = new Headers(init?.headers);
        expect(headers.get(provider === "elevenlabs" ? "xi-api-key" : "Authorization")).toBe(
          provider === "elevenlabs" ? "secret" : "Bearer secret",
        );
        if (provider === "cartesia") expect(headers.get("Cartesia-Version")).toBe("2026-08-14");
        expect(headers.get("Content-Type")).toBeNull();
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get(modelField)).toBe(model);
        expect(await (form.get("file") as Blob).text()).toBe("audio");
        return Response.json({ text: "transcript", ignored: "private metadata" });
      });
      expect(
        await makeVoiceAdapters(fetcher).transcribe(provider, "secret", audio, signal()),
      ).toEqual({ text: "transcript" });
    },
  );

  it.each(["openai", "elevenlabs", "cartesia", "fish"] as const)(
    "synthesizes MP3 with the official %s API",
    async (provider) => {
      const fetcher = vi.fn<VoiceFetch>(async (url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
        if (provider === "openai") {
          expect(String(url)).toBe("https://api.openai.com/v1/audio/speech");
          expect(body).toEqual({
            model: "gpt-4o-mini-tts",
            input: "Hello",
            voice: "alloy",
            response_format: "mp3",
          });
        } else if (provider === "elevenlabs") {
          expect(String(url)).toBe(
            "https://api.elevenlabs.io/v1/text-to-speech/alloy?output_format=mp3_44100_128",
          );
          expect(body).toEqual({ model_id: "eleven_multilingual_v2", text: "Hello" });
        } else if (provider === "cartesia") {
          expect(String(url)).toBe("https://api.cartesia.ai/tts/bytes");
          expect(body.voice).toEqual({ id: "alloy" });
          expect(body.model_id).toBe("sonic-3.6");
          expect(body.output_format).toEqual({
            container: "mp3",
            sample_rate: 44100,
            bit_rate: 128000,
          });
        } else {
          expect(String(url)).toBe("https://api.fish.audio/v1/tts");
          expect(new Headers(init?.headers).get("model")).toBe("s2.1-pro");
          expect(body).toEqual({ text: "Hello", reference_id: "alloy", format: "mp3" });
        }
        return new Response("mp3");
      });
      expect(
        await makeVoiceAdapters(fetcher).synthesize(provider, "secret", "alloy", "Hello", signal()),
      ).toEqual({ audioBase64: "bXAz", mimeType: "audio/mpeg" });
    },
  );

  it("negotiates OpenAI realtime without exposing the key", async () => {
    const fetcher = vi.fn<VoiceFetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/realtime/calls");
      const form = init?.body as FormData;
      expect(form.get("sdp")).toBe("offer\r\n");
      const session = JSON.parse(String(form.get("session")));
      expect(session.model).toBe("gpt-realtime-2.1");
      expect(session.audio.output.voice).toBe("marin");
      expect(session.tools[0].name).toBe("send_to_chat");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
      return new Response("answer\r\n");
    });
    expect(
      await makeVoiceAdapters(fetcher).negotiate(
        "secret",
        "offer\r\n",
        "Instructions",
        "marin",
        signal(),
      ),
    ).toBe("answer\r\n");
  });

  it.each([
    [
      "elevenlabs",
      {
        voices: [{ voice_id: "one", name: "One", preview_url: "private" }],
        has_more: true,
        next_page_token: "next",
      },
    ],
    [
      "cartesia",
      {
        data: [{ id: "one", name: "One", preview_file_url: "private" }],
        has_more: true,
        next_page: "next",
      },
    ],
    [
      "fish",
      {
        items: [
          { _id: "one", title: "One", type: "tts", state: "trained" },
          { _id: "bad", title: "Bad", type: "svc", state: "trained" },
        ],
        total: 300,
        has_more: true,
      },
    ],
  ] as const)("returns redacted paginated %s voice choices", async (provider, response) => {
    const fetcher = vi.fn<VoiceFetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("model")).toBeNull();
      return Response.json(response);
    });
    const result = await makeVoiceAdapters(fetcher).listVoices(provider, "secret", signal());
    expect(result).toEqual({
      voices: [{ id: "one", name: "One" }],
      nextCursor: provider === "fish" ? "2" : "next",
    });
  });

  it("validates dynamic voices by ID rather than a truncated catalog", async () => {
    const fetcher = vi.fn<VoiceFetch>(async (url) => {
      expect(String(url)).toBe("https://api.fish.audio/model/chosen");
      return Response.json({ _id: "chosen", title: "Chosen", type: "tts", state: "trained" });
    });
    await makeVoiceAdapters(fetcher).validateVoice("fish", "secret", "chosen", signal());
    await expect(
      makeVoiceAdapters(fetcher).validateVoice("openai", "secret", "unknown", signal()),
    ).rejects.toMatchObject({ reason: "invalid-voice" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized requests before sending them", async () => {
    const fetcher = vi.fn<VoiceFetch>();
    const adapters = makeVoiceAdapters(fetcher);
    await expect(
      adapters.synthesize("openai", "secret", "alloy", "x".repeat(4001), signal()),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(
      adapters.transcribe(
        "openai",
        "secret",
        {
          ...audio,
          audioBase64: NodeBuffer.Buffer.alloc(VOICE_AUDIO_MAX_BYTES + 1).toString("base64"),
        },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(
      adapters.transcribe("openai", "secret", { ...audio, audioBase64: "not base64" }, signal()),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels response bodies at their size limit", async () => {
    const cancelled = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
        },
        cancel: cancelled,
      }),
    );
    await expect(readVoiceResponse(response, 5)).rejects.toMatchObject({
      reason: "upstream-failed",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("never returns upstream bodies or malformed transcription details in errors", async () => {
    for (const response of [
      new Response("API-KEY private transcript", { status: 500 }),
      Response.json({ text: "private".repeat(16000) }),
      new Response("malformed private data"),
    ]) {
      const fetcher = vi.fn<VoiceFetch>(async () => response);
      await expect(
        makeVoiceAdapters(fetcher).transcribe("openai", "secret", audio, signal()),
      ).rejects.toMatchObject({
        reason: "upstream-failed",
        message: "The voice provider request failed. Check the connection and try again.",
      });
    }
  });

  it("aborts a stalled request at its deadline without leaking the abort reason", async () => {
    const deadline = new AbortController();
    const began = Promise.withResolvers<void>();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetcher = vi.fn<VoiceFetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private timeout details")),
            { once: true },
          );
          began.resolve();
        }),
    );
    try {
      const pending = makeVoiceAdapters(fetcher).synthesize(
        "openai",
        "secret",
        "alloy",
        "Hello",
        signal(),
      );
      await began.promise;
      expect(timeout).toHaveBeenCalledWith(60_000);
      deadline.abort();
      await expect(pending).rejects.toMatchObject({
        reason: "network",
        message: "Could not reach the voice provider. Check the network and try again.",
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it.each(["openai", "elevenlabs", "cartesia", "fish"] as const)(
    "classifies %s auth, quota, and network failures without upstream detail",
    async (provider) => {
      const cases = [
        [401, "provider-auth"],
        [403, "provider-auth"],
        [402, "provider-quota"],
        [429, "provider-quota"],
        [503, "upstream-failed"],
      ] as const;
      for (const [status, reason] of cases) {
        const fetcher = vi.fn<VoiceFetch>(
          async () => new Response(`private key sk-secret ${status}`, { status }),
        );
        const adapters = makeVoiceAdapters(fetcher);
        const failures = [
          adapters.synthesize(provider, "secret", "alloy", "Hello", signal()),
          adapters.test(provider, "secret", signal()),
          ...(provider === "fish"
            ? []
            : [adapters.transcribe(provider, "secret", audio, signal())]),
        ];
        for (const failure of failures) {
          const error = await failure.then(
            () => expect.unreachable(),
            (cause: unknown) => cause,
          );
          expect(error).toMatchObject({ reason });
          expect(JSON.stringify(error)).not.toContain("sk-secret");
        }
      }
      const offline = makeVoiceAdapters(async () => {
        throw new TypeError("fetch failed: private DNS detail");
      });
      await expect(
        offline.synthesize(provider, "secret", "alloy", "Hello", signal()),
      ).rejects.toMatchObject({ reason: "network" });
      await expect(offline.test(provider, "secret", signal())).rejects.toMatchObject({
        reason: "network",
      });
    },
  );

  it("keeps auth failures distinct from an unknown voice during validation", async () => {
    const unauthorized = makeVoiceAdapters(async () => new Response("", { status: 401 }));
    await expect(
      unauthorized.validateVoice("elevenlabs", "secret", "voice", signal()),
    ).rejects.toMatchObject({ reason: "provider-auth" });
    const missing = makeVoiceAdapters(async () => new Response("", { status: 404 }));
    await expect(
      missing.validateVoice("cartesia", "secret", "voice", signal()),
    ).rejects.toMatchObject({ reason: "invalid-voice" });
  });

  it("honors cancellation before making a request", async () => {
    const fetcher = vi.fn<VoiceFetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      makeVoiceAdapters(fetcher).synthesize(
        "openai",
        "secret",
        "alloy",
        "Hello",
        controller.signal,
      ),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

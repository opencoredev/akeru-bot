import { describe, expect, it, vi } from "vite-plus/test";

import {
  CHATGPT_IMAGE_CAPABILITIES,
  CHATGPT_RESPONSES_URL,
  GROK_IMAGE_CAPABILITIES,
  GROK_IMAGE_MODEL,
  type ImageAdapterFailure,
  type ImageAdapterRequest,
  makeChatGptImageAdapter,
  makeGrokImageAdapter,
  parseChatGptImageStream,
  unsupportedReason,
} from "./adapters.ts";
import { sniffImage } from "./imageBytes.ts";
import { base64, jpegBytes, pngBytes } from "./testImages.ts";

const request = (overrides: Partial<ImageAdapterRequest> = {}): ImageAdapterRequest => ({
  operation: "generate",
  prompt: "A red kite over the sea",
  inputImages: [],
  aspectRatio: undefined,
  quality: "standard",
  count: 1,
  ...overrides,
});

function sse(events: ReadonlyArray<unknown>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function chatgptStream(image: Uint8Array) {
  return sse([
    { type: "response.created" },
    {
      type: "response.output_item.done",
      item: { type: "image_generation_call", status: "completed", result: base64(image) },
    },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 40,
          output_tokens: 1200,
          output_tokens_details: { reasoning_tokens: 8 },
        },
      },
    },
  ]);
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function recordingFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchFn };
}

const chatgptAuth = (
  access: { accessToken: string; accountId: string } | undefined | "throw",
  apiKey = false,
) => ({
  getOpenAICodexAccess: async () => {
    if (access === "throw") throw new Error("invalid_grant");
    return access;
  },
  getApiKeyCredential: () => (apiKey ? { type: "api-key" as const, access: "sk-test" } : undefined),
});

const grokAuth = (token: string | undefined) => ({
  getAccessToken: async () => token,
  getApiKeyCredential: () => undefined,
});

async function failureOf(promise: Promise<unknown>): Promise<ImageAdapterFailure> {
  try {
    await promise;
  } catch (error) {
    return error as ImageAdapterFailure;
  }
  throw new Error("expected the adapter to fail");
}

describe("ChatGPT image adapter", () => {
  it("generates through the ChatGPT sign-in and reports usage", async () => {
    const image = pngBytes(1536, 1024);
    const { calls, fetchFn } = recordingFetch(() => new Response(chatgptStream(image)));
    const adapter = makeChatGptImageAdapter({
      subscriptionAuth: chatgptAuth({ accessToken: "oauth-token", accountId: "acct-1" }),
      fetchFn,
    });

    const output = await adapter.run(
      request({ aspectRatio: "3:2", quality: "high" }),
      new AbortController().signal,
    );

    expect(output.images).toHaveLength(1);
    expect(sniffImage(output.images[0]!)).toEqual({
      mimeType: "image/png",
      width: 1536,
      height: 1024,
    });
    expect(output.usage).toEqual({ inputTokens: 40, outputTokens: 1200, reasoningTokens: 8 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(CHATGPT_RESPONSES_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer oauth-token");
    expect(headers["ChatGPT-Account-ID"]).toBe("acct-1");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.tools).toEqual([
      { type: "image_generation", size: "1536x1024", quality: "high", output_format: "png" },
    ]);
    expect(body.store).toBe(false);
  });

  it("sends input images for edits and loops for multiple images", async () => {
    const { calls, fetchFn } = recordingFetch(() => new Response(chatgptStream(pngBytes(8, 8))));
    const adapter = makeChatGptImageAdapter({
      subscriptionAuth: chatgptAuth({ accessToken: "t", accountId: "a" }),
      fetchFn,
    });
    const output = await adapter.run(
      request({
        operation: "edit",
        count: 2,
        inputImages: [{ mimeType: "image/png", bytes: pngBytes(4, 4) }],
      }),
      new AbortController().signal,
    );
    expect(output.images).toHaveLength(2);
    expect(output.usage?.outputTokens).toBe(2400);
    expect(calls).toHaveLength(2);
    const content = JSON.parse(String(calls[0]!.init.body)).input[0].content;
    expect(content[1].type).toBe("input_image");
    expect(content[1].image_url).toMatch(/^data:image\/png;base64,/);
  });

  it("never falls back to an OpenAI API key", async () => {
    const { calls, fetchFn } = recordingFetch(() => new Response(""));
    const adapter = makeChatGptImageAdapter({
      subscriptionAuth: chatgptAuth(undefined, true),
      fetchFn,
    });
    const failure = await failureOf(adapter.run(request(), new AbortController().signal));
    expect(failure.kind).toBe("unavailable");
    expect(failure.message).toContain("API key is not used");
    expect(calls).toHaveLength(0);
  });

  it("reports a rejected refresh and a 401 as revoked", async () => {
    const refresh = makeChatGptImageAdapter({ subscriptionAuth: chatgptAuth("throw") });
    expect((await failureOf(refresh.run(request(), new AbortController().signal))).kind).toBe(
      "revoked",
    );
    const { fetchFn } = recordingFetch(() => new Response("nope", { status: 401 }));
    const rejected = makeChatGptImageAdapter({
      subscriptionAuth: chatgptAuth({ accessToken: "t", accountId: "a" }),
      fetchFn,
    });
    const failure = await failureOf(rejected.run(request(), new AbortController().signal));
    expect(failure.kind).toBe("revoked");
    expect(failure.message).not.toContain("nope");
  });

  it("normalizes server errors, content refusals, and empty results", async () => {
    const auth = chatgptAuth({ accessToken: "t", accountId: "a" });
    const serverError = makeChatGptImageAdapter({
      subscriptionAuth: auth,
      fetchFn: async () => new Response("", { status: 503 }),
    });
    expect((await failureOf(serverError.run(request(), new AbortController().signal))).kind).toBe(
      "provider-failed",
    );

    const refused = makeChatGptImageAdapter({
      subscriptionAuth: auth,
      fetchFn: async () =>
        new Response(
          sse([{ type: "response.failed", response: { error: { code: "moderation_blocked" } } }]),
        ),
    });
    expect((await failureOf(refused.run(request(), new AbortController().signal))).kind).toBe(
      "invalid-request",
    );

    const empty = makeChatGptImageAdapter({
      subscriptionAuth: auth,
      fetchFn: async () => new Response(sse([{ type: "response.completed", response: {} }])),
    });
    expect((await failureOf(empty.run(request(), new AbortController().signal))).kind).toBe(
      "provider-failed",
    );
  });

  it("maps an aborted request to cancelled", async () => {
    const controller = new AbortController();
    const adapter = makeChatGptImageAdapter({
      subscriptionAuth: chatgptAuth({ accessToken: "t", accountId: "a" }),
      fetchFn: (_input, init) =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          // Like real fetch, an already-aborted signal rejects immediately.
          if (init?.signal?.aborted) abort();
          init?.signal?.addEventListener("abort", abort);
        }),
    });
    const pending = failureOf(adapter.run(request(), controller.signal));
    controller.abort();
    expect((await pending).kind).toBe("cancelled");
  });

  it("ignores stream noise and reads only image results", () => {
    const parsed = parseChatGptImageStream(
      `: keep-alive\n\ndata: not-json\n\n${chatgptStream(pngBytes(2, 2))}data: [DONE]\n\n`,
    );
    expect(parsed.images).toHaveLength(1);
  });
});

describe("Grok image adapter", () => {
  it("generates with the documented xAI request", async () => {
    const image = jpegBytes(1280, 720);
    const { calls, fetchFn } = recordingFetch(() =>
      Response.json({ data: [{ b64_json: base64(image) }, { b64_json: base64(image) }] }),
    );
    const adapter = makeGrokImageAdapter({ subscriptionAuth: grokAuth("xai-token"), fetchFn });
    const output = await adapter.run(
      request({ aspectRatio: "16:9", quality: "high", count: 2 }),
      new AbortController().signal,
    );
    expect(output.images).toHaveLength(2);
    expect(output.model).toBe(GROK_IMAGE_MODEL);
    expect(sniffImage(output.images[0]!)).toEqual({
      mimeType: "image/jpeg",
      width: 1280,
      height: 720,
    });
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/images/generations");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: GROK_IMAGE_MODEL,
      prompt: "A red kite over the sea",
      n: 2,
      response_format: "b64_json",
      resolution: "2k",
      aspect_ratio: "16:9",
    });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer xai-token",
    );
  });

  it("edits one input image through the edits endpoint", async () => {
    const { calls, fetchFn } = recordingFetch(() =>
      Response.json({ data: [{ b64_json: base64(jpegBytes(64, 64)) }] }),
    );
    const adapter = makeGrokImageAdapter({ subscriptionAuth: grokAuth("t"), fetchFn });
    await adapter.run(
      request({
        operation: "edit",
        inputImages: [{ mimeType: "image/png", bytes: pngBytes(4, 4) }],
      }),
      new AbortController().signal,
    );
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/images/edits");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.image.type).toBe("image_url");
    expect(body.image.url).toMatch(/^data:image\/png;base64,/);
  });

  it("reports missing and revoked accounts", async () => {
    const missing = makeGrokImageAdapter({ subscriptionAuth: grokAuth(undefined) });
    expect((await failureOf(missing.run(request(), new AbortController().signal))).kind).toBe(
      "unavailable",
    );
    const revoked = makeGrokImageAdapter({
      subscriptionAuth: grokAuth("t"),
      fetchFn: async () => new Response("", { status: 403 }),
    });
    expect((await failureOf(revoked.run(request(), new AbortController().signal))).kind).toBe(
      "revoked",
    );
  });
});

describe("oversized provider responses", () => {
  const oversized = () =>
    new Response("{}", { headers: { "content-length": String(65 * 1024 * 1024) } });

  it("fail before the body is read", async () => {
    const adapters = [
      makeChatGptImageAdapter({
        subscriptionAuth: chatgptAuth({ accessToken: "t", accountId: "a" }),
        fetchFn: async () => oversized(),
      }),
      makeGrokImageAdapter({ subscriptionAuth: grokAuth("t"), fetchFn: async () => oversized() }),
    ];
    for (const adapter of adapters) {
      const failure = await failureOf(adapter.run(request(), new AbortController().signal));
      expect(failure.kind).toBe("provider-failed");
      expect(failure.message).toContain("larger than the image size limit");
    }
  });
});

describe("rejected provider responses", () => {
  it("close the response body", async () => {
    const cancel = vi.fn();
    const rejected = async () => new Response(new ReadableStream({ cancel }), { status: 503 });
    const adapters = [
      makeChatGptImageAdapter({
        subscriptionAuth: chatgptAuth({ accessToken: "t", accountId: "a" }),
        fetchFn: rejected,
      }),
      makeGrokImageAdapter({ subscriptionAuth: grokAuth("t"), fetchFn: rejected }),
    ];
    for (const adapter of adapters) {
      const failure = await failureOf(adapter.run(request(), new AbortController().signal));
      expect(failure.kind).toBe("provider-failed");
    }
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});

describe("unsupportedReason", () => {
  it("rejects combinations a provider cannot serve", () => {
    const twoImages = [
      { mimeType: "image/png", bytes: pngBytes(1, 1) },
      { mimeType: "image/png", bytes: pngBytes(1, 1) },
    ];
    expect(
      unsupportedReason(
        "Grok",
        GROK_IMAGE_CAPABILITIES,
        request({ operation: "edit", inputImages: twoImages }),
      ),
    ).toBe("Grok accepts at most 1 input image for edits.");
    expect(
      unsupportedReason("ChatGPT", CHATGPT_IMAGE_CAPABILITIES, request({ aspectRatio: "16:9" })),
    ).toContain("supports aspect ratios 1:1, 3:2, 2:3");
    expect(
      unsupportedReason("ChatGPT", CHATGPT_IMAGE_CAPABILITIES, request({ operation: "edit" })),
    ).toBe("Image editing needs at least one input image.");
    expect(
      unsupportedReason(
        "Grok",
        GROK_IMAGE_CAPABILITIES,
        request({ aspectRatio: "16:9", count: 4 }),
      ),
    ).toBeUndefined();
  });
});

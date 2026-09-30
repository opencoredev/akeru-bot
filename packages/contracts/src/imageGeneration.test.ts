import { describe, expect, it } from "vite-plus/test";

import { decodeImageGenerationRequest } from "./imageGeneration.ts";

describe("decodeImageGenerationRequest", () => {
  it("accepts a typed generate request", () => {
    const result = decodeImageGenerationRequest({
      operation: "generate",
      prompt: "A lighthouse at dusk",
      aspectRatio: "16:9",
      quality: "high",
      count: 2,
      provider: "grok",
    });
    expect(result).toEqual({
      ok: true,
      request: {
        operation: "generate",
        prompt: "A lighthouse at dusk",
        aspectRatio: "16:9",
        quality: "high",
        count: 2,
        provider: "grok",
      },
    });
  });

  it("rejects arbitrary provider options", () => {
    const result = decodeImageGenerationRequest({
      operation: "generate",
      prompt: "A lighthouse",
      style: "vivid",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-range counts, unknown sizes, and empty prompts", () => {
    expect(decodeImageGenerationRequest({ operation: "generate", prompt: "x", count: 9 }).ok).toBe(
      false,
    );
    expect(
      decodeImageGenerationRequest({ operation: "generate", prompt: "x", aspectRatio: "5:1" }).ok,
    ).toBe(false);
    expect(decodeImageGenerationRequest({ operation: "generate", prompt: "  " }).ok).toBe(false);
    expect(decodeImageGenerationRequest({ operation: "upscale", prompt: "x" }).ok).toBe(false);
  });
});

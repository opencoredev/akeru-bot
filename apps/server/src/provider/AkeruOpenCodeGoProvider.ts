import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { MastraModelConfig } from "@mastra/core/llm";

const OPEN_CODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPEN_CODE_GO_USER_AGENT = "akeru-bot/0.0.37";

const RESPONSES_MODELS = new Set([
  "gpt-5.6-luna",
  "grok-4.5",
  "grok-4.6",
  "muse-spark-1.2-contributor",
  "muse-spark-1.3-contributor",
]);

export type OpenCodeGoProtocol = "anthropic" | "chat-completions" | "responses";
type AkeruOpenCodeGoFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function openCodeGoProtocol(modelId: string): OpenCodeGoProtocol {
  if (RESPONSES_MODELS.has(modelId)) return "responses";
  if (modelId.startsWith("minimax-") || modelId.startsWith("qwen")) return "anthropic";
  return "chat-completions";
}

export function buildAkeruOpenCodeGoFetch(
  protocol: OpenCodeGoProtocol,
  getApiKey: () => Promise<string | undefined>,
  request: AkeruOpenCodeGoFetch = globalThis.fetch,
): AkeruOpenCodeGoFetch {
  return async (input, init) => {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error("OpenCode Go is not connected. Add an API key in Settings.");

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.set("User-Agent", OPEN_CODE_GO_USER_AGENT);
    headers.set("x-opencode-client", "akeru-bot");
    if (protocol === "anthropic") {
      headers.set("x-api-key", apiKey);
    } else {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    return request(input, { ...init, headers });
  };
}

export function akeruOpenCodeGoProvider(
  modelId: string,
  getApiKey: () => Promise<string | undefined>,
): MastraModelConfig {
  const protocol = openCodeGoProtocol(modelId);
  const fetch = buildAkeruOpenCodeGoFetch(protocol, getApiKey) as NonNullable<
    NonNullable<Parameters<typeof createOpenAI>[0]>["fetch"]
  >;
  if (protocol === "responses") {
    return createOpenAI({
      name: "opencode-go",
      apiKey: "api-key-placeholder",
      baseURL: OPEN_CODE_GO_BASE_URL,
      fetch: fetch as NonNullable<NonNullable<Parameters<typeof createOpenAI>[0]>["fetch"]>,
    }).responses(modelId);
  }
  if (protocol === "anthropic") {
    return createAnthropic({
      apiKey: "api-key-placeholder",
      baseURL: OPEN_CODE_GO_BASE_URL,
      fetch: fetch as NonNullable<NonNullable<Parameters<typeof createAnthropic>[0]>["fetch"]>,
    })(modelId);
  }
  return createOpenAICompatible({
    name: "opencode-go",
    apiKey: "api-key-placeholder",
    baseURL: OPEN_CODE_GO_BASE_URL,
    fetch: fetch as NonNullable<NonNullable<Parameters<typeof createOpenAICompatible>[0]>["fetch"]>,
  })(modelId);
}

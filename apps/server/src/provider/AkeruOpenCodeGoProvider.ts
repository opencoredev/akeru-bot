import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { MastraModelConfig } from "@mastra/core/llm";
import { subscriptionRequestUrl } from "../subscription-auth/runtime.ts";

const OPEN_CODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

const OPEN_CODE_GO_USER_AGENT = "akeru-bot/0.0.37";

/** Model families OpenCode Go serves over the Responses API. Matched by
 * prefix so new releases from the live model catalog route correctly. */
const RESPONSES_MODEL_PREFIXES = ["gpt-", "grok-", "muse-spark-"];

export type OpenCodeGoProtocol = "anthropic" | "chat-completions" | "responses";

type AkeruOpenCodeGoFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function openCodeGoProtocol(modelId: string): OpenCodeGoProtocol {
  if (RESPONSES_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix))) return "responses";

  if (modelId.startsWith("minimax-") || modelId.startsWith("qwen")) return "anthropic";

  return "chat-completions";
}

export function buildAkeruOpenCodeGoFetch(
  protocol: OpenCodeGoProtocol,
  getApiKey: () => Promise<string | undefined>,
  request: AkeruOpenCodeGoFetch = globalThis.fetch,
  getBaseUrl: () => string | undefined = () => undefined,
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

    return request(subscriptionRequestUrl(input, OPEN_CODE_GO_BASE_URL, getBaseUrl()), {
      ...init,
      headers,
      redirect: "error",
    });
  };
}

export function akeruOpenCodeGoProvider(
  modelId: string,
  getApiKey: () => Promise<string | undefined>,
  getBaseUrl?: () => string | undefined,
): MastraModelConfig {
  const protocol = openCodeGoProtocol(modelId);

  // SAFETY: The request adapter implements Fetch; this SDK declaration also includes an unused Bun preconnect method.
  const fetch = buildAkeruOpenCodeGoFetch(
    protocol,
    getApiKey,
    globalThis.fetch,
    getBaseUrl,
  ) as NonNullable<NonNullable<Parameters<typeof createOpenAI>[0]>["fetch"]>;

  if (protocol === "responses") {
    return createOpenAI({
      name: "opencode-go",
      apiKey: "api-key-placeholder",
      baseURL: OPEN_CODE_GO_BASE_URL,
      // SAFETY: The SDK accepts this Fetch API implementation; Bun ambient types add preconnect, which the SDK never calls.
      fetch: fetch as NonNullable<NonNullable<Parameters<typeof createOpenAI>[0]>["fetch"]>,
    }).responses(modelId);
  }

  if (protocol === "anthropic") {
    return createAnthropic({
      apiKey: "api-key-placeholder",
      baseURL: OPEN_CODE_GO_BASE_URL,
      // SAFETY: The SDK accepts this Fetch API implementation; Bun ambient types add preconnect, which the SDK never calls.
      fetch: fetch as NonNullable<NonNullable<Parameters<typeof createAnthropic>[0]>["fetch"]>,
    })(modelId);
  }

  return createOpenAICompatible({
    name: "opencode-go",
    apiKey: "api-key-placeholder",
    baseURL: OPEN_CODE_GO_BASE_URL,
    // SAFETY: The SDK accepts this Fetch API implementation; Bun ambient types add preconnect, which the SDK never calls.
    fetch: fetch as NonNullable<NonNullable<Parameters<typeof createOpenAICompatible>[0]>["fetch"]>,
  })(modelId);
}

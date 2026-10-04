import {
  buildOpenAICodexOAuthFetch,
  createCodexMiddleware,
} from "@mastra/code-sdk/providers/openai-codex";
import type { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { createOpenAI } from "@ai-sdk/openai";
import type { ApiKeyCredential } from "../subscription-auth/types.ts";
import { subscriptionRequestUrl } from "../subscription-auth/runtime.ts";

type OpenAIFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const OPENAI_BASE_URL = "https://api.openai.com/v1";

export function buildAkeruOpenAIFetch(
  getCredential: () => ApiKeyCredential | undefined,
  request: OpenAIFetch = globalThis.fetch,
): OpenAIFetch {
  return async (input, init) => {
    const credential = getCredential();

    if (!credential)
      throw new Error("The OpenAI API key is no longer connected. Start a new turn.");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("Authorization", `Bearer ${credential.access}`);
    headers.delete("chatgpt-account-id");

    return request(subscriptionRequestUrl(input, OPENAI_BASE_URL, credential.baseUrl), {
      ...init,
      headers,
      redirect: "error",
    });
  };
}

export function akeruOpenAIProvider(
  modelId: string,
  getCredential: () => ApiKeyCredential | undefined,
) {
  return createOpenAI({
    apiKey: "akeru-api-key",
    baseURL: OPENAI_BASE_URL,
    // SAFETY: The SDK accepts this Fetch API implementation; Bun ambient types add preconnect, which the SDK never calls.
    fetch: buildAkeruOpenAIFetch(getCredential) as NonNullable<
      NonNullable<Parameters<typeof createOpenAI>[0]>["fetch"]
    >,
  }).responses(modelId);
}

/** Preserves the SDK's OAuth default while accepting raw native efforts without coercion. */
export function akeruCodexOAuthProvider(modelId: string, authStorage: AuthStorage) {
  const model = createOpenAI({
    apiKey: "oauth-placeholder",
    fetch: buildOpenAICodexOAuthFetch({ authStorage }),
  }).responses(modelId);

  const middleware = createCodexMiddleware();
  const defaultMiddleware = createCodexMiddleware("medium");

  const transform = (params: Parameters<typeof model.doGenerate>[0], type: "generate" | "stream") =>
    (params.providerOptions?.openai?.reasoningEffort === undefined
      ? defaultMiddleware
      : middleware
    ).transformParams?.({ type, params, model });

  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(params: Parameters<typeof model.doGenerate>[0]) {
      const transformed = await transform(params, "generate");

      return model.doGenerate(transformed ?? params);
    },
    async doStream(params: Parameters<typeof model.doStream>[0]) {
      const transformed = await transform(params, "stream");

      return model.doStream(transformed ?? params);
    },
  };
}

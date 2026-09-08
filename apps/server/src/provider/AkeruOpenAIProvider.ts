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
    fetch: buildAkeruOpenAIFetch(getCredential) as NonNullable<
      NonNullable<Parameters<typeof createOpenAI>[0]>["fetch"]
    >,
  }).responses(modelId);
}

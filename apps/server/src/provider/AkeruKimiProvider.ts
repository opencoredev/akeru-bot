import { createAnthropic } from "@ai-sdk/anthropic";
import type { MastraModelConfig } from "@mastra/core/llm";

import { getKimiCodingDeviceHeaders } from "../subscription-auth/providers/kimi.ts";

const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";
type AkeruKimiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AkeruKimiAccess {
  readonly accessToken: string;
  readonly deviceId: string;
}

export function buildAkeruKimiFetch(
  getAccess: () => Promise<AkeruKimiAccess | undefined>,
  request: AkeruKimiFetch = globalThis.fetch,
): AkeruKimiFetch {
  return async (input, init) => {
    const access = await getAccess();
    if (!access) throw new Error("Kimi For Coding is not connected. Reconnect the account.");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.set("Authorization", `Bearer ${access.accessToken}`);
    for (const [key, value] of Object.entries(getKimiCodingDeviceHeaders(access.deviceId))) {
      headers.set(key, value);
    }
    return request(input, { ...init, headers });
  };
}

export function akeruKimiProvider(
  modelId: string,
  getAccess: () => Promise<AkeruKimiAccess | undefined>,
): MastraModelConfig {
  return createAnthropic({
    apiKey: "oauth-placeholder",
    baseURL: KIMI_CODING_BASE_URL,
    fetch: buildAkeruKimiFetch(getAccess) as NonNullable<
      NonNullable<Parameters<typeof createAnthropic>[0]>["fetch"]
    >,
  })(modelId);
}

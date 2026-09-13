import { describe, expect, it, vi } from "vite-plus/test";
import type { ApiKeyCredential } from "../subscription-auth/types.ts";
import { akeruOpenAIProvider, buildAkeruOpenAIFetch } from "./AkeruOpenAIProvider.ts";

describe("Akeru OpenAI API-key transport", () => {
  it("uses Responses without a ChatGPT account or OAuth token", () => {
    expect(
      akeruOpenAIProvider("gpt-5.6", () => ({ type: "api-key", access: "key" })),
    ).toMatchObject({ modelId: "gpt-5.6", provider: "openai.responses" });
  });

  it("loads current credentials for every request and stops after logout", async () => {
    let credential: ApiKeyCredential | undefined = {
      type: "api-key",
      access: "first-key",
      baseUrl: "https://proxy.example/v1",
    };
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}"),
    );
    const fetch = buildAkeruOpenAIFetch(() => credential, request);
    await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: "{}",
      headers: { "chatgpt-account-id": "stale-account" },
    });
    expect(request).toHaveBeenCalledWith(
      "https://proxy.example/v1/responses",
      expect.objectContaining({ method: "POST", body: "{}", redirect: "error" }),
    );
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer first-key",
    );
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("chatgpt-account-id")).toBeNull();
    credential = { type: "api-key", access: "replacement-key" };
    await fetch("https://api.openai.com/v1/responses");
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer replacement-key",
    );
    credential = undefined;
    await expect(fetch("https://api.openai.com/v1/responses")).rejects.toThrow(
      "no longer connected",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});

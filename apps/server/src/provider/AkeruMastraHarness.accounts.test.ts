import type { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import * as NodeFS from "node:fs";
import { expect, it, vi } from "vite-plus/test";

import { resolveAkeruMastraModel } from "./AkeruMastraHarness.ts";
import { makeTestSubscriptionAuthService } from "../subscription-auth/testUtils/subscriptionAuthService.ts";
import { fixture } from "../subscription-auth/testUtils/subscriptionAuthStorage.ts";

it("pins OpenCode Go's key, endpoint, and outcome when another thread benches its account", async () => {
  const { authPath, directory } = fixture();
  NodeFS.writeFileSync(
    authPath,
    JSON.stringify({
      "opencode-go": { type: "api-key", access: "first-key", baseUrl: "https://first.example/v1" },
      "account:opencode-go:backup": {
        type: "api-key",
        access: "second-key",
        baseUrl: "https://second.example/v1",
      },
    }),
  );
  const service = await makeTestSubscriptionAuthService(authPath);

  const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({
      id: "reply",
      model: "deepseek-v4-pro",
      choices: [
        { index: 0, message: { role: "assistant", content: "Done" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );

  vi.stubGlobal("fetch", request);

  try {
    const model = resolveAkeruMastraModel(
      "opencode-go/deepseek-v4-pro",
      new AuthStorage(authPath),
      undefined,
      async (instanceId, threadId) => {
        const credential = service.getApiKeyCredential("opencode-go", instanceId, threadId);
        service.recordRequestFailure(
          "opencode-go",
          "Spending limit reached.",
          undefined,
          "request",
          "thread-other",
        );
        expect(service.getApiKeyCredential("opencode-go", undefined, "thread-backup")?.access).toBe(
          "second-key",
        );

        return credential;
      },
      undefined,
      (provider, instanceId, threadId) =>
        service.getApiKeyCredential(provider, instanceId, threadId),
      undefined,
      undefined,
      undefined,
      "thread-request",
    ) as ReturnType<ReturnType<typeof createOpenAICompatible>>;

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    expect(request.mock.calls[0]?.[0]).toBe("https://first.example/v1/chat/completions");
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer first-key",
    );
    service.recordRequestSuccess("opencode-go", undefined, "thread-request");
    expect(
      service
        .linkedAccountStatuses()
        .find((status) => status.provider === "opencode-go" && status.accountId === "default")
        ?.health,
    ).toBe("recovered");
  } finally {
    vi.unstubAllGlobals();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

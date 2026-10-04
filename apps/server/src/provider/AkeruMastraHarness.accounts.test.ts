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
    vi.unstubAllEnvs();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["openai-codex", "anthropic", "xai"] as const)(
  "pins %s OAuth auth when a backup uses an API key",
  async (provider) => {
    const { authPath, directory } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        [provider]: {
          type: "oauth",
          access: "expired",
          refresh: "main-refresh",
          expires: 0,
          accountId: "main-account",
        },
        [`account:${provider}:backup`]: { type: "api-key", access: "backup-key" },
      }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", undefined);

    const request = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).includes("token"))
        return Response.json({
          access_token: "refreshed-main",
          refresh_token: "main-refresh",
          expires_in: 3600,
        });

      return new Response("dispatch reached", { status: 503 });
    });

    vi.stubGlobal("fetch", request);

    try {
      const prefix = { "openai-codex": "openai", anthropic: "anthropic", xai: "xai" }[provider];

      const model = resolveAkeruMastraModel(
        `${prefix}/test-model`,
        new AuthStorage(authPath),
        undefined,
        undefined,
        undefined,
        (id, scope, thread) => service.getApiKeyCredential(id, scope, thread),
        undefined,
        (id, scope, thread) => service.getOAuthCredential(id, scope, thread),
        (id, scope, thread) => service.getAccessToken(id, scope, thread),
        "thread-request",
      ) as ReturnType<ReturnType<typeof createOpenAICompatible>>;

      service.recordRequestFailure(
        provider,
        "Spending limit reached.",
        undefined,
        "request",
        "thread-other",
      );
      expect(service.getApiKeyCredential(provider, undefined, "thread-backup")?.access).toBe(
        "backup-key",
      );
      await expect(
        model.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        }),
      ).rejects.toThrow();
      const dispatch = request.mock.calls.find(([input]) => !String(input).includes("token"));
      expect(dispatch).toBeDefined();
      const headers = new Headers(dispatch?.[1]?.headers);
      expect(headers.get("authorization")).toBe("Bearer refreshed-main");

      if (provider === "openai-codex")
        expect(headers.get("chatgpt-account-id")).toBe("main-account");
      service.recordRequestSuccess(provider, undefined, "thread-request");
      expect(
        service
          .linkedAccountStatuses()
          .find((status) => status.provider === provider && status.accountId === "default")?.health,
      ).toBe("recovered");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("pins Codex Responses auth when another thread selects an OAuth backup", async () => {
  const { authPath, directory } = fixture();
  NodeFS.writeFileSync(
    authPath,
    JSON.stringify({
      "openai-codex": { type: "api-key", access: "main-key", baseUrl: "https://main.example/v1" },
      "account:openai-codex:backup": {
        type: "oauth",
        access: "backup-token",
        refresh: "backup-refresh",
        expires: Date.now() + 60000,
        accountId: "backup-account",
      },
    }),
  );
  const service = await makeTestSubscriptionAuthService(authPath);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VITEST", undefined);

  const request = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response("dispatch reached", { status: 503 }),
  );

  vi.stubGlobal("fetch", request);

  try {
    const model = resolveAkeruMastraModel(
      "openai/test-model",
      new AuthStorage(authPath),
      undefined,
      undefined,
      undefined,
      (id, scope, thread) => service.getApiKeyCredential(id, scope, thread),
      undefined,
      undefined,
      undefined,
      "thread-request",
    ) as ReturnType<ReturnType<typeof createOpenAICompatible>>;

    service.recordRequestFailure(
      "openai-codex",
      "Spending limit reached.",
      undefined,
      "request",
      "thread-other",
    );
    expect(service.getOAuthCredential("openai-codex", undefined, "thread-backup")?.access).toBe(
      "backup-token",
    );
    await expect(
      model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }),
    ).rejects.toThrow();
    expect(request.mock.calls[0]?.[0]).toBe("https://main.example/v1/responses");
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer main-key",
    );
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
